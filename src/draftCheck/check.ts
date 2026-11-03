// Mirrored from the public hackathon repo oocm-campaign-autopilot (src/draftCheck/check.ts).
// Edit there first, then copy here, so the two stay identical.
/**
 * The draft checker: watches a creator's draft video and checks it against the
 * brand's brief, with evidence for every verdict.
 *
 *   1. prepare   ffmpeg: H.264 MP4 with faststart, plus a 16 kHz mono WAV.
 *   2. watch     Muse Spark 1.3 reads the video (frames + soundtrack) and the
 *                brief, and answers each check with seconds and a quote.
 *   3. listen    Muse Voice Transcribe writes down what is said (Hindi,
 *                English and 23 more languages), independently of step 2.
 *   4. locate    SAM 3.1 tracks the product through the video, so "product on
 *                screen" comes with frame-accurate boxes, not just a claim.
 *   5. verify    Deterministic cross-checks: a "said" verdict must be backed by
 *                the transcript, a "shown" verdict by SAM. Where the models
 *                disagree, the item goes to a person instead of guessing.
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 */
import logger from "../../utils/logger";
import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deleteFile, respond, segment, transcribe, uploadFile, type MetaUsage, type SamBox, type Transcript } from "./client";
import { hasDisclosure } from "../../utils/disclosure";

const run = promisify(execFile);

export interface Brief {
  brand: string;
  product: string;
  /** Lines or claims the creator must say (paraphrase allowed). */
  mustSay: string[];
  /** Things that must be visible, besides the product itself. */
  mustShow: string[];
  /** Ad disclosure (#ad, "paid partnership") required. Default true. */
  disclosureRequired?: boolean;
  countries?: string[];
  compensationType?: string | null;
  /** Competitor brands that must not appear or be named. */
  competitors: string[];
  /** Free-text do's and don'ts from the brand. */
  dos?: string;
  donts?: string;
  /** Language the brand asked for, if any ("Hindi", "English"). */
  language?: string;
}

export type Verdict = "pass" | "fail" | "needs_review";

export interface CheckItem {
  key: string;
  label: string;
  verdict: Verdict;
  /** One plain sentence a creator or brand can act on. */
  detail: string;
  /** Seconds into the video where the evidence is, when there is one. */
  at_s: number | null;
  until_s: number | null;
  quote: string | null;
  /** Which models agreed: "spark", "transcript", "sam". */
  sources: string[];
  confidence: number;
}

export interface DraftCheckResult {
  items: CheckItem[];
  summary: string;
  durationS: number;
  transcript: Transcript | null;
  productBoxes: SamBox[];
  fps: number;
  usage: { spark: MetaUsage; samFrames: number; audioSeconds: number };
  models: string[];
  ms: number;
}

export interface CheckOptions {
  ffmpeg?: string;
  /** Skip SAM (faster, cheaper); "shown" checks then rest on Spark alone. */
  noSam?: boolean;
  model?: string;
  /** The creator's caption for the post, if any. A disclosure or brand tag there counts. */
  caption?: string | null;
  paidPartnership?: boolean;
}

// ── 1. prepare ─────────────────────────────────────────────────────────────

/** Thrown when the input is not a video container we accept. */
export class NotAVideo extends Error {}

/**
 * Only real MP4/MOV or WebM/Matroska files go to ffmpeg, forced to that demuxer
 * and to local files only. ffmpeg picks a demuxer by content, so without this a
 * "video" that is really an HLS playlist or concat list could make it read
 * local files or internal URLs.
 */
async function containerOf(path: string): Promise<"mov" | "matroska"> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    const box = head.subarray(4, 8).toString("latin1");
    if (["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(box)) return "mov";
    if (head.readUInt32BE(0) === 0x1a45dfa3) return "matroska";
  } finally {
    await fh.close();
  }
  throw new NotAVideo("The file is not an MP4, MOV or WebM video.");
}

// Every ffmpeg run is time-boxed and killed hard, so a broken file can't hold the worker.
// 8 minutes: a 1440p 60fps HEVC file must finish the 720p re-encode.
const FF_OPTS = { timeout: 480_000, killSignal: "SIGKILL" as const, maxBuffer: 1 << 26 };
const FF_BASE = ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file"];

