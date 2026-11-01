// Step 7 (31-Oct-2026) — the Campaign Autopilot agent.
//
// Once a day, per allow-listed campaign: read the live campaign, find what is
// stuck, say one plain next step with proof, and do the safe part itself.
//
// The loop (design §The loop):
//   1. Facts (code, no model). campaignFacts() builds a typed snapshot, each
//      fact with a stable id. Creator names never reach the model (Creator
//      1..n); demo/banned creators are excluded from drafts, safety, dues.
//   2. Diagnose (Muse Spark, JSON schema). Input = facts only. Output = one
//      diagnosis, one action from the closed list, confidence, fact ids used.
//      Truncation retries once at a higher cap; it is never a diagnosis.
//   3. Validate (code). Every cited id must exist; the action must be allowed
//      for this phase. Fails, or confidence < 0.6 → admin, nothing to a brand.
//   4. Act through the existing rails. The brand line is built HERE from
//      templates keyed on the action + fact numbers — the brand never sees
//      model text. Logged to autopilot_action (step `diagnose`) with input,
//      facts, output, evidence, confidence and cost.
//   5. Skip when nothing changed. Same facts hash as the last DONE run =
//      no model call, no message. Failed rows never silence the next day.
//
// The closed action list: none | tell_brand | show_backups | nudge_creators |
// flag_admin. Never reject, approve, pay, invite, post, close, or change a
// budget or deadline — those do not exist in the schema, so the model cannot
// pick them. Autopilot's rank/invite paths are untouched.
//
// Kill: META_CAMPAIGN_AGENT_ENABLED (default off) ANDed with the per-campaign
// allow-list META_CAMPAIGN_AGENT_CAMPAIGNS (empty = NONE, never all), plus the
// existing autopilot `switch` row turns it off for one campaign. This gate is
// independent of AUTOPILOT_ENABLED/autopilot_enabled: today those run on
// nothing (0 campaigns have the switch on), and this agent must not inherit
// that.
import { createHash } from "crypto";
import { CreateDBConnection } from "../../db/create-connection";
import { returnedRows } from "../../utils/dbResult";
import { campaignLiveness, type CampaignPhase } from "../campaignLiveness";
import { brandLastActive } from "../../config/paywall";
import { upsertActionItem } from "../actionItems";
import { createNotification } from "../../controllers/notification/notification.controller";
import { record as autopilotRecord } from "../autopilot";
import { respond } from "./client";
import { logUsage, metaSpendThisMonth, monthlyBudgetUsd, tokenCost } from "./draftCheckQueue";
import { distinctSafetyFlags } from "./safetyFlags";
import { isBrandBlocked } from "../brandBlock";
import { utilityReady } from "../wa/utilityReady";
import logger from "../../utils/logger";

const truthy = (v: string | undefined) => String(v ?? "").toLowerCase() === "true" || String(v ?? "") === "1";

// ── Gate ─────────────────────────────────────────────────────────────────────

/** Default off. Needs the model key too, so a mis-set flag without a key calls nothing. */
export const campaignAgentEnabled = (): boolean =>
  truthy(process.env.META_CAMPAIGN_AGENT_ENABLED) && !!process.env.META_MODEL_API_KEY;

/**
 * Per-campaign allow-list. Empty = NONE (never all): an unset list runs on
 * zero campaigns even with the flag on. This is deliberately NOT the
 * brand-after allow-list (Step-5 B1 lesson: scoping lists are not shared).
 */
export const campaignAgentAllowList = (): number[] =>
  String(process.env.META_CAMPAIGN_AGENT_CAMPAIGNS ?? "").split(",").map((s) => parseInt(s.trim())).filter((n) => Number.isFinite(n));

/** The existing switch row turns it off for one campaign (paused, or switch with enabled=false). */
async function switchedOff(campaignId: number): Promise<string | null> {
  const rows = returnedRows<{ step: string; input: any; reason: string | null }>(await CreateDBConnection.query(
    `SELECT step, input, reason FROM autopilot_action WHERE campaign_id = $1::int AND step IN ('switch','paused','resumed') ORDER BY created_at DESC, id DESC LIMIT 1`,
    [campaignId],
  ));
  const row = rows[0];
  if (!row) return null;
  if (row.step === "paused") return row.reason ?? "paused";
  if (row.step === "switch" && row.input && (row.input as any).enabled === false) return "switched off for this campaign";
  return null;
}

/** The one gate every run goes through. */
export async function campaignAgentFor(campaignId: number): Promise<{ ok: boolean; why: string }> {
  if (!campaignAgentEnabled()) return { ok: false, why: "META_CAMPAIGN_AGENT_ENABLED is off" };
  if (!campaignAgentAllowList().includes(Number(campaignId))) return { ok: false, why: "campaign is not on META_CAMPAIGN_AGENT_CAMPAIGNS" };
  const off = await switchedOff(campaignId).catch(() => null);
  if (off) return { ok: false, why: off };
  return { ok: true, why: "allow-listed" };
}

// ── Facts ────────────────────────────────────────────────────────────────────

export interface AgentFact { id: string; label: string; detail: string }
export interface WaitingDraft { piece_id: number; creator: string; hours: number }
export interface SilentPiece { piece_id: number; application_id: number; creator_id: number; creator: string; days_waiting: number; due_at: string | null }

export interface CampaignFacts {
  campaign_id: number;
  campaign_name: string;
  phase: CampaignPhase;
  facts: AgentFact[];
  applicants: Record<string, number>;
  wanted: number;
  waiting_drafts: WaitingDraft[];
  pieces_past_due: number;
  /** Past-due pieces whose draft is waiting on the brand (subset of pieces_past_due). */
  past_due_waiting: number;
  silent_pieces: SilentPiece[];
  overdue: boolean;
  /** Whole days until apply_by (negative = passed, null = no date set). */
  apply_days_left: number | null;
  /** Whether the apply window is still open (null = no date set). This is the
   *  hash-stable half of apply_days_left: the raw day count ticks every day
   *  and would defeat the hash-skip; the boolean flips exactly when the
   *  window crosses, which SHOULD trigger a fresh run. */
  apply_window_open: boolean | null;
  hash: string;
}

const FACT_IDS = ["phase", "applicants", "fit", "safety", "drafts_waiting", "pieces_past_due", "silent_creators", "brand_activity", "apply_by", "budget", "agent_history"] as const;

/** Canonical hash: counts and ids, never ages (review M-A). waiting hours,
 *  silent days_waiting and fact texts all tick daily — hashing them meant the
 *  skip never fired on any campaign with a stuck thing. agent_history is
 *  excluded on purpose (our own log tail would re-hash every run). The 48h
 *  overdue boundary still flips the hash through `overdue`. */
export const hashFacts = (facts: Omit<CampaignFacts, "hash">): string =>
  createHash("sha256").update(JSON.stringify({
    campaign_id: (facts as any).campaign_id,
    phase: (facts as any).phase,
    applicants: (facts as any).applicants,
    wanted: (facts as any).wanted,
    waiting: ((facts as any).waiting_drafts ?? []).map((w: any) => Number(w?.piece_id)).sort((a: number, b: number) => a - b),
    pastdue: Number((facts as any).pieces_past_due ?? 0),
    pastdue_waiting: Number((facts as any).past_due_waiting ?? 0),
    silent: ((facts as any).silent_pieces ?? []).map((s: any) => Number(s?.piece_id)).sort((a: number, b: number) => a - b),
    overdue: !!(facts as any).overdue,
    apply_window_open: (facts as any).apply_window_open ?? null,
  })).digest("hex").slice(0, 16);

const fact = (id: string, label: string, detail: string): AgentFact => ({ id, label, detail });

/** The full field set liveness needs: lock (tier/override), roster (is_done),
 *  dates in the campaign's own zone (deadline_tz). campaignFacts,
 *  latestBrandLine and the mid-run re-read all go through this — a Locked
 *  brand reads brand_paused here, never live (review R1). */
