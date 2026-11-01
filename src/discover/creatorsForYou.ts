/**
 * "Creators for you" (Meta hackathon Step 2): rank creators who have a reel
 * profile but have NOT applied to the campaign, by fit against the brief.
 *
 * One scorer, not two: fitScore() from meta/creatorFit.ts (the same call the
 * applicant pipeline uses) and the brief builder from creatorFitRunner. The
 * audience pool reuses audienceWhere(), so targeting (platform/geo/tier)
 * and every exclusion (banned, brand-blocked, demo, any application row on
 * the campaign) match outreach exactly.
 *
 * Cache: creator_campaign_fit, one row per (campaign, creator). A row is
 * fresh while its brief_hash matches the campaign's current brief text and
 * its profile_at is at least as new as the creator's creator_fit_at. Fresh
 * rows serve on the request; anything missing is filled in the BACKGROUND
 * (kickFill, fire-and-forget, one run per campaign at a time) so a fresh
 * campaign never holds a GET open for 10 sequential Spark calls. The GET
 * returns cached rows plus `pending: n`; the web polls while pending > 0.
 *
 * Spark only scores. Nothing here changes an application's status, invites
 * anyone, or messages anyone: inviting stays on the existing invite path.
 *
 * Off unless META_CREATORS_FOR_YOU_ENABLED=true (default off). The meta
 * modules (creatorFit, creatorFitRunner, draftCheckQueue) are imported
 * LAZILY inside the functions that need them, so a flag-off caller — the
 * autopilot hot path — never loads them at all.
 */
import { CreateDBConnection } from "../db/create-connection";
import { returnedRows } from "../utils/dbResult";
import logger from "../utils/logger";
import { audienceIds } from "./campaignAudience";
import type { FlaggedEvidence } from "./meta/creatorFit"; // type-only: no runtime load, flag-off safe
import { distinctSafetyFlags } from "./meta/safetyFlags"; // pure strings: no runtime load, flag-off safe

const flagRaw = (): string => String(process.env.META_CREATORS_FOR_YOU_ENABLED ?? "").toLowerCase();
export const creatorsForYouEnabled = (): boolean => flagRaw() === "true" || flagRaw() === "1";

const MODEL = "muse-spark-1.3";
/** Pulse-shortlist pool: the SQL bounds the rows, the slice bounds the scoring. */
export const FIT_POOL = 40;
/** SQL-level bound on the audience rows pulled (they are category-filtered in TS after). */
export const FIT_POOL_SQL = 500;
export const TOP_N = 15;
/** Background fill: this many Spark calls at once, this long per kick. Unfinished work resumes on the next kick. */
export const FILL_CONCURRENCY = 3;
export const FILL_WALL_MS = 20_000;

export interface YouCreator {
  creator_id: number;
  name: string | null;
  instagram_username: string | null;
  followers: number | null;
  city: string | null;
  categories: unknown;
  fit: { score: number; verdict: string; reasons: string[]; pitch: string | null } | null;
  /** "AI saw: ..." from the profiled reels' safety_flags, or null when clean. */
  risk: string | null;
}

export interface FitRank { score: number; verdict: string }
/** A cached fit is fresh while the brief hash matches and the score is at
 * least as new as the profile it scored. The 1s tolerance is load-bearing:
 * creator_fit_at carries microsecond precision while a written profile_at
 * round-trips at milliseconds, so an exact >= would never see a just-written
 * row as fresh and the background fill would rescore it until the wall clock.
 * Re-profiling takes minutes, so a 1s grace never masks a real re-profile. */
const FRESH_PRED = (hashPh: string): string =>
  `f.brief_hash = ${hashPh}::varchar AND f.profile_at >= i.creator_fit_at - INTERVAL '1 second'`;
const goodVerdict = (v: string): boolean => v === "strong" || v === "good";

/**
 * Strong/good fits by score first, unscored creators in their incoming (Pulse)
 * order, weak/poor fits last. Pure. Unscored keep Pulse order via sort stability.
 */
