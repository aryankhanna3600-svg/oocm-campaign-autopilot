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
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deleteFile, respond, segment, transcribe, uploadFile, type MetaUsage, type SamBox, type Transcript } from "../meta/client.ts";

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
}

// ── 1. prepare ─────────────────────────────────────────────────────────────

async function prepare(input: Uint8Array, o: CheckOptions) {
  const dir = await mkdtemp(join(tmpdir(), "draftcheck-"));
  const src = join(dir, "in");
  const mp4 = join(dir, "draft.mp4");
  const wav = join(dir, "audio.wav");
  await writeFile(src, input);
  const ff = o.ffmpeg ?? "ffmpeg";
  // Re-encode only when needed: SAM wants H.264/H.265 MP4, Spark wants MP4.
  // Cap at 10 minutes (Voice Transcribe and SAM limits) and 720p (cost).
  await run(ff, ["-loglevel", "error", "-y", "-i", src, "-t", "600", "-vf", "scale='min(720,iw)':-2", "-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", mp4], { maxBuffer: 1 << 26 });
  let hasAudio = true;
  try {
    await run(ff, ["-loglevel", "error", "-y", "-i", mp4, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1", wav]);
  } catch {
    hasAudio = false;
  }
  // Duration from ffmpeg's own banner (no ffprobe needed on servers).
  const probe = await run(ff, ["-hide_banner", "-i", mp4]).catch((e: any) => e);
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
          required: ["index", "line", "said", "at_s", "quote"],
          properties: { index: { type: "integer", description: "The line's number in the brief." }, line: { type: "string" }, said: { type: "boolean" }, at_s: { type: ["number", "null"] }, quote: { type: ["string", "null"] } },
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
        description: "Each do/don't from the brief that the video clearly breaks. Empty if none.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule", "at_s", "why"],
          properties: { rule: { type: "string" }, at_s: { type: ["number", "null"] }, why: { type: "string" } },
        },
      },
      summary: { type: "string", description: "Two plain sentences to the creator: what works, and the one thing to fix first." },
    },
  },
};

const INSTRUCTIONS = `You check a creator's draft video against a brand's brief before the brand sees it.
Answer only from what is actually seen and heard in the video. Never assume.
Give seconds from the start of the video for every piece of evidence.
A must-say line counts as said if the meaning is said, in any language; quote the words actually spoken.
An ad disclosure is "#ad", "ad", "advertisement", "paid partnership", "sponsored", or the same in Hindi (e.g. "विज्ञापन").
List a competitor only if it is named aloud or its brand is visibly shown.
Write the summary in plain, warm English to the creator.`;

