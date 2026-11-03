# OOCM Campaign Autopilot

A business pastes its website. Meta's models run the whole creator campaign: they write the brief, choose creators, and check every draft video against the brief, with proof, before the brand sees it.

OOCM ([outofcontextmarketing.com](https://outofcontextmarketing.com)) is a live creator-marketing platform. This repository holds **only the code written during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026)**. It plugs into OOCM's existing product, which was built before the event and is not part of this submission.

## The problem

Brands pay creators for videos, then watch the wrong thing go live: the brand name unsaid, the disclosure missing, a competitor's product on screen. Checking every draft by hand does not scale past a handful of creators — and OOCM is built for lakhs of them with one operator. So the checking itself has to be software: watch the video, listen to it, track the product through it, and pass a draft only when two independent sources agree it meets the brief. When they disagree, a person decides — the machine never guesses.

## What was built during the event

Every commit below is in this repo's history (`git log`):

| date | commit | what |
|---|---|---|
| 28-Oct | `760fb07` | Meta Model API client and the draft checker (Spark + Voice Transcribe + SAM) |
| 28-Oct | `62b124b` | Brief reader, usage totals, rules no longer repeat must-say lines |
| 28-Oct | `f8d6b8a` | Harden ffmpeg: time limits, real video containers only, file-path input |
| 28-Oct | `47ec8c8` | Caption counts for disclosure, on-screen brand counts as a mention, other brands listed (not failed) |
| 28-Oct | `7af0ea6` | Creator fit: Spark watches a creator's reels, builds a profile, scores fit against a brief |
| 28-Oct | `2100c16` | Open-weight lane: Muse Spark Open on any OpenAI-compatible host (frames + transcript); readable labels on checks |
| 28-Oct | `2f11044` | Open-weight eval: Muse Spark Open on Fireworks vs Spark API, same frames + transcript, 8 real reels |
| 28-Oct | `3d6a7e2` | Report numbers: product seconds on screen, first brand mention, disclosure |
| 29-Oct | `297dfcb` | Builder Meta modules: client strict/tools/timeout, image doors + photo fetch, runStructuredMeta, zodJson |
| 29-Oct | `805e89d` | Review fixes 1–2: drop naive photo fetch, zod descriptions off schema object |
| 29-Oct | `94dbbda` | Review fixes 3+8: per-call Meta budget, web-search cost |
| 30-Oct | `5a444b7` | Flagged reels are never positive evidence (withheld from prompt, flags stay) |
| 1-Nov | `76d17a9` | Step 8: strict must-say quotes in the open lane + synth baseline script |
| 2-Nov | `546f0e5` | Builder: 150 s Muse budget before Claude fallback — API PR #479 |
| 2-Nov | `bd6a0d8` | Meta client: read last message, not first — API PR #480 |
| 3-Nov | `f1f1673` | Builder: one design run at a time, reload-safe — API PR #485 (only the diff: `patches/pr485-builder-session.diff`) |
| 3-Nov | `8ea3419` | Builder: design again with own numbers, honest notices — API PR #486 (new file `src/builder/rules.ts`; changes to older files only as `patches/pr486-builder.diff`) |
| 3-Nov | `2df849e` | Draft check: 500 MB cap, ffmpeg 480 s, don'ts scored, product-name fallback — API PR #487 |
| 3-Nov | `05faf2e` | Admin: re-run AI draft check on a piece already with the brand — API PR #488 |
| 3-Nov | `a0406be` | AI check card in chat — Web PR #150, App PR #65 |

On top of that, the production Meta-model code written in the same window was copied here verbatim (see "Live code, wired into OOCM"): `src/meta/` (draftCheckQueue, creatorFitRunner, liveCheck, oneScore, pulseReels, safetyFlags), `src/discover/creatorsForYou.ts`, `src/agent/campaignAgent.ts` (`scripts/agent-replay.ts` is also production code but was not recopied in this round — unchanged since 1-Nov).

## Runtime models

Every model this project calls at runtime is a Meta model: Muse Spark 1.3, Muse Voice Transcribe 1.0 and SAM 3.1 on the Meta Model API, Muse Image for the storyboard, and Muse Spark Open on Fireworks for the open-weight lane.

One disclosed exception: `src/builder/modelPath.ts` is the switch that moves OOCM's pre-existing campaign builder onto Muse. If a Muse call fails, or the monthly Meta budget cap is reached, that one call falls back to OOCM's older builder model, and the fallback is logged. The demo campaign (3457, builder session 178) ran on Muse Spark 1.3 at every step, with no fallback. Since 4-Nov the live builder on outofcontextmarketing.com runs on Muse for every brand (checked the same day: a fresh build ran research, options, review on Muse Spark 1.3 and the storyboard on Muse Image, with no fallback in the logs).

## Meta models and their real job

| model | real job in this repo |
|---|---|
| `muse-spark-1.3` | Watches the draft video (frames + soundtrack) and answers every brief check with the second and the words; second text-only pass must copy the exact quote that proves each said line; watches creator reels to build fit profiles; writes campaign briefs; the campaign agent's diagnose + validate calls |
| `muse-voice-transcribe-1.0` | Independent transcript of what is said, primed with the brief's brand names and codes so "DEW10" is not heard as "DU10" |
| `sam-3.1` | Tracks the product through the video, so "product on screen" comes with frame-accurate boxes |
| `accounts/fireworks/models/muse-spark-open` (via Fireworks) | The open-weight comparison lane: same 16 frames + the API run's transcript, judged field by field against the Spark API |

The client also records web-search tool calls when the API reports them, and every call is metered against a per-call and monthly Meta budget.

## Architecture in plain words

1. **Brief.** The brand's site becomes a brief: brand, product, lines that must be said, things that must be shown, competitors, whether disclosure is required.
2. **Fit.** Spark watches each creator's past reels, writes a short profile (what they talk about, on-screen style, audience signals), and scores fit against the brief — so the brand shortlists from evidence, not follower counts.
3. **Check.** For every draft: Spark watches, Voice Transcribe listens, SAM locates the product. A verdict passes only when two independent sources agree; disagreement goes to a person as "needs review".
4. **Watch.** After launch, a daily agent replays each campaign day from read-only facts, spots what is stuck (silent creators, rejection waves, unresponsive brands), and drafts the exact message for the right audience — brand, creator, or admin. A validator kills any message with no evidence or the wrong audience before it can send.

## Live code, wired into OOCM

These files are the production code, copied verbatim — they import OOCM internals (database entities, queues, admin rails) so **they will not build or run in this repo**. They are here so judges read the real thing, not a rewrite:

- `src/meta/draftCheckQueue.ts` — drains the draft-check queue: approves, rejects, or notifies, then promotes or reaps each piece.
- `src/meta/creatorFitRunner.ts`, `src/meta/liveCheck.ts`, `src/meta/oneScore.ts`, `src/meta/pulseReels.ts`, `src/meta/safetyFlags.ts` — fit runner, live-campaign checks, the single creator score, pulse-reel scoring, safety flags.
- `src/discover/creatorsForYou.ts` — creator discovery for brands.
- `src/agent/campaignAgent.ts`, `scripts/agent-replay.ts` — the daily campaign agent and its read-only replay harness.

Everything else here runs standalone (see "How to run"): `src/meta/client.ts`, `src/draftCheck/`, `src/creatorFit/`, `src/meta/openWeight.ts`, and `scripts/` except `agent-replay.ts`.

## What is live in production and what is behind flags

Merge state is from `origin/main` of the OOCM API repo; gating is from the code comments. Whether each flag is currently ON in prod is not recorded here.

- **Draft-check queue** — merged 28-Oct. Off unless `META_DRAFT_CHECK_ENABLED=true`, and then only for campaigns in the `META_DRAFT_CHECK_CAMPAIGNS` allow-list.
- **Creator fit** — merged 28-Oct. Behind `META_CREATOR_FIT_ENABLED`, with a per-day cap.
- **Live check** — merged 28-Oct. Behind `META_LIVE_CHECK_ENABLED`.
- **Creators-for-you** — merged 30-Oct. Behind `META_CREATORS_FOR_YOU_ENABLED`.
- **One score / safety flags / pulse reels** — merged 31-Oct–1-Nov, behind their flags.
- **Campaign agent** — merged to `origin/main` (API PR #469). Advice only to admin — never sends on its own. On the strict replay test it scored 3 of 8. Evaluated here under `eval/agent/`.

## Eval results, as they are

Creator handles in result files are scrubbed to Creator 1–68. No videos are included. Numbers below are copied from the results files; limits are stated where the files state them.

**Open-weight lane vs Spark API** (`eval/open/results.md`) — 8 real reels + 3 synthetic, 11 requests, no tuning:

- Agreement with the API: brand 8/8, disclosure 8/8, low-sugar line 8/8, product 5/8 strict (6/8 counting needs_review as non-pass), other-brands full overlap on all 8 with one open-only extra and naming truncations.
- The strict quote gate mattered: the old lenient lane said "low in sugar" was spoken in 6/8 reels (all wrong); the strict gate reads 0/8 and agrees with the API 8/8.
- The two product misses are frames-only blindness: the open lane has no SAM tracker, so a product the API passes via tracking reads absent in stills.
- Synthetic reels (built for a different brief, so the Sorry Sugar lines are absent by construction): 11/11 agree.
- Cost: 84,777 prompt tokens in, 12,563 out (85–95% of it reasoning), 198.3s total, mean 18.0s per video. Every request under 20K prompt tokens (max seen 9,886); one transient 240s stall cleared on retry.

**Campaign-agent replay** (`eval/agent/`) — read-only facts rebuilt from prod, real diagnose + validate calls, no act, no writes:

- Round 1 (18 scored days): spotted the stuck thing 10 full + 8 partial (0.78); action matched the label 7/18; 2 invalid outputs, both caught by validation (zero wrong-audience messages); 0 false alarms; median lead 2 days before the human acted. Cost $0.051 total ($0.0021–0.0034 per call). Limit: 8 of 27 attempts died on the 600-token cap — complex days go blind.
- Round 4 (30 days, fixed code, frozen labels): action match 9 full + 7 partial / 30 (weighted 0.42); 6 invalid outputs, all caught; 20/30 days identical across 3 runs; 6/6 healthy days drew brand-surface noise (no admin page fired); lead 3 days on the three dated campaigns; spend $0.2796 ($0.0093/day).
- Round 2/3 files are kept unscored (a wrong-date bug, then a half-fixed clock). The bug hunt exposed two real product bugs, fixed with pg tests. E2 follow-up: 9/9 final outcomes in-label.

**Brief builder** (`eval/builder/compare.html` + `frames/`, 10 MB) — same 10 brands, 3 ideas each, Claude vs Muse side by side with frames. Muse $1.39 vs Claude $5.81 on the 9 brands both completed. Read across and pick which you would send.

## How to run

Needs Node 22.18+ (runs TypeScript directly) and ffmpeg. The runnable lane calls the Meta Model API (`META_MODEL_API_KEY`) except the open lane, which uses any OpenAI-compatible host (`OPEN_BASE_URL` / `OPEN_API_KEY`):

```bash
export META_MODEL_API_KEY=...
node scripts/check.ts path/to/draft.mp4        # check a draft against the demo brief
node scripts/fit.ts path/to/reels/            # profile reels, score fit against briefs
node scripts/sam.ts clip.mp4 "the coffee cup" # track a product through a clip
node scripts/probe.ts clip.mp4                # raw client probe: upload + transcribe + respond + segment
OPEN_API_KEY=... node scripts/open-eval.ts test-reels/tagged/results-v2.json clip.mp4 --out my-run.json
```

`test-reels/tagged/*.json` are the API-lane results the open lane is judged against (filenames scrubbed to `creator-N…mp4`; videos not included). `synthetic/*.json` are API baselines for the three synthetic clips. The `src/meta/*Queue|Runner|liveCheck|oneScore|pulseReels|safetyFlags`, `src/discover/`, `src/agent/`, and `scripts/agent-replay.ts` files are live production code and do not run here.

## Live numbers

The first real creator draft checked on the live server was on 3-Nov — a 63-second, 190 MB reel from a creator. Muse Spark 1.3, Voice Transcribe and SAM ran 9 checks (product on screen, must-say line, must-show app, disclosure, competitors, other brands, three don'ts); all 9 passed.

The OOCM app was on screen for 35.3 seconds of the 63.3-second video from 0:07, tracked by SAM; the brief line "OOCM, the new social media where you get paid" was heard at 0:15 (verified by transcript + Spark); #ad disclosure was in the video and the caption; all three don'ts passed. Total check time about 4.5 minutes, cost $0.37.

Separately, campaign 3457 was built by Muse Spark 1.3 end to end, at a cost of $0.42.

## Who wrote what

The code was written with Claude Code, by one founder working with AI. From 31-Oct, Claude Code ran on Meta's Muse models for the main builds (Spark 1.3 on the Meta API, Spark Open on Fireworks): Door 1 (creator-first draft check), the campaign agent, and the AI check card in the chat on web and app. The first draft checker and creator fit (27-28 Oct), the builder fixes (2-3 Nov), the admin re-check and all review fixes were written by Claude Opus. Every model the product calls at runtime is a Meta model (see Runtime models).

## Built before the event, not part of this submission
The builder's core files (`options.ts`, `session.ts`, `notify.ts`) were written on 14-Oct, before the hackathon. They are not in this repo. The hackathon changes to them are in `patches/` as plain diffs, so only the new work is shown.