export function reorderByFit(ids: number[], fits: Map<number, FitRank>): number[] {
  return [...ids].sort((a, b) => {
    const fa = fits.get(a);
    const fb = fits.get(b);
    const ca = !fa ? 1 : goodVerdict(fa.verdict) ? 0 : 2;
    const cb = !fb ? 1 : goodVerdict(fb.verdict) ? 0 : 2;
    if (ca !== cb) return ca - cb;
    if (fa && fb) return fb.score - fa.score;
    return 0;
  });
}

/** Fresh cached ranks for these creators: id -> { score, verdict }. No model calls, ever. */
export async function fitRankFor(campaignId: number, creatorIds: number[]): Promise<Map<number, FitRank>> {
  const out = new Map<number, FitRank>();
  if (!creatorIds.length) return out;
  const { fitBriefFor } = await import("./meta/creatorFitRunner");
  const hash = (await fitBriefFor(campaignId))?.hash ?? "";
  const rows = returnedRows<{ creator_id: number; score: number; verdict: string }>(await CreateDBConnection.query(
    `SELECT f.creator_id, f.score, f.verdict FROM creator_campaign_fit f
      JOIN influencer i ON i.id = f.creator_id
      WHERE f.campaign_id = $1::int AND f.creator_id = ANY($2::int[])
        AND ${FRESH_PRED("$3")}`,
    [campaignId, creatorIds, hash],
  ).catch(() => []));
  for (const r of rows) out.set(Number(r.creator_id), { score: Number(r.score), verdict: String(r.verdict) });
  return out;
}

/**
 * The autopilot seam. The caller checks the raw flag BEFORE dynamically
 * importing this module, so flag-off autopilot never loads the meta chain;
 * this function assumes the flag is on. Never scores — cache reads only.
 */
export async function applyFitRank(campaignId: number, ids: number[], take: number): Promise<{ ids: number[]; fitFirst: number }> {
  const fits = await fitRankFor(campaignId, ids).catch(() => new Map<number, FitRank>());
  if (!fits.size) return { ids: ids.slice(0, take), fitFirst: 0 };
  const ordered = reorderByFit(ids, fits).slice(0, Math.max(0, take));
  const fitFirst = ordered.filter((id) => { const f = fits.get(id); return !!f && goodVerdict(f.verdict); }).length;
  return { ids: ordered, fitFirst };
}

async function loadOwnedCampaign(campaignId: number, brandId: number): Promise<any | null> {
  const [c] = returnedRows<any>(await CreateDBConnection.query(
    `SELECT c.*, b.subscription_tier, b.paywall_overridden
       FROM campaign c JOIN brand b ON b.id = c.brand_id
      WHERE c.id = $1::int AND c.brand_id = $2::int`, [campaignId, brandId]).catch(() => []));
  return c ?? null;
}

/** Null when the campaign may show suggestions; otherwise the reason it may not (and no Spark spend happens). */
async function ineligibility(c: any): Promise<string | null> {
  if (c.approval_status !== "approved") return "not_approved";
  if (c.is_done || c.completed_at) return "done";
  if (c.archived) return "archived";
  if (c.is_demo) return "demo";
  const { applicationsClosed } = await import("./campaignInvites");
  if (applicationsClosed(c)) return "closed";
  const { isBrandLocked } = await import("../config/paywall");
  if (isBrandLocked({ subscription_tier: c.subscription_tier, paywall_overridden: c.paywall_overridden })) return "locked";
  return null;
}

export async function creatorsForYouEligible(campaignId: number, brandId: number): Promise<boolean> {
  const c = await loadOwnedCampaign(campaignId, brandId);
  return !!c && (await ineligibility(c).catch(() => "error")) === null;
}

interface PoolRow { id: number; profile: any; flagged: FlaggedEvidence; fit_at: string }

/** Candidates in Pulse order with their profiles, minus anyone already scored
 * fresh — and minus anyone whose scoring failed in the last 24h (negative
 * cache: a persistently bad profile must not burn a model call every kick). */