/** Re-encode to a 720p H.264 MP4 (and a 16 kHz WAV) in a temp dir. Caller removes `dir`. */
export async function prepare(input: Uint8Array | { path: string }, o: CheckOptions) {
  const dir = await mkdtemp(join(tmpdir(), "draftcheck-"));
  let src = join(dir, "in");
  const mp4 = join(dir, "draft.mp4");
  const wav = join(dir, "audio.wav");
  if (input instanceof Uint8Array) await writeFile(src, input);
  else src = input.path;
  const ff = o.ffmpeg ?? "ffmpeg";
  const format = await containerOf(src).catch(async (e) => {
    await rm(dir, { recursive: true, force: true });
    throw e;
  });
  try {
    // Re-encode: SAM wants H.264/H.265 MP4, Spark wants MP4.
    // Cap at 10 minutes (Voice Transcribe and SAM limits) and 720p (cost).
    await run(ff, [...FF_BASE, "-y", "-f", format, "-i", src, "-t", "600", "-vf", "scale='min(720,iw)':-2", "-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", mp4], FF_OPTS);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  let hasAudio = true;
  try {
    await run(ff, [...FF_BASE, "-y", "-i", mp4, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1", wav], FF_OPTS);
  } catch {
    hasAudio = false;
  }
  // Duration from ffmpeg's own banner (no ffprobe needed on servers).
  const probe = await run(ff, ["-nostdin", "-hide_banner", "-i", mp4], FF_OPTS).catch((e: any) => e);
  const m = String(probe?.stderr ?? "").match(/Duration: (\d+):(\d+):([\d.]+)/);
  const durationS = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return { dir, mp4, wav: hasAudio ? wav : null, durationS, fps: 25 };
}

// ── 2. watch ───────────────────────────────────────────────────────────────

const SPARK_SCHEMA = {
  name: "draft_check",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["product_on_screen", "product_phrase", "must_say", "must_show", "disclosure", "competitors", "language", "rules", "summary"],
    properties: {
      product_on_screen: {
        type: "object",
        additionalProperties: false,
        required: ["shown", "from_s", "to_s", "how"],
        properties: { shown: { type: "boolean" }, from_s: { type: ["number", "null"] }, to_s: { type: ["number", "null"] }, how: { type: "string" } },
      },
      product_phrase: { type: "string", description: "A 1-3 word noun phrase for the product's physical look, e.g. 'green bottle', for an object tracker." },
      must_say: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "line", "said", "shown_on_screen", "at_s", "quote"],
          properties: {
            index: { type: "integer", description: "The line's number in the brief." },
            line: { type: "string" },
            said: { type: "boolean" },
            shown_on_screen: { type: "boolean", description: "True if the line, or the brand name or logo for a brand-name line, appears as on-screen text or graphics." },
            at_s: { type: ["number", "null"] },
            quote: { type: ["string", "null"] },
          },
        },
      },
      must_show: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item", "shown", "at_s"],
          properties: { item: { type: "string" }, shown: { type: "boolean" }, at_s: { type: ["number", "null"] } },
        },
      },
      disclosure: {
        type: "object",
        additionalProperties: false,
        required: ["present", "spoken", "on_screen", "at_s", "quote"],
        properties: { present: { type: "boolean" }, spoken: { type: "boolean" }, on_screen: { type: "boolean" }, at_s: { type: ["number", "null"] }, quote: { type: ["string", "null"] } },
      },
      competitors: {
        type: "array",
        description: "Every brand other than the campaign's own that is named aloud or visibly shown (logo, packaging, on-screen text).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "how", "at_s"],
          properties: { name: { type: "string" }, how: { type: "string", enum: ["said", "shown"] }, at_s: { type: ["number", "null"] } },
        },
      },
      language: { type: "string" },
      rules: {
        type: "array",
        description: "Each do/don't from the brief that the video clearly breaks, leaving out must-say lines, the ad disclosure and competitors (those are checked separately). Quote the exact words said or shown for each. Empty if none.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule", "at_s", "why", "quote"],
          properties: { rule: { type: "string" }, at_s: { type: ["number", "null"] }, why: { type: "string" }, quote: { type: ["string", "null"] } },
        },
      },
      summary: { type: "string", description: "Two plain sentences to the creator: what works, and the one thing to fix first. It must match the item verdicts: if anything failed or needs a look, name it — never 'nothing to fix', 'all good' or 'ready'. The draft still goes to the brand for approval: say it 'can go to the brand', never 'ready to post'." },
    },
  },
};

const INSTRUCTIONS = `You check a creator's draft video against a brand's brief before the brand sees it.
Answer only from what is actually seen and heard in the video. Never assume.
Give seconds from the start of the video for every piece of evidence.
A must-say line counts as said if the meaning is said, in any language; quote the words actually spoken.
An ad disclosure is "#ad", "ad", "advertisement", "paid partnership", "sponsored", or the same in Hindi (e.g. "विज्ञापन").
List every other brand that is named aloud or visibly shown, under competitors.
A brand-name line counts as shown_on_screen if the brand's name or logo is on screen.
If the creator's caption is given, it is part of the post: an ad disclosure written there counts.
Write the summary in plain, warm English to the creator.
The summary must match the item verdicts: if anything failed or needs a look, say what needs fixing or a look — never "nothing to fix", "all good" or "ready".
The draft still goes to the brand for approval after your check: say it "can go to the brand", never "ready to post".`;

