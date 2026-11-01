/**
 * Step 3 (Meta hackathon, 31-Oct-2026): ONE deterministic fit score per
 * application. Fuses three 0–100 parts, renormalized over the parts whose
 * data exists (the Pulse precedent — a missing part is DROPPED, never
 * zero-filled):
 *
 *   ONE = 0.45·reelFit + 0.30·reachEngage + 0.25·pastDelivery
 *
 * - reelFit: ai_fit.score (brief-specific). While the fit job hasn't scored
 *   the reels yet, triage_score stands in, labelled "AI, from their profile".
 * - reachEngage: Pulse engagement math verbatim (capped ER term + reach ratio).
 * - pastDelivery: rating/5·60 + on-time·40 − strikes·30, clamped; null until
 *   the creator has engaged collabs (no history is unknown, not bad).
 *
 * No model calls, ever — pure arithmetic over rows. Recomputed by jobs only
 * (fitApplication after each score, the nightly auto-rank sweep for stale
 * rows), frozen once the application leaves pending. Off unless
 * META_ONE_SCORE_ENABLED=true (default off): when off nothing is written
 * and surfaces keep showing triage exactly as today.
 */
import { returnedRows } from "../../utils/dbResult";
import logger from "../../utils/logger";

// The DB connection is loaded LAZILY (inside the functions that query), so
// the pure core — computeOne, verdictFor, reachEngageOf, pastDeliveryOf —
// imports with zero env and unit-tests hermetically. (db/create-connection
// throws at import without DB_* set.)
const conn = async () => (await import("../../db/create-connection")).CreateDBConnection;

const truthy = (v: string | undefined) => String(v ?? "").toLowerCase() === "true" || String(v ?? "") === "1";
export const oneScoreEnabled = (): boolean => truthy(process.env.META_ONE_SCORE_ENABLED);

const W_REEL = 0.45;
const W_REACH = 0.30;
const W_DELIVERY = 0.25;

export type OneVerdict = "strong" | "good" | "weak" | "poor";
/** ONE bands (verified against the 20-row sample + 3119 fits, see STEP3-DESIGN). */
export const verdictFor = (score: number): OneVerdict =>
  score >= 70 ? "strong" : score >= 50 ? "good" : score >= 35 ? "weak" : "poor";

const clamp100 = (n: number): number => Math.max(0, Math.min(100, n));

/** Aryan's call (review, 31-Oct): when the reelFit part comes from scored
 * reels (not the triage fallback) and the reels said poor (score < 40), the
 * DISPLAYED verdict caps at "weak" — a capped reach part must not let a
 * reels-poor creator surface as "good". The number stays honest; only the
 * word is capped. */
export function capVerdictForReelsPoor(
  verdict: OneVerdict, reelSource: "reels" | "profile-fallback", reelFit: number | null,
): OneVerdict {
  if (reelSource === "reels" && reelFit != null && reelFit < 40 && (verdict === "strong" || verdict === "good")) {
    return "weak";
  }
  return verdict;
}

export interface OneParts { reelFit: number | null; reachEngage: number | null; pastDelivery: number | null }

/** Weighted mean over the parts that exist; null when none do. */
export function computeOne(parts: OneParts): { score: number; confidence: "high" | "medium" | "low" } | null {
  const entries: [number, number][] = [
    [W_REEL, parts.reelFit],
    [W_REACH, parts.reachEngage],
    [W_DELIVERY, parts.pastDelivery],
  ].filter((e): e is [number, number] => e[1] != null && Number.isFinite(e[1]));
  if (!entries.length) return null;
  const wSum = entries.reduce((a, [w]) => a + w, 0);
  const score = Math.round((entries.reduce((a, [w, v]) => a + w * v, 0) / wSum) * 10) / 10;
  return { score, confidence: entries.length >= 3 ? "high" : entries.length === 2 ? "medium" : "low" };
}

/** Pulse engagement math verbatim (creator.pulse.ts): capped ER term plus
 * reach ratio. Null without a synced engagement rate — reach alone is not
 * engagement. */
export function reachEngageOf(r: { avg_engagement_rate: unknown; reach_28d: unknown; ig_followers: unknown }): number | null {
  if (r.avg_engagement_rate == null) return null;
  const er = Number(r.avg_engagement_rate); // percent
  if (!Number.isFinite(er)) return null;
  const reachRatio =
    r.reach_28d != null && Number(r.ig_followers) > 0
      ? Number(r.reach_28d) / Number(r.ig_followers)
      : null;
  return clamp100(Math.min(70, er * 14) + (reachRatio != null ? Math.min(30, reachRatio * 20) : 15));
}

