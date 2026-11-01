// Step-7 replay eval (31-Oct-2026): rebuild campaign facts as of past days from
// prod (READ-ONLY via ~/.claude/oocm-refs/dbq-ro.sh) and run the REAL diagnose +
// validate from built dist. Never acts, never writes: it imports only
// diagnoseWithRetry, validateDiagnosis, hashFacts, buildBrandLine (pure + model
// calls), campaignLiveness (pure) and distinctSafetyFlags (pure). No DB connection.
//
// Run: ./node_modules/.bin/ts-node --transpile-only scripts/agent-replay.ts \
//        --day 3138=2026-10-30 [--day 2701=2026-10-16 ...] [--all] [--out DIR] [--runs 3]
//   --labels eval/agent/labels.json --score   writes results.md + run json
//
// Day list (--all) is the fixed 30-day panel in DAYS below (round 2: the 20
// round-1 days + 6 healthy + 3 silent + 1 zero-funnel-eve). --runs (default 3)
// repeats the model call per day for action stability; retries on truncation
// count as extra attempts inside one run, the same as the product.
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

// Dummy env — config/env.ts refuses to load without these. None is real. The
// replay never opens a DB connection (all prod reads go through dbq-ro.sh) and
// never signs a token or touches AWS, so dummies are safe and touch nothing.
Object.assign(process.env, {
  DATABASE_URL: "replay-no-db", NODE_ENV: "test",
  JWT_AUTH_SECRET_KEY: "replay-no-jwt",
  AWS_ACCESS_KEY: "replay-no-key", AWS_SECRET_ACCESS_KEY: "replay-no-key",
  INSTAGRAM_CLIENT_ID: "replay-no-key", INSTAGRAM_CLIENT_SECRET: "replay-no-key",
  RESEND_API_KEY: "re_test_only",
});

const DBQ = `${process.env.HOME}/.claude/oocm-refs/dbq-ro.sh`;
const KEY_FILE = `${process.env.HOME}/.claude/oocm-refs/meta-model-api.env`;
const PRICE_IN = 1.25 / 1e6, PRICE_OUT = 4.25 / 1e6;

// Real product code, built dist (the same code the pg tests run).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AGENT = require("../dist/services/meta/campaignAgent.js");
const LIVENESS = require("../dist/services/campaignLiveness.js");
const SAFETY = require("../dist/services/meta/safetyFlags.js");

export const DAYS: Array<[number, string]> = [
  [2701, "2026-10-15"], [2701, "2026-10-16"], [2701, "2026-10-17"],
  [2705, "2026-10-16"], [2705, "2026-10-17"],
  [2708, "2026-10-16"], [2708, "2026-10-17"], [2708, "2026-10-18"],
  [2700, "2026-10-16"], [2700, "2026-10-17"], [2700, "2026-10-18"], [2700, "2026-10-19"], [2700, "2026-10-20"],
  [2827, "2026-10-21"], [2827, "2026-10-22"], [2827, "2026-10-24"], [2827, "2026-10-26"], [2827, "2026-10-27"],
  [2828, "2026-10-21"], [2828, "2026-10-23"], [2828, "2026-10-25"],
  [2800, "2026-10-20"], [2800, "2026-10-22"], [2800, "2026-10-24"], [2800, "2026-10-26"],
  [2828, "2026-10-29"],
  [3123, "2026-10-30"], [3123, "2026-10-31"],
  [3138, "2026-10-29"], [3138, "2026-10-30"],
];

function q(sql: string): string[][] {
  const out = execFileSync(DBQ, [sql], { encoding: "utf8", timeout: 30000 });
  return out.split("\n").filter((l) => l.length > 0).map((l) => l.split(" | "));
}
const dayEndMs = (d: string) => Date.parse(`${d}T18:29:59.000Z`); // 23:59:59 IST
const before = (ts: string | null, end: number) => !!ts && Date.parse(ts) <= end;
const dstr = (ts: string | null) => (ts ? new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "");