function briefText(b: Brief): string {
  return [
    `Brand: ${b.brand}`,
    `Product: ${b.product}`,
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

export async function checkDraft(video: Uint8Array, brief: Brief, o: CheckOptions = {}): Promise<DraftCheckResult> {
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
          { type: "input_text", text: `THE BRIEF\n${briefText(brief)}\n\nCheck the video below against it.` },
          { type: "input_video", file_id: fileId },
        ],
        schema: SPARK_SCHEMA,
        effort: "medium",
        maxOutputTokens: 12000,
      }),
      prep.wav ? readFile(prep.wav).then((w) => transcribe(w, languages, briefKeywords(brief))).catch(() => null) : Promise.resolve(null),
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
        } catch {
          /* SAM is a second opinion; its failure never sinks the check */
        }
      })(),
      verifyHeard(said, brief.mustSay, o.model).catch(() => null),
    ]);

    if (process.env.DRAFTCHECK_DEBUG) console.error("HEARD", JSON.stringify(said), JSON.stringify(check ? [...check.lines] : null));
    const items: CheckItem[] = [];

    // Product on screen: Spark's claim, confirmed (or not) by SAM's tracking.
    {
      const sam = samSeconds(boxes, prep.fps);
      const sparkSays = !!s.product_on_screen?.shown;
      let verdict: Verdict;
      let sources = ["spark"];
      let detail: string;
      if (sparkSays && sam) {
        verdict = "pass";
        sources.push("sam");
        detail = `${brief.product} is on screen from ${sam.from.toFixed(1)}s to ${sam.to.toFixed(1)}s (tracked in ${sam.frames} frames).`;
      } else if (sparkSays && (o.noSam || !s.product_phrase)) {
        verdict = "pass";
        detail = `${brief.product} is on screen${fmt(s.product_on_screen.from_s)}: ${s.product_on_screen.how}`;
      } else if (sparkSays) {
        verdict = "needs_review";
        detail = `The video seems to show ${brief.product}${fmt(s.product_on_screen.from_s)}, but the object tracker could not find it. Please check by eye.`;
      } else if (sam) {
        verdict = "needs_review";
        sources = ["sam"];
        detail = `Something like ${brief.product} is tracked from ${sam.from.toFixed(1)}s, but it is not clearly the product. Please check by eye.`;
      } else {
        verdict = "fail";
        detail = `${brief.product} never appears on screen. Show it clearly, ideally in the first few seconds.`;
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
      let verdict: Verdict;
      let sources: string[];
      if (!heard) {
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
          ? `Said${fmt(m.at_s)}: "${quote}"`
          : verdict === "fail"
            ? `Not said: "${line}". Add it in your own words.`
            : `Not sure "${line}" is said${fmt(m.at_s)}: the two checks disagree. Please listen.`;
      items.push({ key: `must_say_${i + 1}`, label: `Says: ${line}`, verdict, detail, at_s: m.at_s ?? null, until_s: null, quote, sources, confidence: verdict === "needs_review" ? 0.5 : sources.length > 1 ? 0.9 : 0.7 });
    });

    // Must-show items (besides the product): Spark only, and only what the brief lists.
    (s.must_show ?? []).slice(0, brief.mustShow.length).forEach((m: any, i: number) => {
      items.push({ key: `must_show_${i + 1}`, label: `Shows: ${m.item}`, verdict: m.shown ? "pass" : "fail", detail: m.shown ? `Shown${fmt(m.at_s)}.` : `Not shown: ${m.item}.`, at_s: m.at_s ?? null, until_s: null, quote: null, sources: ["spark"], confidence: 0.7 });
    });

    // Ad disclosure: spoken claims are checked against the transcript.
    if (brief.disclosureRequired !== false) {
      const d = s.disclosure ?? {};
      const heardDisclosure = check?.disclosure ?? null;
      const spokenOk = !!heardDisclosure || (d.spoken && d.quote && said ? transcriptSupport(d.quote, said) >= 0.5 : false);
      if (heardDisclosure) d.quote = heardDisclosure;
      let verdict: Verdict;
      const sources = ["spark"];
      if (d.on_screen || spokenOk || (d.spoken && !heard)) {
        verdict = "pass";
        if (spokenOk) sources.push("transcript");
      } else if (d.spoken) verdict = "needs_review";
      else verdict = "fail";
      const how = [d.spoken ? "said" : "", d.on_screen ? "shown on screen" : ""].filter(Boolean).join(" and ");
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
      const hits = named.filter((c) => !listed.length || listed.some((l) => norm(c.name).includes(l) || l.includes(norm(c.name))));
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
    }

    // Brand rules the video breaks.
    (s.rules ?? []).forEach((r: any, i: number) => {
      items.push({ key: `rule_${i + 1}`, label: `Brief rule: ${r.rule}`, verdict: "fail", detail: `${r.why}${fmt(r.at_s)}.`, at_s: r.at_s ?? null, until_s: null, quote: null, sources: ["spark"], confidence: 0.65 });
    });

    // Language, when the brand asked for one.
    if (brief.language) {
      const ok = norm(s.language ?? "").includes(norm(brief.language));
      items.push({ key: "language", label: `In ${brief.language}`, verdict: ok ? "pass" : "fail", detail: ok ? `Spoken in ${s.language}.` : `Spoken in ${s.language}; the brief asks for ${brief.language}.`, at_s: null, until_s: null, quote: null, sources: ["spark"], confidence: 0.8 });
    }

    return {
      items,
      summary: String(s.summary ?? ""),
      durationS: prep.durationS,
      transcript: heard,
      productBoxes: boxes,
      fps: prep.fps,
      usage: { spark: spark.usage, samFrames, audioSeconds: heard ? Math.floor(heard.durationMs / 1000) : 0 },
      models: [spark.model, ...(heard ? ["muse-voice-transcribe-1.0"] : []), ...(samFrames ? ["sam-3.1"] : [])],
      ms: Date.now() - t0,
    };
  } finally {
    if (fileId) await deleteFile(fileId);
    await rm(prep.dir, { recursive: true, force: true });
  }
}

/** Shape the web app already renders: { key: { pass, detail } }, plus the evidence it ignores. */
export function toDraftChecks(r: DraftCheckResult): Record<string, { pass: boolean; detail: string; verdict: Verdict; at_s: number | null; quote: string | null; sources: string[] }> {
  const out: Record<string, any> = {};
  for (const it of r.items) {
    out[it.key] = { pass: it.verdict === "pass", detail: it.verdict === "needs_review" ? `Check by eye: ${it.detail}` : it.detail, verdict: it.verdict, at_s: it.at_s, quote: it.quote, sources: it.sources };
  }
  return out;
}