function briefText(b: Brief): string {
  return [
    `Brand: ${b.brand}`,
    `Product: ${b.product?.trim() || "(no physical product — the brand itself is what is shown and said)"}`,
    `Must say: ${b.mustSay.length ? b.mustSay.map((s, i) => `${i + 1}. ${s}`).join(" ") : "nothing specific"}`,
    `Must show: ${b.mustShow.length ? b.mustShow.join("; ") : "the product"}`,
    `Ad disclosure required: ${b.disclosureRequired === false ? "no" : "yes"}`,
    `Competitors (must not appear): ${b.competitors.length ? b.competitors.join(", ") : "none listed"}`,
    b.language ? `Language asked for: ${b.language}` : "",
    b.dos ? `Do's: ${b.dos}` : "",
    b.donts ? `Don'ts: ${b.donts}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Words the speech model should expect: brand, product, and codes/handles in the must-say lines. */
export function briefKeywords(b: Brief): string[] {
  const words = new Set<string>([b.brand, b.product]);
  for (const line of [...b.mustSay, ...b.mustShow]) {
    for (const w of line.split(/\s+/)) {
      const t = w.replace(/^[^\p{L}\p{N}#@]+|[^\p{L}\p{N}]+$/gu, "");
      if (/\d/.test(t) && /\p{L}/u.test(t)) words.add(t); // DEW10
      else if (/^[#@]/.test(t)) words.add(t);
      else if (t.length > 2 && t === t.toUpperCase() && /\p{L}/u.test(t)) words.add(t);
    }
  }
  return [...words].filter(Boolean);
}

/** What to call the product in verdict copy when the brief leaves it blank
 * (piece 799: the detail read " is on screen…" with a leading blank). */
export function displayProduct(brief: Brief): string {
  return brief.product?.trim() || brief.brand?.trim() || "The product";
}

/** One item per don't from the brand ("no …; keep it …" prose, numbered or
 * bulleted). The model only reports the rules it thinks broke, so each don't
 * is matched back by word overlap; the matched model rule is consumed. */
export function splitDonts(donts?: string | null): string[] {
  if (!donts) return [];
  return String(donts)
    .split(/\n+|;\s*|[•\-–]\s+/)
    .flatMap((part) => part.split(/\s*\d+[.)]\s+/))
    .flatMap((part) => part.split(/\.\s+(?=[A-Z])/))
    .map((s) => s.trim().replace(/\s+/g, " ").replace(/\.$/, "").trim())
    .filter((s) => s.length > 1)
    .slice(0, 6);
}

const dontWords = (s: string) =>
  new Set(norm(s).split(" ").filter((w) => w.length > 2));

/** Share of the don't's significant words also in the model's rule + why. */
export function dontRuleOverlap(dont: string, rule: { rule: string; why: string }): number {
  const d = dontWords(dont);
  if (!d.size) return 0;
  const r = new Set([...dontWords(rule.rule), ...dontWords(rule.why ?? "")]);
  let hit = 0;
  for (const w of d) if (r.has(w)) hit++;
  return hit / d.size;
}

export interface ModelRule {
  rule: string;
  at_s: number | null;
  why: string;
  quote?: string | null;
}

/**
 * One scored item per don't (key `dont_<n>`, label "Doesn't: <short>").
 * A don't the model clearly flagged (overlap ≥ 0.5) fails with its time and
 * quote; a weak match needs a human eye; the rest pass. Returns the items and
 * the model-rule indexes they consumed, so the caller doesn't report the
 * same break twice (once as a don't, once as a generic rule).
 */
export function scoreDonts(donts: string[], rules: ModelRule[]): { items: CheckItem[]; consumed: number[] } {
  const consumed: number[] = [];
  const items = donts.map((dont, i) => {
    const short = dont.length > 60 ? `${dont.slice(0, 59).trimEnd()}…` : dont;
    let best = -1;
    let bestScore = 0;
    rules.forEach((r, j) => {
      if (consumed.includes(j)) return;
      const s = dontRuleOverlap(dont, r);
      if (s > bestScore) { bestScore = s; best = j; }
    });
    const base = { key: `dont_${i + 1}`, label: `Doesn't: ${short}`, sources: ["spark"] };
    if (best >= 0 && bestScore >= 0.5) {
      consumed.push(best);
      const r = rules[best];
      return {
        ...base, verdict: "fail" as Verdict,
        detail: `${r.why}${fmt(r.at_s)}.`,
        at_s: r.at_s ?? null, until_s: null, quote: r.quote ?? null, confidence: 0.75,
      };
    }
    if (best >= 0 && bestScore >= 0.25) {
      consumed.push(best);
      const r = rules[best];
      return {
        ...base, verdict: "needs_review" as Verdict,
        detail: `Might break "${short}"${fmt(r.at_s)} — please check by eye.`,
        at_s: r.at_s ?? null, until_s: null, quote: r.quote ?? null, confidence: 0.5,
      };
    }
    return {
      ...base, verdict: "pass" as Verdict,
      detail: `Keeps clear of "${short}".`,
      at_s: null, until_s: null, quote: null, confidence: 0.7,
    };
  });
  return { items, consumed };
}