/** Rating/5·60 + on-time·40 − strikes·30. Null with no engaged collabs. A
 * missing rating or on-time rate inside real history reads neutral (half of
 * the term) rather than zero — unwitnessed is unknown, not bad. */
export function pastDeliveryOf(r: {
  engaged_collabs: unknown; avg_rating: unknown; on_time_rate: unknown; strike_count: unknown;
}): number | null {
  if (Number(r.engaged_collabs) <= 0) return null;
  const ratingTerm = r.avg_rating != null ? (Number(r.avg_rating) / 5) * 60 : 30;
  const onTimeTerm = r.on_time_rate != null ? Number(r.on_time_rate) * 40 : 20;
  return clamp100(ratingTerm + onTimeTerm - Number(r.strike_count ?? 0) * 30);
}

export interface OneInputs extends OneParts {
  reelSource: "reels" | "profile-fallback";
  stamps: Record<string, string | number | null>;
}

/** Everything computeOne needs for one application, plus the stamps the stale
 * sweep compares. One SQL round-trip; the brief hash comes from the shared
 * brief builder (lazy: this module alone never loads the meta chain). */
export async function inputsFor(applicationId: number): Promise<(OneInputs & { status: string; campaignLive: boolean }) | null> {
  const rows = returnedRows<any>(await (await conn()).query(
    `SELECT a.status, a.ai_fit, a.ai_fit_at, a.triage_score,
            c.approval_status = 'approved' AND c.status = true AND COALESCE(c.archived, false) = false
              AND c.completed_at IS NULL AND COALESCE(c.is_demo, false) = false AS live,
            i.avg_engagement_rate, i.reach_28d, i.ig_followers, i.insights_updated_at,
            i.creator_fit_at, i.strike_count,
            (SELECT COUNT(*) FROM campaign_application ca4
              WHERE ca4.creator_id = a.creator_id AND ca4.status IN ('active','completed')) AS engaged_collabs,
            (SELECT COUNT(*) FROM campaign_application ca1
              WHERE ca1.creator_id = a.creator_id AND ca1.status = 'completed') AS completed_collabs,
            (SELECT AVG(ca.rating) FROM campaign_application ca
              WHERE ca.creator_id = a.creator_id AND ca.rating IS NOT NULL) AS avg_rating,
            (SELECT COUNT(*) FILTER (WHERE ca5.submitted_at IS NOT NULL AND c5.timeline_end IS NOT NULL AND ca5.submitted_at <= c5.timeline_end)::float
                   / NULLIF(COUNT(*) FILTER (WHERE ca5.submitted_at IS NOT NULL AND c5.timeline_end IS NOT NULL), 0)
               FROM campaign_application ca5 JOIN campaign c5 ON c5.id = ca5.campaign_id
              WHERE ca5.creator_id = a.creator_id) AS on_time_rate,
            a.campaign_id
       FROM campaign_application a
       JOIN influencer i ON i.id = a.creator_id
       JOIN campaign c ON c.id = a.campaign_id
      WHERE a.id = $1::int`,
    [applicationId]));
  const r = rows[0];
  if (!r) return null;
  // Guards: ai/triage scores arrive as jsonb numerics or strings — NaN and
  // out-of-range values must never enter the fuse. Each part clamps to 0–100.
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? clamp100(n) : null;
  };
  const aiScore = num(r.ai_fit?.score);
  const reelFit = aiScore ?? num(r.triage_score);
  const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
  const engaged = Number(r.engaged_collabs);
  const { fitBriefFor } = await import("./creatorFitRunner");
  const briefHash = (await fitBriefFor(Number(r.campaign_id)))?.hash ?? null;
  return {
    status: String(r.status),
    campaignLive: !!r.live,
    reelFit,
    reelSource: aiScore != null ? "reels" : "profile-fallback",
    reachEngage: reachEngageOf(r),
    pastDelivery: pastDeliveryOf({ ...r, engaged_collabs: engaged }),
    stamps: {
      ai_fit_at: iso(r.ai_fit_at),
      creator_fit_at: iso(r.creator_fit_at),
      insights_at: iso(r.insights_updated_at),
      engaged, completed: Number(r.completed_collabs),
      avg_rating: r.avg_rating != null ? Number(r.avg_rating) : null,
      on_time: r.on_time_rate != null ? Number(r.on_time_rate) : null,
      triage: r.triage_score != null ? Number(r.triage_score) : null,
      brief_hash: briefHash,
    },
  };
}

