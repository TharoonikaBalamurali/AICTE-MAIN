# FlowGuard — implementation report (master build prompt, SIH26262)

Date: 25 Oct 2026. Scope: extend the existing FlowGuard build (not a rewrite) with the EVC lifecycle, Regulation
Bureau escalation, compliance lifecycle, document validity, central deadlines, operational policies, reporting and
the related security controls. Regulatory sources: the supplied APH 2024–27 and the Document Requirements Matrix only.

## Run, migrate, test

```bash
npm install
npm run dev          # http://localhost:3000 — migrations 001–005 run automatically, demo data is seeded
npm test             # 100 tests (in-memory Postgres)
npm run typecheck
npm run build
```

Migrations are plain SQL in `server/db/migrations/` and are applied once each (tracked in `schema_migrations`).
For Supabase: set `DATABASE_URL`, start once, then run `supabase/rls.sql` (untested against a live project).

## EVC scheduling fix (execution prompt, 25 Oct 2026)

### Root causes found

1. A visit stored only a start instant — no end time or time zone — so overlap could not be computed; the only guard was
   a non-blocking "same day" warning.
2. Nothing reserved an official's time and the database had no constraint, so two requests could double-book a member.
3. There was no accept / decline. A reported conflict did not release time, and `CONFIRM_EVC` confirmed a visit
   without any member having accepted.
4. No date/time-aware availability: the committee picker listed everyone regardless of existing assignments.
5. Some notification dedupe keys contained `Date.now()`, so repeating a request produced duplicate notifications.

### What changed

* **Time model** — visits have `scheduled_start`, `scheduled_end` (CHECK end > start), `time_zone` ('Asia/Kolkata') and a
  `schedule_version`. Each holding member row carries `reserved_period tstzrange` = [start − buffer, end + buffer)
  (half-open, so 10:00–12:00 and 12:00–13:00 do not clash; buffer is an operational policy, default 0).
* **Race safety** — `EXCLUDE USING gist (user_id WITH =, reserved_period WITH &&)` (`btree_gist`). Invitation writes run
  in a transaction with `SELECT … FOR UPDATE` on the visit; a lost race surfaces as 409 `MEMBER_SLOT_TAKEN`.
* **Availability** — computed from persisted reservations and recorded unavailability in one query: every registry
  official gets AVAILABLE / BUSY / UNAVAILABLE / INACTIVE / NOT_VERIFIED / NO_ACCOUNT, the reason, the clashing
  assignments and that day's assignments. A slot is "unavailable" only when the required seats (Annexure 16 §16.5)
  cannot be staffed by distinct free, eligible officials; then the exact message *"No eligible EVC committee members are
  available for the selected date and time. Please choose another date or time."* is returned with alternative slots.
* **Statuses** — member responses (INVITED, ACCEPTED, REJECTED, CONFLICT_REPORTED, WITHDRAWAL_REQUESTED) are separate from
  the derived assignment status (DRAFT, PENDING_RESPONSES, PARTIALLY_ACCEPTED, AWAITING_CONFIRMATION, CONFIRMED,
  RESCHEDULING_REQUIRED, IN_PROGRESS, REPORTS_PENDING, COMPLETED, CANCELLED). Sending invitations never confirms a visit;
  `CONFIRM_EVC` requires every active member to have ACCEPTED and a valid composition.
* **Release rules** — INVITED / ACCEPTED / CONFLICT_REPORTED / WITHDRAWAL_REQUESTED hold time; REJECTED, removal,
  cancellation and a missed visit release it. A decline cannot be overwritten by re-inviting the same official to the
  same time (409 `MEMBER_DECLINED`); a reschedule (new version) can invite them again.
* **Reschedule** — re-checks availability, moves every reservation atomically, bumps the version, resets responses to
  INVITED, notifies members and the institution, and writes `evc_schedule_history` (append-only).
* **Reports** — a report can be submitted only by an accepted member after attendance is recorded (409
  `VISIT_NOT_OCCURRED`); versions, timestamps and evidence links are unchanged and private.
* **Notifications** — dedupe keys use the schedule version (`visit:<id>:invite:<user>:v<n>`), so repeats are suppressed.