/** Speech models sometimes stutter a word ("is is"). Drop immediate repeats for display. */
export function unstutter(text: string): string {
  const w = text.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const k = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (out.length && k(out[out.length - 1]) && k(out[out.length - 1]) === k(w[i])) continue;
    if (out.length >= 2 && i + 1 < w.length && k(out[out.length - 2]) === k(w[i]) && k(out[out.length - 1]) === k(w[i + 1])) { i++; continue; }
    out.push(w[i]);
  }
  return out.join(" ");
}

// ── 5. verify helpers ──────────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Share of the quote's words found in the transcript (order-free, tolerant of ASR slips). */
export function transcriptSupport(quote: string, transcript: string): number {
  const q = norm(quote).split(" ").filter((w) => w.length > 2);
  if (!q.length) return 0;
  const t = new Set(norm(transcript).split(" "));
  return q.filter((w) => t.has(w)).length / q.length;
}

function samSeconds(boxes: SamBox[], fps: number): { from: number; to: number; frames: number } | null {
  if (!boxes.length) return null;
  const frames = [...new Set(boxes.map((b) => b.frame))].sort((a, b) => a - b);
  return { from: frames[0] / fps, to: frames[frames.length - 1] / fps, frames: frames.length };
}

const HEARD_SCHEMA = {
  name: "transcript_check",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["lines", "disclosure_excerpt"],
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "present", "excerpt"],
          properties: { index: { type: "integer" }, present: { type: "boolean" }, excerpt: { type: ["string", "null"] } },
        },
      },
      disclosure_excerpt: { type: ["string", "null"] },
    },
  },
};

/**
 * The second, independent opinion on what was said: a text-only call over the
 * transcript (never the video). Each "present" must come with an excerpt copied
 * from the transcript, and the excerpt is then checked to really be in it, so
 * the verdict can be shown to a person as proof. Works across scripts (a
 * Hindi transcript against an English brief line).
 */
async function verifyHeard(transcript: string, lines: string[], model?: string): Promise<{ lines: Map<number, string | null>; disclosure: string | null; usage: MetaUsage } | null> {
  if (!transcript.trim()) return null;
  const r = await respond<any>({
    model,
    instructions:
      "You get a speech transcript and numbered lines a brand wants said. For each line, decide if its meaning is said anywhere in the transcript, in any language. If yes, copy the exact words from the transcript, unchanged and in the transcript's own script. Also copy the exact words of any ad disclosure (ad, paid partnership, sponsored, विज्ञापन, पेड पार्टनरशिप), or null.",
    content: [{ type: "input_text", text: `TRANSCRIPT\n${transcript}\n\nLINES\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}` }],
    schema: HEARD_SCHEMA,
    effort: "low",
    maxOutputTokens: 4000,
  });
  const inT = (ex: string | null) => (ex && transcriptSupport(ex, transcript) >= 0.8 ? unstutter(ex) : null);
  const m = new Map<number, string | null>();
  for (const l of r.data.lines ?? []) m.set(Number(l.index), l.present ? inT(l.excerpt) : null);
  return { lines: m, disclosure: inT(r.data.disclosure_excerpt), usage: r.usage };
}

