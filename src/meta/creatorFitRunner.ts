/**
 * Creator fit, run by jobs/meta-creator-fit (28-Oct-2026).
 *
 * Two kinds of work, applications first because a brand is waiting on them:
 *  1. Fit: an application whose creator has a reel profile but no ai_fit (or a
 *     fit scored on an older version of the brief) gets scored against the
 *     campaign brief. One text call, about a cent.
 *  2. Profile: a creator with a working Instagram connection and no profile
 *     (or one older than 30 days) has their last 5 reels watched by Muse
 *     Spark. Creators with an open application go first.
 *
 * States, kept on the rows themselves:
 *  - creator_fit_profile.status: "ok" | "no_reels" (nothing to watch; tried
 *    again after 7 days) | "token_failed" (Instagram refused; tried again
 *    after 7 days, or as soon as the creator reconnects and the token changes
 *    its expiry).
 *  - campaign_application.ai_fit: written once per brief version.
 * Nothing here changes an application's status or messages anyone: it is
 * advice for the brand, shown next to the applicant.
 *
 * Off unless META_CREATOR_FIT_ENABLED=true. Shares the monthly Meta budget
 * with the draft check, and stops at META_CREATOR_FIT_PER_DAY profiles a day.
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CreateDBConnection } from "../../db/create-connection";
import { returnedRows } from "../../utils/dbResult";
import { fetchUserMedia } from "../../utils/instagram";
import logger from "../../utils/logger";
import { briefHash } from "./brief";
import { buildProfile, fitScore, flaggedEvidenceFromReels, profileReel, type FitBrief, type FlaggedEvidence, type ReelProfile } from "./creatorFit";
import { download, ffmpegBinary, logUsage, metaSpendThisMonth, tokenCost } from "./draftCheckQueue";

const truthy = (v: string | undefined) => String(v ?? "").toLowerCase() === "true" || String(v ?? "") === "1";
export const creatorFitEnabled = (): boolean => truthy(process.env.META_CREATOR_FIT_ENABLED) && !!process.env.META_MODEL_API_KEY;

const REELS_PER_CREATOR = 5;
const MODEL = "muse-spark-1.3";
const perDay = (): number => {
  const n = Number(process.env.META_CREATOR_FIT_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? n : 60;
};
export const monthlyBudgetUsd = (): number => {
  const n = Number(process.env.META_BUDGET_USD_MONTH);
  return Number.isFinite(n) && n >= 0 ? n : 100;
};

// ── Profile ──────────────────────────────────────────────────────────────────

/** Next creator to profile: working Instagram connection, no fresh profile; applicants first. */
export async function nextCreator(): Promise<{ id: number; token: string } | null> {
  const rows = returnedRows<{ id: number; ig_access_token: string }>(await CreateDBConnection.query(
    `SELECT i.id, i.ig_access_token
       FROM influencer i
      WHERE COALESCE(i.is_demo, false) = false
        AND i.ig_access_token IS NOT NULL AND i.instagram_user_id IS NOT NULL
        AND (i.ig_token_expires_at IS NULL OR i.ig_token_expires_at > NOW())
        AND (
              i.creator_fit_at IS NULL
           OR (i.creator_fit_profile->>'status' = 'ok' AND i.creator_fit_at < NOW() - INTERVAL '30 days')
           OR (i.creator_fit_profile->>'status' IN ('no_reels', 'token_failed') AND i.creator_fit_at < NOW() - INTERVAL '7 days')
        )
      ORDER BY EXISTS (SELECT 1 FROM campaign_application a WHERE a.creator_id = i.id AND a.applied_at > NOW() - INTERVAL '30 days') DESC,
               i.creator_fit_at ASC NULLS FIRST, i.id DESC
      LIMIT 1`,
  ));
  const r = rows[0];
  return r ? { id: Number(r.id), token: r.ig_access_token } : null;
}

async function saveProfile(creatorId: number, value: Record<string, unknown>) {
  await CreateDBConnection.query(
    `UPDATE influencer SET creator_fit_profile = $2::jsonb, creator_fit_at = NOW() WHERE id = $1::int`,
    [creatorId, JSON.stringify({ source: "ai_meta_reels", model: MODEL, generated_at: new Date().toISOString(), ...value })],
  );
}

