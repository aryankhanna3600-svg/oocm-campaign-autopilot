# Agent replay eval — round 1, pre-review-fix code (31-Oct)

20 campaign-days attempted, 18 scored, 2 systematically unscorable. Real
`diagnoseWithModel` + `validateDiagnosis` from built dist (API 6012f9c8), facts
rebuilt read-only from prod via dbq-ro.sh, no act, no writes. Labels in
labels.json/labels.md (hand-written from notification + audit + timestamp rows).
This round tests the shipped Step-7 code; round 2 reruns after the review fixes.

## Scoreboard (18 days)

| day | action | spotted | match | invalid | false alarm | lead |
|---|---|---|---|---|---|---|
| 2701 10-15 | show_backups | 1 | 0 | 0 | 0 | 3 |
| 2701 10-16 | show_backups | 1 | 0 | 0 | 0 | 2 |
| 2701 10-17 | show_backups | 1 | 0 | 1 (caught: no evidence) | 0 | 1 |
| 2705 10-16 | show_backups | 1 | 1 | 0 | 0 | 3 |
| 2705 10-17 | show_backups | 1 | 1 | 0 | 0 | 2 |
| 2708 10-16 | show_backups | 0.5 | 0 | 0 | 0 | 3 |
| 2708 10-17 | show_backups | 0.5 | 0 | 0 | 0 | 0 |
| 2708 10-18 | show_backups | 0.5 | 0 | 0 | 0 | 1 |
| 2700 10-17 | show_backups | 1 | 1 | 0 | 0 | 4 |
| 2700 10-19 | show_backups | 1 | 1 | 0 | 0 | 2 |
| 2700 10-20 | show_backups | 1 | 1 | 0 | 0 | 1 |
| 2827 10-22 | show_backups | 0.5 | 1 | 0 | 0 | 6 |
| 2827 10-26 | show_backups | 0.5 | 0 | 0 | 0 | 2 |
| 2827 10-27 | show_backups | 0.5 | 0 | 0 | 0 | 1 |
| 2828 10-25 | tell_brand | 1 | 0 | 1 (caught: wrong phase) | 0 | — |
| 3123 10-30 | flag_admin | 0.5 | 0 | 0 | 0 | — |
| 3123 10-31 | tell_brand | 1 | 1 | 0 | 0 | — |
| 3138 10-30 | flag_admin | 0.5 | 0 | 0 | 0 | — |

- Spotted: 10 full + 8 partial = 0.78. The diagnosis almost always names the true
  stuck thing; partials miss the second half (visit logistics, rejection wave,
  paused state, negotiation queue behind a safety flag).
- Action match: 7/18. `show_backups` is a monoculture: 15 of 19 outputs (smoke
  included). On zero-applicant venue-brand days it offers "backup creators" while
  the brand-side problem (an unresponsive brand, event tomorrow) goes unaddressed. `none` and
  `nudge_creators` never fired — the panel has no healthy days and no silent
  pieces, so both dimensions are untested, not failed.
- Invalid: 2, both caught by validate (empty citations; tell_brand in brand_paused)
  and routed admin. Zero wrong-audience messages in 18 days.
- False alarms: 0.
- Lead: median 2 days before the human acted (14 labelable days; best 6 on 2827).
- Venue-brand wind-down: spotted 1.0 on all 6 scored days, 1–3 days before auto-close.

## Cost (verifies the design's under-1¢ claim)

muse-spark-1.3, 629–667 in / 316–598 out per call, $0.0021–0.0034 each.
Round total $0.0482 (18 files) + smoke $0.0028 = $0.051. Budget left: ~$4.95.

## Failures and artifacts (honest list)

1. Truncation: 8 of 27 attempts died `max_output_tokens` at the 600 cap; 2828/10-23
   and 2827/10-24 failed 3/3 attempts each and are unscored. Complex days go blind,
   and retry-tomorrow would repeat-blind. Failed attempts' tokens are unknowable
   (error carries no usage) and excluded from spend.
2. Non-determinism: 3138/10-30 same facts → show_backups (smoke) then flag_admin.
   Both defensible; the action is not stable run to run.
3. Harness date bug (fixed, not rerun): dates rendered in UTC, so apply_by showed a
   day early (2700: "until 10-18" for a 10-19 IST deadline). Phase derivation used
   raw values and is unaffected. Fixed to Asia/Kolkata in agent-replay.ts; round 2
   reruns with correct dates.
4. Reconstruction limits, per-day in each JSON: brand app last-seen is current-only
   (omitted; brand_activity rebuilt from brand-attributed audit/app rows); safety
   uses current creator_fit_profile unless stamped after the day (residual risk: flag
   TEXT timing for unstamped profiles is unverifiable); fit untested (one_score null
   across the panel); brand tier/lock state is current; deleted rows invisible.