const fmt = (s: number | null) => (s == null ? "" : ` at ${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

// ── the pipeline ───────────────────────────────────────────────────────────

/** video: the bytes, or { path } to a file on disk (the server streams downloads to disk). */
export async function checkDraft(video: Uint8Array | { path: string }, brief: Brief, o: CheckOptions = {}): Promise<DraftCheckResult> {
  const t0 = Date.now();
  const prep = await prepare(video, o);
  let fileId: string | null = null;
  try {
    const mp4 = await readFile(prep.mp4);
    fileId = await uploadFile(mp4, "draft.mp4", "video/mp4", 3600);

    const languages = Array.from(new Set(["English", "Hindi", ...(brief.language ? [brief.language] : [])]));
    const [spark, heard] = await Promise.all([
      respond<any>({
        model: o.model,
        instructions: INSTRUCTIONS,
        content: [
          { type: "input_text", text: `THE BRIEF\n${briefText(brief)}${o.caption ? `\n\nTHE CREATOR'S CAPTION\n${o.caption.slice(0, 2200)}` : ""}\n\nCheck the video below against it.` },
          { type: "input_video", file_id: fileId },
        ],
        schema: SPARK_SCHEMA,
        effort: "medium",
        maxOutputTokens: 12000,
      }),
      prep.wav ? readFile(prep.wav).then((w) => transcribe(w, languages, briefKeywords(brief))).catch((e: any) => { logger.warn(`draft-check: transcribe failed: ${String(e?.message ?? e).slice(0, 200)}`); return null; }) : Promise.resolve(null),
    ]);
    const s = spark.data;
    if (process.env.DRAFTCHECK_DEBUG) console.error("SPARK", JSON.stringify({ must_say: s.must_say, disclosure: s.disclosure }));

    const said = heard?.transcript ?? "";
    let boxes: SamBox[] = [];
    let samFrames = 0;
    const [, check] = await Promise.all([
      (async () => {
        if (o.noSam || !s.product_phrase) return;
        try {
          const r = await segment({ file_id: fileId! }, String(s.product_phrase).split(/\s+/).slice(0, 3).join(" "));
          boxes = r.boxes.filter((b) => b.conf == null || b.conf >= 0.4);
          samFrames = Number(r.usage.video_frames_processed ?? 0);
        } catch (e: any) {
          // SAM is a second opinion; its failure never sinks the check
          logger.warn(`draft-check: SAM failed: ${String(e?.message ?? e).slice(0, 200)}`);
        }
      })(),
      verifyHeard(said, brief.mustSay, o.model).catch((e: any) => { logger.warn(`draft-check: verifyHeard failed: ${String(e?.message ?? e).slice(0, 200)}`); return null; }),
    ]);

    if (process.env.DRAFTCHECK_DEBUG) console.error("HEARD", JSON.stringify(said), JSON.stringify(check ? [...check.lines] : null));
    const items: CheckItem[] = [];

    // Product on screen: Spark's claim, confirmed (or not) by SAM's tracking.
    {
      const sam = samSeconds(boxes, prep.fps);
      const sparkSays = !!s.product_on_screen?.shown;
      const product = displayProduct(brief);
      let verdict: Verdict;
      let sources = ["spark"];
      let detail: string;
      if (sparkSays && sam) {
        verdict = "pass";
        sources.push("sam");
        detail = `${product} is on screen from ${sam.from.toFixed(1)}s to ${sam.to.toFixed(1)}s (tracked in ${sam.frames} frames).`;
      } else if (sparkSays && (o.noSam || !s.product_phrase)) {
        verdict = "pass";
        detail = `${product} is on screen${fmt(s.product_on_screen.from_s)}: ${s.product_on_screen.how}`;
      } else if (sparkSays) {
        verdict = "needs_review";
        detail = `The video seems to show ${product}${fmt(s.product_on_screen.from_s)}, but the object tracker could not find it. Please check by eye.`;
      } else if (sam) {
        verdict = "needs_review";
        sources = ["sam"];
        detail = `Something like ${product} is tracked from ${sam.from.toFixed(1)}s, but it is not clearly the product. Please check by eye.`;
      } else {
        verdict = "fail";
        detail = `${product} never appears on screen. Show it clearly, ideally in the first few seconds.`;
      }
      items.push({ key: "product_on_screen", label: "Product on screen", verdict, detail, at_s: sam?.from ?? s.product_on_screen?.from_s ?? null, until_s: sam?.to ?? s.product_on_screen?.to_s ?? null, quote: null, sources, confidence: verdict === "pass" ? (sources.length > 1 ? 0.95 : 0.75) : verdict === "fail" ? 0.8 : 0.5 });
    }

    // Must-say lines: Spark's "said" must be backed by the transcript.
    // Must-say lines: Spark (watching) and the transcript check (reading) must agree.
    brief.mustSay.forEach((line, i) => {
      const m = (s.must_say ?? []).find((x: any) => Number(x.index) === i + 1) ?? (s.must_say ?? [])[i] ?? { said: false, at_s: null, quote: null };
      const sparkSaid = !!m.said;
      const excerpt = check ? (check.lines.get(i + 1) ?? null) : m.quote && said && transcriptSupport(m.quote, said) >= 0.6 ? m.quote : null;
      const heardSaid = !!excerpt;
      const onScreen = !!m.shown_on_screen;
      let verdict: Verdict;
      let sources: string[];
      if (onScreen && !(sparkSaid && heardSaid)) {
        // Shown as text or logo: a mention even when the speech checks disagree.
        verdict = "pass";
        sources = heardSaid ? ["spark", "transcript"] : ["spark"];
      } else if (!heard) {
        verdict = sparkSaid ? "pass" : "fail";
        sources = ["spark"];
      } else if (sparkSaid && heardSaid) {
        verdict = "pass";
        sources = ["spark", "transcript"];
      } else if (!sparkSaid && !heardSaid) {
        verdict = "fail";
        sources = ["spark", "transcript"];
      } else {
        verdict = "needs_review";
        sources = [sparkSaid ? "spark" : "transcript"];
      }
      const quote = excerpt ?? m.quote ?? null;
      const detail =
        verdict === "pass"
          ? onScreen && !(sparkSaid && heardSaid)
            ? `Shown on screen${fmt(m.at_s)}${sparkSaid ? " and said" : ""}.`
            : `Said${fmt(m.at_s)}: "${quote}"`
          : verdict === "fail"
            ? `Not said: "${line}". Add it in your own words.`
            : `Not sure "${line}" is said${fmt(m.at_s)}: the two checks disagree. Please listen.`;
      items.push({ key: `must_say_${i + 1}`, label: `Says: ${line}`, verdict, detail, at_s: m.at_s ?? null, until_s: null, quote, sources, confidence: verdict === "needs_review" ? 0.5 : sources.length > 1 ? 0.9 : 0.7 });
    });

    // Must-show items (besides the product): Spark only, and only what the brief lists.
    (s.must_show ?? []).slice(0, brief.mustShow.length).forEach((m: any, i: number) => {
      items.push({ key: `must_show_${i + 1}`, label: `Shows: ${m.item}`, verdict: m.shown ? "pass" : "fail", detail: m.shown ? `${m.item} is visible in the video.` : `Not shown: ${m.item}.`, at_s: m.at_s ?? null, until_s: null, quote: null, sources: ["spark"], confidence: 0.7 });
    });

    // Ad disclosure: spoken claims are checked against the transcript.
    if (brief.disclosureRequired !== false) {
      const d = s.disclosure ?? {};
      const heardDisclosure = check?.disclosure ?? null;
      const spokenOk = !!heardDisclosure || (d.spoken && d.quote && said ? transcriptSupport(d.quote, said) >= 0.5 : false);
      if (heardDisclosure) d.quote = heardDisclosure;
      let verdict: Verdict;
      const sources = ["spark"];
      const inCaption = hasDisclosure(o.caption ?? "", brief.countries, o.paidPartnership, brief.compensationType);
      if (d.on_screen || spokenOk || (d.spoken && !heard) || inCaption) {
        verdict = "pass";
        if (spokenOk) sources.push("transcript");
        if (inCaption) sources.push("caption");
      } else if (d.spoken) verdict = "needs_review";
      else verdict = "fail";
      const how = [spokenOk || (d.spoken && !heard) ? "said" : "", d.on_screen ? "shown on screen" : "", inCaption ? "in the caption" : ""].filter(Boolean).join(" and ");
      items.push({
        key: "ad_disclosure",
        label: "Ad disclosure",
        verdict,
        detail: verdict === "pass" ? `Disclosure ${how}${fmt(d.at_s)}${d.quote ? `: "${d.quote}"` : ""}.` : verdict === "fail" ? `No ad disclosure. Say "this is a paid partnership with ${brief.brand}" or add #ad on screen.` : "A disclosure may be said, but the transcript does not confirm it. Please listen.",
        at_s: d.at_s ?? null,
        until_s: null,
        quote: d.quote ?? null,
        sources,
        confidence: verdict === "pass" ? 0.9 : 0.6,
      });
    }

    // Competitors: anything named aloud must also be in the transcript to fail outright.
    {
      const named = (s.competitors ?? []) as { name: string; how: string; at_s: number | null }[];
      const listed = brief.competitors.map(norm);
      const own = norm(brief.brand);
      const others = named.filter((c) => norm(c.name) && !norm(c.name).includes(own) && !own.includes(norm(c.name)));
      const hits = others.filter((c) => listed.some((l) => norm(c.name).includes(l) || l.includes(norm(c.name))));
      const info = others.filter((c) => !hits.includes(c));
      const heardHits = brief.competitors.filter((c) => said && norm(said).includes(norm(c)));
      const all = Array.from(new Set([...hits.map((h) => h.name), ...heardHits]));
      const verdict: Verdict = all.length ? "fail" : "pass";
      items.push({
        key: "no_competitors",
        label: "No competitor brands",
        verdict,
        detail: all.length ? `Mentions ${all.join(", ")}${fmt(hits[0]?.at_s ?? null)}. Remove it: the brief does not allow competitors.` : "No competitor brand is named or shown.",
        at_s: hits[0]?.at_s ?? null,
        until_s: null,
        quote: null,
        sources: heardHits.length ? ["spark", "transcript"] : ["spark"],
        confidence: all.length ? 0.9 : 0.75,
      });
      // Other brands that appear but are not banned: for the brand to see, never a fail.
      if (info.length) {
        const names = Array.from(new Set(info.map((c) => c.name)));
        items.push({ key: "other_brands", label: "Other brands in the video", verdict: "pass", detail: `Also ${info.some((c) => c.how === "said") ? "named" : "shown"}: ${names.join(", ")}. Not on the brief's banned list.`, at_s: info[0]?.at_s ?? null, until_s: null, quote: null, sources: ["spark"], confidence: 0.7 });
      }
    }

    // The brand's don'ts, one scored item per don't — they were in the prompt
    // but never scored. A model rule matched to a don't is consumed here, so
    // the same break is not reported twice (generic rule items below skip it).
    {
      const modelRules: ModelRule[] = (s.rules ?? []).map((r: any) => ({
        rule: String(r.rule ?? ""), at_s: r.at_s ?? null, why: String(r.why ?? ""), quote: r.quote ?? null,
      }));
      const { items: dontItems, consumed } = scoreDonts(splitDonts(brief.donts), modelRules);
      items.push(...dontItems);
      (s.rules ?? []).forEach((r: any, i: number) => {
        if (consumed.includes(i)) return;
        items.push({ key: `rule_${i + 1}`, label: `Brief rule: ${r.rule}`, verdict: "fail", detail: `${r.why}${fmt(r.at_s)}.`, at_s: r.at_s ?? null, until_s: null, quote: r.quote ?? null, sources: ["spark"], confidence: 0.65 });
      });
    }

    // Language, when the brand asked for one.
    if (brief.language) {
      const ok = norm(s.language ?? "").includes(norm(brief.language));
      items.push({ key: "language", label: `In ${brief.language}`, verdict: ok ? "pass" : "fail", detail: ok ? `Spoken in ${s.language}.` : `Spoken in ${s.language}; the brief asks for ${brief.language}.`, at_s: null, until_s: null, quote: null, sources: ["spark"], confidence: 0.8 });
    }

    return {
      items,
      summary: sanitizeSummary(String(s.summary ?? ""), items),
      durationS: prep.durationS,
      transcript: heard,
      productBoxes: boxes,
      fps: prep.fps,
      usage: { spark: addUsage(spark.usage, check?.usage), samFrames, audioSeconds: heard ? Math.floor(heard.durationMs / 1000) : 0 },
      models: [spark.model, ...(heard ? ["muse-voice-transcribe-1.0"] : []), ...(samFrames ? ["sam-3.1"] : [])],
      ms: Date.now() - t0,
    };
  } finally {
    if (fileId) await deleteFile(fileId);
    await rm(prep.dir, { recursive: true, force: true });
  }
}