function loadKey(): void {
  if (process.env.META_MODEL_API_KEY) return;
  for (const line of readFileSync(KEY_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) process.env[m[1]] = m[2];
  }
}

interface AppRow {
  id: number; creator: number; status: string; applied: string;
  onboarded: string | null; removed: string | null; completed: string | null;
  oneScore: number | null; aiFitAt: string | null;
}

// Status as of day-end, from row timestamps + admin audit transitions.
// approve->shortlisted, onboarded->active, reject->rejected, complete->completed,
// released->released, returned_to_applied->pending. No info -> pending.
function statusAsOf(a: AppRow, transitions: Array<{ action: string; at: string }>, end: number): { status: string; how: string } {
  if (!before(a.applied, end)) return { status: "excluded", how: "applied later" };
  const past = transitions.filter((t) => before(t.at, end)).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const map: Record<string, string> = {
    application_approve: "shortlisted", application_onboarded: "active",
    application_reject: "rejected", application_complete: "completed",
    application_released: "released", application_returned_to_applied: "pending",
  };
  if (past.length) {
    const last = past[past.length - 1];
    if (map[last.action]) return { status: map[last.action], how: `audit ${last.action} ${dstr(last.at)}` };
  }
  if (before(a.removed, end)) return { status: "rejected", how: `removed_at ${dstr(a.removed)}` };
  if (before(a.completed, end)) return { status: "completed", how: `completed_at ${dstr(a.completed)}` };
  if (before(a.onboarded, end)) return { status: "active", how: `onboarded_at ${dstr(a.onboarded)}` };
  return { status: "pending", how: "applied, no transition yet" };
}