export async function loadLivenessInput(campaignId: number): Promise<{
  row: any;
  brand: { subscription_tier: string | null; paywall_overridden: boolean | null; last_seen_at: any; last_login: any };
}> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT c.id, c.name, c.status, c.archived, c.approval_status, c.apply_by, c.timeline_end, c.deadline_tz,
            c.is_done, c.completed_at, c.auto_closed_at, c.is_demo, c.brand_id, c.paused_notice_at, c.platform,
            c.number_of_influencers, c.budget,
            b.name AS brand_name, b.subscription_tier, b.paywall_overridden,
            b.last_seen_at AS brand_last_seen, b.last_login AS brand_last_login
       FROM campaign c LEFT JOIN brand b ON b.id = c.brand_id WHERE c.id = $1::int`,
    [campaignId],
  ));
  const row = rows[0];
  if (!row) throw new Error(`campaign ${campaignId} not found`);
  return {
    row,
    brand: {
      subscription_tier: row.subscription_tier ?? null,
      paywall_overridden: row.paywall_overridden ?? null,
      last_seen_at: row.brand_last_seen, last_login: row.brand_last_login,
    },
  };
}

/** Step 1 of the loop: code only, no model. Every claim carries a stable id. */
export async function campaignFacts(campaignId: number): Promise<CampaignFacts> {
  const { row: c, brand } = await loadLivenessInput(campaignId);
  const phase = campaignLiveness(c as any, brand as any).phase;
  const name = String(c.name ?? `campaign ${campaignId}`);

  // Applicant counts exclude demo and banned creators (review R8): fixtures
  // are not a funnel.
  const DEMO = `COALESCE(i.is_demo, false) = false AND COALESCE(i.apply_banned, false) = false AND i.banned_at IS NULL`;
  const appRows = returnedRows<{ status: string; n: string }>(await CreateDBConnection.query(
    `SELECT a.status, COUNT(*)::int AS n FROM campaign_application a JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND ${DEMO} GROUP BY a.status`,
    [campaignId],
  ));
  const applicants: Record<string, number> = {};
  for (const r of appRows) applicants[String(r.status)] = Number(r.n);
  const totalApplicants = Object.values(applicants).reduce((a, b) => a + b, 0);

  // Fit summary from Steps 2-3 data (cache reads only; Spark never runs here).
  const fitRows = returnedRows<{ band: string; n: string }>(await CreateDBConnection.query(
    `SELECT CASE WHEN one_score IS NULL THEN 'unscored' WHEN one_score >= 75 THEN 'strong' WHEN one_score >= 50 THEN 'ok' ELSE 'weak' END AS band,
            COUNT(*)::int AS n
       FROM campaign_application a JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status IN ('pending','shortlisted','active','completed') AND ${DEMO} GROUP BY 1`,
    [campaignId],
  ));
  const fit = Object.fromEntries(fitRows.map((r) => [r.band, Number(r.n)]));
  const safetyRows = returnedRows<{ creator_fit_profile: any }>(await CreateDBConnection.query(
    `SELECT i.creator_fit_profile FROM campaign_application a JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status IN ('pending','shortlisted','active')
        AND COALESCE(i.is_demo, false) = false AND COALESCE(i.apply_banned, false) = false AND i.banned_at IS NULL`,
    [campaignId],
  ));
  let safety: string[] = [];
  try {
    const all: unknown[] = [];
    for (const r of safetyRows) {
      const reels = (r.creator_fit_profile as any)?.reels;
      if (Array.isArray(reels)) all.push(...reels);
    }
    safety = distinctSafetyFlags(all);
  } catch { safety = []; }

  // Drafts waiting on the brand, oldest first, with hours. Demo and banned
  // creators are excluded (review M5): their pieces are fixtures, not work.
  const draftRows = returnedRows<{ piece_id: string; creator: string | null; hours: string }>(await CreateDBConnection.query(
    `SELECT d.id AS piece_id, i.name AS creator,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(d.review_clock_at, d.draft_submitted_at, d.created_at))) / 3600 AS hours
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id
       JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status = 'active' AND d.draft_status = 'draft_submitted'
        AND ${DEMO}
      ORDER BY hours DESC`,
    [campaignId],
  ));
  const waiting: WaitingDraft[] = draftRows.map((r) => ({
    piece_id: Number(r.piece_id), creator: String(r.creator ?? "a creator"), hours: Math.max(0, Math.round(Number(r.hours ?? 0))),
  }));

  // Pieces past their date that are still not approved or waived, split: with
  // a draft waiting on the brand vs truly undelivered (review R4 — the line
  // must not blame creators for pieces sitting with the brand).
  const dueRows = returnedRows<{ waiting: string; silent: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*) FILTER (WHERE d.draft_status = 'draft_submitted')::int AS waiting,
            COUNT(*) FILTER (WHERE COALESCE(d.draft_status, 'not_submitted') <> 'draft_submitted')::int AS silent
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id
       JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status = 'active'
        AND d.due_at IS NOT NULL AND d.due_at < NOW() AND d.content_status NOT IN ('approved','waived')
        AND ${DEMO}`,
    [campaignId],
  ));
  const pastDue = Number(dueRows[0]?.waiting ?? 0) + Number(dueRows[0]?.silent ?? 0);
  const pastDueWaiting = Number(dueRows[0]?.waiting ?? 0);

  // Silent creators: active pieces with nothing submitted and the date passed
  // or a week since onboarding with no draft. Quiet is measured from when the
  // piece went active (onboarding), not the application date — someone applied
  // 8 days ago and accepted today is not "8d quiet" (review R3). No LIMIT:
  // the staleness recheck counts the same set, so a cap here would break it.
  // Demo/banned excluded (M5). due_at is carried so the nudge step and the
  // brand line act only on pieces actually due.
  const silentRows = returnedRows<{ piece_id: string; application_id: string; creator_id: string; creator: string | null; days: string; due_at: string | null }>(await CreateDBConnection.query(
    `SELECT d.id AS piece_id, a.id AS application_id, a.creator_id, i.name AS creator,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(a.onboarded_at, a.applied_at))) / 86400 AS days, d.due_at
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id
       JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status = 'active'
        AND COALESCE(d.draft_status, 'not_submitted') = 'not_submitted'
        AND (d.due_at IS NOT NULL AND d.due_at < NOW()
             OR COALESCE(a.onboarded_at, a.applied_at) < NOW() - INTERVAL '7 days')
        AND ${DEMO}
      ORDER BY days DESC`,
    [campaignId],
  ));
  const silent: SilentPiece[] = silentRows.map((r) => ({
    piece_id: Number(r.piece_id), application_id: Number(r.application_id),
    creator_id: Number(r.creator_id), creator: String(r.creator ?? "a creator"),
    days_waiting: Math.max(0, Math.round(Number(r.days ?? 0))),
    due_at: r.due_at ? new Date(r.due_at).toISOString() : null,
  }));

  const lastActive = brandLastActive(brand as any);
  // Agent history feeds the model step/status/action ONLY — never reason text:
  // reasons carry real names (nudge skips) and old model sentences (review R8).
  const histRows = returnedRows<{ step: string; status: string; output: any; created_at: Date }>(await CreateDBConnection.query(
    `SELECT step, status, output, created_at FROM autopilot_action
      WHERE campaign_id = $1::int AND created_at > NOW() - INTERVAL '7 days' ORDER BY id DESC LIMIT 20`,
    [campaignId],
  ));

  // Creator names never reach the model: facts say Creator 1..n (review M5).
  // Real names stay in waiting/silent for the code paths (nudge skip notes).
  const creatorLabel = (i: number) => `Creator ${i + 1}`;
  const wanted = Number(c.number_of_influencers ?? 1);
  const applyDaysLeft = c.apply_by == null ? null
    : Math.ceil((new Date(c.apply_by).getTime() - Date.now()) / 86_400_000);
  const facts: AgentFact[] = [
    fact("phase", "Stage", `${name} is ${phase}.`),
    fact("applicants", "Applicants", totalApplicants === 0
      ? `Nobody has applied yet (${wanted} creators wanted).`
      : `Applicants: ${Object.entries(applicants).map(([k, v]) => `${v} ${k}`).join(", ")} (${wanted} creators wanted).`),
    fact("fit", "Fit", fitRows.length === 0
      ? "No fit scores yet."
      : `Fit of live applicants: ${Object.entries(fit).map(([k, v]) => `${v} ${k}`).join(", ")}. Strong means a good reel match for this brief.`),
    fact("safety", "Safety", safety.length === 0
      ? "No safety flags on live applicants."
      : `Safety flags seen on applicants: ${safety.join(", ")}.`),
    fact("drafts_waiting", "Drafts waiting", waiting.length === 0
      ? "No drafts waiting on the brand."
      : `${waiting.length} draft${waiting.length === 1 ? "" : "s"} waiting on the brand: ${waiting.slice(0, 3).map((w, i) => `${creatorLabel(i)} (${w.hours}h)`).join(", ")}${waiting.length > 3 ? ", and more" : ""}.`),
    fact("pieces_past_due", "Past due", pastDue === 0
      ? "Nothing past its date."
      : `${pastDue} piece${pastDue === 1 ? "" : "s"} past ${pastDue === 1 ? "its" : "their"} date and still not delivered.`),
    fact("silent_creators", "Quiet creators", silent.length === 0
      ? "Every active creator has sent something or is still in time."
      : `${silent.length} creator${silent.length === 1 ? "" : "s"} quiet: ${silent.slice(0, 3).map((s, i) => `${creatorLabel(i)} (${s.days_waiting}d)`).join(", ")}${silent.length > 3 ? ", and more" : ""}.`),
    fact("brand_activity", "Brand activity", lastActive
      ? `The brand was last active ${lastActive.toISOString().slice(0, 10)}.`
      : "The brand has no recorded activity."),
    fact("apply_by", "Apply by", c.apply_by
      ? `Creators can apply until ${new Date(c.apply_by).toISOString().slice(0, 10)}.`
      : "No apply-by date set."),
    fact("budget", "Budget", c.budget ? `The stated budget is ${String(c.budget)}.` : "No budget stated on the campaign."),
    fact("agent_history", "Recent agent work", histRows.length === 0
      ? "The agent has done nothing here in the last 7 days."
      : `Last 7 days: ${histRows.slice(0, 5).map((h) => `${h.step}/${h.status}/${String((h.output as any)?.action_taken ?? (h.output as any)?.action ?? "?")}`).join("; ")}.`),
  ];
  const overdue = pastDue > 0 || waiting.some((w) => w.hours >= 48);
  const base = {
    campaign_id: Number(campaignId), campaign_name: name, phase, facts,
    applicants, wanted, waiting_drafts: waiting, pieces_past_due: pastDue,
    past_due_waiting: pastDueWaiting,
    silent_pieces: silent, overdue, apply_days_left: applyDaysLeft,
    apply_window_open: c.apply_by == null ? null : new Date(c.apply_by).getTime() >= Date.now(),
  };
  return { ...base, hash: hashFacts(base) };
}