function addUsage(a: MetaUsage, b?: MetaUsage): MetaUsage {
  if (!b) return a;
  return { input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0), output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0), total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0) };
}

/**
 * Demo-video bugs (1-Nov): the model summary sometimes reads all-clear
 * ("nothing needs fixing", "ready") while an item is fail/needs_review, and
 * says "ready to post" although the draft still goes to the brand for
 * approval. The prompt (INSTRUCTIONS + schema) now forbids both, and this
 * guard enforces it deterministically: whenever ANY item is fail or
 * needs_review the summary is built in code from the items — the model's
 * words are never trusted in that case, no matter how honest they read —
 * and "ready to post" always becomes "can go to the brand".
 *
 * Door 1 (1-Nov): the earlier ALL_CLEAR_RE allow-list is gone. Matching a
 * fixed set of all-clear phrases meant any new phrasing ("Great work,
 * everything checks out", "You're good") sailed through untouched while an
 * item needed work. The rule is now unconditional: issues present → built
 * summary, no issues → the model's summary (with the post-phrase fix).
 */
export function sanitizeSummary(summary: string, items: Pick<CheckItem, "label" | "detail" | "verdict">[]): string {
  const raw = String(summary ?? "");
  const firstIssue = items.find((i) => i.verdict === "fail") ?? items.find((i) => i.verdict === "needs_review");
  if (!firstIssue) {
    if (!raw.trim()) return "Looks good — it can go to the brand.";
    return raw.replace(/ready to post/gi, "can go to the brand");
  }
  const tail = firstIssue.verdict === "fail" ? "Fix that and it can go to the brand." : "Give that a look, then it can go to the brand.";
  return `${firstIssue.label} — ${firstIssue.detail} ${tail}`;
}