5. Raas Navratri 2696 is not in prod (no such id, no Raas/Navratri name) — the 7-Oct
   review's campaign id does not resolve. Substituted with the 8 venue-brand days
   plus live arcs; see labels.md evidence cites.
6. Brand lines in these outputs are free model text (review B1: code-built from
   round 2 on). No prompt was tuned on these days; product code untouched this round.

## Files

run-<cid>-<day>.json (18) · labels.json + labels.md (hand labels + evidence) ·
scripts/agent-replay.ts (API worktree, committed) · this file.

## Label freeze (round 2 hygiene, 31-Oct)

labels.json sha256 466c29043067911e055a9084a08d13f1c24b1e9836459a0c9d0ae918602db6bf;
labels.md sha256 43236159589acc4ea0fc9f28d948369657d841338aabf7fda08e792190b69815.
Frozen as-is before round 2: written from prod evidence before any round-1 output
was viewed (only the 3138 smoke predates them), and unchanged after scoring.
New healthy/silent days get labels before their outputs are viewed. Full label
text is in labels.md (spot-check doc); machine labels in labels.json.
Holdout from prompt tuning: 2700/10-20, 2708/10-18, 2827/10-27, 3123/10-31,
3138/10-30 — reported apart in round 2. Wording: client names/sentiment scrubbed
per house rule ("a live venue brand"); numeric ids retained for reproducibility.

## Rounds 2–4 (31-Oct, fixed code, 30 days × 3 runs)

Round 2 ran on the review-1-fixed code and scored 8 full + 7 partial / 30 —
then inspection invalidated it: the model was judging windows against its
assumed date (real today, 31-Oct) instead of the replayed day, e.g. reading
apply_by 10-19 as passed on 10-16. That exposed TWO real product bugs, fixed
and pg-proven (API commits ee9c370c + 28fb501e, 23/23 tests):
- B8 (new): the diagnose input never stated the date. Now a Today line
  (Date.now — real in prod) is prepended, input-only, never in facts/hash;
  prompt judges dates only against it. Proving pg test asserts the line.
- B9 (new): apply_days_left ticks daily inside the hashed snapshot, so the
  done-only hash-skip could never fire on dated campaigns. Hash now covers
  the apply_window_open boolean (flips exactly on crossing) instead.
Round 3 re-ran but the harness only mocked the clock around the phase call —
the Today line still carried the real date. Round-3 files are kept under
round2/ (round 2) and round3/ (round 3) for the record; neither is scored.
Round 4 (valid clock held the whole day) is the scored round.

Round-4 scoreboard (30 days, labels frozen + one documented correction):
- Action-match: 9 full + 7 partial / 30 (weighted 0.42). Main-25: 7/6/12.
  Holdout-5 reported apart: 2 full (2827/10-27, 3123/10-31), 1 part
  (2700/10-20), 2 miss — same shape as main, no overfit signal.
- Validity: 6 invalid outputs, ALL caught by validate (0 wrong-audience):
  tell_brand ×3 in brand_paused (2828/10-25), tell ×2 + show ×1 in
  brand_paused (2828/10-29). The 3 numberless fallback brand lines in the
  audit sit on those failed-validation runs — they render nowhere.
- Stability: 20/30 days identical across 3 runs.
- False alarms: 6/6 healthy days drew non-none actions (mostly
  show_backups on thin-but-live funnels, one tell pair on 2828/10-21).
  No admin page fired on any healthy day; the noise is brand-surface.
- Lead: 3d on all three dated campaigns (2701, 2705, 2708).
- Retries: 2 (truncation retry working); spend $0.2796 ($0.0093/day).
- Brand lines: 25 tell (all carry numbers) + 35 show templates, code-built.
Honest misses: event-day flag_admins where labels say tell/nudge
(2701/10-16, 2705/10-17, 2708/10-17/18 — judgment calls, stable);
show_backups where the funnel-not-brand rule points at tell/flag
(2828/10-23); 3138/10-30 where the never-show-after-close rule
contradicts the label — the rule is product-correct, the label is
debatable, recorded as miss. No prompt was tuned on these days; the
Today/window fixes were product bugs with pg proofs, not label-chasing.
Round-2 files: round2/ (18+12 files, wrong-date model). Round-3: round3/.
Scored round-4: run-<cid>-<day>.json (30) in this dir.

## Label correction (documented, 31-Oct)

2828/2026-10-29 good was ["none","tell_brand"], written from the quiet-piece
evidence while missing the phase: the campaign is brand_paused that day, so
tell_brand is invalid by validation. Corrected to ["none","flag_admin"] with
evidence citing the phase. Round-1 labels untouched. Current freeze:
labels.json 5ae27c46… / labels.md f2865137… (full hashes: shasum above).
