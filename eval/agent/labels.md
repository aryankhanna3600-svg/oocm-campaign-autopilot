# Labels — hand-written 31-Oct from prod evidence only (notification rows,
admin_audit_log, application/deliverable timestamps pulled via dbq-ro.sh).
Each label cites the evidence; none is tuned to any model output. Ground truth
= what was actually stuck that day + the date a human/system acted on it.

## 2701 Sufi Night, live venue brand M3M (brand 560) — 0 applicants, event Fri 16 Oct
- 2026-10-15 (launch): PROBLEM event-tomorrow-zero-applicants. EVID notified_creators=4
  (brief_approve audit), 0 applications ever. HUMAN none until auto-close 10-18.
  GOOD tell_brand|flag_admin.
- 2026-10-16 (event day): PROBLEM event-today-zero-applicants. EVID 0 apps, no notification
  of any kind this day. HUMAN none. GOOD tell_brand.
- 2026-10-17 (day after event): PROBLEM dead-campaign-still-live (apply_by 10-16 passed,
  event over, 0 apps). HUMAN campaign_auto_closed 10-18 (audit, released=0). GOOD tell_brand|flag_admin.

## 2705 Unplugged, live venue brand Central Plaza — 1 applicant, event Sat 17 Oct
- 2026-10-16: PROBLEM one-applicant-for-5-slots-event-tomorrow. EVID 1 app applied 10-16,
  new_application notifs to admin+brand. HUMAN auto-close 10-19 (released=1). GOOD tell_brand|show_backups.
- 2026-10-17 (event day): PROBLEM event-today-one-applicant. EVID no activity rows this day.
  HUMAN auto-close 10-19. GOOD tell_brand.

## 2708 DJ Night, live venue brand SDA — 2 applicants, event Sat 17 Oct
- 2026-10-16: PROBLEM thin-funnel-plus-visit-logistics. EVID 2 apps (applied 10-15/16),
  application_accepted + accepted_by_ops 10-16, 2 deliverables created 10-16. HUMAN visit-date
  nudges 10-17/18 (system), auto-close 10-19 (released=1 removed=1). GOOD tell_brand|nudge_creators.
- 2026-10-17 (event day): PROBLEM event-today-2-creators. EVID deadline_reminder (creator) +
  sla_visit_date_due_nudge (brand) sent this day. GOOD nudge_creators|tell_brand.
- 2026-10-18 (day after): PROBLEM event-over-no-deliveries. EVID renudge to brand this day,
  nothing delivered. HUMAN auto-close 10-19. GOOD tell_brand|none.

## 2700 Jason Derulo Jalebi baby (brand 548) — 6 applicants, deadline 21 Oct
- 2026-10-17: PROBLEM thin-funnel-6-for-20-slots. EVID apps 10-16..19, price_proposed x3 10-16.
  HUMAN completed 10-21 + closed_unselected x6, report_ready. GOOD show_backups|tell_brand.
- 2026-10-19: PROBLEM negotiating-tail-no-new-funnel. EVID last apps 10-19, price_proposed 10-18/19.
  HUMAN completed 10-21. GOOD tell_brand|show_backups.
- 2026-10-20: PROBLEM deadline-tomorrow-roster-short. EVID no rows this day. HUMAN completed 10-21.
  GOOD tell_brand.

## 2827 ODYSSEY (brand 594) — 31 applicants, mass rejections, auto-closed 10-28
- 2026-10-22: PROBLEM rejection-wave-churn (12 rejected 10-22). EVID application_rejected x6
  notifs + removed_at 10-22 on 12 apps; 13+13 new_application 10-21/22. HUMAN pick_creators
  nudges 10-26/27, auto-close 10-28 (25 closed_unselected). GOOD tell_brand|show_backups.
- 2026-10-24: PROBLEM brand-disengaged (autopilot_paused 10-24) + trickle (4 apps). EVID
  autopilot_paused notif. HUMAN pick-creators 10-26. GOOD flag_admin|tell_brand.
- 2026-10-26: PROBLEM brand-has-not-picked. EVID campaign_pick_creators 10-26 + waiting x3.
  HUMAN last_call 10-27, auto-close 10-28. GOOD tell_brand.
- 2026-10-27: PROBLEM decide-today-or-loses-funnel. EVID last_call + waiting x5. HUMAN auto-close
  10-28. GOOD tell_brand.

## 2828 Jason Derulo ISF Day (brand 548) — 26 applicants, paused 10-24
- 2026-10-23: PROBLEM post-reject-churn-plus-pause-resume-chaos. EVID 14 rejected 10-22,
  campaign_paused + resumed 10-22, 208 new_brief 10-22, invite chaos. HUMAN paused_notice 10-24.
  GOOD tell_brand|flag_admin.
- 2026-10-25: PROBLEM campaign-paused-by-brand. EVID paused_notice_at 10-24. HUMAN still paused
  (no resume row). GOOD none|flag_admin (brand actions are invalid in brand_paused).

## 3123 Get paid to post: Tips (brand 647) — 42 applicants, live, negotiation queue
- 2026-10-30: PROBLEM negotiation-queue (price_proposed x9 10-29, x11 10-30). EVID apps 10-29..31,
  no deliverables yet. HUMAN unknown (live). GOOD tell_brand|none.
- 2026-10-31: PROBLEM same, louder. HUMAN unknown (live). GOOD tell_brand.

## 3138 Rave on Sugar's Grave (brand 560) — 9 active + 1 pending of 25, event 30 Oct
- 2026-10-30: PROBLEM short-roster-10-of-25-wanted. EVID 10 apps, 18 pieces created 10-30,
  0 waiting, 0 past-due. HUMAN unknown (live). GOOD show_backups.

## Round-2 additions (labeled 31-Oct BEFORE any round-2 output was viewed)

Healthy days (false-alarm probes — GOOD none unless noted):
- 2700/10-16: funnel-moving-negotiation-active. EVID price_proposed x6 this day,
  apps arriving, no waiting/past-due. GOOD none.
- 2700/10-18: funnel-moving. EVID price_proposed x2, apps 10-16..19. GOOD none.
- 2827/10-21: launch-day-flow. EVID blast + new_brief x48 + new_application x26
  this day, nothing stuck yet. GOOD none.
- 2828/10-21: launch-day-flow. EVID blast + new_brief x90 + new_application x29,
  invites flowing. GOOD none.
- 2800/10-20: early-quiet-in-time. EVID applied 10-18, due 10-23, no rows. GOOD none.
- 2800/10-22: due-tomorrow-nothing-yet. EVID 2 pieces due 10-23 unsubmitted,
  1 draft approved, no rows this day. GOOD none|tell_brand.

Silent days:
- 2800/10-24: thin-funnel-window-closing (RELABLED pre-run: creator 1075 is_demo
  in current prod, so the 2 past-due pieces are demo fixtures the product
  correctly excludes; visible facts are 1 active/2 wanted, window closes 10-25).
  GOOD tell_brand|none.
- 2800/10-26: thin-funnel-window-closed (same relabel; apply_by 10-25 passed).
  GOOD tell_brand|none.
- 2828/10-29: quiet-8d-in-time. EVID 1 creator quiet 8d (applied 10-21), due
  11-06, funnel at 26 applicants. GOOD none|tell_brand.

Zero-funnel-eve (monoculture probe on a new campaign):
- 3138/10-29: event-tomorrow-zero-applicants. EVID 0 applications before 10-30,
  event 10-30, no notification rows. GOOD tell_brand|flag_admin.