### Database migration

`server/db/migrations/005_evc_scheduling.sql` — `btree_gist`; visit end / time zone / version / draft panel /
invitations-sent timestamp; member `ack_status` → `response_status` (PENDING → INVITED, ACKNOWLEDGED → ACCEPTED),
`acknowledged_at` → `responded_at`, `rejection_reason`, `reserved_period`, `invited_version`, the exclusion constraint;
new `evc_member_unavailability` and append-only `evc_schedule_history`; `evc_report_evidence.review_status`.
Applied automatically at start-up (verified on the existing preview database).

### API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/evc/scheduler` | Dashboard: applications ready for scheduling (forwarded on/by, coordination status, conflicts) and calendar visits |
| `GET /api/evc/scheduler/applications/:id` | Scheduling context: visit, members, panel, live availability, alternatives, composition, history |
| `POST /api/evc/scheduler/availability` | Availability of all officials for `{start, end, visitId?, panel}`; capacity message; alternatives |
| `GET/POST/DELETE /api/evc/scheduler/unavailability` | Members record their own unavailability; the RO may record anyone's |
| `POST /api/evc/visits/:id/respond` | Member response `{response, reason}` — only for the caller's own row (`/acknowledge`, `/conflict` kept as aliases) |
| `POST /api/official/applications/:id/actions/PROPOSE_EVC_DATE` | Save the proposal: date, start, end, mode, link, note, draft panel (no reservation) |
| `… /ASSIGN_EVC_MEMBERS` | Send invitations (composition + availability checked, time reserved) |
| `… /CONFIRM_EVC`, `… /RESCHEDULE_EVC`, `… /CANCEL_EVC` | Confirm after all accept; move with revalidation; cancel and release |

All are role-checked and region-scoped on the server; member IDs, roles and statuses sent by the browser are re-read
from the database.

### UI

* `src/pages/official/EvcSchedule.tsx` — EVC scheduling dashboard (KPIs, Mon–Fri calendar with confirmed / proposed /
  panel-conflict cards, selected visit, "Ready for scheduling" table with coordination pills).
* `src/pages/official/EvcScheduleVisit.tsx` (new, `/official/evc/schedule/:applicationId`) — conflict banner, visit
  details (date, IST, start / end, mode, link, coordination note), proposed panel with live availability and responses,
  Edit-panel dialog (ID, name, category, qualification outcome per seat, availability, day assignments, reasons; only
  eligible free officials selectable), alternative slots, invitation summary (save / send / confirm / reschedule /
  cancel), coordination flow stepper and schedule history.
* `src/pages/official/evcCoord.ts` (new) — IST helpers and status labels.
* `EvcMember.tsx` — accept, decline with reason, report conflict, request withdrawal; "My unavailability".
* `Workspace.tsx`, `Bureau.tsx`, `Home.tsx` — response statuses and a link to the scheduling page. The superseded
  `Committee.tsx` (single-time committee builder) was removed.

### Tests (`tests/evc_scheduling.test.ts`, 12 tests, all run)

Required items 1–13 map to: officials listed with availability (1); busy official blocked and fully occupied slot
returns the capacity message (2, 3, 6); simultaneous invitations — exactly one succeeds, no overlapping reservations
(4); reject and cancel release time, decline not overwritten (5); members respond only for themselves (7, 10); partial
acceptance never confirms (8); reschedule revalidates, bumps version, resets responses, notifies (9); report blocked
before the visit occurred, versioned and timestamped (11); evidence private and linked (12); repeated requests create no
duplicates (13); plus half-open adjacency, the database constraint itself and recorded unavailability. Item 14: the full
suite passes. A bug found by these tests was fixed: recorded unavailability was ignored when no visit was excluded.

## EVC member experience (follow-up, 25 Oct 2026)

**Why members saw nothing.** On the demo database the Regional Officer had saved a proposal with one panel member;
invitations can only be sent once all three required seats are filled, so nothing was sent and no member was notified
— the page did not make that clear. Separately, the members' "EVC schedule" menu opened the coordinator view, whose
data endpoint is (correctly) closed to members, so they got an error instead of their schedule.