// ── Diagnose ─────────────────────────────────────────────────────────────────

export const AGENT_ACTIONS = ["none", "tell_brand", "show_backups", "nudge_creators", "flag_admin"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** Actions that must never exist in the schema (design §The closed action list). */
const FORBIDDEN = ["reject", "approve", "pay", "invite", "post", "close", "budget", "deadline", "payout", "ban", "delete"];

export const DIAGNOSE_SCHEMA = {
  name: "campaign_diagnosis",
  schema: {
    type: "object",
    properties: {
      diagnosis: { type: "string", description: "One plain sentence: what is stuck." },
      action: { type: "string", enum: [...AGENT_ACTIONS], description: "The one next step, from the closed list." },
      confidence: { type: "number", description: "0 to 1. Below 0.6 the line never reaches a brand." },
      fact_ids: { type: "array", items: { type: "string" }, description: "The fact ids this uses as proof." },
      admin_note: { type: "string", description: "What OOCM staff should know, with the numbers." },
    },
    required: ["diagnosis", "action", "confidence", "fact_ids", "admin_note"],
    additionalProperties: false,
  },
};

export interface Diagnosis {
  diagnosis: string;
  action: AgentAction;
  confidence: number;
  fact_ids: string[];
  admin_note: string;
}

const DIAGNOSE_PROMPT = `You run one creator-marketing campaign. Read the facts and say the ONE thing most stuck, then pick the ONE next step.

Rules:
- Input is facts only. Never invent people, numbers or events. Cite only fact ids you were given.
- The action MUST be one of: none (nothing stuck), tell_brand (the brand must decide something), show_backups (too few good applicants, show alternates), nudge_creators (a creator is quiet on live work), flag_admin (needs a human at OOCM).
- tell_brand means the BRAND must decide something (picks, reviews, a date). Never use it when the fix is on our side.
- show_backups ONLY when the funnel is the problem (too few or weak applicants) AND there is still time to invite (the apply window is open, the event is not days away). When the problem is the brand (no picks, no reviews, gone quiet) or time has run out, pick tell_brand or flag_admin — never show_backups.
- nudge_creators only when a creator is quiet on live work (the quiet-creators or past-due facts say so).
- You can NEVER reject, approve, pay, invite, post, close, or change a budget or deadline. Those are not options.
- confidence below 0.6 means a person looks first: still answer honestly, the code routes it to admin.
- Judge every date ONLY against the Today line in the input. The apply-by date, the event date, "days waiting" — all relative to Today, never to any date you assume. A window whose date is after Today is still open.
- Your diagnosis sentence goes to OOCM staff only, never to the brand. Write it plainly with the numbers.`;

export async function diagnoseWithModel(facts: CampaignFacts, maxTokens = 1000): Promise<{ diagnosis: Diagnosis; usage: { input_tokens?: number; output_tokens?: number }; model: string }> {
  const lines = facts.facts.map((f) => `- [${f.id}] ${f.label}: ${String(f.detail).slice(0, 300)}`).join("\n");
  // The model has no clock: without this it judges windows against whatever
  // date it assumes (round-2 replay caught it reading apply_by as passed two
  // weeks early). Date.now is mocked in replay, real in prod. The Today line
  // is input-only — never a fact, never in the hash (it changes daily).
  // Prompt-size cap stays: deterministic cut at 6000 chars.
  const today = `Today is ${new Date(Date.now()).toISOString().slice(0, 10)}.`;
  const input = `Campaign: ${facts.campaign_name} (stage: ${facts.phase})\n${today}\n${lines}`.slice(0, 6000);
  const r = await respond<Diagnosis>({
    instructions: DIAGNOSE_PROMPT,
    content: [{ type: "input_text", text: input }],
    schema: DIAGNOSE_SCHEMA,
    maxOutputTokens: maxTokens,
    effort: "minimal",
  });
  return { diagnosis: r.data, usage: r.usage ?? {}, model: r.model };
}

/** Truncation (max_output_tokens) is a blind day, not a diagnosis: retry once
 *  at a higher cap. A retry is a second paid attempt, counted in `attempts`. */
export async function diagnoseWithRetry(facts: CampaignFacts): Promise<{ diagnosis: Diagnosis; usage: { input_tokens?: number; output_tokens?: number }; model: string; attempts: number }> {
  try {
    const r = await diagnoseWithModel(facts, 1000);
    return { ...r, attempts: 1 };
  } catch (e: any) {
    if (!/incomplete|max_output_tokens|truncat/i.test(String(e?.message ?? e))) throw e;
    const r = await diagnoseWithModel(facts, 1600);
    return { ...r, attempts: 2 };
  }
}

// ── Validate ─────────────────────────────────────────────────────────────────

/** Step 3 of the loop: code. A failed validation reaches nobody except admin. */
export function validateDiagnosis(facts: CampaignFacts, d: Diagnosis): { ok: boolean; why: string } {
  if (!d || typeof d !== "object") return { ok: false, why: "empty model output" };
  if (!(AGENT_ACTIONS as readonly string[]).includes(String((d as any).action))) {
    return { ok: false, why: `action ${(d as any).action} is not on the closed list` };
  }
  if (FORBIDDEN.some((f) => String((d as any).action).includes(f))) {
    return { ok: false, why: `forbidden action ${(d as any).action}` };
  }
  const known = new Set(facts.facts.map((f) => f.id));
  const cited = Array.isArray(d.fact_ids) ? d.fact_ids : [];
  const invented = cited.filter((id) => !known.has(String(id)));
  if (invented.length) return { ok: false, why: `cited unknown fact ids: ${invented.join(", ")}` };
  if (cited.length === 0 && d.action !== "none") return { ok: false, why: "no evidence cited" };
  const conf = Number(d.confidence);
  if (!Number.isFinite(conf) || conf < 0.6) return { ok: false, why: `confidence ${String(d.confidence)} below 0.6` };
  const phase = facts.phase;
  if ((d.action === "tell_brand" || d.action === "show_backups") && !phaseAllows(d.action as AgentAction, phase)) {
    return { ok: false, why: `action ${d.action} is not allowed in phase ${phase}` };
  }
  if (d.action === "nudge_creators" && !phaseAllows("nudge_creators", phase)) {
    return { ok: false, why: `nudge_creators is not allowed in phase ${phase}` };
  }
  if (d.action === "nudge_creators" && facts.silent_pieces.length === 0 && facts.pieces_past_due === 0) {
    return { ok: false, why: "nudge_creators with nobody quiet" };
  }
  return { ok: true, why: "validated" };
}

// ── Code-built brand line (review B1) ────────────────────────────────────
// The brand NEVER sees model text. The model picks the action + cited ids +
// confidence; this builds the one line from templates keyed on the action and
// the fact numbers. One limit everywhere: 140 chars, cut on a word boundary.

/** Cut to n chars on a word boundary; single line, no model text inside. */
export const cutWords = (s: string, n: number): string => {
  const flat = String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (flat.length <= n) return flat;
  const cut = flat.slice(0, n - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > n / 2 ? cut.slice(0, lastSpace) : cut).trim();
};

/** Silent pieces actually past due. Quiet is not the same as late, and the
 *  brand line must only count people past their date (review R2). */
export const silentPastDue = (facts: CampaignFacts): number =>
  (facts.silent_pieces ?? []).filter((p) => p.due_at != null && new Date(p.due_at).getTime() < Date.now()).length;

export type BrandLineTopic = "drafts" | "pastdue" | "funnel" | "quiet" | null;

/** Which template the line may use — from what the model CITED, never a fixed
 *  order (review R4). Citing applicants while drafts exist no longer buys a
 *  draft line. Null = nothing true to say; the caller flags admin instead of
 *  sending the old empty fallback. */
export function pickLineTopic(kind: "tell_brand" | "show_backups", facts: CampaignFacts, cited: string[]): BrandLineTopic {
  if (kind === "show_backups") return "funnel";
  const citedSet = new Set((cited ?? []).map(String));
  const total = Object.values(facts.applicants ?? {}).reduce((a, b) => a + Number(b ?? 0), 0);
  if (citedSet.has("drafts_waiting") && facts.waiting_drafts.length > 0) return "drafts";
  if (citedSet.has("pieces_past_due") && facts.pieces_past_due > 0) return "pastdue";
  if ((citedSet.has("applicants") || citedSet.has("fit") || citedSet.has("apply_by")) && total < facts.wanted) return "funnel";
  if ((citedSet.has("silent_creators") || citedSet.has("pieces_past_due")) && silentPastDue(facts) > 0) return "quiet";
  return null;
}

/** The brand line for tell_brand/show_backups, from numbers only. Null when
 *  nothing cited is true — never the empty fallback (review R4). */
export function buildBrandLine(kind: "tell_brand" | "show_backups", facts: CampaignFacts, cited: string[] = [], backupCount = 0): string | null {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (kind === "show_backups") {
    if (backupCount <= 0) return null;
    return cutWords(`${backupCount} more ${plural(backupCount, "creator fits", "creators fit")} this brief — worth a look before you decide.`, 140);
  }
  const topic = pickLineTopic(kind, facts, cited);
  if (topic === "drafts") {
    const drafts = facts.waiting_drafts.length;
    return cutWords(drafts === 1
      ? "1 draft is waiting for your review — the creator is blocked until you respond."
      : `${drafts} drafts are waiting for your review — creators are blocked until you respond.`, 140);
  }
  if (topic === "pastdue") {
    // Split (review R4): pieces sitting with the brand get review wording,
    // only truly undelivered pieces get "not delivered".
    const waiting = facts.past_due_waiting ?? 0;
    const undelivered = Math.max(0, facts.pieces_past_due - waiting);
    if (undelivered > 0) {
      return cutWords(undelivered === 1
        ? "1 piece is past its date and still not delivered."
        : `${undelivered} pieces are past their date and still not delivered.`, 140);
    }
    return cutWords(waiting === 1
      ? "1 piece is past its date and still needs your review."
      : `${waiting} pieces are past their date and still need your review.`, 140);
  }
  if (topic === "funnel") {
    const total = Object.values(facts.applicants ?? {}).reduce((a, b) => a + Number(b ?? 0), 0);
    return cutWords(total === 0
      ? `Nobody has applied for the ${facts.wanted} spots yet.`
      : `Only ${total} applied for the ${facts.wanted} spots.`, 140);
  }
  if (topic === "quiet") {
    const silent = silentPastDue(facts);
    // No promise of a reminder: tell_brand sends none (review R2).
    return cutWords(silent === 1
      ? "1 creator has gone quiet on live work."
      : `${silent} creators have gone quiet on live work.`, 140);
  }
  return null;
}

/** The compact problem signature stored with a tell/show row, so the brand
 *  line can hide the day the world moves on (review B2). pastdue carries the
 *  brand-waiting split (review R4): drafts:2,pastdue:5+3,apps:9/20,silent:1,backups:0. */
export const buildSignal = (facts: CampaignFacts, backupCount = 0): string => {
  const total = Object.values(facts.applicants ?? {}).reduce((a, b) => a + Number(b ?? 0), 0);
  return `drafts:${facts.waiting_drafts.length},pastdue:${facts.pieces_past_due}+${facts.past_due_waiting ?? 0},apps:${total}/${facts.wanted},silent:${facts.silent_pieces.length},backups:${backupCount}`;
};

/** Whether an action may run in a phase. Tell/show speak to the brand (open
 *  work only); nudges chase creators (never on a campaign the brand paused or
 *  hid — review R7); flag/none are always safe. Used by validation AND the
 *  post-diagnose re-read, so a phase change mid-run cannot smuggle a tell. */
export const phaseAllows = (action: AgentAction, phase: string): boolean => {
  if (action === "tell_brand" || action === "show_backups") return phase === "open" || phase === "closed_to_apply";
  if (action === "nudge_creators") return phase === "open" || phase === "closed_to_apply" || phase === "overdue";
  return true;
};

/** Code refusal for show_backups (eval item 2): offering backups when the
 *  audience has no alternates, or when nobody applied and the apply window is
 *  shut or nearly shut, is wrong — the brand must decide instead. */
export function refuseBackups(facts: CampaignFacts, backupCount: number): boolean {
  if (backupCount <= 0) return true;
  const total = Object.values(facts.applicants ?? {}).reduce((a, b) => a + Number(b ?? 0), 0);
  if (total === 0 && facts.apply_days_left != null && facts.apply_days_left <= 2) return true;
  return false;
}

const liveApplicantTotal = (facts: CampaignFacts): number =>
  Object.values(facts.applicants ?? {}).reduce((a, b) => a + Number(b ?? 0), 0);

export interface GateResult { action: AgentAction; gatedFrom: string | null; gateWhy: string }

/** Code gates on brand-surface actions (eval E1, from the design rules — never
 *  from the scored days). show_backups only when the funnel is short AND the
 *  window is open; tell_brand only when the facts hold a brand decision
 *  (drafts waiting, someone to pick, a real shortfall near the window).
 *  Otherwise the action becomes none, logged with the reason. Pure: the
 *  replay scores stored diagnoses through this with backupCount null (the
 *  audience is not time-travelable, so unknown means "cannot refuse"). */
export function gateAction(facts: CampaignFacts, action: AgentAction, backupCount: number | null): GateResult {
  if (action === "show_backups") {
    if (backupCount != null && refuseBackups(facts, backupCount)) {
      return { action: "tell_brand", gatedFrom: "show_backups", gateWhy: `show_backups refused (${backupCount} alternates); told the brand instead` };
    }
    if (!(liveApplicantTotal(facts) < facts.wanted && facts.apply_window_open !== false)) {
      return { action: "none", gatedFrom: "show_backups", gateWhy: "show gated: funnel is not short or the apply window is shut" };
    }
    return { action, gatedFrom: null, gateWhy: "" };
  }
  if (action === "tell_brand") {
    const toPick = Number(facts.applicants?.pending ?? 0) + Number(facts.applicants?.shortlisted ?? 0);
    const days = facts.apply_days_left;
    const nearWindow = days != null && days <= 7;
    if (facts.waiting_drafts.length === 0 && toPick === 0 && !(liveApplicantTotal(facts) < facts.wanted && nearWindow)) {
      return { action: "none", gatedFrom: "tell_brand", gateWhy: "tell gated: no brand decision in facts (no drafts, nobody to pick, no near-window shortfall)" };
    }
    return { action, gatedFrom: null, gateWhy: "" };
  }
  return { action, gatedFrom: null, gateWhy: "" };
}

// ── Act ──────────────────────────────────────────────────────────────────────

export const NUDGE_TEMPLATE = "oocm_task_reminder_v2";

/** Tell and show share one 72h repeat block (review M-C): the brand cannot
 *  tell the difference, so neither can the block. */
async function recentTellOrShow(campaignId: number, hours: number): Promise<boolean> {
  const rows = returnedRows<{ n: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*)::int AS n FROM autopilot_action
      WHERE campaign_id = $1::int AND step = 'diagnose' AND status = 'done'
        AND output->>'action_taken' IN ('tell_brand','show_backups') AND created_at > NOW() - ($2::int || ' hours')::interval`,
    [campaignId, Math.round(hours)],
  ));
  return Number(rows[0]?.n ?? 0) > 0;
}

/** After two tells at least 72h apart in 7 days while an agent item is still
 *  open, the brand is not reading them: stop telling and flag admin (M1/M-C).
 *  Counts prior DONE tells+shows together, not open items — items are
 *  upserted, so open-item counts lie. */
async function tellsIgnored(campaignId: number): Promise<boolean> {
  const openRows = returnedRows<{ n: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*)::int AS n FROM brand_action_item
      WHERE campaign_id = $1::int AND kind IN ('agent_next_step','agent_backups') AND status = 'open'
        AND created_at > NOW() - INTERVAL '7 days'`,
    [campaignId],
  ));
  if (Number(openRows[0]?.n ?? 0) === 0) return false;
  const rows = returnedRows<{ created_at: Date }>(await CreateDBConnection.query(
    `SELECT created_at FROM autopilot_action
      WHERE campaign_id = $1::int AND step = 'diagnose' AND status = 'done'
        AND output->>'action_taken' IN ('tell_brand','show_backups')
        AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at`,
    [campaignId],
  ));
  const ts = rows.map((r) => new Date(r.created_at).getTime()).filter(Number.isFinite);
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      if (ts[j] - ts[i] >= 72 * 3600_000) return true;
    }
  }
  return false;
}

