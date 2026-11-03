/**
 * The video draft check, run by jobs/meta-draft-check (28-Oct-2026).
 *
 * Two lanes. Door 1 (creator-first, 30-Oct-2026): the creator submits, the
 * piece sits in `checking`, Muse checks it, the creator sees the fixes FIRST
 * (in-app row `ai_check_ready`), then taps "send to brand" or resubmits — and
 * every exit a check can take lands the draft with the brand anyway, so the
 * creator is never blocked. Lane 2 (base behavior): pieces already with the
 * brand (`draft_submitted`) are checked as advice, merged into draft_checks.
 *
 * No enqueue step. The worker claims checking pieces FIRST (a waiting creator
 * outranks brand-after), then submitted ones, when the current version has not
 * been checked — so the upload path, the link path and any later path are all
 * covered without touching the controllers.
 *
 * States of one check (application_deliverable.ai_check_status):
 *   running      claimed. A worker that dies leaves it; after 15 minutes it is
 *                claimed again, up to 3 attempts per version.
 *   done         result in ai_check_result; merged into draft_checks ONLY when
 *                the piece is already with the brand — on a `checking` piece
 *                the verdict is stored, never merged, until promoteToBrand.
 *   failed       ai_check_error says why. Retried after 10 minutes, 3 tries,
 *                then promoted anyway (auto:check_failed).
 *   unsupported  the draft is not a video we can fetch (Instagram or YouTube
 *                link, private Drive file, an image). On a `checking` piece the
 *                draft goes straight to the brand (auto:check_unsupported).
 * A new version from the creator supersedes all of these: version moves, the
 * piece is claimed again, and a stale result is never written over a newer
 * draft (every write is guarded on version).
 *
 * The check is advice to the brand and creator, never a verdict: nothing here
 * approves, rejects or notifies the brand — except promoteToBrand, the SINGLE
 * door through which a `checking` draft reaches the brand (creator tap or a
 * system auto-promote). Off unless META_DRAFT_CHECK_ENABLED=true, and it
 * stops for the month once META_BUDGET_USD_MONTH is spent.
 */
import os from "os";
import { createWriteStream, existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promises as dns } from "dns";
import net from "net";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { CreateDBConnection } from "../../db/create-connection";
import { returnedRows } from "../../utils/dbResult";
import { MAX_DRAFT_BYTES } from "../pieceUpload";
import { isMarker, parseMarker, signMarker } from "../../utils/privateFiles";
import { recomputeMirrors } from "../deliverables.service";
import logger from "../../utils/logger";
import { checkDraft, NotAVideo, reportNumbers, toDraftChecks, type Brief, type DraftCheckResult } from "./draftCheck";
import { briefFromText, briefHash, type BriefSource } from "./brief";

const truthy = (v: string | undefined) => String(v ?? "").toLowerCase() === "true" || String(v ?? "") === "1";

export const metaDraftCheckEnabled = (): boolean => truthy(process.env.META_DRAFT_CHECK_ENABLED) && !!process.env.META_MODEL_API_KEY;

/** Optional allow-list for the rollout: comma-separated campaign ids. Empty = every campaign. */
const campaignAllowList = (): number[] =>
  String(process.env.META_DRAFT_CHECK_CAMPAIGNS ?? "").split(",").map((s) => parseInt(s.trim())).filter((n) => Number.isFinite(n));

/**
 * Door-1 lane switch (review B1, 31-Oct-2026): creator-first checks run only
 * when this is on. Default OFF — deploying Door 1 must never change a live
 * campaign's next submit while the base flag is on for brand-after checks.
 */
export const creatorFirstOn = (): boolean => truthy(process.env.META_DRAFT_CHECK_CREATOR_FIRST);

/**
 * The creator-first lane's OWN allow-list (review B1): comma-separated
 * campaign ids, empty = every campaign. Never META_DRAFT_CHECK_CAMPAIGNS —
 * that one scopes brand-after checks, a different lane with different blast
 * radius.
 */
const creatorAllowList = (): number[] =>
  String(process.env.META_DRAFT_CHECK_CREATOR_CAMPAIGNS ?? "").split(",").map((s) => parseInt(s.trim())).filter((n) => Number.isFinite(n));

/**
 * Door-1 gate (30-Oct-2026, B1-hardened 31-Oct): should THIS campaign's
 * submits go through the creator-first check? Base flag + key + lane flag +
 * lane allow-list + monthly budget remaining. When false, both submit doors
 * run today's SQL and today's notify chain, byte-identical.
 */
export async function creatorCheckFor(campaignId: number): Promise<boolean> {
  if (!metaDraftCheckEnabled()) return false;
  if (!creatorFirstOn()) return false;
  const allow = creatorAllowList();
  if (allow.length > 0 && !allow.includes(Number(campaignId))) return false;
  if ((await metaSpendThisMonth().catch(() => 0)) >= monthlyBudgetUsd()) return false;
  return true;
}

// Stays under the $150 Meta hackathon credits by default.
export const monthlyBudgetUsd = (): number => {
  const n = Number(process.env.META_BUDGET_USD_MONTH);
  return Number.isFinite(n) && n >= 0 ? n : 100;
};

const MAX_ATTEMPTS = 3;
const WORKER_ID = `${os.hostname()}:${process.pid}`;

// Spend fns live in ./usage so the builder path can log without this module's chain.
export { metaSpendThisMonth, logUsage, tokenCost } from "./usage";
import { logUsage, metaSpendThisMonth, tokenCost, samCost, audioCost } from "./usage";

// ── Brief ────────────────────────────────────────────────────────────────────