async function unscoredPool(campaignId: number, hash: string, limit: number): Promise<{ rows: PoolRow[]; poolSize: number }> {
  const full = await CreateDBConnection.query(`SELECT * FROM campaign WHERE id = $1::int`, [campaignId]).then((r: any[]) => r[0]);
  if (!full) return { rows: [], poolSize: 0 };
  const pool = (await audienceIds(full, { rank: "pulse", sqlLimit: FIT_POOL_SQL })).slice(0, FIT_POOL);
  if (!pool.length) return { rows: [], poolSize: 0 };
  const { flaggedEvidenceFromReels } = await import("./meta/creatorFit");
  const creators = returnedRows<any>(await CreateDBConnection.query(
    `SELECT i.id, i.creator_fit_profile, i.creator_fit_at,
            (${FRESH_PRED("$2")}) AS fresh,
            (fl.failed_at > NOW() - INTERVAL '24 hours') AS quarantined
       FROM influencer i LEFT JOIN creator_campaign_fit f
         ON f.campaign_id = $3::int AND f.creator_id = i.id
        LEFT JOIN creator_fit_failure fl
         ON fl.campaign_id = $3::int AND fl.creator_id = i.id
      WHERE i.id = ANY($1::int[]) AND i.creator_fit_profile->>'status' = 'ok'`,
    [pool, hash, campaignId]));
  const byId = new Map(creators.map((r: any) => [Number(r.id), r]));
  const ordered = pool.filter((id) => byId.has(id));
  // ISO, not String(date): Postgres rejects "Fri Oct 30 2026 ... GMT+0530" as timestamptz.
  const fitAt = (id: number): string => new Date(byId.get(id).creator_fit_at).toISOString();
  const rows = ordered.filter((id) => !byId.get(id).fresh && !byId.get(id).quarantined)
    .slice(0, Math.max(0, limit))
    .map((id) => {
      const full = byId.get(id).creator_fit_profile;
      return {
        id,
        profile: full.profile,
        // A flagged reel is never positive evidence: its content leaves the
        // prompt here, only its flag stays (applicant pipeline does the same).
        flagged: flaggedEvidenceFromReels(full?.reels),
        fit_at: fitAt(id),
      };
    });
  return { rows, poolSize: ordered.length };
}

// ── Background fill ──────────────────────────────────────────────────────────
// One run per campaign at a time: the in-process Set stops two tabs,
// StrictMode or a retry in THIS instance, and a Postgres advisory lock stops
// a second INSTANCE (two dynos, a deploy overlap). Idempotent upserts, so a
// second kick after the first finishes just finds nothing missing.

const filling = new Set<number>();
/** Test hook: is a fill running for this campaign right now. */
export const fillInFlight = (campaignId: number): boolean => filling.has(campaignId);

function kickFill(campaignId: number): void {
  if (filling.has(campaignId)) return;
  fillCreatorsForYou(campaignId)
    .catch((e: any) => logger.warn(`creators-for-you: fill ${campaignId}: ${String(e?.message ?? e).slice(0, 200)}`));
}

/** Score the campaign's unscored pool: concurrency-capped, wall-clock and budget bounded. Exported so tests can await it. */
export async function fillCreatorsForYou(campaignId: number, opts: { budgetMs?: number; concurrency?: number } = {}): Promise<{ scored: number; stopped?: string }> {
  if (filling.has(campaignId)) return { scored: 0, stopped: "inflight" };
  filling.add(campaignId);
  // Same lock idiom as the auto-approve sweep: a dedicated runner, because
  // advisory locks are session-level and the pool would split lock/unlock.
  const runner = CreateDBConnection.createQueryRunner();
  await runner.connect();
  let gotLock = false;
  try {
    const [row] = await runner.query(`SELECT pg_try_advisory_lock(hashtext($1::text)::bigint) AS ok`, [`creators-for-you-fill:${campaignId}`]);
    gotLock = !!row?.ok;
    if (!gotLock) return { scored: 0, stopped: "locked" };
    return await fillLocked(campaignId, opts);
  } finally {
    if (gotLock) await runner.query(`SELECT pg_advisory_unlock(hashtext($1::text)::bigint)`, [`creators-for-you-fill:${campaignId}`]).catch(() => {});
    await runner.release();
    filling.delete(campaignId);
  }
}