**Changes**

* Scheduling page: a "Before invitations can be sent" checklist, **Fill vacant seats** (proposes the first free,
  verified, eligible official per vacant seat for the RO to review; nothing is sent), and save messages that say
  members are not notified until invitations are sent.
* Member home (`src/pages/official/EvcMemberHome.tsx`): invitations from the Regional Officer with **Accept** /
  **Decline (with reason)** in place, a Reporting list, **My schedule** (Mon–Fri grid on tablet/desktop, agenda on
  phones; read-only), all assignments as responsive rows, and own unavailability.
* "EVC schedule" for members shows only their own visits, read-only. Members cannot propose, invite, confirm,
  reschedule or cancel (server-enforced; tested).
* Visit workspace: **Inspection updates** (sent to the Regional Officer and kept in the record); **Evidence &
  supporting documents** with a type (supporting document, visit photograph, attendance sheet, video recording,
  other); **Final EVC report** with the attachments listed and a required declaration. On submission it goes to the
  Regional Officer and the Regulation Bureau; APH Ch. I §1.10(a) says the Executive Committee decides after the
  committee's recommendations and the Bureau's views. (The APH uses "Executive Committee"; FlowGuard does not route
  anything to the Executive Committee itself.) Evidence is frozen once the report is submitted.
* Migration `006_evc_member_reporting.sql`: `evc_report_evidence.category`, `evc_reports.declaration_at`.
* API: `POST /api/evc/visits/:id/updates`; `POST /api/evc/visits/:id/evidence` accepts `category`;
  `SUBMIT_EVC_REPORT` requires `declaration: true`.
* Tests: 101 / 101 pass (new: member read-only scheduling and invitation visibility; inspection update, evidence
  categories, declaration, Bureau notification, evidence frozen after submission).
* Verified in the browser at 375 px and 768 px (no horizontal scrolling): member accepts an invitation from the
  dashboard, sees it in My schedule, posts an inspection update; RO fills vacant seats after picking an alternative slot.

### Report documents and visit evidence (separate uploads)

* Visit workspace has two upload sections: **Inspection report documents** (inspection report — PDF only; supporting
  document and attendance sheet — PDF/JPG/PNG; 10 MB) and **Visit evidence — photos & videos** (photograph — JPG/PNG,
  10 MB; video — MP4/MOV/WebM, 50 MB; other). Photos show as thumbnails and videos in a player; documents as a list
  with "In final report" status. The final-report card summarises both groups.
* File types are enforced per category on the server from the file content (`sniffType` / new `sniffVideo`), not
  from the name. Migration `007_evc_report_documents.sql` adds the `INSPECTION_REPORT` category. The 50 MB video
  limit is a system limit, not a regulatory one. Videos are served whole (no range requests).

## Committee dashboards — EC, SHC, SAC, Council (master implementation prompt, 25 Oct 2026)

**Gaps found.** One generic `DECISION_AUTHORITY` role recorded both Executive Committee and Council decisions; SHC /
SAC had only a single action panel inside the application workspace; there was no record of hearings or
clarification requests and no way for an institution to place compliance before a committee; institutions could
read SHC / SAC recommendation notes; after the SAC ordered a further Scrutiny / EVC, the case went straight to the
Council instead of back to the SAC (Ch. I §1.11(d)); decisions and recommendations were not protected from edits.

**Verified clauses used.** Ch. I §1.10(a)-(c) (EC decides after committee recommendations and Regulation Bureau
views; LoA / LoD / LoR with reasons); §1.11(a) (appeal once, 7 days from issue of the LoD), (b)-(e) (SAC considers;
recommends / not recommends / SC-EVC, whose reports go before another SAC; Council final); Ch. II §2.23.3 (SHC
verifies compliance, recommendations to EC, EC decision with detailed speaking order); §2.24(a) (7 days from
upload of the EC decision), (b)-(f).