export async function profileCreator(creatorId: number, token: string): Promise<"ok" | "no_reels" | "token_failed"> {
  const media = await fetchUserMedia(token, 25);
  if (!media.length) {
    // fetchUserMedia returns [] on any Instagram error, including a revoked token.
    await saveProfile(creatorId, { status: "token_failed" });
    return "token_failed";
  }
  const videos = media.filter((m) => m.media_type === "VIDEO" && m.media_url).slice(0, REELS_PER_CREATOR);
  if (!videos.length) {
    await saveProfile(creatorId, { status: "no_reels", media_seen: media.length });
    return "no_reels";
  }
  const dir = await mkdtemp(join(tmpdir(), "creatorfit-"));
  const reels: (ReelProfile & { media_id: string; permalink: string; timestamp: string | null })[] = [];
  let input = 0, output = 0;
  try {
    for (const [i, v] of videos.entries()) {
      try {
        const file = join(dir, `r${i}`);
        await download(v.media_url!, file); // fetched right after listing: Instagram CDN links expire
        const r = await profileReel({ path: file }, { ffmpeg: ffmpegBinary() });
        input += r.usage.input_tokens ?? 0;
        output += r.usage.output_tokens ?? 0;
        reels.push({ ...r.profile, media_id: v.id, permalink: v.permalink, timestamp: v.timestamp });
        await rm(file, { force: true });
      } catch (e: any) {
        logger.warn(`meta-creator-fit: creator ${creatorId} media ${v.id}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await logUsage("creator_profile", MODEL, { input_tokens: input, output_tokens: output, reels: reels.length }, tokenCost({ input_tokens: input, output_tokens: output }), creatorId);
  if (!reels.length) {
    await saveProfile(creatorId, { status: "no_reels", media_seen: media.length, reels_failed: videos.length });
    return "no_reels";
  }
  await saveProfile(creatorId, {
    status: "ok",
    source_media_ids: reels.map((r) => r.media_id),
    profile: buildProfile(reels),
    reels: reels.map(({ media_id, permalink, timestamp, niche, format, language, hook, hook_strength, production_quality, brands_shown, safety_flags, summary }) =>
      ({ media_id, permalink, timestamp, niche, format, language, hook, hook_strength, production_quality, brands_shown, safety_flags, summary })),
  });
  return "ok";
}

// ── Fit ──────────────────────────────────────────────────────────────────────

/** Campaign text as a FitBrief, plus the hash of that text. Shared with the "Creators for you" endpoint so there is one brief builder, not two. */
export async function fitBriefFor(campaignId: number): Promise<{ brief: FitBrief; hash: string } | null> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT c.name, c.offer_name, c.description_what_giving, c.description_what_doing, c.dos, c.donts, c.product_link,
            c.ai_brief_spec, b.name AS brand_name
       FROM campaign c LEFT JOIN brand b ON b.id = c.brand_id WHERE c.id = $1::int`,
    [campaignId],
  ));
  const c = rows[0];
  if (!c) return null;
  const hash = briefHash({ brand: c.brand_name || "the brand", campaign: c.name, offer: c.offer_name, whatGiving: c.description_what_giving, whatDoing: c.description_what_doing, dos: c.dos, donts: c.donts, productLink: c.product_link });
  return {
    hash,
    brief: {
      brand: c.brand_name || "the brand",
      campaign: c.name,
      product: c.offer_name || c.description_what_giving || undefined,
      whatDoing: c.description_what_doing,
      dos: c.dos,
      donts: c.donts,
      competitors: c.ai_brief_spec?.brief?.competitors ?? [],
    },
  };
}

/** Next application to score: creator has an "ok" profile, and no fit yet or one older than the creator's profile. */
export async function nextApplication(): Promise<{ id: number; campaign_id: number; profile: any; flagged: FlaggedEvidence; fit_hash: string | null } | null> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT a.id, a.campaign_id, i.creator_fit_profile->'profile' AS profile, i.creator_fit_profile->'reels' AS reels, a.ai_fit->>'brief_hash' AS fit_hash
       FROM campaign_application a
       JOIN influencer i ON i.id = a.creator_id
       JOIN campaign c ON c.id = a.campaign_id
      WHERE i.creator_fit_profile->>'status' = 'ok'
        AND COALESCE(c.is_demo, false) = false AND COALESCE(c.archived, false) = false
        AND a.applied_at > NOW() - INTERVAL '60 days'
        AND (a.ai_fit_at IS NULL OR a.ai_fit_at < i.creator_fit_at)
      ORDER BY a.applied_at DESC
      LIMIT 1`,
  ));
  const r = rows[0];
  return r ? { id: Number(r.id), campaign_id: Number(r.campaign_id), profile: r.profile, flagged: flaggedEvidenceFromReels(r.reels), fit_hash: r.fit_hash } : null;
}

export async function fitApplication(app: { id: number; campaign_id: number; profile: any; flagged: FlaggedEvidence }): Promise<void> {
  const b = await fitBriefFor(app.campaign_id);
  if (!b) return;
  // A flagged reel is never positive evidence: its content leaves the prompt,
  // only its flag stays (as a WITHHELD line the model may cite in risks).
  // `flagged` is REQUIRED (not optional): a future caller must consciously
  // pass evidence, never silently skip redaction.
  const r = await fitScore(app.profile, b.brief, { withheld: app.flagged });
  await logUsage("creator_fit", MODEL, { input_tokens: r.usage.input_tokens ?? 0, output_tokens: r.usage.output_tokens ?? 0 }, tokenCost(r.usage), app.id);
  await CreateDBConnection.query(
    `UPDATE campaign_application SET ai_fit = $2::jsonb, ai_fit_at = NOW() WHERE id = $1::int`,
    [app.id, JSON.stringify({ ...r.fit, brief_hash: b.hash, model: MODEL, source: "ai_meta_reels", generated_at: new Date().toISOString() })],
  );
  // Step 3: a fresh reel-fit moves ONE. Best-effort (flag-gated inside);
  // the nightly sweep catches whatever this misses.
  try {
    const { refreshOneScore } = await import("./oneScore");
    await refreshOneScore(app.id);
  } catch (e: any) {
    logger.warn(`meta-creator-fit: one-score refresh ${app.id}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

/** Re-score fits whose campaign brief text changed since they were scored. */
async function staleBriefFits(): Promise<number[]> {
  // Cheap check, at most 20 a tick: hashes are computed here, not in SQL.
  const rows = returnedRows<{ id: number; campaign_id: number; fit_hash: string }>(await CreateDBConnection.query(
    `SELECT a.id, a.campaign_id, a.ai_fit->>'brief_hash' AS fit_hash FROM campaign_application a
      WHERE a.ai_fit IS NOT NULL AND a.applied_at > NOW() - INTERVAL '60 days' ORDER BY a.ai_fit_at ASC LIMIT 20`,
  ));
  const stale: number[] = [];
  const hashes = new Map<number, string | null>();
  for (const r of rows) {
    if (!hashes.has(r.campaign_id)) hashes.set(r.campaign_id, (await fitBriefFor(r.campaign_id))?.hash ?? null);
    if (hashes.get(r.campaign_id) && hashes.get(r.campaign_id) !== r.fit_hash) stale.push(Number(r.id));
  }
  return stale;
}

async function profilesToday(): Promise<number> {
  const rows = returnedRows<{ n: string }>(await CreateDBConnection.query(
    `SELECT count(*) AS n FROM meta_usage_log WHERE feature = 'creator_profile' AND created_at >= date_trunc('day', NOW())`,
  ));
  return Number(rows[0]?.n ?? 0);
}

export async function drainCreatorFit(budgetMs: number): Promise<{ fits: number; profiles: Record<string, number>; stopped?: string }> {
  const tally = { fits: 0, profiles: {} as Record<string, number> } as { fits: number; profiles: Record<string, number>; stopped?: string };
  if (!creatorFitEnabled()) return { ...tally, stopped: "disabled" };
  const until = Date.now() + budgetMs;
  // A changed brief clears its fits so they are scored again below — and
  // clears ONE with them (the reelFit part is stale until the re-score).
  // Pending-only: a decided application's ONE is frozen history, and its
  // ai_fit_at is its record, not the job's to touch.
  const stale = await staleBriefFits();
  if (stale.length) await CreateDBConnection.query(
    `UPDATE campaign_application SET ai_fit_at = NULL, one_score = NULL, one_breakdown = NULL WHERE id = ANY($1::int[]) AND status = 'pending'`, [stale]);
  while (Date.now() < until) {
    if ((await metaSpendThisMonth()) >= monthlyBudgetUsd()) return { ...tally, stopped: "budget" };
    const app = await nextApplication();
    if (app) {
      try {
        await fitApplication(app);
        tally.fits += 1;
      } catch (e: any) {
        logger.warn(`meta-creator-fit: application ${app.id}: ${String(e?.message ?? e).slice(0, 200)}`);
        // Mark it tried so one bad row can't hold the queue; retried when the profile refreshes.
        await CreateDBConnection.query(`UPDATE campaign_application SET ai_fit_at = NOW() WHERE id = $1::int`, [app.id]);
      }
      continue;
    }
    if ((await profilesToday()) >= perDay()) return { ...tally, stopped: "daily_cap" };
    const c = await nextCreator();
    if (!c) break;
    const outcome = await profileCreator(c.id, c.token);
    tally.profiles[outcome] = (tally.profiles[outcome] ?? 0) + 1;
  }
  return tally;
}