/** The campaign's checkable brief, read by Spark once per brief version and cached on the campaign. */
export async function briefFor(campaignId: number): Promise<Brief> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT c.id, c.name, c.offer_name, c.description_what_giving, c.description_what_doing, c.dos, c.donts,
            c.product_link, c.ai_brief_spec, c.countries, c.compensation_type, b.name AS brand_name
       FROM campaign c LEFT JOIN brand b ON b.id = c.brand_id WHERE c.id = $1::int`,
    [campaignId],
  ));
  const c = rows[0];
  if (!c) throw new Error(`campaign ${campaignId} not found`);
  const src: BriefSource = {
    brand: c.brand_name || "the brand",
    campaign: c.name,
    offer: c.offer_name,
    whatGiving: c.description_what_giving,
    whatDoing: c.description_what_doing,
    dos: c.dos,
    donts: c.donts,
    productLink: c.product_link,
  };
  const hash = briefHash(src);
  if (c.ai_brief_spec?.hash === hash && c.ai_brief_spec?.brief) return { ...c.ai_brief_spec.brief, countries: c.countries, compensationType: c.compensation_type } as Brief;

  const r = await briefFromText(src);
  await logUsage("brief_spec", "muse-spark-1.3", { input_tokens: r.usage.input_tokens ?? 0, output_tokens: r.usage.output_tokens ?? 0 }, tokenCost(r.usage), campaignId);
  await CreateDBConnection.query(
    `UPDATE campaign SET ai_brief_spec = $2::jsonb WHERE id = $1::int`,
    [campaignId, JSON.stringify({ hash, brief: r.brief, checkable: r.checkable, at: new Date().toISOString() })],
  );
  return { ...r.brief, countries: c.countries, compensationType: c.compensation_type };
}

// ── Fetching the video ───────────────────────────────────────────────────────

class Unsupported extends Error {}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)(\?|#|$)/i;

/** Where to download the draft from, or why we can't. */
export function videoSource(draftFile: string | null, draftUrl: string | null): { url: string } | { unsupported: string } {
  const raw = draftFile || draftUrl;
  if (!raw) return { unsupported: "No draft file or link on the piece." };
  if (isMarker(raw)) {
    const url = signMarker(raw, 900);
    return url ? { url } : { unsupported: "The uploaded file could not be signed." };
  }
  let u: URL;
  try { u = new URL(raw); } catch { return { unsupported: "The draft link is not a web address." }; }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "drive.google.com" || host === "docs.google.com") {
    if (/\/folders\//.test(u.pathname)) return { unsupported: "The draft is a Drive folder; send one file." };
    const id = u.pathname.match(/\/file\/d\/([\w-]{10,})/)?.[1] ?? u.searchParams.get("id");
    if (!id) return { unsupported: "Couldn't read the Drive file id from the link." };
    return { url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t` };
  }
  if (/(^|\.)instagram\.com$|(^|\.)youtube\.com$|^youtu\.be$|(^|\.)tiktok\.com$/.test(host)) {
    return { unsupported: "Links to Instagram, YouTube or TikTok can't be downloaded for the video check." };
  }
  if (VIDEO_EXT.test(u.pathname)) return { url: u.toString() };
  return { unsupported: "The draft link is not a video file." };
}

/** Private, loopback, link-local (incl. the AWS metadata address) and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, "");
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

/** DNS for the address check. An object so tests can replace it. */
export const resolver = {
  lookup: async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true })).map((a) => a.address),
};