**Changes.**
* Roles `EC_OFFICIAL` and `COUNCIL_OFFICIAL` (demo logins `ec.official`, `council.official`). `ISSUE_DECISION` is
  accepted only from the EC when no appeal is pending and only from the Council on appeal (403 `EC_DECIDES` /
  `COUNCIL_DECIDES`); 409 `RETURN_TO_SAC` while a SAC-ordered further committee is pending. Decisions store
  `recorded_role` and `aph_reference`. `DECISION_AUTHORITY` keeps reopen approvals, compliance review and closure.
* New action `RETURN_TO_SAC` (Ch. I §1.11(d)). "Ready for decision" notifications go to the body that decides next.
* Migration `008_committees.sql`: `committee_proceedings` (review note, clarification request, hearing notice,
  hearing record; only requests and notices are disclosed), `committee_submissions` (institution material placed
  before SHC / SAC / EC-on-clarification), decision provenance columns; decisions, committee reviews, proceedings
  and submissions are append-only (DB triggers).
* API `server/routes/committee.ts`: `GET /api/committee/queue` (cases before the caller's body + handled ones, KPIs),
  `GET /api/committee/applications/:id` (case file), `POST …/proceedings`, `GET …/appeal-document`,
  `GET /api/committee/submissions/:id/download`, and `POST /api/applications/:id/committee-submissions` (institution).
* UI `src/pages/official/CommitteeDesk.tsx`: one desk per body (purpose and APH clause, KPIs, filters, search, case
  table) and a case file (appeal, issues before the committee, EVC findings, reports / recommendations / decisions
  as separate records, institution submissions, proceedings, workflow history; recommendation or decision form and
  proceedings form for the body that holds the case). Institution application page: "Committee notices" with
  hearing notices, clarification requests and a submission form; these events also appear in its timeline.
* Privacy: institutions see that a recommendation was recorded, not its outcome or notes, and never internal notes
  or hearing records; SAC notes are removed from the appeal they see.
* Tests `tests/committees.test.ts` (7): SHC referral only when forwarded; hearing notice disclosed, internal note
  not; institution submission + access control; EC clarification + speaking-order rule; appeal timeliness from the
  verified clause (and Ch. I LoD rule); SAC orders EVC → back to SAC → Council; original EC decision preserved;
  append-only checks; desk / institution access limits; every disclosable step in the institution's notifications.

**Not done / needs verification.** The EC and Council are modelled as one authorised recording official each, not
multi-member voting; how the Regulation Bureau's "views" are recorded before the EC (§1.10(a)) is not modelled
beyond its notification; SAC / SHC hearing schedules are entered by the committee (the APH says the SAC schedule is
notified on the portal but gives no rule for it); Chapter I appeals against decisions other than an LoD stay
unconfigured pending verification; external delivery channels (email / SMS) are not configured.

## Results (this build)

* `npm test`: **108 / 108 passed** (6 files, after the committee dashboards). Browser check on an isolated instance:
  SHC desk and case file, hearing notice sent from the UI and received on the institution page, institution
  submission to the SHC, EC case file.

* `npm test`: **101 / 101 passed** (after the member follow-up and the separate upload sections). Before it: **100 / 100 passed** — engine 25, workflow 22, scrutiny 23, EVC / Bureau / compliance / security 18,
  EVC scheduling 12.
* Browser check of the scheduling screens on an isolated instance (port 3001, synthetic data): dashboard with a
  confirmed visit, an overlapping proposal flagged "Panel conflict", partial acceptance and an unscheduled application;
  "Use this slot" resolving the conflict; sending invitations; a member declining with a reason; the RO view showing
  the vacant seat and the decliner blocked from re-invitation.

Earlier results:

* `npm test` (before the scheduling fix): 88 / 88 passed — engine 25, workflow 22, scrutiny 23, EVC / Bureau / compliance / security 18.
* `npm run typecheck`: pass. `npm run build`: pass.
* Browser check on an isolated instance with synthetic data: committee builder with live §16.5 check, confirmation,
  EVC member acknowledgement and missed-visit report (escalation raised), Bureau overview / queue / acknowledgement,
  registry, reports and CSV export, operational settings, compliance review, institution compliance + document
  validity, institution EVC video link.

## Changed and new files

* Database: `server/db/migrations/004_evc_bureau_compliance.sql` (regions, user regions, operational policies + history,
  EVC expert registry + events, member seats / acknowledgement / attendance, visit outcome fields, report drafts,
  report evidence, deadlines, escalations + append-only actions, compliance submissions / reviews, `deadline_register`
  view, rule verifier column). `server/db/seed.ts` (demo regions, accounts, experts, policies).
* Services: `server/evc/composition.ts`, `server/evc/service.ts`, `server/escalations.ts`, `server/validity.ts`,
  `server/policy.ts`, `server/scheduler.ts`, `server/services.ts` (region scoping, EVC member visibility,
  compliance display status, APH undertakings), `server/http.ts` (error logging in tests).
* API: `server/routes/evc.ts`, `server/routes/bureau.ts`, `server/routes/reports.ts`; `server/routes/official.ts`
  (EVC actions, composition gate, offline justification, scoped queues, policies, compliance review, rule four-eyes);
  `server/routes/institution.ts` (compliance history, document validity, EVC video link); `server/app.ts` (routers,
  source/config/dotfile guard); `server/workflow/stateMachine.ts` (Regulation Bureau role).
* UI: `src/pages/official/EvcMember.tsx`, `Bureau.tsx`, `Registry.tsx`, `Committee.tsx`, `PendencyReport.tsx`;
  updated `Workspace.tsx`, `Home.tsx`, `EvcSchedule.tsx`, `Governance.tsx`, `src/pages/Processing.tsx`,
  `src/components/Layout.tsx`, `src/App.tsx`, `src/lib/roles.ts`.
* Tests: `tests/evc_bureau.test.ts` (new); `tests/scrutiny.test.ts`, `tests/workflow.test.ts` updated for the
  registry-based committee.
* Docs/config: `README.md`, `.env.example`, `supabase/rls.sql`.

## Completed

1. Unified login and server-side roles, now including Regulation Bureau; Regional Officers limited to their regions;
   EVC members see only visits they are actively assigned to.
2. EVC registry with separate verification; deterministic §16.5 composition checks; confirmation blocked until valid.
3. Committee assignment, acknowledgement, conflict reporting, replacement with reason, rescheduling (members
   re-acknowledge), cancellation, attendance, completion / missed recording — never inferred from time.
4. Sectioned EVC report drafts (from §1.9(c)-(g)), evidence upload, versioned submission with receipt number.
5. Escalations for missed visits, unrecorded outcomes, overdue reports, unacknowledged assignments and unresolved
   conflicts; Bureau queue and actions with append-only history; RO / member responses.
6. Central deadline records with source type and configuration version; idempotent sweep; no automatic rejection.
7. Compliance lifecycle with submission / review history; APH-sourced undertakings; document validity alerts.
8. Role dashboards (EVC member, Bureau, RO EVC status), pendency report with filters and audited CSV export.
9. Operational policies with propose / authorise separation; rule publication requires a second official.

## Requires authorised regulatory clarification

See README "Requirements that remain unverified" items 17–23 (new) and 1–16 (earlier), in particular:
the EVC selection method (§1.9(a) vs Definition 29), §16.5 seat-3 wording, Deemed-University status,
all operational periods (marked demonstration until authorised), state → region mapping, and the Bureau queue design.

## Known limitations

* Supabase Postgres / Auth / Storage not tested live; email / SMS not implemented (in-app notifications only).
* No Regional Coordinator role and no role-administration UI.
* The EVC report template follows the APH clauses, not an official AICTE report form (none was supplied).
* Browser-level automated E2E tests are not set up; UI verification was manual.
* EVC scheduling: the slot window (09:00–18:00), alternative-search days (7) and buffer (0 min) are demonstration
  operational values until authorised. Only three eligible demo officials exist, so after a decline there is often no
  replacement and the RO must reschedule. Public holidays are not modelled. The `btree_gist` constraint is verified on
  PGlite; on Supabase the extension must be enabled (migration 005 does `CREATE EXTENSION IF NOT EXISTS btree_gist`).
  Email / SMS delivery of invitations is not implemented (in-app notifications only).
* Not legally compliant or production-secure by virtue of these controls alone (penetration testing, backups,
  retention policy and key management remain to be done).
