// Step 4 (30-Oct-2026): Pulse reads the reel profile + media-kit reels/pitch.
//
// Pure: no db, no model calls, no env except the flag helpers. Four jobs:
//
//   reelBlockForPrompt() — facts-only block for the Pulse narrator (hook
//     strength, format/language mix, production quality, brands shown, top
//     openers as the model described them). Flagged reels contribute ONLY
//     their flags — never hooks or summaries — the same un-seeing rule as
//     Step 2's withoutFlaggedEvidence.
//   pickKitReels() / kitPitch() — the public media kit's best-3-reels +
//     one-line pitch. Deterministic template, not a model: the kit is public,
//     must render fast, and must be testable without spend. The pitch is built
//     from CLEAN reels only and stays neutral — never a superlative the data
//     can't support, never a slight.
//   withTimeoutMs() / sparkAuditWithFallback() — the Spark narrator attempt:
//     25s cap, shared Meta budget gate, Haiku fallback. Deps-injected so unit
//     tests can fire the timeout and error paths without model keys.
//
// creator_fit_profile shape (written by creatorFitRunner): widened here with
// `| null` returns. Stored reel rows carry no thumbnails, so kit cards link
// out to the permalink — letting a brand open the work is the point.

import type { RespondResult } from "./client";

export const PULSE_SPARK_MODEL = "muse-spark-1.3";
export const PULSE_HAIKU_MODEL = "claude-haiku-4-5-20251001";

/** META_PULSE_REELS_ENABLED=true: Spark narrator + reel block. Default off. */
export const pulseReelsEnabled = (): boolean => {
  const v = String(process.env.META_PULSE_REELS_ENABLED ?? "").toLowerCase();
  return v === "true" || v === "1";
};

/** Review 30-Oct-2026 #1: the public kit pages have their own flag. Default off. */
export const kitReelsEnabled = (): boolean => {
  const v = String(process.env.META_KIT_REELS_ENABLED ?? "").toLowerCase();
  return v === "true" || v === "1";
};

/** Review 30-Oct-2026 #3: the Spark Pulse path shares the Meta monthly cap. */
export const pulseBudgetUsd = (): number => {
  const n = Number(process.env.META_BUDGET_USD_MONTH);
  return Number.isFinite(n) && n >= 0 ? n : 100;
};

export interface FitReelRow {
  media_id?: string;
  permalink?: string;
  timestamp?: string | null;
  niche?: string[];
  format?: string;
  language?: string;
  hook?: string;
  hook_strength?: number;
  production_quality?: number;
  brands_shown?: string[];
  safety_flags?: string[];
  summary?: string;
}

export interface KitReel {
  permalink: string;
  hook: string;
  format: string;
  language: string;
  hook_strength: number;
}

interface FitRoot {
  status?: string;
  profile?: {
    niches?: { tag: string; reels: number }[];
    formats?: { format: string; reels: number }[];
    languages?: string[];
    hook_strength?: number;
    production_quality?: number;
    brands_worked_with?: string[];
    safety_flags?: string[];
  };
  reels?: FitReelRow[];
}