/** Throws unless the URL is https and every address it resolves to is public. */
async function assertPublicHttps(u: URL): Promise<void> {
  if (u.protocol !== "https:") throw new Unsupported("The draft link must be an https link.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : await resolver.lookup(host);
  if (!ips.length || ips.some(isPrivateAddress)) throw new Unsupported("The draft link doesn't point to a public website.");
}

/** Draft downloads stop here. Uploads allow MAX_DRAFT_BYTES (pieceUpload), so the
 * check reads the same limit — a draft the creator could send is a draft the
 * check can open. META_DRAFT_MAX_MB still overrides, in MB. */
export const maxBytes = (): number => {
  const mb = Number(process.env.META_DRAFT_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : MAX_DRAFT_BYTES / (1024 * 1024)) * 1024 * 1024;
};

/**
 * Stream the draft to a temp file (never held in memory), up to META_DRAFT_MAX_MB.
 * Redirects are followed by hand, at most 3, and every hop is checked to be a
 * public https address: draft links are typed by creators.
 */
export async function download(url: string, dest: string): Promise<void> {
  const cap = maxBytes();
  const tooBig = () => new Unsupported(`The video is over ${Math.round(cap / 1024 / 1024)} MB.`);
  let at = new URL(url);
  let res: Response | null = null;
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicHttps(at);
    res = await fetch(at, { redirect: "manual", signal: AbortSignal.timeout(180_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      at = new URL(res.headers.get("location")!, at);
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new Unsupported("The draft link redirects too many times.");
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  // Drive answers a private file with its sign-in page.
  if (/text\/html/i.test(type)) throw new Unsupported("The Drive file isn't shared with 'anyone with the link'.");
  if (/^image\//i.test(type)) throw new Unsupported("The draft is an image, not a video.");
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > cap) throw tooBig();
  if (!res.body) throw new Error("download: empty body");
  let total = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      cb(total > cap ? tooBig() : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(dest));
}

let ffmpegPath: string | null | undefined;
/** FFMPEG_BIN, else the ffmpeg-static binary (an optional dependency), else ffmpeg on PATH. */
export function ffmpegBinary(): string {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  if (ffmpegPath === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ffmpegPath = require("ffmpeg-static") as string | null;
    } catch {
      ffmpegPath = null;
    }
  }
  return ffmpegPath && existsSync(ffmpegPath) ? ffmpegPath : "ffmpeg";
}

// ── Claim, run, write ───────────────────────────────────────────────────────

interface Claimed {
  id: number;
  application_id: number;
  campaign_id: number;
  version: number;
  draft_status: string;
  draft_file: string | null;
  draft_url: string | null;
  draft_notes: string | null;
  ai_check_attempts: number;
}

/**
 * Claim the oldest piece in `status` whose current version has not been
 * checked. One statement, SKIP LOCKED.
 *
 * The `checking` lane additionally requires the world to still be intact —
 * app active, campaign live, creator not banned (a deleted creator drops out
 * of the inner join on its own) — and the piece unsettled (review M1: a brand
 * that waived or approved mid-check settled it; the queue never reaps settled
 * work, the B4 abandon path owns it). The lane is dead when the creator flag
 * is off (review B1): nothing is claimed, and the drain promotes everything
 * waiting instead.
 *
 * The `draft_submitted` lane keeps main's predicate EXACTLY (review Nice-2):
 * single-table, no joins, byte-identical when the creator lane is off.
 */
export async function claimIn(status: "checking" | "draft_submitted"): Promise<Claimed | null> {
  if (status === "checking") {
    if (!creatorFirstOn()) return null;
    const allow = creatorAllowList();
    const rows = returnedRows<Claimed>(await CreateDBConnection.query(
      `UPDATE application_deliverable d
          SET ai_check_status = 'running', ai_check_started_at = NOW(), ai_check_finished_at = NULL, ai_check_error = NULL,
              ai_check_attempts = CASE WHEN d.ai_check_version = d.version THEN d.ai_check_attempts + 1 ELSE 1 END,
              ai_check_version = d.version,
              ai_check_result = CASE WHEN d.ai_check_version IS DISTINCT FROM d.version THEN NULL ELSE d.ai_check_result END
        WHERE d.id = (
          SELECT d2.id FROM application_deliverable d2
            JOIN campaign_application a ON a.id = d2.application_id
            JOIN campaign c ON c.id = d2.campaign_id
            JOIN influencer i ON i.id = a.creator_id
           WHERE d2.draft_status = 'checking'
             AND d2.draft_submitted_at > NOW() - INTERVAL '3 days'
             AND COALESCE(d2.draft_file, d2.draft_url) IS NOT NULL
             AND (cardinality($1::int[]) = 0 OR d2.campaign_id = ANY($1::int[]))
             AND a.status = 'active' AND c.archived = false AND c.completed_at IS NULL AND c.auto_closed_at IS NULL
             AND i.apply_banned = false
             AND d2.content_status NOT IN ('waived', 'approved')
             AND (
                   d2.ai_check_version IS DISTINCT FROM d2.version
                OR (d2.ai_check_status = 'running' AND d2.ai_check_started_at < NOW() - INTERVAL '15 minutes' AND d2.ai_check_attempts < $2::int)
                OR (d2.ai_check_status = 'failed'  AND d2.ai_check_finished_at < NOW() - INTERVAL '10 minutes' AND d2.ai_check_attempts < $2::int)
             )
           ORDER BY d2.draft_submitted_at ASC LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.application_id, d.campaign_id, d.version, d.draft_status, d.draft_file, d.draft_url, d.draft_notes, d.ai_check_attempts`,
      [allow, MAX_ATTEMPTS],
    ));
    return rows[0] ?? null;
  }
  const allow = campaignAllowList();
  const rows = returnedRows<Claimed>(await CreateDBConnection.query(
    `UPDATE application_deliverable d
        SET ai_check_status = 'running', ai_check_started_at = NOW(), ai_check_finished_at = NULL, ai_check_error = NULL,
            ai_check_attempts = CASE WHEN d.ai_check_version = d.version THEN d.ai_check_attempts + 1 ELSE 1 END,
            ai_check_version = d.version
      WHERE d.id = (
        SELECT id FROM application_deliverable
         WHERE draft_status = 'draft_submitted'
           AND draft_submitted_at > NOW() - INTERVAL '3 days'
           AND COALESCE(draft_file, draft_url) IS NOT NULL
           AND (cardinality($1::int[]) = 0 OR campaign_id = ANY($1::int[]))
           AND (
                 ai_check_version IS DISTINCT FROM version
              OR (ai_check_status = 'running' AND ai_check_started_at < NOW() - INTERVAL '15 minutes' AND ai_check_attempts < $2::int)
              OR (ai_check_status = 'failed'  AND ai_check_finished_at < NOW() - INTERVAL '10 minutes' AND ai_check_attempts < $2::int)
           )
         ORDER BY draft_submitted_at ASC LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.application_id, d.campaign_id, d.version, d.draft_status, d.draft_file, d.draft_url, d.draft_notes, d.ai_check_attempts`,
    [allow, MAX_ATTEMPTS],
  ));
  return rows[0] ?? null;
}

/** Checking first: a waiting creator outranks brand-after. */
export async function claimNext(): Promise<Claimed | null> {
  return (await claimIn("checking")) ?? (await claimIn("draft_submitted"));
}

/** A check whose worker died on every attempt ends as failed, so nothing shows "running" forever. */
async function closeExhausted(): Promise<void> {
  await CreateDBConnection.query(
    `UPDATE application_deliverable
        SET ai_check_status = 'failed', ai_check_finished_at = NOW(),
            ai_check_error = COALESCE(ai_check_error, 'The check stopped without finishing, 3 times.')
      WHERE ai_check_status = 'running' AND ai_check_started_at < NOW() - INTERVAL '15 minutes' AND ai_check_attempts >= $1::int`,
    [MAX_ATTEMPTS],
  );
}

// Exported for the Door-1 pg suite (M5: a late finish must merge, not replace).
export async function finish(p: Claimed, status: "done" | "failed" | "unsupported", fields: { error?: string; result?: unknown; checks?: unknown }) {
  const rows = returnedRows<{ id: number; after_status: string; after_content: string }>(await CreateDBConnection.query(
    `UPDATE application_deliverable
        SET ai_check_status = $3::varchar, ai_check_finished_at = NOW(), ai_check_error = $4::text,
            ai_check_result = CASE WHEN $5::jsonb IS NULL THEN ai_check_result
                                   ELSE COALESCE(ai_check_result, '{}'::jsonb) || $5::jsonb END,
            draft_checks = CASE WHEN $6::jsonb IS NULL OR draft_status IS DISTINCT FROM 'draft_submitted' THEN draft_checks
                                ELSE COALESCE(draft_checks, '{}'::jsonb) || $6::jsonb END
      WHERE id = $1::int AND version = $2::int AND ai_check_version = $2::int
      RETURNING id, draft_status AS after_status, content_status AS after_content`,
    [p.id, p.version, status, fields.error ?? null,
     fields.result === undefined ? null : JSON.stringify(fields.result),
     fields.checks === undefined ? null : JSON.stringify(fields.checks)],
  ));
  if (!rows.length) {
    logger.info(`meta-draft-check: piece ${p.id} v${p.version} superseded by a newer draft; result dropped`);
    return;
  }
  if (fields.checks !== undefined) await recomputeMirrors(p.application_id).catch((e: any) => logger.warn(`recomputeMirrors ${p.application_id}: ${e?.message}`));
  // N1: a DONE verdict landed while the creator still holds the draft — tell
  // them first, in-app only (they're in-flow; WA would cost and risk
  // category). Reads after_status, not the claim: a promote that slipped in
  // between means the brand already has it, so no N1. Done ONLY (review M8):
  // unsupported/failed auto-promote straight to the brand, whose N2 note is
  // the creator's copy — an N1 first would double-notify, and a failed
  // attempt's N1 would fire on every retry. The merge above (review M5) keeps
  // a late finish from wiping the N3 nudge stamp or any other same-version
  // provenance: a failed finish (no result) touches nothing.
  // Review 2 Nice: a waive/approve that landed mid-check settled the piece —
  // the settle flow owns the copy, so a racing finish stays silent.
  if (rows[0].after_status === "checking" && status === "done"
      && rows[0].after_content !== "waived" && rows[0].after_content !== "approved") {
    await notifyCheckReady(p.id).catch((e: any) => logger.warn({ err: e?.message, pieceId: p.id }, "ai_check_ready notify failed"));
  }
}

/** N1 — "Your AI check is ready". In-app row on the creator; never WhatsApp. */
async function notifyCheckReady(pieceId: number): Promise<void> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT d.application_id, d.deliverable_type, d.ordinal, a.creator_id, i.name AS creator_name,
            c.name AS campaign_name, b.name AS brand_name
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id
       JOIN campaign c ON c.id = d.campaign_id
       LEFT JOIN brand b ON b.id = c.brand_id
       JOIN influencer i ON i.id = a.creator_id
      WHERE d.id = $1::int`,
    [pieceId],
  ));
  const r = rows[0];
  if (!r?.creator_id) return;
  const { createNotification } = await import("../../controllers/notification/notification.controller");
  await createNotification({
    user_id: Number(r.creator_id),
    recipient_role: "creator",
    type: "ai_check_ready",
    title: "Your AI check is ready",
    body: `Our check on your draft for "${r.campaign_name ?? "the campaign"}" is done — review the fixes, then send it to ${r.brand_name ?? "the brand"} or resubmit.`,
    ref_id: Number(r.application_id),
  });
}

export function costOf(r: DraftCheckResult): number {
  return tokenCost(r.usage.spark) + samCost(r.usage.samFrames) + audioCost(r.usage.audioSeconds);
}

// ── promoteToBrand: the SINGLE door to the brand (Door 1) ───────────────────
//
// A `checking` draft reaches the brand exactly one way: this function. Creator
// tap and every system auto-promote converge here, so the brand cannot tell
// Door 1 from a direct submit — same card, same WhatsApp, same in-app row,
// same 72h clock. Version-guarded: a resubmit between read and tap returns
// null (the tap handler turns it into a 409 "moved on").
//
// When the world moved on (review B4) the piece is ABANDONED, not refused:
// ai_check_result is stamped (abandoned_at/reason), the piece moves out of
// `checking` (draft columns kept, submitted clock cleared, check columns
// parked), and it never re-enters a sweep. A close or settle owns its own
// copy (cohort notice, verdict row) — Door 1 sends nothing extra there; a
// banned or blocking creator is told here, in plain words. The tap handler
// turns `abandoned` into a 400 with that same copy. Notify failures never
// undo the flip.

export type PromoteBy = "creator" | "system";

/** Dead-world refusals (review B4): the check is over, the draft never reaches the brand. */
export type AbandonReason =
  | "campaign_closed"   // app not active, or campaign dead — close's own cohort notice is the creator's copy; Door 1 sends nothing extra
  | "creator_banned"    // creator banned mid-check — plain-words row if they can still see it
  | "creator_gone"      // creator row gone — nobody to tell; ops warn log only
  | "settled_waived"    // brand/admin settled mid-check (review M1) — the settle flow owns the copy
  | "settled_approved"
  | "brand_blocked";    // creator blocked the brand mid-check (review Nice-6) — plain-words row

export interface PromoteOut { applicationId: number; version: number; abandoned?: AbandonReason }

/** Plain-words copy for a tap that lands on an abandoned check (review B4). */
export const abandonMessage = (reason: AbandonReason): string => {
  switch (reason) {
    case "campaign_closed": return "This campaign has closed, so your draft was kept but not sent to the brand.";
    case "creator_banned": return "Your draft was not sent — your account can't post new work right now. Message us in the OOCM chat and we'll sort it.";
    case "creator_gone": return "Your draft was not sent — we couldn't find your account. Message us and we'll sort it.";
    case "settled_waived": return "This piece was waived while the check was running — nothing is owed.";
    case "settled_approved": return "This piece was already approved — nothing more to send.";
    case "brand_blocked": return "You blocked this brand, so your draft was not sent. Unblock them from their page to send work here.";
  }
};

const PROMOTE_WORDS: Record<string, string> = {
  "creator:send_to_brand": "you sent it",
  "auto:check_unsupported": "the check couldn't open the video",
  "auto:check_failed": "the check didn't finish",
  "auto:check_unfinished_15m": "the check ran long",
  "auto:budget_paused": "the check is paused for this month",
  "auto:check_disabled": "the check is paused",
  "auto:creator_check_off": "the creator-first check is off",
  "auto:creator_no_action": "it waited a day after the check finished",
};

/**
 * B4: stamp the check abandoned and move the piece OUT of `checking` so no
 * sweep re-selects it. The draft columns stay (the moat + the creator's own
 * screen); draft_submitted_at is cleared — nothing was ever submitted to the
 * brand — and the check columns are parked (ai_check_version = version reads
 * as "this version is done with the machine"). Idempotent: a second call on
 * an already-moved piece stamps nothing and still reports the reason, so
 * every refusal path converges here.
 */
export async function abandonChecking(pieceId: number, version: number, reason: AbandonReason): Promise<PromoteOut | null> {
  const rows = returnedRows<{ application_id: number; creator_id: number }>(await CreateDBConnection.query(
    `UPDATE application_deliverable
        SET draft_status = 'not_submitted', draft_submitted_at = NULL, review_clock_at = NULL, reminded_at = NULL,
            ai_check_status = NULL, ai_check_version = version,
            ai_check_result = COALESCE(ai_check_result, '{}'::jsonb) || $3::jsonb
      WHERE id = $1::int AND version = $2::int AND draft_status = 'checking'
      RETURNING application_id,
              (SELECT creator_id FROM campaign_application WHERE id = application_deliverable.application_id) AS creator_id`,
    [pieceId, version, JSON.stringify({ abandoned_at: new Date().toISOString(), abandoned_reason: reason, abandoned_by: "system" })],
  ));
  const r = rows[0];
  if (!r) {
    // Already moved (a parallel sweep got here first, or a resubmit superseded
    // it): the piece is out of the machine either way — report, don't act.
    const app = returnedRows<{ application_id: number }>(await CreateDBConnection.query(
      `SELECT application_id FROM application_deliverable WHERE id = $1::int`, [pieceId]));
    if (!app[0]) return null;
    return { applicationId: Number(app[0].application_id), version, abandoned: reason };
  }
  const appId = Number(r.application_id);
  await recomputeMirrors(appId).catch((e: any) => logger.warn(`recomputeMirrors ${appId}: ${e?.message}`));
  // Who tells the creator: settled and closed worlds have their own copy (the
  // settle verdict, close's cohort notice) — Door 1 sends nothing extra. A
  // banned or blocking creator hears it here, in plain words.
  if ((reason === "creator_banned" || reason === "brand_blocked") && r.creator_id) {
    const { createNotification } = await import("../../controllers/notification/notification.controller");
    await createNotification({
      user_id: Number(r.creator_id),
      recipient_role: "creator",
      type: "draft_sent_to_brand",
      title: "Your draft was not sent",
      body: abandonMessage(reason),
      ref_id: appId,
    }).catch((e: any) => logger.warn({ err: e?.message, pieceId }, "abandon note failed"));
  }
  logger.warn({ pieceId, version, reason }, "meta-draft-check: checking piece abandoned");
  return { applicationId: appId, version, abandoned: reason };
}

async function readPieceWorld(pieceId: number) {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT d.id, d.application_id, d.campaign_id, d.version, d.draft_status, d.content_status,
            d.draft_url, d.draft_file, d.draft_notes,
            a.status AS app_status, a.creator_id,
            c.archived, c.completed_at, c.auto_closed_at, c.brand_id,
            i.apply_banned
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id
       JOIN campaign c ON c.id = d.campaign_id
       LEFT JOIN influencer i ON i.id = a.creator_id
      WHERE d.id = $1::int`,
    [pieceId],
  ));
  return rows[0] ?? null;
}