export interface OneRefresh { score: number | null; verdict: OneVerdict | null; recomputed: boolean; skipped?: string }

/** Canonical stamp compare. Stored stamps round-trip through jsonb, which
 * reorders object keys — a raw JSON.stringify compare against the freshly
 * built stamps would ALWAYS read as drift and the sweep would rewrite every
 * row nightly. Sort keys on both sides instead. */
export function sameStamps(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    }
    return v ?? null;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Recompute ONE for one application. Pending-only (a decided application is
 * history), live-campaign-only, flag-gated. Always writes the breakdown
 * (stamps keep the sweep honest); the score stays NULL until a part exists. */
export async function refreshOneScore(applicationId: number): Promise<OneRefresh> {
  if (!oneScoreEnabled()) return { score: null, verdict: null, recomputed: false, skipped: "disabled" };
  const inp = await inputsFor(applicationId).catch(() => null);
  if (!inp) return { score: null, verdict: null, recomputed: false, skipped: "missing" };
  if (inp.status !== "pending") return { score: null, verdict: null, recomputed: false, skipped: "frozen" };
  if (!inp.campaignLive) return { score: null, verdict: null, recomputed: false, skipped: "not_live" };
  const out = computeOne(inp);
  const rawVerdict = out ? verdictFor(out.score) : null;
  const verdict = out && rawVerdict ? capVerdictForReelsPoor(rawVerdict, inp.reelSource, inp.reelFit) : null;
  const breakdown = {
    parts: {
      reelFit: inp.reelFit != null ? { value: inp.reelFit, source: inp.reelSource } : null,
      reachEngage: inp.reachEngage,
      pastDelivery: inp.pastDelivery,
    },
    weights_used: { reelFit: W_REEL, reachEngage: W_REACH, pastDelivery: W_DELIVERY },
    confidence: out?.confidence ?? null,
    verdict,
    stamps: inp.stamps,
    computed_at: new Date().toISOString(),
  };
  await (await conn()).query(
    `UPDATE campaign_application SET one_score = $2::int, one_breakdown = $3::jsonb WHERE id = $1::int`,
    [applicationId, out ? Math.round(out.score) : null, JSON.stringify(breakdown)]);
  return { score: out ? Math.round(out.score) : null, verdict, recomputed: true };
}

/** Nightly sweep: pending rows on live campaigns whose ONE is missing or
 * whose inputs moved since it was computed (re-profile, new rating, brief
 * edit, insights refresh — all visible as stamp drift). Bounded;
 * deterministic; no model. */
export async function refreshStaleOneScores(limit = 200): Promise<{ checked: number; recomputed: number }> {
  if (!oneScoreEnabled()) return { checked: 0, recomputed: 0 };
  const rows = returnedRows<{ id: number; one_score: number | null; one_breakdown: any }>(
    await (await conn()).query(
      `SELECT a.id, a.one_score, a.one_breakdown FROM campaign_application a JOIN campaign c ON c.id = a.campaign_id
        WHERE a.status = 'pending' AND a.applied_at > NOW() - INTERVAL '60 days'
          AND c.approval_status = 'approved' AND c.status = true
          AND COALESCE(c.archived, false) = false AND c.completed_at IS NULL
          AND COALESCE(c.is_demo, false) = false
        ORDER BY a.applied_at DESC LIMIT $1::int`,
      [limit]));
  let recomputed = 0;
  for (const r of rows) {
    try {
      // Only a missing breakdown counts as missing: a row whose inputs yield
      // no parts still gets its breakdown (with stamps) written, so it stops
      // recomputing until an input actually moves.
      if (r.one_breakdown == null) {
        if ((await refreshOneScore(Number(r.id))).recomputed) recomputed += 1;
        continue;
      }
      // Score exists: recompute only on stamp drift.
      const inp = await inputsFor(Number(r.id)).catch(() => null);
      if (!inp) continue;
      if (!sameStamps(inp.stamps, r.one_breakdown?.stamps) && (await refreshOneScore(Number(r.id))).recomputed) recomputed += 1;
    } catch (e: any) {
      logger.warn(`one-score: application ${r.id}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return { checked: rows.length, recomputed };
}