/** Shape the web app already renders: { key: { pass, detail } }, plus the evidence it ignores. */
export function toDraftChecks(r: DraftCheckResult): Record<string, { pass: boolean; detail: string; label: string; verdict: Verdict; at_s: number | null; quote: string | null; sources: string[] }> {
  const out: Record<string, any> = {};
  for (const it of r.items) {
    out[it.key] = { pass: it.verdict === "pass", detail: it.verdict === "needs_review" ? `Check by eye: ${it.detail}` : it.detail, label: it.label, verdict: it.verdict, at_s: it.at_s, quote: it.quote, sources: it.sources };
  }
  return out;
}

/** The numbers a brand report shows for one checked video. */
export interface ReportNumbers {
  duration_s: number;
  /** Seconds the product is on screen: frames the object tracker found it in, over the sampling rate. Spark's from/to when SAM did not run. */
  product_s: number | null;
  product_share: number | null;
  product_first_s: number | null;
  /** First moment the brand is said or shown. */
  brand_first_s: number | null;
  brand_how: "said" | "shown" | null;
  disclosed: boolean | null;
  disclosure_how: string[];
  other_brands: string[];
}

export function reportNumbers(r: DraftCheckResult, brand: string): ReportNumbers {
  const item = (k: string) => r.items.find((i) => i.key === k);
  const product = item("product_on_screen");
  let productS: number | null = null;
  if (r.productBoxes.length && r.fps > 0) {
    productS = Math.min(r.durationS, new Set(r.productBoxes.map((b) => b.frame)).size / r.fps);
  } else if (product?.verdict === "pass" && product.at_s != null && product.until_s != null) {
    productS = Math.max(0, product.until_s - product.at_s);
  } else if (product?.verdict === "fail") productS = 0;
  const b = norm(brand);
  const brandHits = r.items
    .filter((i) => i.key.startsWith("must_say_") && i.verdict === "pass" && i.at_s != null && b && norm(i.label).includes(b))
    .sort((x, y) => x.at_s! - y.at_s!);
  const first = brandHits[0] ?? null;
  const disclosure = item("ad_disclosure");
  const how = disclosure?.verdict === "pass" ? disclosure.sources.map((s) => (s === "spark" ? "in the video" : s === "transcript" ? "said" : s)) : [];
  const others = item("other_brands");
  return {
    duration_s: Math.round(r.durationS * 10) / 10,
    product_s: productS == null ? null : Math.round(productS * 10) / 10,
    product_share: productS == null || !r.durationS ? null : Math.round((productS / r.durationS) * 100) / 100,
    product_first_s: product?.verdict !== "fail" ? (product?.at_s ?? null) : null,
    brand_first_s: first?.at_s ?? null,
    brand_how: first ? (first.detail.startsWith("Shown on screen") ? "shown" : "said") : null,
    disclosed: disclosure ? disclosure.verdict === "pass" : null,
    disclosure_how: Array.from(new Set(how)),
    other_brands: others ? others.detail.replace(/^Also (named|shown): /, "").replace(/\. Not on the brief's banned list\.$/, "").split(", ").filter(Boolean) : [],
  };
}

/** Report totals over the pieces Muse Spark checked. Null when none were. */
export function aiWatchSummary(watches: any[]) {
  const w = watches.filter(Boolean);
  if (!w.length) return null;
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const nums = (k: string) => w.map((x) => x[k]).filter((v) => typeof v === "number") as number[];
  return {
    pieces: w.length,
    product_s_avg: avg(nums("product_s")),
    product_share_avg: avg(nums("product_share").map((v) => v * 100)),
    brand_first_s_avg: avg(nums("brand_first_s")),
    brand_in_first_3s: nums("brand_first_s").filter((v) => v <= 3).length,
    disclosed: w.filter((x) => x.disclosed === true).length,
    from_live: w.filter((x) => x.source === "ai_meta_live").length,
    source: "ai_meta_draft",
  };
}