export async function promoteToBrand(pieceId: number, version: number, by: PromoteBy, reason: string): Promise<PromoteOut | null> {
  const r = await readPieceWorld(pieceId);
  // Race, not refusal: the piece moved (promoted, resubmitted, never checking)
  // — the caller turns this into "moved on".
  if (!r || Number(r.version) !== Number(version) || r.draft_status !== "checking") return null;
  // Review M1: settled mid-check is not promotable — and the flip below guards
  // the same predicate, so a settle landing between read and write abandons on
  // the next pass instead of leaking.
  if (r.content_status === "waived" || r.content_status === "approved") {
    return abandonChecking(pieceId, version, r.content_status === "waived" ? "settled_waived" : "settled_approved");
  }
  if (r.app_status !== "active" || r.archived || r.completed_at || r.auto_closed_at) {
    return abandonChecking(pieceId, version, "campaign_closed");
  }
  if (!r.creator_id) {
    return abandonChecking(pieceId, version, "creator_gone");
  }
  if (r.apply_banned) {
    logger.warn({ pieceId, reason }, "promoteToBrand refused: creator banned or gone");
    return abandonChecking(pieceId, version, "creator_banned");
  }
  // Review Nice-6 (verified real): the creator doors check "you blocked this
  // brand", the system lane did not — a block mid-check still delivered.
  const { isBrandBlocked } = await import("../brandBlock");
  if (await isBrandBlocked(Number(r.creator_id), Number(r.brand_id)).catch(() => false)) {
    return abandonChecking(pieceId, version, "brand_blocked");
  }
  const flipped = returnedRows<any>(await CreateDBConnection.query(
    `UPDATE application_deliverable
        SET draft_status = 'draft_submitted', review_clock_at = NOW(), reminded_at = NULL,
            draft_checks = CASE WHEN (ai_check_result->>'version')::int IS DISTINCT FROM version THEN COALESCE(draft_checks, '{}'::jsonb)
                                ELSE COALESCE(ai_check_result->'checks', '{}'::jsonb) || COALESCE(draft_checks, '{}'::jsonb) END,
            ai_check_result = COALESCE(ai_check_result, '{}'::jsonb) || $3::jsonb
      WHERE id = $1::int AND version = $2::int AND draft_status = 'checking'
        AND content_status NOT IN ('waived', 'approved')
      RETURNING id, application_id, version`,
    [pieceId, version, JSON.stringify({ promoted_by: by, promoted_at: new Date().toISOString(), promote_reason: reason })],
  ));
  if (!flipped.length) {
    // Lost the race between read and write (a settle, a resubmit, a parallel
    // sweep). Re-read once: a dead or settled world abandons, anything else is
    // a plain race.
    const fresh = await readPieceWorld(pieceId);
    if (!fresh || Number(fresh.version) !== Number(version) || fresh.draft_status !== "checking") return null;
    if (fresh.content_status === "waived" || fresh.content_status === "approved") {
      return abandonChecking(pieceId, version, fresh.content_status === "waived" ? "settled_waived" : "settled_approved");
    }
    if (fresh.app_status !== "active" || fresh.archived || fresh.completed_at || fresh.auto_closed_at || !fresh.creator_id || fresh.apply_banned) {
      return abandonChecking(pieceId, version, !fresh.creator_id ? "creator_gone" : "campaign_closed");
    }
    return null;
  }
  const appId = Number(flipped[0].application_id);
  await recomputeMirrors(appId).catch((e: any) => logger.warn(`recomputeMirrors ${appId}: ${e?.message}`));
  try {
    await sendBrandSurface(appId, pieceId);
  } catch (e: any) {
    logger.warn({ err: e?.message, pieceId }, "promoteToBrand: brand surface failed after the flip (flip stands)");
  }
  if (by === "system") {
    try {
      await sendSystemPromoteNote(appId, pieceId, reason);
    } catch (e: any) {
      logger.warn({ err: e?.message, pieceId }, "promoteToBrand: creator note failed");
    }
  }
  return { applicationId: appId, version };
}