const asRoot = (v: unknown): FitRoot | null => {
  let o: any = v;
  if (typeof o === "string") {
    try { o = JSON.parse(o); } catch { return null; }
  }
  if (!o || typeof o !== "object") return null;
  return o as FitRoot;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const cleanReels = (root: FitRoot | null): FitReelRow[] => {
  if (!root || root.status !== "ok" || !Array.isArray(root.reels)) return [];
  return root.reels.filter(
    (r) => !Array.isArray(r?.safety_flags) || r.safety_flags.length === 0
  );
};

/** Clean reels only, strongest hooks first. Exported for the narrator stamp. */
export const countCleanReels = (profileJson: unknown): number =>
  cleanReels(asRoot(profileJson)).length;

/**
 * Best reels for the public kit: never a reel with safety_flags, strongest
 * hooks first, production quality breaks ties. Reels without a permalink
 * can't be opened, so they can't be picked either.
 */
export function pickKitReels(profileJson: unknown, n = 3): KitReel[] {
  return cleanReels(asRoot(profileJson))
    .filter((r) => typeof r.permalink === "string" && r.permalink.length > 0)
    .sort((a, b) => {
      const dh = (num(b.hook_strength) ?? 0) - (num(a.hook_strength) ?? 0);
      if (dh !== 0) return dh;
      return (num(b.production_quality) ?? 0) - (num(a.production_quality) ?? 0);
    })
    .slice(0, Math.max(0, n))
    .map((r) => ({
      permalink: String(r.permalink),
      hook: String(r.hook ?? "").trim(),
      format: String(r.format ?? "video").trim(),
      language: String(r.language ?? "").trim(),
      hook_strength: num(r.hook_strength) ?? 0,
    }));
}

/** One-line kit pitch from the CLEAN reels only. Null when there is nothing
 * to stand behind: no usable profile, fewer than 3 clean reels, or no niche
 * tag on any clean reel (a language with no niche would read "<language>
 * creator reels" — true of everyone, useful to no one, so null instead).
 * The hook clause appears only when the clean-reel average exists and reaches
 * 3.5; below that the pitch simply doesn't brag. Never "up-and-coming" or any
 * other slight — the kit is a public page about a real person. */
export function kitPitch(profileJson: unknown): string | null {
  const root = asRoot(profileJson);
  if (!root || root.status !== "ok") return null;
  const clean = cleanReels(root);
  if (clean.length < 3) return null;
  const topTag = (vals: Array<string | null | undefined>): string | null => {
    const counts = new Map<string, number>();
    for (const v of vals) {
      const t = String(v ?? "").replace(/_/g, " ").trim();
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [k, n] of counts) {
      if (n > bestN) { best = k; bestN = n; }
    }
    return best;
  };
  const niche = topTag(clean.flatMap((r) => (Array.isArray(r.niche) ? r.niche : [])));
  if (!niche) return null;
  const format = topTag(clean.map((r) => r.format));
  const language = topTag(clean.map((r) => r.language));
  const hookVals = clean.map((r) => num(r.hook_strength)).filter((v): v is number => v != null);
  const hookAvg = hookVals.length ? hookVals.reduce((a, b) => a + b, 0) / hookVals.length : null;
  const hookClause =
    hookAvg != null && hookAvg >= 3.5 ? ` with ${hookAvg >= 4 ? "strong" : "solid"} 3-second hooks` : "";
  const line = `${language ? `${language} ` : ""}${niche} reels${format ? ` in ${format} format` : ""}${hookClause}`;
  return line.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Facts-only block for the narrator prompt. Openers are the model's own
 * descriptions of what it saw — never presented as the creator's words;
 * flagged reels appear only as a withheld count with flag names. Null when
 * there is no usable profile — the caller then sends today's prompt verbatim.
 * Second review 31-Oct (a): the profile aggregates (hook/production averages,
 * formats, languages, brands) are tallied over ALL reels, flagged ones
 * included — so they are recomputed here from the clean reels for the prompt.
 */
export function reelBlockForPrompt(profileJson: unknown): string | null {
  const root = asRoot(profileJson);
  if (!root || root.status !== "ok" || !Array.isArray(root.reels) || root.reels.length === 0) return null;
  const clean = cleanReels(root);
  const flagged = root.reels.length - clean.length;
  const agg = cleanAggregates(clean);
  const lines: string[] = [
    `Meta watched ${root.reels.length} recent reel${root.reels.length === 1 ? "" : "s"} (picture and sound, not self-reported).`,
  ];
  if (agg.hookAvg != null) lines.push(`Hook strength ${agg.hookAvg}/5 avg; production quality ${agg.prodAvg ?? "?"}/5.`);
  if (agg.formats.length) {
    lines.push(`Formats: ${agg.formats.slice(0, 4).map((f) => `${f.format.replace(/_/g, " ")} x${f.reels}`).join(", ")}.`);
  }
  if (agg.languages.length) lines.push(`Languages: ${agg.languages.slice(0, 3).join(", ")}.`);
  lines.push(`Brands shown: ${agg.brands.length ? agg.brands.slice(0, 5).join(", ") : "none"}.`);
  const hooks = clean
    .map((r) => String(r.hook ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (hooks.length) lines.push(`Strongest openers (as the model described them): ${hooks.map((h) => `"${h}"`).join(" ; ")}.`);
  if (flagged > 0) {
    const flags = [...new Set(root.reels.flatMap((r) => (Array.isArray(r?.safety_flags) ? r.safety_flags : [])).map((f) => String(f).trim()).filter(Boolean))];
    lines.push(
      `Withheld for brand safety: ${flagged} reel${flagged === 1 ? "" : "s"} judged on flags only${flags.length ? ` (${flags.join(", ")})` : ""} — never cite them as positives, never describe their content.`
    );
  }
  return lines.join("\n");
}

/** One-decimal average of the finite numbers, null when there are none. */
const avg1 = (vs: unknown[]): number | null => {
  const ns = vs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!ns.length) return null;
  return Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 10) / 10;
};

/** buildProfile tallies every reel, flagged included — the prompt must not
 * see flagged content even in aggregate, so these are tallied from clean
 * reels only. Shape mirrors CreatorProfile's aggregate fields. */
function cleanAggregates(clean: FitReelRow[]): {
  hookAvg: number | null; prodAvg: number | null;
  formats: { format: string; reels: number }[]; languages: string[]; brands: string[];
} {
  const counts = new Map<string, number>();
  for (const r of clean) {
    const f = String(r.format ?? "").trim();
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return {
    hookAvg: avg1(clean.map((r) => r.hook_strength)),
    prodAvg: avg1(clean.map((r) => r.production_quality)),
    formats: [...counts.entries()].map(([format, reels]) => ({ format, reels })),
    languages: [...new Set(clean.map((r) => String(r.language ?? "").trim()).filter(Boolean))],
    brands: [...new Set(
      clean.flatMap((r) => (Array.isArray(r.brands_shown) ? r.brands_shown : []))
        .map((b) => String(b).trim()).filter(Boolean)
    )],
  };
}

/** Audit JSON contract, shared by the Haiku and Spark paths. */
export const PULSE_AUDIT_SCHEMA = {  name: "pulse_audit",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "working", "not_working", "next_moves"],
    properties: {
      summary: { type: "string" },
      working: { type: "array", items: { type: "string" } },
      not_working: { type: "array", items: { type: "string" } },
      patterns: { type: "array", items: { type: "string" } },
      next_moves: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "why", "action"],
          properties: {
            label: { type: "string" },
            why: { type: "string" },
            action: {
              type: "string",
              enum: ["post_reel", "post", "rate_card", "apply", "complete_profile", "connect_ig", "verify_ig", "none"],
            },
          },
        },
      },
    },
  },
};