/** The hash of the last DONE run. Failed and skipped rows never count
 *  (review B3): a failed day must not silence the next day. */
async function latestFactsHash(campaignId: number): Promise<string | null> {
  const rows = returnedRows<{ input: any }>(await CreateDBConnection.query(
    `SELECT input FROM autopilot_action WHERE campaign_id = $1::int AND step = 'diagnose' AND status = 'done' ORDER BY id DESC LIMIT 1`,
    [campaignId],
  ));
  const h = (rows[0]?.input as any)?.facts_hash;
  return typeof h === "string" ? h : null;
}

/** The stored input: flat — facts is the array, not the whole snapshot. */
const factInput = (facts: CampaignFacts) => ({
  facts_hash: facts.hash, phase: facts.phase, campaign_name: facts.campaign_name, facts: facts.facts,
});

/** A flag of the same kind sent in the window: the repeat block (R5). */
async function recentFlag(campaignId: number, key: string, hours: number): Promise<boolean> {
  const rows = returnedRows<{ n: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*)::int AS n FROM autopilot_action
      WHERE campaign_id = $1::int AND step = 'diagnose' AND output->>'flag_key' = $2::varchar
        AND created_at > NOW() - ($3::int || ' hours')::interval`,
    [campaignId, key, Math.round(hours)],
  ));
  return Number(rows[0]?.n ?? 0) > 0;
}

/** One flag per campaign per reason per 72h (review R5): the registry emails
 *  every flag, and facts with hours/days change daily, so without this each
 *  stuck campaign pages admin daily. Returns false when blocked — the caller
 *  logs instead of sending. The key lands on the row as output.flag_key. */
async function flagAdmin(campaignId: number, title: string, body: string, key = "flag"): Promise<boolean> {
  if (await recentFlag(campaignId, key, 72).catch(() => false)) return false;
  await createNotification({
    recipient_role: "admin", type: "admin:campaign_agent_flag",
    title, body: body.slice(0, 500), ref_id: campaignId,
  }).catch((e: any) => logger.warn({ campaignId, err: e?.message }, "campaign agent admin flag failed"));
  return true;
}

/** Top alternates for show_backups: Step-2 fit order over the audience. Cache reads only. */
async function topBackups(campaignId: number, take = 5): Promise<Array<{ creator_id: number; name: string; why: string }>> {
  const crows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT c.*, b.country AS brand_country FROM campaign c LEFT JOIN brand b ON b.id = c.brand_id WHERE c.id = $1::int`,
    [campaignId],
  ));
  const c = crows[0];
  if (!c) return [];
  const { audienceIds } = await import("../campaignAudience");
  const ids = await audienceIds(c, { rank: "pulse", limit: 30 }).catch(() => [] as number[]);
  if (!ids.length) return [];
  let ordered = ids.slice(0, take);
  try {
    const { applyFitRank } = await import("../creatorsForYou");
    ordered = (await applyFitRank(campaignId, ids, take)).ids;
  } catch { /* Pulse order stands */ }
  // Exclude creators already on this campaign.
  const onRows = returnedRows<{ creator_id: number }>(await CreateDBConnection.query(
    `SELECT creator_id FROM campaign_application WHERE campaign_id = $1::int AND status NOT IN ('rejected','removed','expired')`,
    [campaignId],
  ));
  const on = new Set(onRows.map((r) => Number(r.creator_id)));
  const fresh = ordered.filter((id) => !on.has(Number(id))).slice(0, take);
  if (!fresh.length) return [];
  const pros = returnedRows<{ id: number; name: string | null }>(await CreateDBConnection.query(
    `SELECT id, name FROM influencer WHERE id = ANY($1::int[])`, [fresh],
  ));
  const byId = new Map(pros.map((p) => [Number(p.id), p]));
  return fresh.map((id) => ({ creator_id: Number(id), name: String(byId.get(Number(id))?.name ?? "A creator"), why: "Fits this brief and is free to invite." }));
}