/**
 * The full brand surface of a direct submit, replayed for a promoted draft:
 * B0 autopilot precheck record, B1 chat card, B2 WhatsApp UTILITY (inside
 * onDraftSent), B3 the explicit brand content_submitted in-app row. Dynamic
 * imports: this module is imported by jobs AND controllers, so no new static
 * edges into chat/autopilot/notification graphs.
 *
 * M4: the card's video comes from meta.file, not meta.link — so the file
 * object is re-derived from the stored draft_file marker (extension → mime /
 * kind, size from S3). A marker must never land in meta.link either: it is
 * not openable, so when draft_url IS the marker the link is nulled. M3: content_submitted is CAMPAIGN_SCOPED —
 * ref_id is the campaign id, or the brand's tap lands on campaign
 * #<applicationId>.
 */
async function sendBrandSurface(appId: number, pieceId: number): Promise<void> {
  const { CreateDBConnection: db } = await import("../../db/create-connection");
  const appRepo = db.getRepository((await import("../../entity/CampaignApplication")).CampaignApplication);
  const pieceRepo = db.getRepository((await import("../../entity/ApplicationDeliverable")).ApplicationDeliverable);
  const app: any = await appRepo.findOne({ where: { id: appId }, relations: ["campaign", "campaign.brand", "creator"] });
  if (!app) throw new Error(`application ${appId} gone`);
  const pieces: any[] = await pieceRepo.find({ where: { application_id: appId }, order: { id: "ASC" } });
  const piece: any = pieces.find((p: any) => p.id === pieceId);
  if (!piece) throw new Error(`piece ${pieceId} gone`);
  const { pieceLabel } = await import("../deliverables.service");
  const { onDraftSubmitted } = await import("../autopilot");
  const { onDraftSent } = await import("../chatReview.service");
  const { createNotification } = await import("../../controllers/notification/notification.controller");
  const label = pieceLabel(piece, pieces);
  const v = piece.version || 1;
  const campaignId = Number(app.campaign?.id);
  onDraftSubmitted(appId, Number(pieceId));
  // Review 2 Nice: keep the real check duration on the card instead of null —
  // the stored verdict carries duration_s from the run.
  const durationSec = Number((piece as any)?.ai_check_result?.duration_s);
  await onDraftSent({
    app, piece, pieces, creatorId: Number(app.creator?.id ?? app.creator_id),
    file: await fileFromMarkerWithSize(piece.draft_file),
    link: isMarker(piece.draft_url) ? null : (piece.draft_url ?? null),
    caption: piece.draft_notes ?? null, whatFixed: piece.draft_notes ?? null,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
  });
  await createNotification({
    user_id: Number(app.campaign?.brand?.id),
    recipient_role: "brand",
    type: "content_submitted",
    title: "Draft submitted for review",
    body: `${app.creator?.name ?? "A creator"} sent ${label} v${v} for ${app.campaign?.name ?? "your campaign"}. Review it in the chat.`,
    ref_id: campaignId,
  });
}

/**
 * Review Nice-7: what the CREATOR may see of a check result. The stored result
 * carries cost_usd, the full brief internals, the transcript, models and
 * timings — the creator's fix card needs the verdict (summary + items) and
 * the lifecycle stamps, nothing else. Pick-keep, so the next stored field
 * defaults to hidden. Version rides along so the UI gates on
 * result.version === piece.version (review M6).
 */