export async function replayDay(campaignId: number, day: string): Promise<any> {
  const end = dayEndMs(day);
  const assumptions: string[] = [];
  const leakage: string[] = ["prod snapshot is read at replay time; rows deleted since (if any) are invisible"];

  // NOTE: name is selected LAST: names can contain the ' | ' separator.
  // Field set matches the product's loadLivenessInput (review R1): lock,
  // roster, deadline zone — the replay runs the same liveness path.
  const crows = q(`SELECT id, status, archived, approval_status, apply_by, timeline_end, budget, number_of_influencers, completed_at, auto_closed_at, is_demo, brand_id, paused_notice_at, platform, deadline_tz, is_done, name FROM campaign WHERE id = ${campaignId}`);
  if (!crows.length) throw new Error(`campaign ${campaignId} not found in prod`);
  const c = crows[0];
  const col = (i: number) => (c[i] === "" ? null : c[i]);
  const name = String(c[16]);
  const brandId = Number(c[11]);
  // Gate the day the way the drain does: only approved, live campaigns.
  if (col(3) !== "approved") throw new Error(`skip: approval ${col(3)}`);
  if (col(1) === "f" || col(1) === "false") throw new Error("skip: brand switched off (status=false)");
  if (col(2) === "t") throw new Error("skip: archived");
  if (before(col(8), end) || before(col(9), end)) throw new Error("skip: closed on/before this day");
  // Hold the clock at day-end for the WHOLE day: facts, the Today line in the
  // diagnose input, and validation. (Round 3 only mocked it around the phase
  // call, so the model saw the real today and misjudged every window.)
  // Restored in main's finally per day. Latency uses the real clock below.
  const realNow: () => number = Date.now;
  (globalThis as any).__replayRealNow = realNow;
  (Date as any).now = () => end;

  const brows = q(`SELECT subscription_tier, paywall_overridden FROM brand WHERE id = ${brandId}`);
  const brand = brows.length ? { subscription_tier: brows[0][0] || null, paywall_overridden: brows[0][1] === "t", last_seen_at: null, last_login: null } : null;
  leakage.push("brand tier/override/lock state is current, not as-of-day");
  const crow: any = {
    id: campaignId, name, status: col(1) !== "f", archived: false, approval_status: "approved",
    apply_by: col(4), timeline_end: col(5), deadline_tz: col(14), is_done: col(15) === "t" || col(15) === "true",
    budget: col(6), number_of_influencers: col(7),
    completed_at: before(col(8), end) ? col(8) : null, auto_closed_at: before(col(9), end) ? col(9) : null,
    is_demo: col(10) === "t", brand_id: brandId,
    paused_notice_at: before(col(12), end) ? col(12) : null, platform: col(13),
  };
  // Phase exactly the way the product derives it (clock already held above).
  const phase = LIVENESS.campaignLiveness(crow, brand).phase;

  const arows = q(`SELECT id, creator_id, status, applied_at, onboarded_at, removed_at, completed_at, one_score, ai_fit_at FROM campaign_application WHERE campaign_id = ${campaignId} ORDER BY id`);
  const apps: AppRow[] = arows.map((r) => ({
    id: Number(r[0]), creator: Number(r[1]), status: r[2], applied: r[3],
    onboarded: r[4] || null, removed: r[5] || null, completed: r[6] || null,
    oneScore: r[7] === "" ? null : Number(r[7]), aiFitAt: r[8] || null,
  }));
  const ids = apps.map((a) => a.id);
  const trows = ids.length ? q(`SELECT resource_id, action, created_at FROM admin_audit_log WHERE resource_type = 'application' AND resource_id IN (${ids.join(",")}) AND LEFT(action, 12) = 'application_' ORDER BY created_at`) : [];
  const trans = new Map<number, Array<{ action: string; at: string }>>();
  for (const r of trows) {
    const id = Number(r[0]);
    if (!trans.has(id)) trans.set(id, []);
    trans.get(id)!.push({ action: r[1], at: r[2] });
  }
  const live = apps.map((a) => ({ ...a, at: statusAsOf(a, trans.get(a.id) ?? [], end) })).filter((a) => a.at.status !== "excluded");
  // Applicant counts exclude demo/banned creators (review R8), the way the
  // product excludes them. Flags are current, not as-of-day: recorded below.
  const allCreators = [...new Set(live.map((a) => a.creator))];
  const fixture = new Set<number>();
  if (allCreators.length) {
    for (const r of q(`SELECT id, is_demo, apply_banned, banned_at FROM influencer WHERE id IN (${allCreators.join(",")})`)) {
      if (r[1] === "t" || r[1] === "true" || r[2] === "t" || r[2] === "true" || (r[3] || "") !== "") fixture.add(Number(r[0]));
    }
    if (fixture.size) leakage.push("demo/banned flags are current, not as-of-day");
  }
  const liveReal = live.filter((a) => !fixture.has(a.creator));
  const counts: Record<string, number> = {};
  for (const a of liveReal) counts[a.at.status] = (counts[a.at.status] ?? 0) + 1;
  const total = liveReal.length;

  // Fit: only scores stamped on/before the day (all null in this panel so far).
  const scored = liveReal.filter((a) => a.oneScore != null && before(a.aiFitAt, end));
  const bands: Record<string, number> = {};
  for (const a of scored) bands[a.oneScore! >= 75 ? "strong" : a.oneScore! >= 50 ? "ok" : "weak"] = (bands[a.oneScore! >= 75 ? "strong" : a.oneScore! >= 50 ? "ok" : "weak"] ?? 0) + 1;
  const futureScores = liveReal.filter((a) => a.oneScore != null && !before(a.aiFitAt, end)).length;
  if (futureScores) assumptions.push(`${futureScores} fit score(s) stamped after the day, excluded`);

  // Safety: current creator_fit_profile, per-creator freshness from creator_fit_at.
  // Demo/banned creators are excluded, the way the product excludes them.
  const creators = [...new Set(liveReal.filter((a) => ["pending", "shortlisted", "active"].includes(a.at.status)).map((a) => a.creator))];
  let safety: string[] = [];
  if (creators.length) {
    const prows = q(`SELECT id, creator_fit_profile, creator_fit_at, is_demo, apply_banned, banned_at FROM influencer WHERE id IN (${creators.join(",")})`);
    const reels: unknown[] = [];
    for (const r of prows) {
      if (r[3] === "t" || r[3] === "true" || r[4] === "t" || r[4] === "true" || (r[5] || "") !== "") continue;
      const at = r[2] || "";
      if (at !== "" && !before(at, end)) { leakage.push(`creator ${r[0]} fit profile scored ${dstr(at)}, after the day`); continue; }
      try {
        const prof = JSON.parse(r[1]);
        if (Array.isArray(prof?.reels)) reels.push(...prof.reels);
      } catch { /* unparsable profile: treated as no flags */ }
    }
    try { safety = SAFETY.distinctSafetyFlags(reels); } catch { safety = []; }
  }

  // Pieces as of day-end. Draft waiting = submitted on/before, not reviewed by day-end.
  // Demo/banned creators' pieces are fixtures, not work: excluded everywhere.
  const drows = q(`SELECT d.id, d.application_id, d.draft_status, d.draft_submitted_at, d.review_clock_at, d.created_at, d.due_at, d.content_status, d.reviewed_at, d.submitted_at, i.name, i.is_demo, i.apply_banned, i.banned_at FROM application_deliverable d JOIN campaign_application a ON a.id = d.application_id JOIN influencer i ON i.id = a.creator_id WHERE a.campaign_id = ${campaignId}`);
  const appById = new Map(live.map((a) => [a.id, a]));
  const waiting: Array<{ piece_id: number; creator: string; hours: number }> = [];
  let pastDue = 0, pastDueWaiting = 0;
  const silent: Array<{ piece_id: number; application_id: number; creator_id: number; creator: string; days_waiting: number; due_at: string | null }> = [];
  let fixtures = 0;
  for (const r of drows) {
    const app = appById.get(Number(r[1]));
    if (!app || app.at.status !== "active") continue;
    if (r[11] === "t" || r[11] === "true" || r[12] === "t" || r[12] === "true" || (r[13] || "") !== "") { fixtures++; continue; }
    const submitted = r[3] || "", clock = r[4] || "", created = r[5] || "", due = r[6] || "", reviewed = r[8] || "";
    const submittedAsOf = r[2] === "draft_submitted" || (submitted !== "" && before(submitted, end) && !before(reviewed, end));
    if (submittedAsOf) {
      if (!before(submitted || created, end)) continue;
      if (before(reviewed, end)) continue;
      const base = clock !== "" && before(clock, end) ? clock : submitted || created;
      waiting.push({ piece_id: Number(r[0]), creator: r[10] || "a creator", hours: Math.max(0, Math.round((end - Date.parse(base)) / 3600000)) });
    }
    if (due !== "" && before(due, end) && !(r[7] === "approved" || r[7] === "waived")) {
      if (r[7] === "approved" || r[7] === "waived") { assumptions.push(`piece ${r[0]} ${r[7]} with no review stamp: counted as still open`); }
      if (reviewed !== "" && before(reviewed, end)) continue;
      pastDue++;
      if (submittedAsOf) pastDueWaiting++;
    }
    const draftGone = submitted !== "" && before(submitted, end);
    // Quiet from onboarding (accepted), not application (review R3 parity).
    const quietSince = app.onboarded || app.applied;
    if (!draftGone && ((due !== "" && before(due, end)) || Date.parse(quietSince) <= end - 7 * 86400000)) {
      silent.push({ piece_id: Number(r[0]), application_id: app.id, creator_id: app.creator, creator: r[10] || "a creator", days_waiting: Math.max(0, Math.round((end - Date.parse(quietSince)) / 86400000)), due_at: due || null });
    }
  }
  waiting.sort((a, b) => b.hours - a.hours);
  if (fixtures) assumptions.push(`${fixtures} piece(s) from demo/banned creators excluded, as the product excludes them`);

  // Brand activity: reconstructed from brand-attributed events only (app/DB
  // last-seen is current-only and would leak, so it is omitted, not faked).
  const onboardBrand = apps.filter((a) => before(a.onboarded, end)).length;
  const brev: Array<{ at: string; what: string }> = [];
  if (onboardBrand) brev.push({ at: "", what: `${onboardBrand} brand onboarding(s) on record` });

  const fid = (id: string, label: string, detail: string) => ({ id, label, detail });
  const facts = [
    fid("phase", "Stage", `${name} is ${phase}.`),
    fid("applicants", "Applicants", total === 0
      ? `Nobody has applied yet (${Number(crow.number_of_influencers ?? 1)} creators wanted).`
      : `Applicants: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")} (${Number(crow.number_of_influencers ?? 1)} creators wanted).`),
    fid("fit", "Fit", scored.length === 0 ? "No fit scores yet."
      : `Fit of live applicants: ${Object.entries(bands).map(([k, v]) => `${v} ${k}`).join(", ")}. Strong means a good reel match for this brief.`),
    fid("safety", "Safety", safety.length === 0 ? "No safety flags on live applicants." : `Safety flags seen on applicants: ${safety.join(", ")}.`),
    fid("drafts_waiting", "Drafts waiting", waiting.length === 0 ? "No drafts waiting on the brand."
      : `${waiting.length} draft${waiting.length === 1 ? "" : "s"} waiting on the brand: ${waiting.slice(0, 3).map((w, i) => `Creator ${i + 1} (${w.hours}h)`).join(", ")}${waiting.length > 3 ? ", and more" : ""}.`),
    fid("pieces_past_due", "Past due", pastDue === 0 ? "Nothing past its date." : `${pastDue} piece${pastDue === 1 ? "" : "s"} past ${pastDue === 1 ? "its" : "their"} date and still not delivered.`),
    fid("silent_creators", "Quiet creators", silent.length === 0 ? "Every active creator has sent something or is still in time."
      : `${silent.length} creator${silent.length === 1 ? "" : "s"} quiet: ${silent.slice(0, 3).map((s, i) => `Creator ${i + 1} (${s.days_waiting}d)`).join(", ")}${silent.length > 3 ? ", and more" : ""}.`),
    fid("brand_activity", "Brand activity", brev.length === 0
      ? "No brand-attributed action on this campaign up to this day (reconstructed; app last-seen is not time-travelable and is omitted)."
      : `Brand-attributed actions up to this day: ${brev.map((b) => b.what).join("; ")} (reconstructed; app last-seen omitted).`),
    fid("apply_by", "Apply by", crow.apply_by ? `Creators can apply until ${dstr(crow.apply_by)}.` : "No apply-by date set."),
    fid("budget", "Budget", crow.budget ? `The stated budget is ${String(crow.budget)}.` : "No budget stated on the campaign."),
    fid("agent_history", "Recent agent work", "The agent did not exist yet; no agent history."),
  ];
  const wanted = Number(crow.number_of_influencers ?? 1);
  const applyDaysLeft = crow.apply_by == null ? null : Math.ceil((Date.parse(crow.apply_by) - end) / 86400000);
  const snapshot: any = {
    campaign_id: campaignId, campaign_name: name, phase, facts,
    applicants: counts, wanted, waiting_drafts: waiting, pieces_past_due: pastDue,
    past_due_waiting: pastDueWaiting,
    silent_pieces: silent, overdue: pastDue > 0 || waiting.some((w) => w.hours >= 48),
    apply_days_left: applyDaysLeft,
    apply_window_open: crow.apply_by == null ? null : Date.parse(crow.apply_by) >= end,
  };
  snapshot.hash = AGENT.hashFacts(snapshot);

  const runs: Array<Record<string, unknown>> = [];
  const nRuns = (globalThis as any).__replayRuns ?? 3;
  for (let i = 0; i < nRuns; i++) {
    const t0 = ((globalThis as any).__replayRealNow as () => number)();
    const r = await AGENT.diagnoseWithRetry(snapshot);
    const ms = ((globalThis as any).__replayRealNow as () => number)() - t0;
    const usage = r.usage ?? {};
    const cost = (usage.input_tokens ?? 0) * PRICE_IN + (usage.output_tokens ?? 0) * PRICE_OUT;
    const validation = AGENT.validateDiagnosis(snapshot, r.diagnosis);
    // Score what the CODE would do (eval E1), not the raw pick: the gates run
    // here exactly as in production (backupCount unknown in replay, so the
    // audience refusal cannot fire — recorded). The brand line is built from
    // the gated action with the cited ids, the way the product builds it.
    const gated = AGENT.gateAction(snapshot, r.diagnosis.action, null);
    const gatedAction = validation.ok ? gated.action : r.diagnosis.action;
    const brandLine = gatedAction === "tell_brand" ? AGENT.buildBrandLine("tell_brand", snapshot, r.diagnosis.fact_ids ?? [])
      : gatedAction === "show_backups" ? "show_backups:<live backup count> more creators fit this brief — worth a look before you decide."
      : null;
    runs.push({
      model: r.model, usage, cost_usd: cost, latency_ms: ms, attempts: r.attempts,
      diagnosis: r.diagnosis, validation, brand_line: brandLine,
      gated_action: gatedAction, gated_from: validation.ok ? gated.gatedFrom : null,
      gate_why: validation.ok ? gated.gateWhy : "",
    });
    if (i < nRuns - 1) await new Promise((r2) => setTimeout(r2, 500));
  }
  return {
    campaign_id: campaignId, campaign_name: name, day, phase, facts_hash: snapshot.hash,
    facts: facts.map((f) => ({ id: f.id, detail: f.detail })),
    applicants: counts, wanted, apply_days_left: applyDaysLeft,
    waiting_drafts: waiting.length, pieces_past_due: pastDue, past_due_waiting: pastDueWaiting,
    silent_pieces: silent.length, overdue: snapshot.overdue,
    runs, assumptions, leakage,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const days: Array<[number, string]> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--day" && args[i + 1]) {
      const [cid, d] = args[++i].split("=");
      days.push([Number(cid), d]);
    } else if (args[i] === "--all") days.push(...DAYS);
  }
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : `${process.env.HOME}/OOCM-hackathon/eval/agent`;
  const runsIdx = args.indexOf("--runs");
  (globalThis as any).__replayRuns = runsIdx >= 0 && Number(args[runsIdx + 1]) > 0 ? Math.min(5, Math.floor(Number(args[runsIdx + 1]))) : 3;
  if (!days.length) { console.error("usage: agent-replay.ts --day CID=YYYY-MM-DD [--day ...] | --all [--out DIR] [--runs N]"); process.exit(2); }
  loadKey();
  mkdirSync(outDir, { recursive: true });
  let spend = 0;
  for (const [cid, d] of days) {
    try {
      const res = await replayDay(cid, d);for (const run of res.runs) spend += Number((run as any).cost_usd ?? 0);
      writeFileSync(`${outDir}/run-${cid}-${d}.json`, JSON.stringify(res, null, 2));
      const acts = res.runs.map((run: any) => `${run.diagnosis.action}${run.gated_action !== run.diagnosis.action ? `=>${run.gated_action}` : ""}${run.validation.ok ? "" : "!"}`).join("/");
      const atts = res.runs.map((run: any) => run.attempts).join("/");
      console.log(`${cid} ${d} ${res.phase} [${acts}] attempts=${atts} $${res.runs.reduce((a: number, run: any) => a + Number(run.cost_usd ?? 0), 0).toFixed(5)} model=${(res.runs[0] as any).model}`);
    } catch (e: any) {
      console.log(`${cid} ${d} SKIP ${e?.message ?? e}`);
    } finally {
      if ((globalThis as any).__replayRealNow) (Date as any).now = (globalThis as any).__replayRealNow;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`SPEND $${spend.toFixed(4)} over ${days.length} requested day(s)`);
}

if (require.main === module) void main().catch((e) => { console.error(e); process.exit(1); });