async function fillLocked(campaignId: number, opts: { budgetMs?: number; concurrency?: number }): Promise<{ scored: number; stopped?: string }> {
  const until = Date.now() + (opts.budgetMs ?? FILL_WALL_MS);
  const conc = Math.max(1, opts.concurrency ?? FILL_CONCURRENCY);
  const { fitBriefFor, monthlyBudgetUsd } = await import("./meta/creatorFitRunner");
  const { metaSpendThisMonth, logUsage, tokenCost } = await import("./meta/draftCheckQueue");
  const { fitScore } = await import("./meta/creatorFit");
  const b = await fitBriefFor(campaignId);
  if (!b) return { scored: 0, stopped: "no_brief" };
  let scored = 0;
  let dbDead = false;
  const scoreOne = async (row: PoolRow): Promise<"ok" | "model_error" | "db_error"> => {
    let r: Awaited<ReturnType<typeof fitScore>>;
    try {
      r = await fitScore(row.profile, b.brief, { withheld: row.flagged });
    } catch (e: any) {
      // One bad profile must not kill the batch — but it must not burn a
      // model call on every kick either: quarantine the creator for 24h.
      // (A sick DATABASE is different: db_error stops the kick, and the next
      // kick retries — our outage must never quarantine the creator.)
      logger.warn(`creators-for-you: campaign ${campaignId} creator ${row.id}: ${String(e?.message ?? e).slice(0, 200)}`);
      await CreateDBConnection.query(
        `INSERT INTO creator_fit_failure (campaign_id, creator_id, failed_at)
         VALUES ($1::int, $2::int, NOW())
         ON CONFLICT (campaign_id, creator_id) DO UPDATE SET failed_at = NOW()`,
        [campaignId, row.id]).catch(() => {});
      return "model_error";
    }
    try {
      // Cache first, then the spend log: usage is logged only for fits that stuck.
      await CreateDBConnection.query(
        `INSERT INTO creator_campaign_fit (campaign_id, creator_id, score, verdict, reasons, risks, pitch, brief_hash, profile_at, model, cost_usd, updated_at)
         VALUES ($1::int, $2::int, $3::int, $4::varchar, $5::jsonb, $6::jsonb, $7::text, $8::varchar, $9::timestamptz, $10::varchar, $11::numeric, NOW())
         ON CONFLICT (campaign_id, creator_id) DO UPDATE SET
           score = EXCLUDED.score, verdict = EXCLUDED.verdict, reasons = EXCLUDED.reasons, risks = EXCLUDED.risks,
           pitch = EXCLUDED.pitch, brief_hash = EXCLUDED.brief_hash, profile_at = EXCLUDED.profile_at,
           model = EXCLUDED.model, cost_usd = EXCLUDED.cost_usd, updated_at = NOW()`,
        [campaignId, row.id, Math.round(r.fit.score), r.fit.verdict, JSON.stringify(r.fit.reasons ?? []),
         JSON.stringify(r.fit.risks ?? []), r.fit.pitch ?? null, b.hash, row.fit_at, MODEL, tokenCost(r.usage).toFixed(6)]);
      await logUsage("creator_fit_you", MODEL,
        { input_tokens: r.usage.input_tokens ?? 0, output_tokens: r.usage.output_tokens ?? 0 },
        tokenCost(r.usage), row.id);
      // A score that stuck clears any earlier failure: a fixed profile retries now, not in 24h.
      await CreateDBConnection.query(
        `DELETE FROM creator_fit_failure WHERE campaign_id = $1::int AND creator_id = $2::int`,
        [campaignId, row.id]).catch(() => {});
      return "ok";
    } catch (e: any) {
      // The database is sick: stop burning model money, the next kick retries.
      logger.warn(`creators-for-you: campaign ${campaignId} write failed: ${String(e?.message ?? e).slice(0, 200)}`);
      return "db_error";
    }
  };
  while (Date.now() < until && !dbDead) {
    if ((await metaSpendThisMonth().catch(() => Infinity)) >= monthlyBudgetUsd()) return { scored, stopped: "budget" };
    const { rows } = await unscoredPool(campaignId, b.hash, conc * 4).catch(() => ({ rows: [] as PoolRow[], poolSize: 0 }));
    if (!rows.length) return { scored };
    for (let i = 0; i < rows.length && !dbDead && Date.now() < until; i += conc) {
      if ((await metaSpendThisMonth().catch(() => Infinity)) >= monthlyBudgetUsd()) return { scored, stopped: "budget" };
      const outcomes = await Promise.all(rows.slice(i, i + conc).map(scoreOne));
      scored += outcomes.filter((o) => o === "ok").length;
      if (outcomes.includes("db_error")) dbDead = true;
    }
  }
  return { scored, stopped: dbDead ? "db" : "time" };
}