export function slimCheckForCreator(result: any): any | null {
  if (!result || typeof result !== "object") return null;
  const out: any = {};
  for (const k of ["version", "checked_at", "summary", "items", "nudge_sent_at",
    "promoted_by", "promoted_at", "promote_reason", "abandoned_at", "abandoned_reason"]) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  return out;
}

/** Same slim over a piece list, for creator payloads that embed raw pieces. */
export function slimPiecesForCreator(pieces: any[]): any[] {
  return (pieces ?? []).map((p: any) => {
    if (!p || typeof p !== "object" || !("ai_check_result" in p)) return p;
    return { ...p, ai_check_result: slimCheckForCreator((p as any).ai_check_result) };
  });
}

// ── ai_check on the chat's draft card (3-Nov-2026) ───────────────────────────
//
// The brand used to see the check result only on the campaign page; the chat
// card — where they actually decide — showed nothing. getMessages now reads
// the piece by deliverable_id and attaches this object on every kind='draft'
// message. Brand and creator see the SAME object.
//
// Version rule: a recorded outcome (done/failed/unsupported) belongs to exactly
// one draft version, so it is returned ONLY when ai_check_version equals that
// message's draft version (meta.version) — an old check never shows on a new
// version. The one exception is a version with NO outcome yet on a fresh draft
// (ai_check_version NULL, submitted within the claim window): nothing stale can
// show, and the check really is queued, so it reads `running`.
//
// Leak rule (same as the Door 1 brand-leak sanitize): the brand gets verdicts,
// never raw errors, abandon reasons or brand-blocked/banned copy. The `done`
// object is pick-keep; `why` is one of three fixed plain-words strings.

export interface ChatAiCheckItem {
  key: string | null;
  label: string | null;
  verdict: string | null;
  detail: string | null;
  at_s: number | null;
  quote: string | null;
}

export interface ChatAiCheck {
  state: "running" | "done" | "unchecked";
  checked_at?: string | null;
  summary?: string | null;
  items?: ChatAiCheckItem[];
  report?: {
    duration_s: number | null;
    product_s: number | null;
    product_share: number | null;
    brand_first_s: number | null;
    brand_how: string | null;
    disclosed: boolean | null;
    disclosure_how: string[] | null;
  } | null;
  transcript?: string | null;
  why?: string;
}

/** Plain words for people — the only strings that ever reach the brand here. */
function chatUncheckedWhy(piece: any): string {
  const err = String(piece?.ai_check_error ?? "");
  if (/over\s+\d+\s*MB|too big/i.test(err)) return "the video was too big for our check";
  if (piece?.ai_check_status === "unsupported") return "the check couldn't open the video";
  if (piece?.ai_check_status === "failed") return "the check didn't finish";
  return "sent before our check finished";
}

export function chatAiCheck(piece: any, draftVersion: number | null | undefined): ChatAiCheck | undefined {
  if (!piece || typeof piece !== "object") return undefined;
  if (draftVersion == null) return undefined;
  const recorded = piece.ai_check_version;
  if (recorded != null && Number(recorded) !== Number(draftVersion)) return undefined;
  if (piece.ai_check_status == null && piece.ai_check_version == null && piece.draft_status !== "checking") return undefined;
  const r = piece.ai_check_result;
  const result = r && typeof r === "object" ? r : null;
  if (piece.ai_check_status === "done" && result && (result as any).checked_at) {
    const rep = (result as any).report;
    return {
      state: "done",
      checked_at: (result as any).checked_at ?? null,
      summary: (result as any).summary ?? null,
      items: Array.isArray((result as any).items)
        ? (result as any).items.map((it: any) => ({
          key: it?.key ?? null,
          label: it?.label ?? null,
          verdict: it?.verdict ?? null,
          detail: it?.detail ?? null,
          at_s: it?.at_s ?? null,
          quote: it?.quote ?? null,
        }))
        : [],
      report: rep && typeof rep === "object"
        ? {
          duration_s: rep.duration_s ?? null,
          product_s: rep.product_s ?? null,
          product_share: rep.product_share ?? null,
          brand_first_s: rep.brand_first_s ?? null,
          brand_how: rep.brand_how ?? null,
          disclosed: rep.disclosed ?? null,
          disclosure_how: rep.disclosure_how ?? null,
        }
        : null,
      transcript: (result as any).transcript ?? null,
    };
  }
  if (piece.ai_check_status === "running" || piece.ai_check_status === "queued" || piece.draft_status === "checking") return { state: "running" };
  if (piece.ai_check_status === "unsupported" || piece.ai_check_status === "failed") return { state: "unchecked", why: chatUncheckedWhy(piece) };
  return undefined;
}

/**
 * Review M4: re-derive onDraftSent's file object from a stored marker. Extension
 * → mime, exactly the set presignUpload writes. Size comes from S3 (a chat
 * card stamped size 0 for a 190 MB upload hid the real file from the brand);
 * when the lookup fails it reads 0 — the card player needs marker + mime +
 * kind, and retention cleanup (chat-review-sweeps reads meta.file) needs the
 * marker. Null when the draft is a link, not an upload.
 */
const MARKER_MIME: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", "3gp": "video/3gpp",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
};

export function fileFromMarker(marker: string | null): { marker: string; size: number; mime: string; kind: "video" | "image" } | null {
  const p = parseMarker(marker);
  if (!p) return null;
  const ext = p.key.split(".").pop()?.toLowerCase() ?? "";
  const mime = MARKER_MIME[ext];
  if (!mime) return null;
  return { marker: marker as string, size: 0, mime, kind: mime.startsWith("video/") ? "video" : "image" };
}

/** fileFromMarker plus the stored size (0 when S3 can't be reached). */
export async function fileFromMarkerWithSize(marker: string | null): Promise<{ marker: string; size: number; mime: string; kind: "video" | "image" } | null> {
  const f = fileFromMarker(marker);
  if (!f) return null;
  const { markerFileSize } = await import("../pieceUpload");
  const size = await markerFileSize(marker).catch(() => null);
  return { ...f, size: size ?? 0 };
}