/** Nudge quiet creators, honestly (reviews M2/M3/M4):
 *  - only pieces actually past due (M3);
 *  - skip creators touched by ANY message in 24h, or by a deadline sweep in
 *    48h (M3 — no double reminders with deadline-notify);
 *  - claim-first: the ledger row is INSERTed before the send and released when
 *    nothing goes out (M2 — no phantom nudges);
 *  - only a queued send counts as nudged (M2);
 *  - `quiet` is true when every skip is benign (48h windows, nothing due):
 *    the caller logs those and does NOT page admin (M4). Anything else that
 *    blocks every send (no phone, template down, send error) is noisy. */
async function nudgeCreators(campaignId: number, campaignName: string, pieces: SilentPiece[]): Promise<{ nudged: number; skipped: string[]; quiet: boolean }> {
  let nudged = 0;
  const skipped: string[] = [];
  let noisy = false;
  // One creator with 2 quiet pieces gets ONE message, not two (review R3):
  // keep the most past-due piece per creator. Skipped reasons never carry
  // real names — they land in autopilot_action.reason, which the model reads
  // back as agent_history (review R8). Numeric creator ids stay.
  const byCreator = new Map<number, SilentPiece>();
  const ordered = [...pieces].sort((a, b) => Number(a.due_at == null) - Number(b.due_at == null)
    || String(a.due_at ?? "").localeCompare(String(b.due_at ?? "")));
  for (const p of ordered) {
    if (!byCreator.has(p.creator_id)) byCreator.set(p.creator_id, p);
    else skipped.push(`creator #${p.creator_id} (second quiet piece; one message per creator per run)`);
  }
  const queue = [...byCreator.values()];
  const { enqueue } = await import("../wa/outbox");
  // A 48h epoch bucket, not a calendar day: at a 04:17 fire time a date stamp
  // drifts the real window. The nudged_at recency check below still holds the
  // exact 48h across bucket edges.
  const bucket = `agent48:${Math.floor(Date.now() / 172_800_000)}`;
  for (const p of queue) {
    const [app] = returnedRows<{ status: string }>(await CreateDBConnection.query(
      `SELECT status FROM campaign_application WHERE id = $1::int`, [p.application_id],
    ));
    if (!app || app.status !== "active") { skipped.push(`creator #${p.creator_id} (no longer active)`); noisy = true; continue; }
    // Nudge only pieces that are actually due: quiet is not the same as late.
    if (!p.due_at || new Date(p.due_at).getTime() >= Date.now()) { skipped.push(`creator #${p.creator_id} (nothing past due)`); continue; }
    const [inf] = returnedRows<{ id: number; name: string | null; phone: string | null; phone_e164: string | null }>(await CreateDBConnection.query(
      `SELECT id, name, phone, phone_e164 FROM influencer WHERE id = $1::int`, [p.creator_id],
    ));
    if (!inf) { skipped.push(`creator #${p.creator_id} (creator gone)`); noisy = true; continue; }
    const [crow] = returnedRows<{ brand_id: number }>(await CreateDBConnection.query(
      `SELECT brand_id FROM campaign WHERE id = $1::int`, [campaignId],
    ));
    if (crow && await isBrandBlocked(Number(p.creator_id), Number(crow.brand_id)).catch(() => false)) {
      skipped.push(`creator #${p.creator_id} (blocked this brand)`); noisy = true; continue;
    }
    // No phone = nothing to claim: skip before touching the ledger.
    const phone = (inf as any).phone_e164 ?? (inf as any).phone;
    if (!phone) { skipped.push(`creator #${p.creator_id} (no phone)`); noisy = true; continue; }
    // Any message to this creator in 24h (in or out — a creator who just wrote
    // in needs an answer, not a nudge).
    const [hit24] = returnedRows<{ x: number }>(await CreateDBConnection.query(
      `SELECT 1 AS x FROM wa_message m JOIN wa_contact co ON co.id = m.contact_id
        WHERE co.subject_id = $1::int AND co.role = 'creator' AND m.created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [p.creator_id],
    ));
    if (hit24) { skipped.push(`creator #${p.creator_id} (messaged in the last 24h)`); continue; }
    // Reached by a sibling sweep in 48h (deadline-notify's campaign_deadline /
    // deadline_reminder): acting too would double-remind.
    const [hit48] = returnedRows<{ x: number }>(await CreateDBConnection.query(
      `SELECT 1 AS x FROM wa_message m JOIN wa_contact co ON co.id = m.contact_id
        WHERE co.subject_id = $1::int AND co.role = 'creator' AND m.campaign_id = $2::int
          AND m.notification_type IN ('campaign_deadline','deadline_reminder')
          AND m.created_at > NOW() - INTERVAL '48 hours' LIMIT 1`,
      [p.creator_id, campaignId],
    ));
    if (hit48) { skipped.push(`creator #${p.creator_id} (deadline sweep reminded in the last 48h)`); continue; }
    const recent = returnedRows<{ n: string }>(await CreateDBConnection.query(
      `SELECT COUNT(*)::int AS n FROM sla_nudge WHERE state_key = 'campaign_agent_nudge' AND ref_id = $1::int AND nudged_at > NOW() - INTERVAL '48 hours'`,
      [p.piece_id],
    ));
    if (Number(recent[0]?.n ?? 0) > 0) { skipped.push(`creator #${p.creator_id} (reminded in the last 48h)`); continue; }
    // Template down = nothing to claim either.
    if (!(await utilityReady(NUDGE_TEMPLATE, 3).catch(() => false))) {
      skipped.push(`creator #${p.creator_id} (reminder template not ready)`); noisy = true; continue;
    }
    // Claim-first: one row per piece per 48h bucket. No row = someone (this
    // job, a retry, a concurrent run) already holds it.
    const [claim] = returnedRows<{ id: number }>(await CreateDBConnection.query(
      `INSERT INTO sla_nudge (state_key, ref_id, stage) VALUES ('campaign_agent_nudge', $1::int, $2::varchar)
       ON CONFLICT ON CONSTRAINT uq_sla_nudge DO NOTHING RETURNING id`,
      [p.piece_id, bucket],
    ));
    if (!claim) { skipped.push(`creator #${p.creator_id} (reminded in the last 48h)`); continue; }
    const clean = (s: unknown) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    const outcome = await enqueue({
      subjectId: Number(p.creator_id), role: "creator", phone,
      templateName: NUDGE_TEMPLATE,
      bodyVars: [clean(String((inf as any).name ?? p.creator).split(" ")[0]) || "there", clean(campaignName), "your video draft"],
      urlVars: [String(p.application_id)],
      notificationType: "campaign_agent_nudge", refId: campaignId, campaignId,
      dedupeKey: `campaign_agent:${p.piece_id}:${bucket}`,
    }).catch(() => "error" as const);
    if (outcome === "queued" || outcome === "queued_session") {
      nudged++;
    } else {
      // Nothing went out: release the claim so tomorrow is a clean try, and
      // say so. A queued-out send that errors downstream keeps its claim.
      await CreateDBConnection.query(`DELETE FROM sla_nudge WHERE id = $1::int`, [claim.id]).catch(() => {});
      skipped.push(`creator #${p.creator_id} (send ${outcome})`); noisy = true;
    }
  }
  return { nudged, skipped, quiet: !noisy };
}

/** The latest brand-safe line: newest validated tell_brand/show_backups row.
 *  Nudge rows are excluded on purpose — the brand is never told about a nudge
 *  (the creators hear it, the brand page stays quiet). A switched-off campaign
 *  shows nothing: off means off, even for a line written before the switch.
 *  Stale lines hide (review B2): older than 72h, a phase that is no longer
 *  live, or facts that no longer show the same problem — a fixed problem must
 *  not keep greeting the brand. The web shows the real date, never "today". */
export async function latestBrandLine(campaignId: number): Promise<{ line: string; date: string } | null> {
  if (!campaignAgentEnabled() || !campaignAgentAllowList().includes(Number(campaignId))) return null;
  if (await switchedOff(campaignId).catch(() => null)) return null;
  const rows = returnedRows<{ output: any; input: any; created_at: Date }>(await CreateDBConnection.query(
    `SELECT output, input, created_at FROM autopilot_action
      WHERE campaign_id = $1::int AND step = 'diagnose' AND status = 'done'
        AND output->>'validated' = 'true' AND output->>'action_taken' IN ('tell_brand','show_backups')
        AND created_at > NOW() - INTERVAL '72 hours'
      ORDER BY id DESC LIMIT 1`,
    [campaignId],
  ));
  const row = rows[0];
  const line = String(row?.output?.brand_line ?? "").trim();
  if (!line || !row) return null;
  // Stored phase must have been live, and the CURRENT derived phase must be
  // live too — admin shows derived truth, and so does the brand (DONE rule 4).
  if (!["open", "closed_to_apply"].includes(String((row.input as any)?.phase ?? ""))) return null;
  try {
    // Same full field set as facts (review R1): lock, roster, deadline zone.
    const { row: crow, brand } = await loadLivenessInput(campaignId);
    if (!crow) return null;
    const live = campaignLiveness(crow as any, brand as any).phase;
    if (!["open", "closed_to_apply"].includes(live)) return null;
  } catch { return null; /* fail closed: a line we cannot verify does not show */ }
  const stillTrue = await brandLineStillTrue(campaignId, String((row.output as any)?.signal ?? "")).catch(() => false);
  if (!stillTrue) return null;
  return { line, date: new Date(row.created_at).toISOString().slice(0, 10) };
}

/** True when the live counts still equal the signature stored with the line:
 *  same drafts waiting, same past-due, same applicants, same quiet creators. */
async function brandLineStillTrue(campaignId: number, signal: string): Promise<boolean> {
  const m = signal.match(/^drafts:(\d+),pastdue:(\d+)\+(\d+),apps:(\d+)\/(\d+),silent:(\d+),backups:(\d+)$/);
  if (!m) return false;
  const [, drafts, pastdue, pastdueWaiting, apps, wanted, silent] = m.map(Number);
  const [w] = returnedRows<{ n: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*)::int AS n FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status = 'active' AND d.draft_status = 'draft_submitted'
        AND COALESCE(i.is_demo, false) = false AND COALESCE(i.apply_banned, false) = false AND i.banned_at IS NULL`,
    [campaignId],
  ));
  const [pd] = returnedRows<{ waiting: string; silent: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*) FILTER (WHERE d.draft_status = 'draft_submitted')::int AS waiting,
            COUNT(*) FILTER (WHERE COALESCE(d.draft_status, 'not_submitted') <> 'draft_submitted')::int AS silent
       FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status = 'active'
        AND d.due_at IS NOT NULL AND d.due_at < NOW() AND d.content_status NOT IN ('approved','waived')
        AND COALESCE(i.is_demo, false) = false AND COALESCE(i.apply_banned, false) = false AND i.banned_at IS NULL`,
    [campaignId],
  ));
  // Applicants exclude demo/banned, the way campaignFacts counts them (R8):
  // fixtures are not a funnel, and a demo application must not hide the line.
  const [a] = returnedRows<{ n: string; w: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*)::int AS n, (SELECT COALESCE(number_of_influencers, 1)::int FROM campaign WHERE id = $1::int) AS w
       FROM campaign_application a JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int
        AND COALESCE(i.is_demo, false) = false AND COALESCE(i.apply_banned, false) = false AND i.banned_at IS NULL`,
    [campaignId],
  ));
  const [s] = returnedRows<{ n: string }>(await CreateDBConnection.query(
    `SELECT COUNT(*)::int AS n FROM application_deliverable d
       JOIN campaign_application a ON a.id = d.application_id JOIN influencer i ON i.id = a.creator_id
      WHERE a.campaign_id = $1::int AND a.status = 'active'
        AND COALESCE(d.draft_status, 'not_submitted') = 'not_submitted'
        AND (d.due_at IS NOT NULL AND d.due_at < NOW() OR COALESCE(a.onboarded_at, a.applied_at) < NOW() - INTERVAL '7 days')
        AND COALESCE(i.is_demo, false) = false AND COALESCE(i.apply_banned, false) = false AND i.banned_at IS NULL`,
    [campaignId],
  ));
  return Number(w?.n ?? -1) === drafts && Number(pd?.waiting ?? -1) + Number(pd?.silent ?? -1) === pastdue
    && Number(pd?.waiting ?? -1) === pastdueWaiting
    && Number(a?.n ?? -1) === apps && Number(a?.w ?? -1) === wanted && Number(s?.n ?? -1) === silent;
}

/** The full agent timeline for the admin page: facts cited, confidence, cost. */
export async function agentTimeline(campaignId: number, limit = 30): Promise<Array<Record<string, unknown>>> {
  const rows = returnedRows<any>(await CreateDBConnection.query(
    `SELECT id, created_at, status, reason, input, output, cost_usd FROM autopilot_action
      WHERE campaign_id = $1::int AND step = 'diagnose' ORDER BY id DESC LIMIT $2::int`,
    [campaignId, Math.max(1, Math.min(100, limit))],
  ));
  return rows.map((r) => {
    // The cited fact TEXT, looked up from the stored input — an admin judging
    // the call sees the evidence, not just its ids (nice-to-have 4).
    const storedFacts: Array<{ id: string; label: string; detail: string }> =
      Array.isArray((r.input as any)?.facts) ? (r.input as any).facts : [];
    const byId = new Map(storedFacts.map((f) => [String(f.id), f]));
    const cited: string[] = Array.isArray((r.output as any)?.fact_ids) ? (r.output as any).fact_ids : [];
    return {
      id: r.id, at: r.created_at, status: r.status, reason: r.reason,
      facts_hash: (r.input as any)?.facts_hash ?? null,
      diagnosis: (r.output as any)?.diagnosis ?? null,
      action: (r.output as any)?.action_taken ?? (r.output as any)?.action ?? null,
      fact_ids: cited,
      fact_texts: cited.map((id) => {
        const f = byId.get(String(id));
        return f ? `[${f.id}] ${f.label}: ${String(f.detail).slice(0, 200)}` : `[${id}] (fact not stored)`;
      }),
      confidence: (r.output as any)?.confidence ?? null,
      brand_line: (r.output as any)?.brand_line ?? null,
      admin_note: (r.output as any)?.admin_note ?? null,
      cost_usd: Number(r.cost_usd ?? 0),
    };
  });
}

// ── One campaign ─────────────────────────────────────────────────────────────

/** Resolve agent items the world moved past (review R6): a stored signal that
 *  no longer matches live counts, any item on a campaign no longer
 *  open/closed_to_apply, or rows predating the signal (no provenance to
 *  verify). Runs at the START of every run — including hash-skip days, which
 *  otherwise leave a stale line repeating in the digest forever. */
async function sweepStaleAgentItems(campaignId: number, facts: CampaignFacts): Promise<number> {
  const live = facts.phase === "open" || facts.phase === "closed_to_apply";
  let items: Array<{ id: number; kind: string; payload: any }> = [];
  try {
    items = returnedRows<{ id: number; kind: string; payload: any }>(await CreateDBConnection.query(
      `SELECT id, kind, payload FROM brand_action_item
        WHERE campaign_id = $1::int AND kind IN ('agent_next_step','agent_backups') AND status = 'open'`,
      [campaignId],
    ));
  } catch { items = []; }
  if (!items.length) return 0;
  const { resolveActionItems } = await import("../actionItems");
  let closed = 0;
  for (const it of items) {
    const sig = (it.payload as any)?.signal;
    const bc = Number((it.payload as any)?.backups ?? 0);
    if (!live || typeof sig !== "string" || sig !== buildSignal(facts, bc)) {
      await resolveActionItems({ campaignId, kind: it.kind as any, by: "agent-stale" }).catch(() => 0);
      closed++;
    }
  }
  return closed;
}

export interface AgentRunResult {
  ran: boolean;
  why: string;
  modelCalls: number;
  actionTaken: string | null;
  costUsd: number;
}

/** Phases where a diagnose run is meaningful. overdue runs (B4: pieces past
 *  due still need eyes); paused/brand_paused run (the model can say none or
 *  flag_admin — brand actions stay invalid there by validation). Everything
 *  else — draft, in_review, rejected, archived, auto_closed, completed — skips. */
const RUNNABLE_PHASES = ["open", "closed_to_apply", "overdue", "paused", "brand_paused"];

/** Steps 2–5 of the loop for one campaign, through the real rails. */
export async function runCampaignAgent(campaignId: number): Promise<AgentRunResult> {
  const gate = await campaignAgentFor(campaignId);
  if (!gate.ok) return { ran: false, why: gate.why, modelCalls: 0, actionTaken: null, costUsd: 0 };

  const facts = await campaignFacts(campaignId);
  // Stale agent items close first, every run including hash-skip days (R6).
  const swept = await sweepStaleAgentItems(campaignId, facts).catch(() => 0);
  // Terminal or pre-live mid-run: skip and say why (DONE rule 1).
  if (!RUNNABLE_PHASES.includes(facts.phase)) {
    await autopilotRecord(campaignId, "diagnose", "skipped", `phase ${facts.phase}: nothing to run`);
    return { ran: false, why: `phase ${facts.phase}`, modelCalls: 0, actionTaken: null, costUsd: 0 };
  }

  // Step 5 first: same facts as yesterday = no model call, no message. But a
  // stuck campaign must not skip forever (review M-B): when the last done row
  // is over 72h old and an agent item is still open, the skip expires and the
  // campaign runs again.
  let skipExpired = false;
  const prev = await latestFactsHash(campaignId).catch(() => null);
  if (prev === facts.hash) {
    let lastDone: { created_at: Date } | undefined;
    let openCount = 0;
    try {
      [lastDone] = returnedRows<{ created_at: Date }>(await CreateDBConnection.query(
        `SELECT created_at FROM autopilot_action WHERE campaign_id = $1::int AND step = 'diagnose' AND status = 'done' ORDER BY id DESC LIMIT 1`,
        [campaignId],
      ));
      const [open] = returnedRows<{ n: string }>(await CreateDBConnection.query(
        `SELECT COUNT(*)::int AS n FROM brand_action_item
          WHERE campaign_id = $1::int AND kind IN ('agent_next_step','agent_backups') AND status = 'open'`,
        [campaignId],
      ));
      openCount = Number(open?.n ?? 0);
    } catch { /* fail closed below: without proof of staleness, skip */ }
    const stale = !!lastDone?.created_at
      && Date.now() - new Date(lastDone.created_at).getTime() > 72 * 3600_000
      && openCount > 0;
    if (!stale) {
      await autopilotRecord(campaignId, "diagnose", "skipped", "facts unchanged since yesterday; silence beats repetition", { facts_hash: facts.hash });
      return { ran: false, why: "facts unchanged", modelCalls: 0, actionTaken: null, costUsd: 0 };
    }
    skipExpired = true;
  }

  // Over the month's Meta budget: the model stays off. The spend check failing
  // is fail-CLOSED (nice-to-have 6): money we cannot account stays unspent.
  let overBudget = false;
  let modelError: string | null = null;
  try {
    overBudget = (await metaSpendThisMonth()) >= monthlyBudgetUsd();
    if (overBudget) modelError = "monthly Meta budget spent";
  } catch {
    overBudget = true;
    modelError = "Meta spend check failed; model stays off";
  }
  let out: Diagnosis | null = null;
  let usage: { input_tokens?: number; output_tokens?: number } = { input_tokens: 0, output_tokens: 0 };
  let modelName = "muse-spark-1.3";
  let modelCalls = 0;
  let attempts = 0;
  if (!overBudget) {
    try {
      const r = await diagnoseWithRetry(facts);
      out = r.diagnosis; usage = r.usage; modelName = r.model; attempts = r.attempts; modelCalls = 1;
    } catch (e: any) { modelError = String(e?.message ?? e).slice(0, 200); attempts = Math.max(attempts, 1); }
  }
  const cost = modelCalls ? tokenCost(usage) : 0;
  if (modelCalls) await logUsage("campaign_agent", modelName, usage, cost, campaignId);

  // Model failed, timed out or over budget: flag admin only when the facts
  // already show something overdue; otherwise log and retry tomorrow. Never a
  // brand message from this path. Flags carry a key for the 72h repeat block.
  if (!out) {
    if (facts.overdue) {
      const sent = await flagAdmin(campaignId, `Agent needs eyes on ${facts.campaign_name}`, `The check failed (${modelError}) and ${facts.pieces_past_due} pieces are past due with ${facts.waiting_drafts.length} drafts waiting.`, "model_fail");
      await autopilotRecord(campaignId, "diagnose", "failed", `model failed and facts overdue; ${sent ? "flagged admin" : "flag repeat-blocked, logged only"} (${modelError})`, { facts_hash: facts.hash },
        sent ? { action_taken: "flag_admin", flag_key: "model_fail" } : { action_taken: null, flag_key: "model_fail", flag_sent: false }, cost);
      return { ran: true, why: "model failed, overdue: flagged admin", modelCalls, actionTaken: sent ? "flag_admin" : null, costUsd: cost };
    }
    await autopilotRecord(campaignId, "diagnose", "failed", `model failed; retry tomorrow (${modelError})`, { facts_hash: facts.hash });
    return { ran: true, why: "model failed, retry tomorrow", modelCalls, actionTaken: null, costUsd: cost };
  }

  // Step 3: validate. Anything off → admin, nothing reaches a brand.
  const v = validateDiagnosis(facts, out);
  let action: AgentAction = out.action;
  let actionTaken: string = action;
  let downgradedFrom: string | null = null;
  let flagBody: string | null = null;
  if (!v.ok) {
    const sent = await flagAdmin(campaignId, `Agent needs eyes on ${facts.campaign_name}`, `Validation failed (${v.why}). Diagnosis was: ${String(out.diagnosis).slice(0, 200)}`, "validation");
    await autopilotRecord(campaignId, "diagnose", "failed", `validation failed: ${v.why}${sent ? "" : " (flag repeat-blocked, logged only)"}`, factInput(facts),
      { ...out, validated: false, action_taken: sent ? "flag_admin" : null, evidence: out.fact_ids, cost_usd: cost, attempts, flag_key: "validation", ...(sent ? {} : { flag_sent: false }) }, cost);
    return { ran: true, why: `validation failed: ${v.why}`, modelCalls, actionTaken: sent ? "flag_admin" : null, costUsd: cost };
  }

  // Backups need an audience and a window: otherwise the brand must decide.
  let top: Array<{ creator_id: number; name: string; why: string }> = [];
  if (action === "show_backups") {
    top = await topBackups(campaignId).catch(() => []);
    if (refuseBackups(facts, top.length)) {
      downgradedFrom = "show_backups";
      action = "tell_brand";
      actionTaken = "tell_brand";
    }
  }

  // Code gates on brand-surface actions (eval E1): show only on a short funnel
  // with an open window, tell only with a brand decision in the facts.
  // Anything else becomes none, logged with the reason.
  let gatedFrom: string | null = null;
  let gateWhy = "";
  const g = gateAction(facts, action, action === "show_backups" ? top.length : null);
  if (g.action !== action) {
    gatedFrom = g.gatedFrom ?? action;
    gateWhy = g.gateWhy;
    action = g.action;
    actionTaken = g.action;
  }

  // Overdue with pieces past due and a "nothing stuck" verdict: the verdict is
  // wrong, the campaign is dead air. Code-built admin flag (review B4).
  if (facts.phase === "overdue" && facts.pieces_past_due > 0 && action === "none") {
    action = "flag_admin";
    actionTaken = "flag_admin (overdue pieces, nothing proposed)";
    flagBody = `Overdue with ${facts.pieces_past_due} piece${facts.pieces_past_due === 1 ? "" : "s"} past due; the check proposed nothing, so this needs eyes.`;
  }

  // A tell/show of the last 72h is never sent again (one shared block, M-C);
  // two ignored tells 72h+ apart become an admin flag.
  if ((action === "tell_brand" || action === "show_backups") && await recentTellOrShow(campaignId, 72)) {
    await autopilotRecord(campaignId, "diagnose", "skipped", `same tell/show sent in the last 72h`, factInput(facts),
      { ...out, validated: true, evidence: out.fact_ids, cost_usd: cost, attempts }, cost);
    return { ran: true, why: "72h repeat block", modelCalls, actionTaken: null, costUsd: cost };
  }
  if ((action === "tell_brand" || action === "show_backups") && await tellsIgnored(campaignId)) {
    action = "flag_admin";
    actionTaken = "flag_admin (two ignored tells)";
    flagBody = `Two tells 72h+ apart in 7 days went unread (the agent item is still open). Stopped telling; needs eyes.`;
  }

  // Phase re-read right before acting (review R7): the action is re-validated
  // against the FRESH phase, not just RUNNABLE — closing to paused between
  // diagnose and act can no longer smuggle a tell or a nudge through.
  const fresh = await campaignFacts(campaignId).catch(() => null);
  if (!fresh || !RUNNABLE_PHASES.includes(fresh.phase) || !phaseAllows(action, fresh.phase)) {
    await autopilotRecord(campaignId, "diagnose", "skipped", `phase moved to ${fresh?.phase ?? "gone"} before acting (action ${action})`, factInput(facts),
      { ...out, validated: true, evidence: out.fact_ids, cost_usd: cost, attempts }, cost);
    return { ran: true, why: "closed mid-run", modelCalls, actionTaken: null, costUsd: cost };
  }

  // Step 4: act through the existing rails.
  const [crow] = returnedRows<{ brand_id: number; name: string }>(await CreateDBConnection.query(
    `SELECT brand_id, name FROM campaign WHERE id = $1::int`, [campaignId],
  ));
  const brandId = Number(crow?.brand_id ?? 0);
  // The brand line is built here, from numbers and the cited evidence — never
  // model text (B1/R4). Null = nothing cited is true: flag admin instead of
  // sending the old empty fallback.
  let flagSent = true;
  // Set only when a flag is actually raised. A tell/show/nudge/none row must
  // not carry flag_key "flag": the default used to leak into every done row,
  // so the first action of the week repeat-blocked the next genuine flag.
  let flagKey: string | null = null;
  const topic = action === "tell_brand" || action === "show_backups"
    ? pickLineTopic(action, facts, out.fact_ids ?? []) : null;
  const brandLine = action === "tell_brand" ? buildBrandLine("tell_brand", facts, out.fact_ids ?? [])
    : action === "show_backups" ? buildBrandLine("show_backups", facts, out.fact_ids ?? [], top.length)
    : null;
  if ((action === "tell_brand" || action === "show_backups") && !brandLine) {
    action = "flag_admin";
    actionTaken = "flag_admin (no true line)";
    flagKey = "no_line";
    flagBody = `The check picked ${out.action} but nothing cited is still true (cited: ${(out.fact_ids ?? []).join(", ")}). Needs eyes.`;
  }
  const signal = (action === "tell_brand" || action === "show_backups")
    ? buildSignal(facts, action === "show_backups" ? top.length : 0) : "";
  const recordOutput = {
    diagnosis: out.diagnosis, action: out.action, confidence: out.confidence,
    fact_ids: out.fact_ids, admin_note: out.admin_note,
    validated: true, action_taken: actionTaken.split(" ")[0], evidence: out.fact_ids,
    cost_usd: cost, brand_line: brandLine, signal, attempts, swept,
    ...(skipExpired ? { skip_expired: true } : {}),
    ...(downgradedFrom ? { downgraded_from: downgradedFrom } : {}),
    ...(gatedFrom ? { gated_from: gatedFrom, gate_why: gateWhy } : {}),
  };
  if (action === "tell_brand") {
    // No tell about drafts when the BUILT line is the drafts line and a
    // draft_waiting item already says it (M3/R4): the digest carries that
    // item daily; a second tell is pure repetition.
    if (topic === "drafts") {
      const [dup] = returnedRows<{ x: number }>(await CreateDBConnection.query(
        `SELECT 1 AS x FROM brand_action_item WHERE campaign_id = $1::int AND kind = 'draft_waiting' AND status = 'open' LIMIT 1`,
        [campaignId],
      ));
      if (dup) {
        await autopilotRecord(campaignId, "diagnose", "skipped", "draft_waiting item already open; no duplicate tell", factInput(facts), recordOutput, cost);
        return { ran: true, why: "draft tell already open", modelCalls, actionTaken: null, costUsd: cost };
      }
    }
    await upsertActionItem({
      brandId, campaignId, kind: "agent_next_step" as any,
      payload: { campaign_name: facts.campaign_name, line: brandLine, signal, backups: 0 },
    });
  } else if (action === "show_backups") {
    await upsertActionItem({
      brandId, campaignId, kind: "agent_backups" as any,
      payload: { campaign_name: facts.campaign_name, line: brandLine, top, signal, backups: top.length },
    });
  } else if (action === "nudge_creators") {
    const live = fresh.silent_pieces.length ? fresh.silent_pieces : facts.silent_pieces;
    const r = await nudgeCreators(campaignId, facts.campaign_name, live);
    if (r.nudged === 0 && r.quiet) {
      // Nothing went out and everything skipped was benign (48h windows,
      // nothing due): log only, never page admin (M4). Not "done" — nothing
      // was done — so the action is null and the drain does not count it.
      await autopilotRecord(campaignId, "diagnose", "skipped", `nobody to remind; logged only (${r.skipped.join("; ").slice(0, 200)})`, factInput(facts), recordOutput, cost);
      return { ran: true, why: "nudges all inside windows; logged only", modelCalls, actionTaken: null, costUsd: cost };
    }
    if (r.nudged === 0) {
      flagKey = "nudge_blocked";
      flagSent = await flagAdmin(campaignId, `Agent needs eyes on ${facts.campaign_name}`, `Wanted to nudge quiet creators but all were skipped: ${r.skipped.join("; ").slice(0, 300)}`, flagKey);
      actionTaken = flagSent ? "flag_admin (nobody to nudge)" : "flag_admin (nobody to nudge; repeat-blocked)";
    }
  } else if (action === "flag_admin" || actionTaken.startsWith("flag_admin")) {
    if (actionTaken.startsWith("flag_admin (two")) flagKey = "ignored_tells";
    else if (actionTaken.startsWith("flag_admin (overdue")) flagKey = "overdue_none";
    else if (actionTaken.startsWith("flag_admin (no true")) flagKey = "no_line";
    else flagKey = "flag";
    flagSent = await flagAdmin(campaignId, `Agent flag on ${facts.campaign_name}`, flagBody ?? out.admin_note ?? out.diagnosis, flagKey);
    if (!flagSent) actionTaken = `${actionTaken}; repeat-blocked`;
  } else if (action === "none") {
    // Nothing stuck: close any agent items the world moved past (M1).
    const { resolveActionItems } = await import("../actionItems");
    await resolveActionItems({ campaignId, kind: "agent_next_step" as any, by: "agent" }).catch(() => 0);
    await resolveActionItems({ campaignId, kind: "agent_backups" as any, by: "agent" }).catch(() => 0);
  }
  // A repeat-blocked flag sends nothing: log the decision, report no action.
  const logOnly = !flagSent;
  const reason = downgradedFrom
    ? `show_backups refused (${top.length} alternates); told the brand instead`
    : gatedFrom
      ? gateWhy
      : actionTaken.startsWith("flag_admin (overdue") || actionTaken.startsWith("flag_admin (two")
        ? actionTaken
        : out.diagnosis;
  const taken = logOnly ? null : actionTaken.split(" ")[0];
  await autopilotRecord(campaignId, "diagnose", "done", logOnly ? `${reason} (flag repeat-blocked, logged only)` : reason, factInput(facts),
    { ...recordOutput, action_taken: taken, ...(flagKey ? { flag_key: flagKey } : {}), ...(logOnly ? { flag_sent: false } : {}) }, cost);
  return { ran: true, why: logOnly ? `${actionTaken} (repeat-blocked)` : actionTaken, modelCalls, actionTaken: taken, costUsd: cost };
}

// ── The daily job ────────────────────────────────────────────────────────────

/** One pass over every runnable campaign. Closed/archived/demo/brandless never enter. */
export async function drainCampaignAgent(now = new Date()): Promise<{ campaigns: number; diagnosed: number; modelCalls: number; costUsd: number }> {
  if (!campaignAgentEnabled()) return { campaigns: 0, diagnosed: 0, modelCalls: 0, costUsd: 0 };
  const allow = campaignAgentAllowList();
  if (!allow.length) return { campaigns: 0, diagnosed: 0, modelCalls: 0, costUsd: 0 };
  void now;
  const rows = returnedRows<{ id: number }>(await CreateDBConnection.query(
    `SELECT c.id FROM campaign c JOIN brand b ON b.id = c.brand_id
      WHERE c.id = ANY($1::int[]) AND c.approval_status = 'approved' AND c.archived = false
        AND c.completed_at IS NULL AND c.auto_closed_at IS NULL AND COALESCE(c.is_demo, false) = false`,
    [allow],
  ));
  let diagnosed = 0, modelCalls = 0, costUsd = 0;
  for (const r of rows) {
    try {
      const res = await runCampaignAgent(Number(r.id));
      if (res.ran && res.actionTaken) diagnosed++;
      modelCalls += res.modelCalls;
      costUsd += res.costUsd;
    } catch (e: any) { logger.warn({ campaign: r.id, err: e?.message }, "campaign agent: one campaign failed"); }
  }
  return { campaigns: rows.length, diagnosed, modelCalls, costUsd };
}
