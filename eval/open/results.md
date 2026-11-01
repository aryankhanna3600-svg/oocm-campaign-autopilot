# Step 8 — open-weight lane vs Spark API (1-Nov-2026)

Model: `accounts/fireworks/models/muse-spark-open` via Fireworks, 16 frames max
(512px, 1fps) + the API run's transcript. Every request under 20K prompt tokens
(max seen 9,886). Numbers as they are — no tuning.

**Item 1 fix** (`scripts/open-eval.ts`): must-say now requires an exact quote
(`brand_quote`, `low_sugar_quote`) checked against the transcript in code with
`transcriptSupport >= 0.6` — the API lane's own gate (`check.ts:428`). A bare
`said:true` with no supporting quote fails; a brand visible on screen but not
spoken still counts (same allowance the API lane gives `shown_on_screen`).

Proof it mattered — low-sugar line, API lane says FAIL on all 8 tagged reels:

| lane | reels saying "low in sugar" said |
|---|---|
| old lenient bools (`open-results.json`) | 6/8 True (all wrong) |
| strict quote gate (`open-results-step8.json`) | 0/8, agrees with API 8/8 |

## Tagged reels (8) — agreement with Spark API

| reel | brand | disclosure | product | low-sugar | other brands |
|---|---|---|---|---|---|
| Creator 3 | pass/pass | fail/fail | fail/False | fail/False | 4/4 overlap (open +1 extra: Subway) |
| Creator 6 | pass/pass | fail/fail | needs_review/False | fail/False | 4/4 |
| Creator 1 | pass/pass | fail/fail | fail/False | fail/False | 4/4 ("Sleepy Owl" vs "Sleepy Owl Coffee") |
| Creator 2 | pass/pass¹ | fail/fail | fail/False | fail/False | 4/4 |
| Creator 4 | pass/pass | fail/fail | fail/False | fail/False | 2/2 (case only) |
| Creator 5 | pass/pass¹ | fail/fail | **pass/False** | fail/False | 3/3 |
| Creator 7 | pass/pass | fail/fail | **pass/False** | fail/False | 4/4 (case only) |
| Creator 8 | pass/pass | fail/fail | pass/True | fail/False | 4/4 ("Third Wave" vs "Third Wave Coffee") |

¹ quote support 0 — passed on the on-screen allowance, not speech. With a pure
transcript gate these two read fail; the API lane passes them (said or shown).

Totals: brand 8/8 · disclosure 8/8 · low-sugar 8/8 · product 5/8 strict
(6/8 counting needs_review as non-pass) · other-brands full overlap 8/8 with
one open-only extra (Subway) and naming truncations. The two product misses
are frames-only blindness: the open lane has no SAM tracker, so a product the
API passes via tracking reads absent in stills.

## Synthetic reels (3) — new API baselines + open lane

No API baseline existed, so `scripts/synth-baseline.ts` (new, committed) ran
the API lane with the same Sorry Sugar brief → `synthetic/api-results-step8.json`
(new file). Note: these videos were built for the Dewdrop brief, so "Sorry
Sugar" lines are absent by construction — agreement, not capability, is the read.

| reel | brand | disclosure | product | low-sugar | other brands |
|---|---|---|---|---|---|
| good.mp4 | fail/False | pass/pass | fail/False | fail/False | Dewdrop/Dewdrop |
| bad.mp4 | fail/False | fail/fail | fail/False | fail/False | Lumen Skin/Lumen skin |
| hindi.mp4 | fail/False | pass/pass | fail/False | fail/False | Dewdrop/Dewdrop |

11/11 agree (API product=fail everywhere here — the Sorry Sugar cup is in none
of them; the open lane correctly sees no cup rather than hallucinating one).

## Cost and seconds per video (open lane, Fireworks)

| video | in-tokens | out-tokens (of which reasoning) | seconds |
|---|---|---|---|
| Creator 3 | 6,393 | 1,479 (1,394) | 15.2 |
| Creator 6 | 9,878 | 1,283 (1,201) | 13.0 |
| Creator 1 | 9,883 | 1,092 (1,006) | 20.7 |
| Creator 2 | 8,124 | 2,298 (2,210) | 42.3 |
| Creator 4 | 9,886 | 902 (813) | 8.9 |
| Creator 5 | 5,765 | 1,721 (1,636) | 24.7 |
| Creator 7 | 5,817 | 2,095 (2,008) | 24.7 |
| Creator 8 | 6,370 | 1,399 (1,319) | 24.6 |
| good.mp4 | 8,724 | 364 (294) | 9.8 |
| bad.mp4 | 6,373 | 444 (374) | 5.2 |
| hindi.mp4 | 7,564 | 487 (417) | 9.2 |
| **total (11)** | **84,777 in** | **12,563 out** | **198.3s, mean 18.0s** |

$ cost = tokens above at the Fireworks serverless list price (not converted
here — no price table consulted). Reasoning is 85–95% of output tokens.
API-lane comparison (synthetic baselines): Spark 6,592–8,252 tokens + SAM
249–350 frames + Voice Transcribe per 10–14s video.

## Files

- `oocm-campaign-autopilot/scripts/open-eval.ts` — quote gate + `--out` (old
  `open-results.json` untouched).
- `oocm-campaign-autopilot/scripts/synth-baseline.ts` — new, API baselines.
- `test-reels/tagged/open-results-step8.json` — new, next to the old ones.
- `synthetic/api-results-step8.json`, `synthetic/open-results-step8.json` — new.
- One transient stall (240s fetch abort on the first attempt, 16-frame
  request) cleared on retry; all 11 final requests completed first try.