/** N2 — system promotes tell the creator in plain words (creator taps need no row). */
async function sendSystemPromoteNote(appId: number, pieceId: number, reason: string): Promise<void> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT a.creator_id, c.name AS campaign_name, b.name AS brand_name
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id
       JOIN campaign c ON c.id = d.campaign_id
       LEFT JOIN brand b ON b.id = c.brand_id
      WHERE d.id = $1::int`,
    [pieceId],
  ));
  const r = rows[0];
  if (!r?.creator_id) return;
  const { createNotification } = await import("../../controllers/notification/notification.controller");
  await createNotification({
    user_id: Number(r.creator_id),
    recipient_role: "creator",
    type: "draft_sent_to_brand",
    title: "Your draft went to the brand",
    body: `Your draft for "${r.campaign_name ?? "the campaign"}" went to ${r.brand_name ?? "the brand"} for review — ${PROMOTE_WORDS[reason] ?? reason}.`,
    ref_id: appId,
  });
}

// ── Sweeps: every exit lands with the brand ──────────────────────────────────
// All four converge on promoteToBrand (idempotent: a second call on a moved
// piece returns null), and all four count REAL promotes only — an abandon
// (B4: dead world, settled, blocked) is a resolution, not a delivery.

/**
 * No verdict 15 min after submit: the check ran long; promote, don't strand.
 * A DONE verdict on the current version is NOT stale (review B3): the piece
 * waits for the creator's tap (or the silent sweep below), and promoting it
 * here would send a finished check to the brand at 15 minutes with the false
 * reason "ran long".
 *
 * Door 1 (1-Nov, stuck piece): a FAILED check with attempts under 3 whose
 * world is dead never leaves `checking` otherwise — the claim skips dead
 * worlds (and drafts over 3 days old, and settled pieces), and
 * promoteFailedChecking needs 3 attempts. So the stale sweep also reaps a
 * failed piece whose world is dead (app not active, campaign archived /
 * completed / auto-closed, creator banned or gone, piece settled, or draft
 * over 3 days old so the claim will never touch it again). Each one goes
 * through promoteToBrand with the honest reason "the check didn't finish":
 * dead and settled worlds abandon there (B4), a merely-old draft with a live
 * world still reaches the brand. A failed piece in a LIVE world is NOT
 * stale — it is mid-retry (the claim reaps it after 10 min) or exhausts
 * into auto:check_failed.
 */
export async function promoteStaleChecking(): Promise<number> {
  const rows = returnedRows<{ id: number; version: number; failed: boolean }>(await CreateDBConnection.query(
    `SELECT d.id, d.version,
            (d.ai_check_status = 'failed') AS failed
       FROM application_deliverable d
       LEFT JOIN campaign_application a ON a.id = d.application_id
       LEFT JOIN campaign c ON c.id = d.campaign_id
       LEFT JOIN influencer i ON i.id = a.creator_id
      WHERE d.draft_status = 'checking'
        AND (
          -- the classic stale: no verdict 15 min after submit, not failed,
          -- no finished current-version verdict waiting for the tap.
          (d.ai_check_status IS DISTINCT FROM 'failed'
           AND d.draft_submitted_at < NOW() - INTERVAL '15 minutes'
           AND (d.ai_check_status IS DISTINCT FROM 'running' OR d.ai_check_started_at < NOW() - INTERVAL '15 minutes')
           AND NOT (d.ai_check_status = 'done'
                    AND (d.ai_check_result->>'version')::int = d.version
                    AND (d.ai_check_result->>'checked_at') IS NOT NULL))
          OR
          -- the stuck: failed, attempts left, but the world is dead — the
          -- claim will never reap it and promoteFailedChecking never fires.
          (d.ai_check_status = 'failed' AND COALESCE(d.ai_check_attempts, 0) < $1::int
           AND (a.status IS DISTINCT FROM 'active'
                OR c.archived OR c.completed_at IS NOT NULL OR c.auto_closed_at IS NOT NULL
                OR a.creator_id IS NULL OR COALESCE(i.apply_banned, false)
                OR d.content_status IN ('waived', 'approved')
                OR d.draft_submitted_at < NOW() - INTERVAL '3 days'))
        )`,
    [MAX_ATTEMPTS],
  ));
  let n = 0;
  for (const r of rows) {
    const reason = r.failed ? "auto:check_failed" : "auto:check_unfinished_15m";
    const out = await promoteToBrand(Number(r.id), Number(r.version), "system", reason).catch(() => null);
    if (out && !out.abandoned) n++;
  }
  return n;
}

/** 3 dead attempts: the check didn't finish; the brand still gets the draft. */
export async function promoteFailedChecking(): Promise<number> {
  const rows = returnedRows<{ id: number; version: number }>(await CreateDBConnection.query(
    `SELECT id, version FROM application_deliverable
      WHERE draft_status = 'checking' AND ai_check_status = 'failed' AND ai_check_attempts >= $1::int`,
    [MAX_ATTEMPTS],
  ));
  let n = 0;
  for (const r of rows) {
    const out = await promoteToBrand(Number(r.id), Number(r.version), "system", "auto:check_failed").catch(() => null);
    if (out && !out.abandoned) n++;
  }
  return n;
}

/** Budget spent / flag off mid-flight: everything waiting goes to the brand. */
export async function promoteAllChecking(reason: "auto:budget_paused" | "auto:check_disabled" | "auto:creator_check_off"): Promise<number> {
  const rows = returnedRows<{ id: number; version: number }>(await CreateDBConnection.query(
    `SELECT id, version FROM application_deliverable WHERE draft_status = 'checking'`,
  ));
  let n = 0;
  for (const r of rows) {
    const out = await promoteToBrand(Number(r.id), Number(r.version), "system", reason).catch(() => null);
    if (out && !out.abandoned) n++;
  }
  if (n) logger.warn(`meta-draft-check: promoted ${n} checking drafts (${reason})`);
  return n;
}

/**
 * The creator went quiet after the check finished. N3 at 2h (in-app only —
 * no approved UTILITY template fits a "your check is ready" nudge, and a new
 * template submission is NOT Door 1); auto-promote when the wait is over.
 *
 * The wait ends at the EARLIER of 24h after the verdict and the piece's own
 * due_at (review M10): for a same-night deadline the old "due within a day →
 * promote NOW" rule gave the creator about a minute. An already-passed due_at
 * promotes at once — the deadline is blown, the brand needs the draft now —
 * and the N3 copy always states the real send time, never "tomorrow".
 * One N3 per version, claimed in one statement.
 */
export async function sweepCreatorSilent(now = new Date()): Promise<{ nudged: number; promoted: number }> {
  const out = { nudged: 0, promoted: 0 };
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT d.id, d.version, d.due_at, d.application_id, d.ai_check_result,
            a.creator_id, a.status AS app_status, c.name AS campaign_name, b.name AS brand_name
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id
       JOIN campaign c ON c.id = d.campaign_id
       LEFT JOIN brand b ON b.id = c.brand_id
      WHERE d.draft_status = 'checking'
        AND (d.ai_check_result->>'checked_at') IS NOT NULL`,
  ));
  const { createNotification } = await import("../../controllers/notification/notification.controller");
  for (const r of rows) {
    const res = r.ai_check_result ?? {};
    if (Number(res.version) !== Number(r.version)) continue; // stale result, new version in flight
    // A wrap or removal ends the wait now; promoteToBrand parks the piece (1-Nov audit).
    if (r.app_status !== "active") {
      await promoteToBrand(Number(r.id), Number(r.version), "system", "auto:creator_no_action").catch(() => null);
      continue;
    }
    const checkedAt = new Date(String(res.checked_at)).getTime();
    if (!Number.isFinite(checkedAt)) continue;
    const dayAfter = checkedAt + 24 * 3_600_000;
    const dueAt = r.due_at ? new Date(r.due_at).getTime() : NaN;
    // Review 2 M-E: a past-due piece still gets 45 minutes with the verdict.
    // A resubmit after due_at used to auto-promote seconds after the check
    // finished — the creator never saw their fixes. Floor under the wait.
    const promoteAt = Math.max(
      Number.isFinite(dueAt) && dueAt < dayAfter ? dueAt : dayAfter,
      checkedAt + 45 * 60_000,
    );
    if (now.getTime() >= promoteAt) {
      const p = await promoteToBrand(Number(r.id), Number(r.version), "system", "auto:creator_no_action").catch(() => null);
      if (p && !p.abandoned) out.promoted++;
      continue;
    }
    if (now.getTime() - checkedAt >= 2 * 3_600_000 && !res.nudge_sent_at && r.creator_id) {
      const stamped = returnedRows<any>(await CreateDBConnection.query(
        `UPDATE application_deliverable
            SET ai_check_result = ai_check_result || $2::jsonb
          WHERE id = $1::int AND version = $3::int AND (ai_check_result->>'nudge_sent_at') IS NULL
          RETURNING id`,
        [r.id, JSON.stringify({ nudge_sent_at: now.toISOString() }), r.version],
      ));
      if (!stamped.length) continue;
      const sendDay = new Date(promoteAt).toDateString() === now.toDateString() ? "today" : "tomorrow";
      await createNotification({
        user_id: Number(r.creator_id),
        recipient_role: "creator",
        type: "ai_check_nudge",
        title: "Your AI check is ready",
        body: `Your check on "${r.campaign_name ?? "the campaign"}" finished — send it to ${r.brand_name ?? "the brand"} or fix & resubmit. It goes on its own ${sendDay}.`,
        ref_id: Number(r.application_id),
      }).catch(() => {});
      out.nudged++;
    }
  }
  return out;
}

