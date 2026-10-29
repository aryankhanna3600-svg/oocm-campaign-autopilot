/**
 * Creator fit from reels: Muse Spark watches a creator's recent reels (picture
 * and sound together) and records what a brand would want to know before
 * picking them. Then it scores the creator against a campaign brief.
 *
 *   profileReel()     one reel  -> niche, format, language, on-camera style,
 *                      hook, production quality, brands shown, safety flags
 *   buildProfile()    many reels -> one creator profile (plain counting, no model)
 *   fitScore()        profile + brief -> 0-100 with reasons and risks
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 */
import { rm, readFile } from "node:fs/promises";
import { deleteFile, respond, uploadFile, type MetaUsage } from "../meta/client.ts";
import { prepare } from "../draftCheck/check.ts";

export const FORMATS = ["talking_head", "vlog", "tutorial", "review", "comparison", "skit", "montage", "dance", "unboxing", "other"] as const;

export interface ReelProfile {
  niche: string[];
  format: (typeof FORMATS)[number];
  language: string;
  face_on_camera: boolean;
  talks_to_camera: boolean;
  setting: string;
  hook: string;
  hook_strength: number;
  production_quality: number;
  energy: number;
  brands_shown: string[];
  product_integration: string;
  audience: string;
  safety_flags: string[];
  summary: string;
}

const REEL_SCHEMA = {
  name: "reel_profile",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["niche", "format", "language", "face_on_camera", "talks_to_camera", "setting", "hook", "hook_strength", "production_quality", "energy", "brands_shown", "product_integration", "audience", "safety_flags", "summary"],
    properties: {
      niche: { type: "array", maxItems: 3, items: { type: "string" }, description: "1-3 short niche tags, most specific first: 'coffee reviews', 'skincare', 'Delhi cafes', 'fitness', 'fashion hauls'." },
      format: { type: "string", enum: [...FORMATS] },
      language: { type: "string", description: "Spoken language(s), e.g. 'Hindi', 'English', 'Hinglish', or 'none (music only)'." },
      face_on_camera: { type: "boolean" },
      talks_to_camera: { type: "boolean" },
      setting: { type: "string", description: "Where it is shot, in 2-4 words: 'home bedroom', 'cafe', 'street', 'gym'." },
      hook: { type: "string", description: "What happens in the first 3 seconds to stop the scroll, in one short sentence." },
      hook_strength: { type: "integer", minimum: 1, maximum: 5 },
      production_quality: { type: "integer", minimum: 1, maximum: 5, description: "Lighting, framing, sound, editing. 3 = clean phone video." },
      energy: { type: "integer", minimum: 1, maximum: 5 },
      brands_shown: { type: "array", items: { type: "string" }, description: "Brands named or visibly shown." },
      product_integration: { type: "string", description: "How any product is worked in: 'none', 'natural use', 'held up to camera', 'comparison', 'hard sell'." },
      audience: { type: "string", description: "Who this content is for, in a few words: 'young women in metro India into cafes'." },
      safety_flags: { type: "array", items: { type: "string" }, description: "Anything a brand would worry about: profanity, alcohol, smoking, unsafe acts, misleading health claims. Empty if none." },
      summary: { type: "string", description: "One plain sentence describing the reel." },
    },
  },
};

const REEL_INSTRUCTIONS = `You watch a creator's reel, picture and sound, and describe it for a brand deciding whether to hire them.
Judge only what is in the video. Be specific and short. Scores are 1 to 5 where 3 is ordinary.`;

export async function profileReel(video: Uint8Array | { path: string }, o: { ffmpeg?: string; model?: string } = {}): Promise<{ profile: ReelProfile; usage: MetaUsage; durationS: number }> {
  const prep = await prepare(video, { ffmpeg: o.ffmpeg });
  let fileId: string | null = null;
  try {
    fileId = await uploadFile(await readFile(prep.mp4), "reel.mp4", "video/mp4", 3600);
    const r = await respond<ReelProfile>({
      model: o.model,
      instructions: REEL_INSTRUCTIONS,
      content: [{ type: "input_text", text: "Describe this reel." }, { type: "input_video", file_id: fileId }],
      schema: REEL_SCHEMA,
      maxOutputTokens: 6000,
      effort: "low",
    });
    return { profile: r.data, usage: r.usage, durationS: prep.durationS };
  } finally {
    if (fileId) await deleteFile(fileId);
    await rm(prep.dir, { recursive: true, force: true });
  }
}

