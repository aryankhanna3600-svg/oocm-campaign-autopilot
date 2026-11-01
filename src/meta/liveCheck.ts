/**
 * Live-post check (Meta models, 28-Oct-2026).
 *
 * A draft can pass and the post that goes live can still differ: the
 * disclosure cut, the brand line dropped, a different video altogether. Once a
 * piece has an Instagram post URL, this finds that post in the creator's OWN
 * media list (their Instagram connection; no scraping), downloads the video,
 * runs the same check as the draft with the real caption, and records what
 * changed against the checked draft.
 *
 * application_deliverable.ai_live_check, always { status, source:
 * "ai_meta_live", checked_at, ... }:
 *   done        items, report (reportNumbers), changes[], transcript_match
 *   not_found   the URL is not in the creator's recent media (retried)
 *   token_failed Instagram returned nothing for the token (retried)
 *   not_video   a photo or carousel; nothing to watch (final)
 *   failed      download or model error (retried)
 * Retries: every 6 hours, at most 4 tries. Advice only: no status changes.
 * Off unless META_LIVE_CHECK_ENABLED=true (and META_MODEL_API_KEY is set).
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CreateDBConnection } from "../../db/create-connection";
import { returnedRows } from "../../utils/dbResult";
import { fetchUserMedia } from "../../utils/instagram";
import logger from "../../utils/logger";
import { checkDraft, reportNumbers, type CheckItem } from "./draftCheck";
import { briefFor, costOf, download, ffmpegBinary, logUsage, metaSpendThisMonth } from "./draftCheckQueue";

const truthy = (v: string | undefined) => String(v ?? "").toLowerCase() === "true" || String(v ?? "") === "1";
export const liveCheckEnabled = (): boolean => truthy(process.env.META_LIVE_CHECK_ENABLED) && !!process.env.META_MODEL_API_KEY;
const monthlyBudgetUsd = (): number => {
  const n = Number(process.env.META_BUDGET_USD_MONTH);
  return Number.isFinite(n) && n >= 0 ? n : 100;
};
const MAX_ATTEMPTS = 4;

export const shortcodeOf = (url: string | null | undefined): string | null => {
  const m = String(url ?? "").match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
};

interface LivePiece {
  id: number;
  campaign_id: number;
  content_url: string;
  token: string;
  draft_result: Record<string, any> | null;
  ai_live_attempts: number;
}

/** Claim the next live Instagram piece to check (posted in the last 14 days, creator connected). */
export async function claimNextLive(): Promise<LivePiece | null> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `UPDATE application_deliverable d
        SET ai_live_check_at = NOW(), ai_live_attempts = d.ai_live_attempts + 1
      WHERE d.id = (
        SELECT d2.id FROM application_deliverable d2
          JOIN campaign_application a ON a.id = d2.application_id
          JOIN influencer i ON i.id = a.creator_id
         WHERE d2.content_status IN ('submitted', 'approved')
           AND d2.content_url ~* 'instagram\\.com/([^/]+/)?(p|reel|reels|tv)/'
           AND COALESCE(d2.live_at, d2.submitted_at) > NOW() - INTERVAL '14 days'
           AND COALESCE(i.is_demo, false) = false
           AND i.ig_access_token IS NOT NULL
           AND (i.ig_token_expires_at IS NULL OR i.ig_token_expires_at > NOW())
           AND (
                 d2.ai_live_check IS NULL AND d2.ai_live_check_at IS NULL
              OR (d2.ai_live_check->>'status' IN ('not_found', 'token_failed', 'failed')
                  AND d2.ai_live_check_at < NOW() - INTERVAL '6 hours' AND d2.ai_live_attempts < $1::int)
              OR (d2.ai_live_check IS NULL AND d2.ai_live_check_at < NOW() - INTERVAL '30 minutes' AND d2.ai_live_attempts < $1::int)
           )
         ORDER BY d2.ai_live_check_at ASC NULLS FIRST, d2.id ASC
         LIMIT 1
         FOR UPDATE OF d2 SKIP LOCKED)
      RETURNING d.id, d.application_id, d.content_url, d.ai_check_result AS draft_result, d.ai_live_attempts`,
    [MAX_ATTEMPTS],
  ));
  const r = rows[0];
  if (!r) return null;
  const [who] = returnedRows<any>(await CreateDBConnection.query(
    `SELECT a.campaign_id, i.ig_access_token FROM campaign_application a JOIN influencer i ON i.id = a.creator_id WHERE a.id = $1::int`,
    [r.application_id],
  ));
  return { id: Number(r.id), campaign_id: Number(who.campaign_id), content_url: r.content_url, token: who.ig_access_token, draft_result: r.draft_result ?? null, ai_live_attempts: Number(r.ai_live_attempts) };
}