export async function runOne(p: Claimed): Promise<string> {
  const src = videoSource(p.draft_file, p.draft_url);
  if ("unsupported" in src) {
    await finish(p, "unsupported", { error: src.unsupported });
    // Door 1: a checking draft the check can't open still reaches the brand.
    if (p.draft_status === "checking") {
      await promoteToBrand(p.id, p.version, "system", "auto:check_unsupported").catch((e: any) =>
        logger.warn({ err: e?.message, pieceId: p.id }, "auto-promote after unsupported failed"));
    }
    return "unsupported";
  }
  const dir = await mkdtemp(join(tmpdir(), "draftdl-"));
  try {
    const brief = await briefFor(p.campaign_id);
    const file = join(dir, "draft");
    await download(src.url, file);
    const r = await checkDraft({ path: file }, brief, { ffmpeg: ffmpegBinary(), caption: p.draft_notes });
    const cost = costOf(r);
    await logUsage("draft_check", r.models.join("+"), {
      input_tokens: r.usage.spark.input_tokens ?? 0, output_tokens: r.usage.spark.output_tokens ?? 0,
      sam_frames: r.usage.samFrames, audio_s: r.usage.audioSeconds, video_s: r.durationS, ms: r.ms,
    }, cost, p.id);
    const result = {
      version: p.version, checked_at: new Date().toISOString(), summary: r.summary, items: r.items,
      duration_s: r.durationS, models: r.models, ms: r.ms, cost_usd: Number(cost.toFixed(4)),
      transcript: r.transcript?.transcript ?? null, brief,
      report: reportNumbers(r, brief.brand),
      checks: toDraftChecks(r), // stored, never merged while checking — promoteToBrand merges on the way out
    };
    await finish(p, "done", { result, checks: toDraftChecks(r) });
    return "done";
  } catch (e: any) {
    if (e instanceof Unsupported || e instanceof NotAVideo) {
      await finish(p, "unsupported", { error: e.message });
      if (p.draft_status === "checking") {
        await promoteToBrand(p.id, p.version, "system", "auto:check_unsupported").catch((er: any) =>
          logger.warn({ err: er?.message, pieceId: p.id }, "auto-promote after unsupported failed"));
      }
      return "unsupported";
    }
    const msg = String(e?.message ?? e).slice(0, 500);
    logger.warn(`meta-draft-check: piece ${p.id} v${p.version} attempt ${p.ai_check_attempts} failed: ${msg}`);
    await finish(p, "failed", { error: msg });
    return "failed";
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** M11: every exit that lands a waiting draft with the brand, in one call — the
 * meta worker's drain AND the chat-review backstop both hang off this, so no
 * exit depends on one cron alone. Each sweep logs-and-continues internally. */
export async function sweepCheckingExits(now = new Date()): Promise<{ failed: number; stale: number; nudged: number; promoted: number }> {
  const failed = await promoteFailedChecking().catch((e: any) => { logger.warn({ err: e?.message }, "promoteFailedChecking failed"); return 0; });
  const stale = await promoteStaleChecking().catch((e: any) => { logger.warn({ err: e?.message }, "promoteStaleChecking failed"); return 0; });
  const silent = await sweepCreatorSilent(now).catch((e: any) => { logger.warn({ err: e?.message }, "sweepCreatorSilent failed"); return { nudged: 0, promoted: 0 }; });
  return { failed, stale, ...silent };
}

/** Work through the queue for up to budgetMs. One check at a time per process; they take about a minute each. */
export async function drainDraftChecks(budgetMs: number): Promise<{ done: number; failed: number; unsupported: number; stopped?: string }> {
  const tally = { done: 0, failed: 0, unsupported: 0 } as { done: number; failed: number; unsupported: number; stopped?: string };
  if (!metaDraftCheckEnabled()) {
    // Flag-off mid-checking never strands: everything waiting goes to the brand.
    await promoteAllChecking("auto:check_disabled").catch((e: any) => logger.warn({ err: e?.message }, "promoteAllChecking(disabled) failed"));
    return { ...tally, stopped: "disabled" };
  }
  if (!creatorFirstOn()) {
    // B1: the creator lane is off but brand-after runs — anything left waiting
    // from when it was on goes to the brand instead of stranding (claimIn
    // returns null with the lane off, so the loop below would never touch it).
    await promoteAllChecking("auto:creator_check_off").catch((e: any) => logger.warn({ err: e?.message }, "promoteAllChecking(creator-off) failed"));
  }
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const spent = await metaSpendThisMonth();
    if (spent >= monthlyBudgetUsd()) {
      logger.warn(`meta-draft-check: monthly budget reached ($${spent.toFixed(2)} of $${monthlyBudgetUsd()}); paused till next month`);
      await promoteAllChecking("auto:budget_paused").catch((e: any) => logger.warn({ err: e?.message }, "promoteAllChecking(budget) failed"));
      return { ...tally, stopped: "budget" };
    }
    await closeExhausted();
    await sweepCheckingExits();
    const p = await claimNext();
    if (!p) break;
    const outcome = await runOne(p);
    (tally as any)[outcome] += 1;
  }
  if (tally.done + tally.failed + tally.unsupported) logger.info(`meta-draft-check (${WORKER_ID}): ${JSON.stringify(tally)}`);
  return tally;
}