export interface CreatorProfile {
  reels: number;
  niches: { tag: string; reels: number }[];
  formats: { format: string; reels: number }[];
  languages: string[];
  face_on_camera: number;
  talks_to_camera: number;
  hook_strength: number;
  production_quality: number;
  energy: number;
  brands_worked_with: string[];
  safety_flags: string[];
  audience: string[];
  summaries: string[];
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = x.trim().toLowerCase();
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

/** Many reels into one profile. Plain counting: no model call. */
export function buildProfile(reels: ReelProfile[]): CreatorProfile {
  return {
    reels: reels.length,
    niches: tally(reels.flatMap((r) => r.niche)).slice(0, 6).map(([tag, n]) => ({ tag, reels: n })),
    formats: tally(reels.map((r) => r.format)).map(([format, n]) => ({ format, reels: n })),
    languages: tally(reels.map((r) => r.language)).map(([l]) => l),
    face_on_camera: avg(reels.map((r) => (r.face_on_camera ? 1 : 0))),
    talks_to_camera: avg(reels.map((r) => (r.talks_to_camera ? 1 : 0))),
    hook_strength: avg(reels.map((r) => r.hook_strength)),
    production_quality: avg(reels.map((r) => r.production_quality)),
    energy: avg(reels.map((r) => r.energy)),
    brands_worked_with: tally(reels.flatMap((r) => r.brands_shown)).map(([b]) => b),
    safety_flags: tally(reels.flatMap((r) => r.safety_flags)).map(([f]) => f),
    audience: tally(reels.map((r) => r.audience)).slice(0, 3).map(([a]) => a),
    summaries: reels.map((r) => r.summary),
  };
}

export interface FitBrief {
  brand: string;
  campaign: string;
  product?: string;
  whatDoing?: string | null;
  dos?: string | null;
  donts?: string | null;
  audience?: string | null;
  competitors?: string[];
}

export interface FitResult {
  score: number;
  verdict: "strong" | "good" | "weak" | "poor";
  reasons: string[];
  risks: string[];
  pitch: string;
}

const FIT_SCHEMA = {
  name: "creator_fit",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["score", "verdict", "reasons", "risks", "pitch"],
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      verdict: { type: "string", enum: ["strong", "good", "weak", "poor"] },
      reasons: { type: "array", maxItems: 3, items: { type: "string" }, description: "Why they fit, each pointing at something seen in their reels." },
      risks: { type: "array", maxItems: 3, items: { type: "string" }, description: "What could go wrong for this brand: niche mismatch, competitor work, safety flags, weak hooks." },
      pitch: { type: "string", description: "One sentence: the reel idea this creator would make best for this brief." },
    },
  },
};

const FIT_INSTRUCTIONS = `You decide how well a creator fits a brand's campaign, from a profile built by watching their recent reels.
Score 0-100: 80+ strong, 60-79 good, 40-59 weak, under 40 poor.
Weigh niche and audience match most, then on-camera style and hook strength, then production quality.
Recent work for a competitor is a risk, not an automatic no. Never invent facts that are not in the profile.
Some reels were withheld for brand safety and appear only as a WITHHELD line naming their flag: never present a withheld reel as a positive, never describe its content, and draw every reason and the pitch only from the summaries shown in full. A withheld reel may still appear in risks.`;

/** What a flagged reel contributed, so the scorer can un-see it. Built by the
 * caller from the full reel array (the aggregated profile can't say which
 * summary came from which reel). */
export interface FlaggedEvidence {
  summaries: string[];
  brands: string[];
  flags: string[];
}

/**
 * Strip a flagged reel's citable content from the evidence the model sees:
 * its summaries leave `summaries`, its brands leave `brands_worked_with`.
 * Aggregate tallies (niches, formats) stay — a niche tag is not a reel
 * citation — and the flags themselves stay visible so the model can weigh
 * risk. Pure.
 */
export function withoutFlaggedEvidence(profile: CreatorProfile, flagged: FlaggedEvidence): CreatorProfile {
  const badS = new Set(flagged.summaries.map((s) => s.trim()).filter(Boolean));
  const badB = new Set(flagged.brands.map((b) => b.trim().toLowerCase()).filter(Boolean));
  return {
    ...profile,
    summaries: (profile.summaries ?? []).filter((s) => !badS.has(String(s).trim())),
    brands_worked_with: (profile.brands_worked_with ?? []).filter((b) => !badB.has(String(b).trim().toLowerCase())),
  };
}

/**
 * Collect what the flagged reels contributed, from the full reel array with
 * per-reel safety_flags (profiling output, not the aggregated profile). Pure.
 * No flagged reels → empty arrays, and fitScore behaves exactly as before.
 */
export function flaggedEvidenceFromReels(reels: any[]): FlaggedEvidence {
  const flagged = (Array.isArray(reels) ? reels : []).filter(
    (r) => Array.isArray(r?.safety_flags) && r.safety_flags.length > 0);
  return {
    summaries: flagged.map((r) => String(r.summary ?? "")).map((s) => s.trim()).filter(Boolean),
    brands: flagged.flatMap((r) => r?.brands_shown ?? []).map((b) => String(b).trim()).filter(Boolean),
    flags: flagged.flatMap((r) => r?.safety_flags ?? []).map((f) => String(f).trim()).filter(Boolean),
  };
}

export async function fitScore(profile: CreatorProfile, brief: FitBrief, o: { model?: string; withheld?: FlaggedEvidence } = {}): Promise<{ fit: FitResult; usage: MetaUsage }> {
  const shown = o.withheld ? withoutFlaggedEvidence(profile, o.withheld) : profile;
  const withheldLine = o.withheld && o.withheld.flags.length
    ? `WITHHELD for brand safety (${o.withheld.flags.length} reel${o.withheld.flags.length === 1 ? "" : "s"} shown to the model only as flags): ${[...new Set(o.withheld.flags)].join(", ")}`
    : "";
  const text = [
    "THE BRIEF",
    `Brand: ${brief.brand}`,
    `Campaign: ${brief.campaign}`,
    brief.product && `Product: ${brief.product}`,
    brief.whatDoing && `What the creator does: ${brief.whatDoing}`,
    brief.dos && `Do's: ${brief.dos}`,
    brief.donts && `Don'ts: ${brief.donts}`,
    brief.audience && `Audience: ${brief.audience}`,
    brief.competitors?.length ? `Competitors: ${brief.competitors.join(", ")}` : "",
    "",
    "THE CREATOR (from their reels)",
    JSON.stringify(shown),
    withheldLine,
  ].filter(Boolean).join("\n");
  const r = await respond<FitResult>({ model: o.model, instructions: FIT_INSTRUCTIONS, content: [{ type: "input_text", text }], schema: FIT_SCHEMA, maxOutputTokens: 3000, effort: "low" });
  return { fit: r.data, usage: r.usage };
}