async function save(id: number, check: Record<string, unknown>): Promise<void> {
  await CreateDBConnection.query(
    `UPDATE application_deliverable SET ai_live_check = $2::jsonb WHERE id = $1::int`,
    [id, JSON.stringify({ source: "ai_meta_live", checked_at: new Date().toISOString(), ...check })],
  );
}

const words = (s: string | null | undefined) => new Set(String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));

/** Share of the draft's spoken words also spoken in the live post, 0-1. Null when either has no speech. */
export function transcriptMatch(draft: string | null | undefined, live: string | null | undefined): number | null {
  const a = words(draft), b = words(live);
  if (a.size < 5 || b.size < 5) return null;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit += 1;
  return Math.round((hit / a.size) * 100) / 100;
}

/** What got worse (or better) between the checked draft and the live post, in plain sentences. */
export function changesFromDraft(draftItems: CheckItem[] | null | undefined, liveItems: CheckItem[], match: number | null): string[] {
  const out: string[] = [];
  if (match != null && match < 0.5) out.push(`The live post says something different from the draft (${Math.round(match * 100)}% of the draft's words are in it).`);
  if (!draftItems?.length) return out;
  const live = new Map(liveItems.map((i) => [i.key, i]));
  for (const d of draftItems) {
    const l = live.get(d.key);
    if (!l) continue;
    if (d.verdict === "pass" && l.verdict === "fail") out.push(`${d.label}: passed in the draft, missing in the live post.`);
    else if (d.verdict === "fail" && l.verdict === "pass") out.push(`${d.label}: fixed in the live post.`);
  }
  return out;
}

export async function runLive(p: LivePiece): Promise<string> {
  const code = shortcodeOf(p.content_url);
  const media = await fetchUserMedia(p.token, 50);
  if (!media.length) {
    await save(p.id, { status: "token_failed", attempts: p.ai_live_attempts });
    return "token_failed";
  }
  const hit = media.find((m) => shortcodeOf(m.permalink) === code);
  if (!hit) {
    await save(p.id, { status: "not_found", attempts: p.ai_live_attempts, media_seen: media.length });
    return "not_found";
  }
  if (hit.media_type !== "VIDEO" || !hit.media_url) {
    await save(p.id, { status: "not_video", media_id: hit.id, media_type: hit.media_type, permalink: hit.permalink });
    return "not_video";
  }
  const dir = await mkdtemp(join(tmpdir(), "livedl-"));
  try {
    const brief = await briefFor(p.campaign_id);
    const file = join(dir, "live");
    await download(hit.media_url, file);
    const r = await checkDraft({ path: file }, brief, { ffmpeg: ffmpegBinary(), caption: hit.caption });
    const cost = costOf(r);
    await logUsage("live_check", r.models.join("+"), {
      input_tokens: r.usage.spark.input_tokens ?? 0, output_tokens: r.usage.spark.output_tokens ?? 0,
      sam_frames: r.usage.samFrames, audio_s: r.usage.audioSeconds, video_s: r.durationS, ms: r.ms,
    }, cost, p.id);
    const match = transcriptMatch(p.draft_result?.transcript, r.transcript?.transcript);
    await save(p.id, {
      status: "done", media_id: hit.id, permalink: hit.permalink, posted_at: hit.timestamp,
      summary: r.summary, items: r.items, report: reportNumbers(r, brief.brand),
      changes: changesFromDraft(p.draft_result?.items, r.items, match),
      transcript_match: match, draft_checked: !!p.draft_result,
      models: r.models, cost_usd: Number(cost.toFixed(4)),
    });
    return "done";
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    logger.warn(`meta-live-check: piece ${p.id} attempt ${p.ai_live_attempts} failed: ${msg}`);
    await save(p.id, { status: "failed", attempts: p.ai_live_attempts, error: msg });
    return "failed";
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function drainLiveChecks(budgetMs: number): Promise<Record<string, number | string>> {
  const tally: Record<string, number | string> = {};
  if (!liveCheckEnabled()) return { stopped: "disabled" };
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if ((await metaSpendThisMonth()) >= monthlyBudgetUsd()) return { ...tally, stopped: "budget" };
    const p = await claimNextLive();
    if (!p) break;
    const outcome = await runLive(p);
    tally[outcome] = Number(tally[outcome] ?? 0) + 1;
  }
  return tally;
}