export interface CreatorsForYouOut { creators: YouCreator[]; pending: number; cache: { cached: number } }

export async function getCreatorsForYou(campaignId: number, brandId: number): Promise<CreatorsForYouOut | null> {
  const c = await loadOwnedCampaign(campaignId, brandId);
  if (!c) return null;
  if (await ineligibility(c).catch(() => "error")) return { creators: [], pending: 0, cache: { cached: 0 } };
  const { fitBriefFor } = await import("./meta/creatorFitRunner");
  const b = await fitBriefFor(campaignId);
  if (!b) return { creators: [], pending: 0, cache: { cached: 0 } };

  const full = await CreateDBConnection.query(`SELECT * FROM campaign WHERE id = $1::int`, [campaignId]).then((r: any[]) => r[0]);
  const pool = (await audienceIds(full, { rank: "pulse", sqlLimit: FIT_POOL_SQL })).slice(0, FIT_POOL);
  if (!pool.length) return { creators: [], pending: 0, cache: { cached: 0 } };
  const creators = returnedRows<any>(await CreateDBConnection.query(
    `SELECT i.id, i.name, i.instagram_username, COALESCE(i.ig_followers, i.followers, 0) AS followers,
            i.city, i.content_categories, i.creator_fit_profile,
            f.score, f.verdict, f.reasons, f.pitch,
            (${FRESH_PRED("$2")}) AS fresh
       FROM influencer i LEFT JOIN creator_campaign_fit f
         ON f.campaign_id = $3::int AND f.creator_id = i.id
      WHERE i.id = ANY($1::int[]) AND i.creator_fit_profile->>'status' = 'ok'`,
    [pool, b.hash, campaignId]));
  const byId = new Map(creators.map((r: any) => [Number(r.id), r]));
  const ordered = pool.filter((id) => byId.has(id));
  const freshRows = ordered.filter((id) => byId.get(id).fresh);
  const missing = ordered.length - freshRows.length;
  if (missing > 0) kickFill(campaignId);

  const ranked = freshRows
    .sort((x, y) => Number(byId.get(y).score) - Number(byId.get(x).score))
    .slice(0, TOP_N);

  const out: YouCreator[] = ranked.map((id) => {
    const row = byId.get(id);
    const flags = distinctSafetyFlags(row.creator_fit_profile?.reels);
    return {
      creator_id: id,
      name: row.name ?? null,
      instagram_username: row.instagram_username ?? null,
      followers: row.followers != null ? Number(row.followers) : null,
      city: row.city ?? null,
      categories: row.content_categories ?? null,
      fit: { score: Number(row.score), verdict: String(row.verdict), reasons: (row.reasons ?? []).slice(0, 2), pitch: row.pitch ?? null },
      risk: flags.length ? `AI saw: ${flags.join(", ")}` : null,
    };
  });
  return { creators: out, pending: missing, cache: { cached: freshRows.length } };
}