// ── Spark attempt: timeout + budget gate + Haiku fallback ───────────────────
// Review 30-Oct-2026 #3/#4. Deps-injected so tests fire the timeout, error and
// budget paths with stubs — no model keys needed.

/** The 25s race lost: the narrator falls back to Haiku, never fails the audit. */
export class SparkTimeoutError extends Error {
  constructor(ms: number) {
    super(`spark narrator timed out after ${ms}ms`);
    this.name = "SparkTimeoutError";
  }
}

/** Race a promise against ms. The timer is cleared on settle; unref'd so a hung model call can't hold the worker. */
export function withTimeoutMs<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SparkTimeoutError(ms)), ms);
    (timer as unknown as { unref?: () => void })?.unref?.();
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

export interface SparkAttempt {
  callSpark: (signal: AbortSignal) => Promise<RespondResult<Record<string, unknown>>>;
  runHaiku: () => Promise<Record<string, unknown> | null>;
  overBudget: () => Promise<boolean>;
  timeoutMs?: number;
  onSparkError?: (e: unknown) => void;
}

export type SparkOutcome =
  | { narrator: "spark"; result: RespondResult<Record<string, unknown>> }
  | { narrator: "haiku"; audit: Record<string, unknown> | null };

/** Over budget, timed out, or errored: Haiku narrates. A Spark success passes through untouched. */
export async function sparkAuditWithFallback(a: SparkAttempt): Promise<SparkOutcome> {
  if (await a.overBudget()) return { narrator: "haiku", audit: await a.runHaiku() };
  // Second review 31-Oct: the timeout ABORTS the Spark fetch (its signal
  // reaches fetch — client.ts never retries an abort), it doesn't just race
  // past it while Meta keeps billing. The race stays too: a stub (or a
  // client that ignores the signal) that never settles still falls back.
  const ms = a.timeoutMs ?? 25_000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  (timer as unknown as { unref?: () => void })?.unref?.();
  try {
    const result = await withTimeoutMs(a.callSpark(ctl.signal), ms);
    return { narrator: "spark", result };
  } catch (e) {
    a.onSparkError?.(e);
    return { narrator: "haiku", audit: await a.runHaiku() };
  } finally {
    clearTimeout(timer);
  }
}
