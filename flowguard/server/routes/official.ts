/**
 * Official workspaces: Scrutiny, Re-Scrutiny, EVC scheduling, Supervisor and Administrator.
 *
 * Principle: automate the process, not the statutory decision. The backend validates, reports,
 * notifies and monitors deadlines; every scrutiny outcome, notice, handoff and decision is an
 * explicit, reasoned action by an authorised official, recorded in officer_actions and the audit log.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { CATEGORIES } from '../catalogue/categories.ts';
import type { Db } from '../db/index.ts';
import { evaluateEvcEligibility } from '../evc.ts';
import { ah, audit, HttpError, requireRole, user, type AuthUser } from '../http.ts';
import { notify, retryFailedDeliveries } from '../notify.ts';
import { noticePdf } from '../pdf.ts';
import { getPolicy, POLICY, POLICY_DESCRIPTION, policyLabel } from '../policy.ts';
import { SEATS, type Seat } from '../evc/composition.ts';
import { assertReadyToConfirm, moveVisit, releaseReservations, REPORT_SECTIONS, SECTION_FINDINGS, sendInvitations, slotLabel } from '../evc/service.ts';
import { createScrutinyReport, deadlineLabel, DISCLAIMER } from '../reports.ts';
import { RULESET_VERSION } from '../rules/ruleset.ts';
import { runDeadlineSweep, runJob } from '../scheduler.ts';
import {
  appealEligibility,
  assertAssignee,
  canSeeAll,
  categoryOrThrow,
  complianceDisplayStatus,
  createObligations,
  decisionObligations,
  loadAppFor,
  notifyInstitution,
  notifyRole,
  OFFICIAL_VISIBLE_SQL,
  REGION_SCOPE_SQL,
  regionScoped,
  visibleSql,
  mineSql,
  recordOfficerAction,
  runValidation,
  todayIST,
  transition,
  VISIBLE_STATES,
  type AppRow,
} from '../services.ts';
import { MAX_UPLOAD_BYTES, type Storage } from '../storage.ts';
import { afterScrutiny, pendingActor, ROLES, STATE_LABELS, stageOf, TRANSITIONS, type Action, type AppState, type Role } from '../workflow/stateMachine.ts';
import { applicationDetail, sendFile, storeUpload } from './institution.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 30 } });

const OFFICIAL_ROLES: Role[] = ['SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL', 'REGIONAL_OFFICER', 'EVC_MEMBER', 'SHC_MEMBER', 'DECISION_AUTHORITY', 'SAC_MEMBER', 'EC_OFFICIAL', 'COUNCIL_OFFICIAL', 'SUPERVISOR', 'SYSTEM_ADMIN', 'REGULATION_BUREAU'];

/** Applications each role is expected to act on now. */
export const QUEUES: Partial<Record<Role, AppState[]>> = {
  SCRUTINY_OFFICIAL: ['SUBMITTED', 'UNDER_SCRUTINY', 'SCRUTINY_COMPLETED'],
  RE_SCRUTINY_OFFICIAL: ['READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'],
  REGIONAL_OFFICER: ['SCRUTINY_COMPLETED', 'AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED', 'EVC_REPORT_SUBMITTED'],
  EVC_MEMBER: ['EVC_SCHEDULED', 'EVC_IN_PROGRESS'],
  SHC_MEMBER: ['AWAITING_COMMITTEE_REVIEW'],
  DECISION_AUTHORITY: ['SUBMITTED', 'DECISION_ISSUED'],
  EC_OFFICIAL: ['AWAITING_AUTHORISED_DECISION'],
  COUNCIL_OFFICIAL: ['AWAITING_AUTHORISED_DECISION'],
  SAC_MEMBER: ['APPEAL_SUBMITTED', 'APPEAL_UNDER_REVIEW'],
  SUPERVISOR: ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS', 'SCRUTINY_COMPLETED'],
};

/** The role whose assignment governs an action (an assigned application can only be acted on by its assignee). */
const ACTION_GROUP: Partial<Record<string, Role>> = {
  SEND_FOR_RESCRUTINY: 'SCRUTINY_OFFICIAL',
  FORWARD_TO_EVC: 'SCRUTINY_OFFICIAL',
  START_SCRUTINY: 'SCRUTINY_OFFICIAL',
  FORWARD_SELF_DISCLOSURE: 'SCRUTINY_OFFICIAL',
  ISSUE_DEFICIENCY_NOTICE: 'SCRUTINY_OFFICIAL',
  COMPLETE_SCRUTINY: 'SCRUTINY_OFFICIAL',
  START_RE_SCRUTINY: 'RE_SCRUTINY_OFFICIAL',
  REQUEST_FURTHER_CORRECTION: 'RE_SCRUTINY_OFFICIAL',
  COMPLETE_RE_SCRUTINY: 'RE_SCRUTINY_OFFICIAL',
  REFER_UNRESOLVED: 'RE_SCRUTINY_OFFICIAL',
  PROPOSE_EVC_DATE: 'REGIONAL_OFFICER',
  CONFIRM_EVC: 'REGIONAL_OFFICER',
  SCHEDULE_EVC: 'REGIONAL_OFFICER',
  RESCHEDULE_EVC: 'REGIONAL_OFFICER',
  CANCEL_EVC: 'REGIONAL_OFFICER',
  ASSIGN_EVC_MEMBERS: 'REGIONAL_OFFICER',
  FORWARD_AFTER_EVC: 'REGIONAL_OFFICER',
};

/**
 * Tells whoever decides next that a case reached the decision stage: the Executive Committee in the first instance;
 * on appeal, the SAC again after a further committee it ordered (Ch. I §1.11(d)), otherwise the Council (§1.11(e)).
 */
async function notifyDecisionStage(t: Db, app: Pick<AppRow, 'id'>, eventType: string, title: string, message: string) {
  const appeal = await t.one<{ status: string }>('SELECT status FROM appeals WHERE application_id = $1', [app.id]);
  const role: Role = !appeal || appeal.status === 'DECIDED' ? 'EC_OFFICIAL' : appeal.status === 'REFERRED' ? 'SAC_MEMBER' : 'COUNCIL_OFFICIAL';
  await notifyRole(t, role, app.id, eventType, title, message);
}

/** Material actions must carry a reason / supporting note. */
const REASON_REQUIRED = new Set([
  'SEND_FOR_RESCRUTINY',
  'FORWARD_TO_EVC',
  'FORWARD_SELF_DISCLOSURE',
  'ISSUE_DEFICIENCY_NOTICE',
  'COMPLETE_SCRUTINY',
  'REQUEST_FURTHER_CORRECTION',
  'COMPLETE_RE_SCRUTINY',
  'REFER_UNRESOLVED',
  'APPROVE_EVC_HANDOFF',
  'APPROVE_REOPEN',
  'DECLINE_REOPEN',
  'CLOSE',
]);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(4000) });

// ---------------------------------------------------------------------------------- notices

async function issueNotice(t: Db, storage: Storage, app: AppRow, u: AuthUser, kind: 'INITIAL' | 'FURTHER_CORRECTION', reason: string, deficiencyIds: string[]) {
  const cat = categoryOrThrow(app.category_code);
  const prev = await t.one<{ id: string; notice_no: string; version: number }>('SELECT id, notice_no, version FROM deficiency_notices WHERE application_id = $1 ORDER BY version DESC LIMIT 1', [app.id]);
  const noticeNo = prev?.notice_no ?? `FG-DN-${(await t.one<{ n: string }>("SELECT nextval('notice_ref_seq')::text AS n"))!.n.padStart(6, '0')}`;
  const version = (prev?.version ?? 0) + 1;
  const defs = await t.query<Record<string, any>>('SELECT *, deadline::text AS deadline FROM deficiencies WHERE id = ANY($1) ORDER BY raised_at', [deficiencyIds]);
  const sv = (await t.one<{ submission_version: number }>('SELECT submission_version FROM applications WHERE id = $1', [app.id]))!.submission_version;
  const report = await t.one<{ content: any }>('SELECT content FROM workflow_reports WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1', [app.id]);
  const s = report?.content?.summary;
  const scrutinySummary = report
    ? report.content.kind === 'SCRUTINY'
      ? `Automated scrutiny report v${report.content.version}: ${s.counts.DISCREPANCY_DETECTED} discrepancy finding(s), ${s.counts.UNABLE_TO_VERIFY} unable to verify, ${s.counts.HUMAN_REVIEW_REQUIRED} for human review, ${s.counts.PASS} passed. After review, the officer recorded ${defs.length} deficiency(ies). Officer note: ${reason}`
      : `Re-scrutiny report v${report.content.version} reviewed. ${defs.length} item(s) require further correction. Officer note: ${reason}`
    : `${defs.length} deficiency(ies) recorded. Officer note: ${reason}`;
  const content = {
    noticeNo,
    version,
    kind,
    issuedAt: new Date().toISOString(),
    issuedBy: { name: u.fullName, role: u.activeRole === 'RE_SCRUTINY_OFFICIAL' ? 'Re-Scrutiny Committee' : 'Scrutiny Committee' },
    application: {
      id: app.id,
      referenceNo: app.reference_no,
      submissionVersion: sv,
      categoryTitle: cat.title,
      subtypeLabel: cat.subtypes?.find((x) => x.value === app.subtype)?.label ?? null,
    },
    institution: {
      name: app.institution_snapshot?.name,
      aicteInstitutionId: app.institution_snapshot?.aicteInstitutionId,
      idVerification: app.institution_snapshot?.idVerification ?? 'UNVERIFIED',
      address: app.institution_snapshot?.address,
    },
    scrutinySummary,
    deficiencies: defs.map((d) => ({
      id: d.id,
      referenceNo: d.reference_no,
      target: { type: d.target_type, id: d.target_id, label: d.target_label },
      category: d.category,
      explanation: d.explanation,
      correctiveAction: d.corrective_action,
      requiredReplacement: d.required_replacement,
      sourceReference: d.source_reference,
      deadline: { type: d.deadline_type, date: d.deadline, basis: d.deadline_basis, label: deadlineLabel(d.deadline_type, d.deadline, d.deadline_basis) },
    })),
    nextSteps: [
      'Open the application in your portal dashboard (Deficiencies tab).',
      'For each deficiency, upload the corrected / replacement document or update the named field, and record a response.',
      'Submit all corrections for re-scrutiny. The Re-Scrutiny Committee verifies only the deficiencies listed in this notice.',
      'Deadlines marked "operational" are system-configured. Missing a deadline does not change your application automatically; an official decides the next step.',
    ],
    supersedes: prev ? `${prev.notice_no} v${prev.version}` : null,
    disclaimer: DISCLAIMER,
  };
  const pdf = await noticePdf(content);
  const stored = await storage.put(pdf, 'pdf');
  const n = await t.one<{ id: string }>(
    `INSERT INTO deficiency_notices(notice_no, application_id, version, submission_version, kind, content, storage_key, sha256, supersedes_id, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [noticeNo, app.id, version, sv, kind, JSON.stringify(content), stored.key, stored.sha256, prev?.id ?? null, u.id],
  );
  await t.query("UPDATE deficiencies SET status = 'OPEN', notice_id = $2, updated_at = now() WHERE id = ANY($1)", [deficiencyIds, n!.id]);
  for (const id of deficiencyIds) await t.query('INSERT INTO deficiency_events(deficiency_id, event, actor_id, note) VALUES ($1,$2,$3,$4)', [id, kind === 'INITIAL' ? 'NOTICE_ISSUED' : 'FURTHER_CORRECTION_REQUESTED', u.id, `${noticeNo} v${version}`]);
  return { id: n!.id, noticeNo, version };
}

const draftSchema = z.object({
  targetType: z.enum(['FIELD', 'DOCUMENT', 'APPLICATION']),
  targetId: z.string().max(80).nullable().optional(),
  category: z.enum(['MISSING_DOCUMENT', 'INVALID_OR_EXPIRED', 'SIGNATURE_AUTHENTICATION', 'MISMATCH', 'INCOMPLETE_INFORMATION', 'UNREADABLE_FILE', 'OTHER']),
  explanation: z.string().trim().min(5).max(4000),
  sourceReference: z.string().trim().max(200).optional(),
  correctiveAction: z.string().trim().min(3).max(2000),
  requiredReplacement: z.string().trim().max(1000).optional(),
  deadlineType: z.enum(['APH', 'OPERATIONAL', 'NOT_CONFIGURED']).default('NOT_CONFIGURED'),
  deadline: dateStr.optional(),
  deadlineBasis: z.string().trim().max(300).optional(),
  sourceFindingRuleId: z.string().max(200).optional(),
  parentDeficiencyId: z.string().uuid().optional(),
});
type DraftInput = z.infer<typeof draftSchema>;

/** Validates and stores one DRAFT deficiency (not visible to the institution until a notice is issued). */
async function insertDraftDeficiency(t: Db, app: AppRow, u: AuthUser, cat: ReturnType<typeof categoryOrThrow>, b: DraftInput) {
  if (b.targetType !== 'APPLICATION') {
    const ok = b.targetType === 'FIELD' ? cat.fields.some((f) => f.id === b.targetId) : cat.documents.some((d) => d.id === b.targetId);
    if (!ok) throw new HttpError(400, 'INVALID_TARGET', 'The affected field/document does not belong to this application type.');
  }
  if (b.deadlineType === 'NOT_CONFIGURED' && b.deadline) throw new HttpError(400, 'DEADLINE_TYPE', 'Choose a deadline type (regulatory or operational) when setting a deadline.');
  if (b.deadlineType !== 'NOT_CONFIGURED' && (!b.deadline || !b.deadlineBasis))
    throw new HttpError(400, 'DEADLINE_BASIS_REQUIRED', 'A deadline needs a date and its basis. The portal does not invent statutory deadlines.');
  if (b.deadline && b.deadline < todayIST()) throw new HttpError(400, 'DEADLINE_PAST', 'The deadline cannot be in the past.');
  const label =
    b.targetType === 'FIELD' ? cat.fields.find((f) => f.id === b.targetId)!.label : b.targetType === 'DOCUMENT' ? cat.documents.find((d) => d.id === b.targetId)!.name : 'Application (general)';
  const seq = await t.one<{ n: string }>("SELECT nextval('deficiency_ref_seq')::text AS n");
  const d = await t.one<{ id: string; reference_no: string }>(
    `INSERT INTO deficiencies(reference_no, application_id, target_type, target_id, target_label, category, explanation, source_reference, stage_detected, corrective_action,
       required_replacement, deadline, deadline_basis, deadline_type, source_finding_rule_id, parent_deficiency_id, raised_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'DRAFT') RETURNING id, reference_no`,
    [
      `FG-DEF-${seq!.n.padStart(6, '0')}`,
      app.id,
      b.targetType,
      b.targetId ?? null,
      label,
      b.category,
      b.explanation,
      b.sourceReference ?? null,
      app.status === 'UNDER_RE_SCRUTINY' ? 'RE_SCRUTINY' : 'SCRUTINY',
      b.correctiveAction,
      b.requiredReplacement ?? null,
      b.deadline ?? null,
      b.deadlineBasis ?? null,
      b.deadlineType,
      b.sourceFindingRuleId ?? null,
      b.parentDeficiencyId ?? null,
      u.id,
    ],
  );
  await t.query('INSERT INTO deficiency_events(deficiency_id, event, actor_id, note) VALUES ($1,$2,$3,$4)', [d!.id, 'DRAFTED', u.id, b.explanation]);
  await recordOfficerAction(t, u, app.id, 'DRAFT_DEFICIENCY', null, { deficiency: d!.reference_no, sourceFindingRuleId: b.sourceFindingRuleId ?? null });
  return d!;
}

// ---------------------------------------------------------------------------------- router

export function officialRouter(db: Db, storage: Storage) {
  const r = Router();
  r.use(requireRole(...OFFICIAL_ROLES));

  // ------------------------------------------------------------------ dashboards
  r.get(
    '/dashboard',
    ah(async (req, res) => {
      const u = user(req);
      const states = QUEUES[u.activeRole] ?? [];
      const today = todayIST();
      // None of these queries depend on each other, so they run concurrently — run serially they
      // are 8-13 round trips, each costing real latency against a remote (e.g. Supabase) database.
      const [byStatus, overdue, mine, verif, upcoming, failed, lastSweep, recentActivity, supervisorData] = await Promise.all([
        db.query<{ status: AppState; n: number }>(
          `SELECT a.status, count(*)::int AS n FROM applications a WHERE a.status <> 'DRAFT' AND ${canSeeAll(u.activeRole) ? '($1::text[] IS NOT NULL OR true) AND $2::uuid IS NOT NULL' : visibleSql(u.activeRole)} GROUP BY a.status`,
          [VISIBLE_STATES[u.activeRole] ?? [], u.id],
        ),
        db.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM deficiencies d JOIN applications a ON a.id = d.application_id
           WHERE d.status = 'OPEN' AND d.deadline IS NOT NULL AND d.deadline < $1::date AND a.status IN ('DEFICIENCY_RAISED','CORRECTION_IN_PROGRESS')`,
          [today],
        ),
        db.one<{ n: number }>("SELECT count(*)::int AS n FROM assignments s JOIN applications a ON a.id = s.application_id WHERE s.user_id = $1 AND s.active AND a.status = ANY($2)", [u.id, states]),
        db.one<{ n: number }>("SELECT count(*)::int AS n FROM verification_requests WHERE status = 'OPEN'"),
        db.query(
          `SELECT v.id, v.application_id, v.mode, v.scheduled_start, v.status, a.reference_no, i.name AS institution_name FROM evc_visits v
           JOIN applications a ON a.id = v.application_id JOIN institutions i ON i.id = a.institution_id
           WHERE v.status IN ('PROPOSED','SCHEDULED','RESCHEDULED','IN_PROGRESS') ORDER BY v.scheduled_start LIMIT 20`,
        ),
        db.one<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE delivery_status = 'FAILED'"),
        db.one('SELECT job, status, started_at, finished_at, summary, error FROM job_runs ORDER BY id DESC LIMIT 1'),
        // Workflow events on applications this role may view (same visibility rule as the "all" queue).
        db.query(
          `SELECT e.id, e.action, e.to_status, e.actor_role, e.created_at, a.id AS application_id, a.reference_no, uu.full_name AS actor_name
           FROM workflow_events e JOIN applications a ON a.id = e.application_id LEFT JOIN users uu ON uu.id = e.actor_id
           WHERE a.status <> 'DRAFT' AND ${canSeeAll(u.activeRole) ? '($1::text[] IS NOT NULL OR true) AND $2::uuid IS NOT NULL' : visibleSql(u.activeRole)}
           ORDER BY e.id DESC LIMIT 6`,
          [VISIBLE_STATES[u.activeRole] ?? [], u.id],
        ),
        u.activeRole === 'SUPERVISOR'
          ? Promise.all([
              db.query(
                `SELECT uu.id, uu.full_name, uu.designation, uu.status, uu.last_login_at, array_agg(DISTINCT r.role) AS roles,
                        (SELECT count(*)::int FROM assignments s JOIN applications a ON a.id = s.application_id
                          WHERE s.user_id = uu.id AND s.active AND a.status NOT IN ('DECISION_ISSUED','CLOSED')) AS active_assignments
                 FROM users uu JOIN user_roles r ON r.user_id = uu.id
                 WHERE r.role <> 'INSTITUTION_APPLICANT' GROUP BY uu.id ORDER BY uu.full_name`,
              ),
              db.one(
                'SELECT l.action, l.entity_type, l.created_at, l.actor_role, uu.full_name AS actor_name FROM audit_log l LEFT JOIN users uu ON uu.id = l.actor_id ORDER BY l.id DESC LIMIT 1',
              ),
              db.query('SELECT lifecycle_status, count(*)::int AS n FROM regulatory_rules GROUP BY 1 ORDER BY 1'),
              db.one<{ n: number }>(
                `SELECT count(*)::int AS n FROM applications a WHERE a.status IN ('SUBMITTED','UNDER_SCRUTINY','READY_FOR_RE_SCRUTINY','UNDER_RE_SCRUTINY','AWAITING_EVC_SCHEDULING')
                 AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id AND s.active)`,
              ),
            ])
          : Promise.resolve(null),
      ]);
      const count = (s: AppState) => byStatus.find((x) => x.status === s)?.n ?? 0;
      const supervisor = supervisorData
        ? { people: supervisorData[0], latestAudit: supervisorData[1], rulesetVersion: RULESET_VERSION, ruleCounts: supervisorData[2], unassigned: supervisorData[3]?.n }
        : null;
      res.json({
        role: u.activeRole,
        queueCounts: Object.fromEntries(states.map((s) => [s, count(s)])),
        stateLabels: STATE_LABELS,
        overdueDeficiencies: overdue?.n ?? 0,
        assignedToMe: mine?.n ?? 0,
        openVerificationRequests: verif?.n ?? 0,
        upcomingVisits: upcoming,
        failedNotifications: failed?.n ?? 0,
        lastSweep,
        policy: POLICY_DESCRIPTION,
        pipeline: (canSeeAll(u.activeRole) ? byStatus : []).map((x) => ({ ...x, label: STATE_LABELS[x.status], stage: stageOf(x.status) })),
        recentActivity,
        supervisor,
      });
    }),
  );

  r.get(
    '/queue',
    ah(async (req, res) => {
      const u = user(req);
      const q = z
        .object({
          scope: z.enum(['mine', 'all']).optional(),
          q: z.string().max(100).optional(),
          category: z.string().max(60).optional(),
          status: z.string().max(40).optional(),
          assigned: z.enum(['me', 'unassigned', 'any']).optional(),
        })
        .parse(req.query);
      const states = q.scope === 'all' ? (VISIBLE_STATES[u.activeRole] ?? []) : (QUEUES[u.activeRole] ?? []);
      // $1 states, $2 current user, $3 active role; filters follow.
      const params: unknown[] = [states, u.id, u.activeRole];
      // Every bound parameter must be referenced, so $1/$2 always appear.
      const where = [
        "a.status <> 'DRAFT'",
        '$2::uuid IS NOT NULL',
        canSeeAll(u.activeRole) && q.scope === 'all' ? '(true OR a.status = ANY($1))' : q.scope === 'all' ? visibleSql(u.activeRole) : mineSql(u.activeRole),
      ];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (q.q) add('(a.reference_no ILIKE ? OR i.name ILIKE ?)', `%${q.q}%`);
      if (q.category) add('a.category_code = ?', q.category);
      if (q.status) add('a.status = ?', q.status);
      if (q.assigned === 'me') where.push('EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id AND s.user_id = $2 AND s.active)');
      const rows = await db.query<Record<string, unknown>>(
        `SELECT a.id, a.reference_no, a.category_code, a.subtype, a.status, a.submitted_at, a.updated_at, a.reopen_requested_at, a.submission_version,
                i.name AS institution_name, i.aicte_institution_id,
                (SELECT json_build_object('role', s.role, 'userId', s.user_id, 'name', uu.full_name) FROM assignments s JOIN users uu ON uu.id = s.user_id
                   WHERE s.application_id = a.id AND s.active AND s.role = $3 LIMIT 1) AS assignment,
                (SELECT uu.full_name FROM assignments s JOIN users uu ON uu.id = s.user_id
                   WHERE s.application_id = a.id AND s.active ORDER BY s.assigned_at DESC LIMIT 1) AS assigned_any,
                (SELECT count(*)::int FROM deficiencies d WHERE d.application_id = a.id AND d.status IN ('OPEN','RESPONDED','UNRESOLVED','PARTIALLY_RESOLVED')) AS outstanding_deficiencies,
                (SELECT min(d.deadline)::text FROM deficiencies d WHERE d.application_id = a.id AND d.status = 'OPEN' AND d.deadline IS NOT NULL) AS next_deadline,
                (SELECT (content->'summary'->'counts') FROM workflow_reports w WHERE w.application_id = a.id ORDER BY w.created_at DESC LIMIT 1) AS latest_counts,
                (SELECT (content->'summary'->'byAssessment') FROM workflow_reports w WHERE w.application_id = a.id ORDER BY w.created_at DESC LIMIT 1) AS latest_assessments,
                (SELECT max(c.submitted_at) FROM correction_submissions c WHERE c.application_id = a.id) AS last_correction_at,
                (SELECT count(*)::int FROM deficiencies d WHERE d.application_id = a.id AND d.status IN ('RESPONDED','RESOLVED','UNRESOLVED','PARTIALLY_RESOLVED')) AS responded_items,
                i.region_code,
                (SELECT json_build_object('visitId', v.id, 'visitStatus', v.status, 'start', v.scheduled_start, 'mode', v.mode,
                   'members', (SELECT count(*)::int FROM evc_visit_members m WHERE m.visit_id = v.id AND m.active),
                   'acknowledged', (SELECT count(*)::int FROM evc_visit_members m WHERE m.visit_id = v.id AND m.active AND m.response_status = 'ACCEPTED'),
                   'conflicts', (SELECT count(*)::int FROM evc_visit_members m WHERE m.visit_id = v.id AND m.active AND m.response_status IN ('CONFLICT_REPORTED','REJECTED','WITHDRAWAL_REQUESTED')),
                   'reportVersion', (SELECT max(r.version) FROM evc_reports r WHERE r.visit_id = v.id),
                   'reportDueAt', (SELECT d.due_at FROM deadlines d WHERE d.subject_type = 'EVC_REPORT' AND d.subject_id = v.id::text))
                 FROM evc_visits v WHERE v.application_id = a.id AND v.status <> 'CANCELLED' ORDER BY v.scheduled_at DESC LIMIT 1) AS evc
         FROM applications a JOIN institutions i ON i.id = a.institution_id
         WHERE ${where.join(' AND ')} ${q.assigned === 'unassigned' ? 'AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id AND s.active AND s.role = $3)' : ''}
         ORDER BY a.updated_at DESC LIMIT 500`,
        params,
      );
      res.json({
        applications: rows.map((a) => ({
          ...a,
          categoryTitle: CATEGORIES.find((c) => c.code === a.category_code)?.title,
          statusLabel: STATE_LABELS[a.status as AppState],
          stage: stageOf(a.status as AppState),
          pendingAction: pendingActor(a.status as AppState),
        })),
      });
    }),
  );

  r.get(
    '/applications/:id',
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const detail = await applicationDetail(db, app, { official: true });
      const inst = await db.one('SELECT * FROM institutions WHERE id = $1', [app.institution_id]);
      const cat = categoryOrThrow(app.category_code);
      const reopenAudit = await db.one('SELECT details FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY id DESC LIMIT 1', [app.id, 'REOPEN_REQUESTED']);
      const reports = await db.query('SELECT id, kind, version, submission_version, created_at, created_by, content FROM workflow_reports WHERE application_id = $1 ORDER BY created_at DESC', [app.id]);
      const assignments = await db.query(
        'SELECT s.role, s.user_id, s.assigned_at, uu.full_name, ab.full_name AS assigned_by_name FROM assignments s JOIN users uu ON uu.id = s.user_id JOIN users ab ON ab.id = s.assigned_by WHERE s.application_id = $1 AND s.active',
        [app.id],
      );
      const verificationRequests = await db.query(
        'SELECT v.*, a.full_name AS requested_by_name, b.full_name AS resolved_by_name FROM verification_requests v JOIN users a ON a.id = v.requested_by LEFT JOIN users b ON b.id = v.resolved_by WHERE v.application_id = $1 ORDER BY v.created_at DESC',
        [app.id],
      );
      const officerActions = await db.query('SELECT o.*, uu.full_name AS actor_name FROM officer_actions o JOIN users uu ON uu.id = o.actor_id WHERE o.application_id = $1 ORDER BY o.id DESC', [app.id]);
      const handoffs = await db.query('SELECT h.*, uu.full_name AS approved_by_name FROM evc_handoffs h JOIN users uu ON uu.id = h.approved_by WHERE h.application_id = $1 ORDER BY h.created_at DESC', [app.id]);
      const visitMembers = await db.query(
        'SELECT m.visit_id, m.user_id, m.expert_id, m.seat, m.response_status, m.responded_at, m.rejection_reason, m.conflict_note, m.attendance, m.active, m.removed_reason, uu.full_name FROM evc_visit_members m JOIN users uu ON uu.id = m.user_id WHERE m.visit_id IN (SELECT id FROM evc_visits WHERE application_id = $1) ORDER BY m.active DESC, m.assigned_at',
        [app.id],
      );
      const visitEvents = await db.query(
        'SELECT e.*, uu.full_name AS actor_name FROM evc_visit_events e LEFT JOIN users uu ON uu.id = e.actor_id WHERE e.visit_id IN (SELECT id FROM evc_visits WHERE application_id = $1) ORDER BY e.id DESC',
        [app.id],
      );
      const deadlineEvents = await db.query('SELECT * FROM deadline_events WHERE application_id = $1 ORDER BY id DESC', [app.id]);
      const documentReviews = await db.query(
        'SELECT r.*, uu.full_name AS reviewed_by_name FROM document_reviews r JOIN users uu ON uu.id = r.reviewed_by WHERE r.application_id = $1 ORDER BY r.created_at DESC',
        [app.id],
      );
      res.json({
        ...detail,
        evcVisits: (detail.evcVisits as Array<Record<string, unknown>>).map((v) => ({ ...v, members: visitMembers.filter((m) => m.visit_id === v.id), events: visitEvents.filter((e) => e.visit_id === v.id) })),
        institution: inst,
        fieldsDef: cat.fields.map((f) => ({ id: f.id, label: f.label, type: f.type })),
        documentsDef: cat.documents.map((d) => ({ id: d.id, name: d.name, aphReference: d.aphReference, stage: d.stage })),
        reopenRequest: reopenAudit?.details ?? null,
        reports,
        assignments,
        verificationRequests,
        officerActions,
        handoffs,
        deadlineEvents,
        documentReviews,
        evcEligibility: cat.route.evc === 'YES' ? await evaluateEvcEligibility(db, app) : null,
        disclaimer: DISCLAIMER,
      });
    }),
  );

  r.get(
    '/reports/:id',
    ah(async (req, res) => {
      const rep = await db.one<{ application_id: string }>('SELECT * FROM workflow_reports WHERE id = $1', [req.params.id]);
      if (!rep) throw new HttpError(404, 'NOT_FOUND', 'Report not found.');
      await loadAppFor(db, user(req), rep.application_id, req);
      res.json({ report: rep });
    }),
  );

  r.get(
    '/applications/:id/evc-eligibility',
    ah(async (req, res) => {
      const app = await loadAppFor(db, user(req), req.params.id, req);
      res.json(await evaluateEvcEligibility(db, app));
    }),
  );

  r.get(
    '/users',
    requireRole('SUPERVISOR', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const { role } = z.object({ role: z.enum(ROLES) }).parse(req.query);
      if (user(req).activeRole === 'REGIONAL_OFFICER' && role !== 'EVC_MEMBER') throw new HttpError(403, 'FORBIDDEN', 'Regional Officers can list EVC members only.');
      res.json({ users: await db.query("SELECT u.id, u.full_name, u.designation FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = $1 AND u.status = 'ACTIVE' ORDER BY u.full_name", [role]) });
    }),
  );

  // ------------------------------------------------------------------ document examination
  r.post(
    '/applications/:id/documents/:docId/review',
    requireRole('SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const b = z
        .object({
          status: z.enum(['EXAMINED_NO_OBSERVATION', 'OBSERVATION_RECORDED', 'CLARIFICATION_NEEDED']),
          observation: z.string().trim().max(4000).optional(),
          sourceReference: z.string().trim().max(200).optional(),
        })
        .parse(req.body);
      const active: Partial<Record<Role, AppState[]>> = { SCRUTINY_OFFICIAL: ['SUBMITTED', 'UNDER_SCRUTINY'], RE_SCRUTINY_OFFICIAL: ['READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'] };
      if (!active[u.activeRole]?.includes(app.status)) throw new HttpError(409, 'NOT_IN_REVIEW', 'Documents can be examined only while the application is at your review stage.');
      if (b.status !== 'EXAMINED_NO_OBSERVATION' && (b.observation?.length ?? 0) < 5) throw new HttpError(400, 'OBSERVATION_REQUIRED', 'Record the observation (at least 5 characters).');
      await assertAssignee(db, u, app.id, u.activeRole);
      const doc = await db.one<{ id: string; requirement_id: string }>('SELECT id, requirement_id FROM documents WHERE id = $1 AND application_id = $2', [req.params.docId, app.id]);
      if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document not found on this application.');
      const row = await db.tx(async (t) => {
        const r0 = await t.one(
          `INSERT INTO document_reviews(application_id, document_id, requirement_id, submission_version, status, observation, source_reference, reviewed_by, reviewer_role)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [app.id, doc.id, doc.requirement_id, (app as AppRow & { submission_version: number }).submission_version, b.status, b.observation || null, b.sourceReference || null, u.id, u.activeRole],
        );
        await recordOfficerAction(t, u, app.id, 'RECORD_DOCUMENT_REVIEW', b.observation || null, { documentId: doc.id, requirementId: doc.requirement_id, status: b.status });
        return r0;
      });
      await audit(db, req, 'DOCUMENT_REVIEWED', 'document', doc.id, { status: b.status }, app.institution_id);
      res.json({ review: row });
    }),
  );

  // ------------------------------------------------------------------ assignment
  r.post(
    '/applications/:id/claim',
    requireRole('SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      if (!QUEUES[u.activeRole]?.includes(app.status)) throw new HttpError(409, 'NOT_IN_QUEUE', 'This application is not at a stage your role handles.');
      const existing = await db.one<{ user_id: string }>('SELECT user_id FROM assignments WHERE application_id = $1 AND role = $2 AND active', [app.id, u.activeRole]);
      if (existing && existing.user_id !== u.id) throw new HttpError(409, 'ALREADY_ASSIGNED', 'Already assigned to another official. Ask a supervisor to reassign.');
      if (!existing) await db.query('INSERT INTO assignments(application_id, role, user_id, assigned_by) VALUES ($1,$2,$3,$3)', [app.id, u.activeRole, u.id]);
      await recordOfficerAction(db, u, app.id, 'CLAIM', null, { role: u.activeRole });
      await audit(db, req, 'ASSIGNMENT_CLAIMED', 'application', app.id, { role: u.activeRole }, app.institution_id);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/applications/:id/assign',
    requireRole('SUPERVISOR'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z.object({ role: z.enum(['SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL', 'REGIONAL_OFFICER']), userId: z.string().uuid(), reason: z.string().trim().min(5).max(1000) }).parse(req.body);
      const app = await loadAppFor(db, u, req.params.id, req);
      const ok = await db.one("SELECT 1 FROM user_roles r JOIN users x ON x.id = r.user_id WHERE r.user_id = $1 AND r.role = $2 AND x.status = 'ACTIVE'", [b.userId, b.role]);
      if (!ok) throw new HttpError(400, 'INVALID_ASSIGNEE', 'The selected user does not hold that role.');
      await db.tx(async (t) => {
        await t.query('UPDATE assignments SET active = false WHERE application_id = $1 AND role = $2 AND active', [app.id, b.role]);
        await t.query('INSERT INTO assignments(application_id, role, user_id, assigned_by) VALUES ($1,$2,$3,$4)', [app.id, b.role, b.userId, u.id]);
        await recordOfficerAction(t, u, app.id, 'ASSIGN', b.reason, { role: b.role, userId: b.userId });
        await notify(t, { recipientUserId: b.userId, applicationId: app.id, eventType: 'ASSIGNED', title: `Assigned: ${app.reference_no}`, message: `You were assigned as ${b.role.replace(/_/g, ' ').toLowerCase()}. ${b.reason}` });
      });
      await audit(db, req, 'ASSIGNMENT_SET', 'application', app.id, b, app.institution_id);
      res.json({ ok: true });
    }),
  );

  // ------------------------------------------------------------------ scrutiny checks & deficiency drafts
  r.post(
    '/applications/:id/rerun-checks',
    requireRole('SCRUTINY_OFFICIAL'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      if (!['SUBMITTED', 'UNDER_SCRUTINY'].includes(app.status)) throw new HttpError(409, 'WRONG_STAGE', 'Checks can be re-run during scrutiny.');
      await assertAssignee(db, u, app.id, 'SCRUTINY_OFFICIAL');
      const out = await db.tx(async (t) => {
        const run = await runValidation(t, app, { stage: 'SCRUTINY', actor: `user:${u.id}`, includeNotApplicable: true });
        const rep = await createScrutinyReport(t, app, run.runId, `user:${u.id}`);
        await recordOfficerAction(t, u, app.id, 'RERUN_CHECKS', null, { reportVersion: rep.version });
        return rep;
      });
      res.json({ report: out });
    }),
  );

  r.post(
    '/applications/:id/deficiency-drafts',
    requireRole('SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const b = draftSchema.parse(req.body);
      const cat = categoryOrThrow(app.category_code);
      if (u.activeRole === 'SCRUTINY_OFFICIAL') {
        if (!(app.status === 'UNDER_SCRUTINY' || (app.status === 'SUBMITTED' && !cat.route.scrutiny))) throw new HttpError(409, 'WRONG_STAGE', 'Deficiencies are drafted while the application is under scrutiny.');
      } else {
        if (app.status !== 'UNDER_RE_SCRUTINY') throw new HttpError(409, 'WRONG_STAGE', 'Follow-up deficiencies are drafted during re-scrutiny.');
        // Re-scrutiny scope (Ch. I §1.8(g)): only deficiencies already pointed out by scrutiny.
        if (!b.parentDeficiencyId) throw new HttpError(422, 'OUT_OF_SCOPE', 'Re-scrutiny verifies only the deficiencies pointed out by the Scrutiny Committee. Link this follow-up to an original deficiency.');
        const parent = await db.one('SELECT 1 FROM deficiencies WHERE id = $1 AND application_id = $2', [b.parentDeficiencyId, app.id]);
        if (!parent) throw new HttpError(400, 'INVALID_PARENT', 'The original deficiency was not found on this application.');
      }
      await assertAssignee(db, u, app.id, u.activeRole);
      const def = await db.tx((t) => insertDraftDeficiency(t, app, u, cat, b));
      res.status(201).json({ deficiency: def });
    }),
  );

  r.post(
    '/deficiencies/:id/withdraw',
    requireRole('SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL'),
    ah(async (req, res) => {
      const u = user(req);
      const d = await db.one<{ id: string; application_id: string; status: string }>('SELECT id, application_id, status FROM deficiencies WHERE id = $1', [req.params.id]);
      if (!d) throw new HttpError(404, 'NOT_FOUND', 'Deficiency not found.');
      await loadAppFor(db, u, d.application_id, req);
      if (d.status !== 'DRAFT') throw new HttpError(409, 'NOT_DRAFT', 'Only draft deficiencies can be withdrawn.');
      await db.query("UPDATE deficiencies SET status = 'WITHDRAWN', updated_at = now() WHERE id = $1", [d.id]);
      await db.query('INSERT INTO deficiency_events(deficiency_id, event, actor_id) VALUES ($1,$2,$3)', [d.id, 'WITHDRAWN', u.id]);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/deficiencies/:id/review',
    requireRole('RE_SCRUTINY_OFFICIAL'),
    ah(async (req, res) => {
      const u = user(req);
      const body = z.object({ outcome: z.enum(['RESOLVED', 'UNRESOLVED', 'PARTIALLY_RESOLVED']), note: z.string().trim().min(3).max(4000) }).parse(req.body);
      const d = await db.one<{ id: string; application_id: string; status: string; reference_no: string; automated_assessment: string | null }>(
        'SELECT id, application_id, status, reference_no, automated_assessment FROM deficiencies WHERE id = $1',
        [req.params.id],
      );
      if (!d) throw new HttpError(404, 'NOT_FOUND', 'Deficiency not found.');
      const app = await loadAppFor(db, u, d.application_id, req);
      if (app.status !== 'UNDER_RE_SCRUTINY') throw new HttpError(409, 'NOT_IN_RE_SCRUTINY', 'Deficiencies are reviewed during re-scrutiny.');
      if (!['RESPONDED', 'RESOLVED', 'UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(d.status)) throw new HttpError(409, 'NOT_REVIEWABLE', 'This deficiency has no correction to review.');
      await assertAssignee(db, u, app.id, 'RE_SCRUTINY_OFFICIAL');
      await db.tx(async (t) => {
        await t.query('UPDATE deficiencies SET status = $2, officer_response = $3, updated_at = now() WHERE id = $1', [d.id, body.outcome, body.note]);
        await t.query('INSERT INTO deficiency_events(deficiency_id, event, actor_id, note) VALUES ($1,$2,$3,$4)', [d.id, `REVIEW_${body.outcome}`, u.id, body.note]);
        await recordOfficerAction(t, u, app.id, `REVIEW_${body.outcome}`, body.note, { deficiency: d.reference_no, automatedAssessment: d.automated_assessment });
      });
      await audit(db, req, `DEFICIENCY_${body.outcome}`, 'deficiency', d.id, {}, app.institution_id);
      res.json({ ok: true });
    }),
  );

  // ------------------------------------------------------------------ verification requests & supervisor
  r.post(
    '/applications/:id/verification-requests',
    requireRole('SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const { reason } = reasonSchema.parse(req.body);
      const vr = await db.tx(async (t) => {
        const v = await t.one<{ id: string }>('INSERT INTO verification_requests(application_id, requested_by, requested_role, reason) VALUES ($1,$2,$3,$4) RETURNING id', [app.id, u.id, u.activeRole, reason]);
        await recordOfficerAction(t, u, app.id, 'REQUEST_VERIFICATION', reason, { requestId: v!.id });
        await notifyRole(t, 'SUPERVISOR', app.id, 'VERIFICATION_REQUESTED', `Further verification requested: ${app.reference_no}`, reason, `vr:${v!.id}`);
        return v;
      });
      res.status(201).json({ request: vr });
    }),
  );

  r.post(
    '/verification-requests/:id/resolve',
    requireRole('SUPERVISOR'),
    ah(async (req, res) => {
      const u = user(req);
      const { resolution } = z.object({ resolution: z.string().trim().min(5).max(4000) }).parse(req.body);
      const v = await db.one<{ id: string; application_id: string; status: string; requested_by: string }>('SELECT * FROM verification_requests WHERE id = $1', [req.params.id]);
      if (!v || v.status !== 'OPEN') throw new HttpError(404, 'NOT_FOUND', 'Open request not found.');
      await db.tx(async (t) => {
        await t.query("UPDATE verification_requests SET status = 'RESOLVED', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1", [v.id, resolution, u.id]);
        await recordOfficerAction(t, u, v.application_id, 'RESOLVE_VERIFICATION', resolution, { requestId: v.id });
        await notify(t, { recipientUserId: v.requested_by, applicationId: v.application_id, eventType: 'VERIFICATION_RESOLVED', title: 'Verification request resolved', message: resolution, dedupeKey: `vr:${v.id}:resolved` });
      });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/escalations',
    requireRole('SUPERVISOR'),
    ah(async (_req, res) => {
      const today = todayIST();
      const overdue = await db.query(
        `SELECT d.id, d.reference_no, d.target_label, d.deadline::text AS deadline, d.deadline_type, d.status, a.id AS application_id, a.reference_no AS application_ref, i.name AS institution_name,
                uu.full_name AS raised_by_name
         FROM deficiencies d JOIN applications a ON a.id = d.application_id JOIN institutions i ON i.id = a.institution_id JOIN users uu ON uu.id = d.raised_by
         WHERE d.status = 'OPEN' AND d.deadline IS NOT NULL AND d.deadline < $1::date AND a.status IN ('DEFICIENCY_RAISED','CORRECTION_IN_PROGRESS') ORDER BY d.deadline`,
        [today],
      );
      const events = await db.query(
        'SELECT e.*, a.reference_no AS application_ref FROM deadline_events e LEFT JOIN applications a ON a.id = e.application_id ORDER BY e.id DESC LIMIT 100',
      );
      const requests = await db.query(
        `SELECT v.*, a.reference_no AS application_ref, uu.full_name AS requested_by_name FROM verification_requests v JOIN applications a ON a.id = v.application_id
         JOIN users uu ON uu.id = v.requested_by ORDER BY (v.status = 'OPEN') DESC, v.created_at DESC LIMIT 100`,
      );
      res.json({ overdue, events, requests, policy: POLICY_DESCRIPTION });
    }),
  );

  // ------------------------------------------------------------------ administrator
  r.get(
    '/admin/notifications',
    requireRole('SYSTEM_ADMIN'),
    ah(async (req, res) => {
      const { status } = z.object({ status: z.enum(['PENDING', 'DELIVERED', 'FAILED']).optional() }).parse(req.query);
      const rows = await db.query(
        `SELECT n.id, n.event_type, n.title, n.delivery_status, n.attempts, n.last_error, n.created_at, n.delivered_at, n.dedupe_key, uu.login_id AS recipient
         FROM notifications n JOIN users uu ON uu.id = n.recipient_user_id WHERE ($1::text IS NULL OR n.delivery_status = $1) ORDER BY n.created_at DESC LIMIT 300`,
        [status ?? null],
      );
      const counts = await db.query('SELECT delivery_status, count(*)::int AS n FROM notifications GROUP BY 1');
      res.json({ notifications: rows, counts });
    }),
  );
  r.post(
    '/admin/notifications/retry',
    requireRole('SYSTEM_ADMIN'),
    ah(async (req, res) => {
      const out = await retryFailedDeliveries(db);
      await audit(db, req, 'NOTIFICATION_RETRY', null, null, out);
      res.json(out);
    }),
  );
  // Operational policies: an administrator proposes a value; a supervisor (a different person) authorises it.
  r.get(
    '/admin/policies',
    requireRole('SYSTEM_ADMIN', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (_req, res) => {
      const policies = await db.query('SELECT * FROM operational_policies ORDER BY key');
      const history = await db.query('SELECT h.*, uu.full_name AS changed_by_name FROM operational_policy_history h LEFT JOIN users uu ON uu.id = h.changed_by ORDER BY h.id DESC LIMIT 100');
      res.json({ policies, history, note: 'Operational configuration. Values drive reminders and follow-up deadlines only.' });
    }),
  );
  r.put(
    '/admin/policies/:key',
    requireRole('SYSTEM_ADMIN'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z.object({ value: z.number().min(0).max(3650), reason: z.string().trim().min(5).max(500) }).parse(req.body);
      const p = await db.one<{ key: string; version: number }>('SELECT key, version FROM operational_policies WHERE key = $1', [req.params.key]);
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'Unknown policy.');
      await db.tx(async (t) => {
        await t.query("UPDATE operational_policies SET value = $2, version = version + 1, status = 'DEMO_UNAUTHORISED', authorised_by = NULL, authorised_at = NULL, updated_at = now() WHERE key = $1", [p.key, JSON.stringify(b.value)]);
        await t.query('INSERT INTO operational_policy_history(key, version, value, status, changed_by, reason) VALUES ($1,$2,$3,$4,$5,$6)', [p.key, p.version + 1, JSON.stringify(b.value), 'DEMO_UNAUTHORISED', u.id, b.reason]);
      });
      await audit(db, req, 'OPERATIONAL_POLICY_CHANGED', 'operational_policy', p.key, b);
      res.json({ ok: true });
    }),
  );
  r.post(
    '/admin/policies/:key/authorise',
    requireRole('SUPERVISOR'),
    ah(async (req, res) => {
      const u = user(req);
      const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
      const p = await db.one<{ key: string; version: number; value: unknown }>('SELECT key, version, value FROM operational_policies WHERE key = $1', [req.params.key]);
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'Unknown policy.');
      const last = await db.one<{ changed_by: string | null }>('SELECT changed_by FROM operational_policy_history WHERE key = $1 ORDER BY id DESC LIMIT 1', [p.key]);
      if (last?.changed_by === u.id) throw new HttpError(409, 'SAME_PERSON', 'The person who changed a policy cannot authorise it.');
      await db.tx(async (t) => {
        await t.query("UPDATE operational_policies SET status = 'AUTHORISED', authorised_by = $2, authorised_at = now() WHERE key = $1", [p.key, `${u.fullName} (${u.loginId})`]);
        await t.query('INSERT INTO operational_policy_history(key, version, value, status, changed_by, reason) VALUES ($1,$2,$3,$4,$5,$6)', [p.key, p.version, JSON.stringify(p.value), 'AUTHORISED', u.id, reason]);
      });
      await audit(db, req, 'OPERATIONAL_POLICY_AUTHORISED', 'operational_policy', p.key, { reason });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/admin/jobs',
    requireRole('SYSTEM_ADMIN', 'SUPERVISOR'),
    ah(async (_req, res) => {
      res.json({ jobs: await db.query('SELECT * FROM job_runs ORDER BY id DESC LIMIT 50'), policy: POLICY_DESCRIPTION, intervalMs: POLICY.sweepIntervalMs });
    }),
  );
  r.post(
    '/admin/run-sweep',
    requireRole('SYSTEM_ADMIN', 'SUPERVISOR'),
    ah(async (req, res) => {
      const out = await runJob(db, 'deadline-sweep (manual)', () => runDeadlineSweep(db));
      await audit(db, req, 'SWEEP_RUN_MANUALLY', null, null, out);
      res.json(out);
    }),
  );

  // ------------------------------------------------------------------ EVC calendar
  r.get(
    '/evc/visits',
    requireRole('REGIONAL_OFFICER', 'SUPERVISOR', 'EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const rows = await db.query(
        `SELECT v.*, a.reference_no, a.category_code, a.status AS application_status, i.name AS institution_name,
                (SELECT json_agg(json_build_object('userId', m.user_id, 'name', uu.full_name, 'seat', m.seat, 'response', m.response_status, 'attendance', m.attendance)) FROM evc_visit_members m JOIN users uu ON uu.id = m.user_id WHERE m.visit_id = v.id AND m.active) AS members
         FROM evc_visits v JOIN applications a ON a.id = v.application_id JOIN institutions i ON i.id = a.institution_id
         WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM evc_visit_members m WHERE m.visit_id = v.id AND m.user_id = $1 AND m.active))
           AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM user_regions ur WHERE ur.user_id = $2 AND ur.region_code = i.region_code))
         ORDER BY v.scheduled_start`,
        [u.activeRole === 'EVC_MEMBER' ? u.id : null, u.activeRole === 'REGIONAL_OFFICER' ? u.id : null],
      );
      res.json({ visits: rows });
    }),
  );

  // ------------------------------------------------------------------ workflow actions
  const actionSchemas: Partial<Record<string, z.ZodTypeAny>> = {
    SCHEDULE_EVC: z.object({
      mode: z.enum(['ONLINE', 'PHYSICAL']),
      scheduledStart: z.string().datetime({ offset: true }),
      scheduledEnd: z.string().datetime({ offset: true }),
      timeZone: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
      location: z.string().max(400).optional(),
      meetingLink: z.string().url().max(400).optional(),
      /** Draft panel kept with the proposal; no official's time is reserved until invitations are sent. */
      panel: z.array(z.object({ expertId: z.string().uuid(), seat: z.enum(SEATS) })).max(10).optional(),
      agenda: z.string().max(4000).optional(),
      prepareItems: z.string().max(4000).optional(),
      instructions: z.string().max(4000).optional(),
      committeeDisclosure: z.string().max(1000).optional(),
      /** Ch. I §1.8 NOTE: EVCs are online; offline only under extraordinary circumstances (incl. Court directions). */
      offlineJustification: z.string().trim().max(2000).optional(),
    }),
    RESCHEDULE_EVC: z.object({ scheduledStart: z.string().datetime({ offset: true }), scheduledEnd: z.string().datetime({ offset: true }), reason: z.string().trim().min(3).max(1000), meetingLink: z.string().url().max(400).optional(), location: z.string().max(400).optional() }),
    CANCEL_EVC: z.object({ reason: z.string().trim().min(3).max(1000) }),
    ASSIGN_EVC_MEMBERS: z.object({
      members: z.array(z.object({ expertId: z.string().uuid(), seat: z.enum(SEATS) })).min(1).max(10),
      reason: z.string().trim().max(1000).optional(),
    }),
    SUBMIT_EVC_REPORT: z.object({
      observations: z.string().trim().min(10).max(20000),
      recommendation: z.string().trim().min(3).max(2000),
      disclosedSummary: z.string().trim().max(4000).optional(),
      evidenceRefs: z.array(z.string().max(400)).max(50).optional(),
      /** The submitting member confirms the report states what the committee verified. */
      declaration: z.literal(true, { errorMap: () => ({ message: 'Confirm the declaration before submitting the final report.' }) }),
      sections: z
        .record(z.enum(REPORT_SECTIONS.map((s) => s.key) as [string, ...string[]]), z.object({ finding: z.enum(SECTION_FINDINGS), observation: z.string().trim().max(4000).optional() }))
        .optional(),
    }),
    FORWARD_AFTER_EVC: z.object({ toShc: z.boolean() }),
    RECORD_SHC_OUTCOME: z.object({ outcome: z.enum(['COMPLIANCE_SATISFACTORY', 'COMPLIANCE_NOT_SATISFACTORY', 'PARTIAL']), notes: z.string().trim().min(3).max(8000) }),
    RECORD_SAC_RECOMMENDATION: z.object({ outcome: z.enum(['RECOMMEND', 'NOT_RECOMMEND', 'REFER_SCRUTINY', 'REFER_EVC']), notes: z.string().trim().min(3).max(8000) }),
  };
  actionSchemas.PROPOSE_EVC_DATE = actionSchemas.SCHEDULE_EVC;
  actionSchemas.SEND_FOR_RESCRUTINY = z.object({ reason: z.string(), deficiencies: z.array(draftSchema).max(50).default([]) });
  actionSchemas.FORWARD_TO_EVC = z.object({ reason: z.string() });

  r.post(
    '/applications/:id/actions/:action',
    upload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const action = req.params.action as Action | 'DECLINE_REOPEN' | 'ASSIGN_EVC_MEMBERS' | 'SEND_FOR_RESCRUTINY' | 'FORWARD_TO_EVC';
      // Authorise the action for this role before reading any input.
      const roleFor =
        action === 'DECLINE_REOPEN'
          ? TRANSITIONS.APPROVE_REOPEN
          : action === 'ASSIGN_EVC_MEMBERS'
            ? TRANSITIONS.PROPOSE_EVC_DATE
            : action === 'SEND_FOR_RESCRUTINY' || action === 'FORWARD_TO_EVC'
              ? TRANSITIONS.COMPLETE_SCRUTINY
              : TRANSITIONS[action as Action];
      if (!roleFor || action === 'ROUTE_TO_DECISION') throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
      if (!roleFor.roles.includes(u.activeRole)) {
        await audit(db, req, 'ACTION_DENIED', 'application', req.params.id, { action });
        throw new HttpError(403, 'FORBIDDEN', `Your role is not permitted to perform ${action}.`);
      }
      const app = await loadAppFor(db, u, req.params.id, req);
      const group = ACTION_GROUP[action];
      if (group) await assertAssignee(db, u, app.id, group);
      if (action === 'APPROVE_EVC_HANDOFF' && u.activeRole !== 'SUPERVISOR') await assertAssignee(db, u, app.id, u.activeRole);
      const actor = { id: u.id, role: u.activeRole };
      const schema = actionSchemas[action];
      const body = schema ? schema.parse(req.body) : (req.body ?? {});
      const reason: string | null = REASON_REQUIRED.has(action) ? reasonSchema.parse(req.body).reason : (typeof req.body?.reason === 'string' ? req.body.reason : null);
      const cat = categoryOrThrow(app.category_code);
      const result: Record<string, unknown> = {};
      const routeAfterScrutiny = async (t: Db) => {
        const next = afterScrutiny(cat.route);
        if (next === 'AWAITING_AUTHORISED_DECISION') {
          await transition(t, req, { id: null, role: 'SYSTEM' }, app, 'ROUTE_TO_DECISION', { to: next }, 'Routed for authorised decision (no EVC step for this category)');
          await notifyDecisionStage(t, app, 'STAGE_READY', `${app.reference_no} ready for decision`, cat.title);
        } else {
          result.evcEligibility = await evaluateEvcEligibility(t, app);
          await notifyRole(t, 'REGIONAL_OFFICER', app.id, 'AWAITING_HANDOFF', `${app.reference_no}: scrutiny completed`, 'Awaiting authorised EVC handoff.');
        }
      };

      /**
       * After the committee has accepted and the visit is confirmed: notify the institution and the committee and
       * register the visit-outcome follow-up (operational configuration).
       */
      const afterConfirm = async (t: Db, visitId: string, start: string, end: string | null, mode: string, version: number) => {
        const when = slotLabel(start, end);
        await notifyInstitution(t, app, 'EVC_SCHEDULED', `EVC confirmed for ${app.reference_no}`, `${mode === 'ONLINE' ? 'Online' : 'Physical'} visit on ${when}.`, `visit:${visitId}:confirmed:v${version}`);
        const grace = await getPolicy(t, 'EVC_VISIT_OUTCOME_GRACE_HOURS');
        await t.query(
          `INSERT INTO deadlines(subject_type, subject_id, application_id, visit_id, responsible_role, due_at, source_type, source_reference, policy_key, policy_version)
           VALUES ('EVC_VISIT_OUTCOME',$1,$2,$8::uuid,'REGIONAL_OFFICER', $3::timestamptz + ($4 || ' hours')::interval, 'AUTHORISED_OPERATIONAL_CONFIGURATION',$5,$6,$7)
           ON CONFLICT (subject_type, subject_id) DO UPDATE SET due_at = EXCLUDED.due_at, status = 'OPEN', completed_at = NULL`,
          [visitId, app.id, end ?? start, String(grace.value), policyLabel(grace), grace.key, grace.version, visitId],
        );
        const members = await t.query<{ user_id: string }>("SELECT user_id FROM evc_visit_members WHERE visit_id = $1 AND active AND response_status = 'ACCEPTED'", [visitId]);
        for (const m of members)
          await notify(t, { recipientUserId: m.user_id, applicationId: app.id, eventType: 'EVC_CONFIRMED', title: `EVC confirmed: ${app.reference_no}`, message: `${when} (${mode.toLowerCase()}). Instructions and documents are in your EVC workspace.`, dedupeKey: `visit:${visitId}:confirmed:v${version}` });
      };

      /** The scrutiny officer's two actions take up the application for scrutiny automatically. */
      const startScrutinyIfNeeded = async (t: Db) => {
        if (app.status !== 'SUBMITTED' || !cat.route.scrutiny) return;
        await transition(t, req, actor, app, 'START_SCRUTINY');
        if (!(await t.one('SELECT 1 FROM assignments WHERE application_id = $1 AND role = $2 AND active', [app.id, 'SCRUTINY_OFFICIAL'])))
          await t.query('INSERT INTO assignments(application_id, role, user_id, assigned_by) VALUES ($1,$2,$3,$3)', [app.id, 'SCRUTINY_OFFICIAL', u.id]);
      };

      switch (action) {
        case 'SEND_FOR_RESCRUTINY': {
          // Deficiency route: explain each deficiency / discrepancy, issue the notice; corrections go to re-scrutiny.
          const b = body as { deficiencies: DraftInput[] };
          if (!['SUBMITTED', 'UNDER_SCRUTINY'].includes(app.status)) throw new HttpError(409, 'WRONG_STAGE', 'This application is not awaiting scrutiny.');
          await db.tx(async (t) => {
            await startScrutinyIfNeeded(t);
            for (const d of b.deficiencies) await insertDraftDeficiency(t, app, u, cat, d);
            const drafts = await t.query<{ id: string }>("SELECT id FROM deficiencies WHERE application_id = $1 AND status = 'DRAFT'", [app.id]);
            if (!drafts.length) throw new HttpError(422, 'NO_DEFICIENCIES', 'Explain at least one deficiency or discrepancy before sending for re-scrutiny.');
            const n = await issueNotice(t, storage, app, u, 'INITIAL', reason!, drafts.map((d) => d.id));
            await transition(t, req, actor, app, 'ISSUE_DEFICIENCY_NOTICE', {}, `Sent for re-scrutiny: notice ${n.noticeNo} v${n.version} (${drafts.length} item(s))`);
            await notifyInstitution(
              t,
              app,
              'DEFICIENCY_NOTICE',
              `Deficiency notice ${n.noticeNo} issued`,
              `${drafts.length} deficiency(ies) recorded for ${app.reference_no}. Download the notice, correct the items and submit for re-scrutiny.`,
              `notice:${n.id}`,
            );
            await notifyRole(t, 'RE_SCRUTINY_OFFICIAL', app.id, 'RESCRUTINY_EXPECTED', `${app.reference_no}: sent for re-scrutiny`, `Notice ${n.noticeNo} issued; the application reaches your queue when the institution submits corrections.`, `notice:${n.id}:rs`);
            result.notice = n;
          });
          break;
        }
        case 'FORWARD_TO_EVC': {
          // No-deficiency route: record scrutiny as in order and hand off to the EVC Coordinator (or decision stage where Table 2.3 has no EVC).
          if (!['SUBMITTED', 'UNDER_SCRUTINY', 'SCRUTINY_COMPLETED'].includes(app.status)) throw new HttpError(409, 'WRONG_STAGE', 'This application is not awaiting scrutiny.');
          const drafts = await db.one("SELECT 1 FROM deficiencies WHERE application_id = $1 AND status = 'DRAFT'", [app.id]);
          if (drafts) throw new HttpError(409, 'DRAFTS_PENDING', 'There are unsent deficiency drafts. Send for re-scrutiny instead.');
          await db.tx(async (t) => {
            if (app.status === 'SUBMITTED' && !cat.route.scrutiny) {
              await transition(t, req, actor, app, 'FORWARD_SELF_DISCLOSURE', {}, reason!);
              await notifyDecisionStage(t, app, 'AWAITING_DECISION', `Decision pending ${app.reference_no}`, cat.title);
              result.forwardedTo = 'DECISION';
              return;
            }
            await startScrutinyIfNeeded(t);
            if (app.status === 'UNDER_SCRUTINY') await transition(t, req, actor, app, 'COMPLETE_SCRUTINY', {}, `Scrutiny: found in order. ${reason}`);
            if (cat.route.evc === 'NO') {
              await routeAfterScrutiny(t);
              result.forwardedTo = 'DECISION';
              return;
            }
            const el = await evaluateEvcEligibility(t, app);
            if (!el.eligible) throw new HttpError(409, 'NOT_ELIGIBLE', `Cannot forward to EVC — ${el.unresolvedPrerequisites.join('; ')}. Use "Send for re-scrutiny" if there are deficiencies.`);
            const h = await t.one<{ id: string }>('INSERT INTO evc_handoffs(application_id, eligibility, approved_by, approved_role, note) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
              app.id,
              JSON.stringify(el),
              u.id,
              u.activeRole,
              reason,
            ]);
            await transition(t, req, actor, app, 'APPROVE_EVC_HANDOFF', {}, `Forwarded to EVC Coordinator: ${reason}`);
            await notifyRole(t, 'REGIONAL_OFFICER', app.id, 'EVC_HANDOFF', `Ready for EVC: ${app.reference_no}`, `${cat.title}. Forwarded by ${u.fullName} after scrutiny.`, `handoff:${h!.id}`);
            result.handoff = h;
            result.forwardedTo = 'EVC';
          });
          break;
        }
        case 'START_SCRUTINY':
          await db.tx(async (t) => {
            await transition(t, req, actor, app, 'START_SCRUTINY', {}, reason ?? undefined);
            const has = await t.one("SELECT 1 FROM workflow_reports WHERE application_id = $1 AND kind = 'SCRUTINY'", [app.id]);
            if (!has) {
              const run = await runValidation(t, app, { stage: 'SCRUTINY', actor: `user:${u.id}`, includeNotApplicable: true });
              await createScrutinyReport(t, app, run.runId, `user:${u.id}`);
            }
            if (!(await t.one('SELECT 1 FROM assignments WHERE application_id = $1 AND role = $2 AND active', [app.id, 'SCRUTINY_OFFICIAL'])))
              await t.query('INSERT INTO assignments(application_id, role, user_id, assigned_by) VALUES ($1,$2,$3,$3)', [app.id, 'SCRUTINY_OFFICIAL', u.id]);
          });
          break;
        case 'FORWARD_SELF_DISCLOSURE':
          await db.tx(async (t) => {
            const drafts = await t.one("SELECT 1 FROM deficiencies WHERE application_id = $1 AND status = 'DRAFT'", [app.id]);
            if (drafts) throw new HttpError(409, 'DRAFTS_PENDING', 'Issue or withdraw the draft deficiencies first.');
            await transition(t, req, actor, app, 'FORWARD_SELF_DISCLOSURE', {}, reason!);
            await notifyDecisionStage(t, app, 'AWAITING_DECISION', `Decision pending ${app.reference_no}`, cat.title);
          });
          break;
        case 'ISSUE_DEFICIENCY_NOTICE': {
          const drafts = await db.query<{ id: string }>("SELECT id FROM deficiencies WHERE application_id = $1 AND status = 'DRAFT'", [app.id]);
          if (!drafts.length) throw new HttpError(409, 'NO_DRAFTS', 'Draft at least one deficiency from the report before issuing a notice.');
          await db.tx(async (t) => {
            const n = await issueNotice(t, storage, app, u, 'INITIAL', reason!, drafts.map((d) => d.id));
            await transition(t, req, actor, app, 'ISSUE_DEFICIENCY_NOTICE', {}, `Deficiency notice ${n.noticeNo} v${n.version} issued (${drafts.length} item(s))`);
            await notifyInstitution(t, app, 'DEFICIENCY_NOTICE', `Deficiency notice ${n.noticeNo} issued`, `${drafts.length} deficiency(ies) recorded for ${app.reference_no}. Download the notice and submit corrections from your dashboard.`, `notice:${n.id}`);
            result.notice = n;
          });
          break;
        }
        case 'COMPLETE_SCRUTINY':
        case 'COMPLETE_RE_SCRUTINY': {
          const pending = await db.query<{ reference_no: string; status: string }>("SELECT reference_no, status FROM deficiencies WHERE application_id = $1 AND status NOT IN ('RESOLVED','WITHDRAWN')", [app.id]);
          if (pending.length)
            throw new HttpError(409, 'DEFICIENCIES_PENDING', `Not all deficiencies are resolved (${pending.map((p) => `${p.reference_no}: ${p.status.toLowerCase()}`).join(', ')}). Issue a notice / request further correction, or refer unresolved items.`);
          await db.tx(async (t) => {
            await transition(t, req, actor, app, action, {}, `${action === 'COMPLETE_SCRUTINY' ? 'Scrutiny' : 'Re-scrutiny'}: found in order. ${reason}`);
            await routeAfterScrutiny(t);
          });
          break;
        }
        case 'START_RE_SCRUTINY':
          await db.tx(async (t) => {
            await transition(t, req, actor, app, 'START_RE_SCRUTINY');
            if (!(await t.one('SELECT 1 FROM assignments WHERE application_id = $1 AND role = $2 AND active', [app.id, 'RE_SCRUTINY_OFFICIAL'])))
              await t.query('INSERT INTO assignments(application_id, role, user_id, assigned_by) VALUES ($1,$2,$3,$3)', [app.id, 'RE_SCRUTINY_OFFICIAL', u.id]);
          });
          break;
        case 'REQUEST_FURTHER_CORRECTION': {
          const unreviewed = await db.query<{ reference_no: string }>("SELECT reference_no FROM deficiencies WHERE application_id = $1 AND status = 'RESPONDED'", [app.id]);
          if (unreviewed.length) throw new HttpError(409, 'UNREVIEWED', `Record your review of every correction first: ${unreviewed.map((x) => x.reference_no).join(', ')}.`);
          const items = await db.query<{ id: string }>("SELECT id FROM deficiencies WHERE application_id = $1 AND status IN ('UNRESOLVED','PARTIALLY_RESOLVED','DRAFT')", [app.id]);
          if (!items.length) throw new HttpError(409, 'NOTHING_TO_CORRECT', 'No deficiency is marked unresolved or partially resolved.');
          await db.tx(async (t) => {
            const n = await issueNotice(t, storage, app, u, 'FURTHER_CORRECTION', reason!, items.map((d) => d.id));
            await transition(t, req, actor, app, 'REQUEST_FURTHER_CORRECTION', {}, `Updated notice ${n.noticeNo} v${n.version}: further correction required`);
            await notifyInstitution(t, app, 'DEFICIENCY_NOTICE', `Further correction required: ${app.reference_no}`, `Updated notice ${n.noticeNo} v${n.version} lists ${items.length} item(s) still requiring correction.`, `notice:${n.id}`);
            result.notice = n;
          });
          break;
        }
        case 'REFER_UNRESOLVED':
          await db.tx(async (t) => {
            const to = await transition(t, req, actor, app, 'REFER_UNRESOLVED', {}, reason!);
            if (to === 'AWAITING_COMMITTEE_REVIEW') await notifyRole(t, 'SHC_MEMBER', app.id, 'STAGE_READY', `${app.reference_no} referred`, reason!);
            else await notifyDecisionStage(t, app, 'STAGE_READY', `${app.reference_no} referred`, reason!);
          });
          break;
        case 'APPROVE_EVC_HANDOFF': {
          const el = await evaluateEvcEligibility(db, app);
          if (!el.eligible) throw new HttpError(409, 'NOT_ELIGIBLE', `EVC handoff blocked — unresolved prerequisites: ${el.unresolvedPrerequisites.join('; ')}.`);
          await db.tx(async (t) => {
            const h = await t.one<{ id: string }>('INSERT INTO evc_handoffs(application_id, eligibility, approved_by, approved_role, note) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
              app.id,
              JSON.stringify(el),
              u.id,
              u.activeRole,
              reason,
            ]);
            await transition(t, req, actor, app, 'APPROVE_EVC_HANDOFF', {}, `Authorised EVC handoff: ${reason}`);
            await notifyRole(t, 'REGIONAL_OFFICER', app.id, 'EVC_HANDOFF', `Ready for EVC scheduling: ${app.reference_no}`, `${cat.title}. Handoff approved by ${u.fullName}.`, `handoff:${h!.id}`);
            result.handoff = h;
          });
          break;
        }
        case 'PROPOSE_EVC_DATE': {
          // Saves the proposal (date, time range, mode, draft panel). No official's time is reserved until invitations are sent.
          const b = body as z.infer<NonNullable<typeof actionSchemas.SCHEDULE_EVC>>;
          if (!(new Date(b.scheduledEnd) > new Date(b.scheduledStart))) throw new HttpError(400, 'INVALID_TIME_RANGE', 'The end time must be after the start time.');
          if (b.mode === 'PHYSICAL' && !b.location) throw new HttpError(400, 'LOCATION_REQUIRED', 'Physical EVC requires a location.');
          if (b.mode === 'PHYSICAL' && (b.offlineJustification ?? '').length < 10)
            throw new HttpError(400, 'OFFLINE_JUSTIFICATION_REQUIRED', 'EVCs are conducted online; an offline visit needs the extraordinary circumstance recorded (e.g. Court direction).');
          await db.tx(async (t) => {
            const existing = await t.one<{ id: string; scheduled_start: string; scheduled_end: string | null; invitations_sent_at: string | null }>(
              "SELECT id, scheduled_start, scheduled_end, invitations_sent_at FROM evc_visits WHERE application_id = $1 AND status = 'PROPOSED' ORDER BY scheduled_at DESC LIMIT 1 FOR UPDATE",
              [app.id],
            );
            const timeChanged = existing && (new Date(existing.scheduled_start).getTime() !== new Date(b.scheduledStart).getTime() || new Date(existing.scheduled_end ?? 0).getTime() !== new Date(b.scheduledEnd).getTime());
            if (existing?.invitations_sent_at && timeChanged) throw new HttpError(409, 'USE_RESCHEDULE', 'Invitations were already sent for this slot. Use reschedule so every member is told and re-asked.');
            const vals = [b.mode, b.scheduledStart, b.scheduledEnd, b.location ?? null, b.meetingLink ?? null, b.agenda ?? null, b.prepareItems ?? null, b.instructions ?? null, b.committeeDisclosure ?? null, b.mode === 'PHYSICAL' ? b.offlineJustification : null, b.panel ? JSON.stringify(b.panel) : null];
            const v = existing
              ? await t.one<{ id: string }>(
                  `UPDATE evc_visits SET mode=$2, scheduled_start=$3, scheduled_end=$4, location=$5, meeting_link=$6, agenda=$7, prepare_items=$8, instructions=$9, committee_disclosure=$10, offline_justification=$11,
                     draft_panel = CASE WHEN invitations_sent_at IS NULL THEN $12::jsonb ELSE draft_panel END, updated_at = now() WHERE id = $1 RETURNING *`,
                  [existing.id, ...vals],
                )
              : await t.one<{ id: string }>(
                  `INSERT INTO evc_visits(application_id, mode, scheduled_start, scheduled_end, location, meeting_link, agenda, prepare_items, instructions, committee_disclosure, offline_justification, draft_panel, scheduled_by, status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'PROPOSED') RETURNING *`,
                  [app.id, ...vals, u.id],
                );
            await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [v!.id, existing ? 'PROPOSAL_UPDATED' : 'PROPOSED', u.id, JSON.stringify(b)]);
            const when = slotLabel(b.scheduledStart, b.scheduledEnd);
            await transition(t, req, actor, app, 'PROPOSE_EVC_DATE', {}, `EVC date proposed: ${when}`);
            if (!existing || timeChanged)
              await notifyInstitution(t, app, 'EVC_PROPOSED', `EVC date proposed for ${app.reference_no}`, `Proposed ${b.mode.toLowerCase()} visit on ${when} — subject to the committee's acceptance and confirmation.`, `visit:${v!.id}:proposed:${b.scheduledStart}:${b.scheduledEnd}`);
            result.visit = v;
          });
          break;
        }
        case 'SCHEDULE_EVC':
          throw new HttpError(409, 'USE_INVITATIONS', 'A visit is confirmed only after the committee is invited and every member accepts. Propose the slot, send invitations, then confirm.');
        case 'CONFIRM_EVC': {
          await db.tx(async (t) => {
            const v = await t.one<{ id: string; scheduled_start: string; scheduled_end: string | null; mode: string; status: string; schedule_version: number }>(
              "SELECT id, scheduled_start, scheduled_end, mode, status, schedule_version FROM evc_visits WHERE application_id = $1 AND status IN ('PROPOSED','RESCHEDULED') ORDER BY scheduled_at DESC LIMIT 1 FOR UPDATE",
              [app.id],
            );
            if (!v) throw new HttpError(409, 'NO_PROPOSAL', 'There is no proposed or rescheduled visit to confirm.');
            result.composition = await assertReadyToConfirm(t, v.id);
            await t.query("UPDATE evc_visits SET status = 'SCHEDULED', confirmed_at = now(), updated_at = now() WHERE id = $1", [v.id]);
            await t.query('INSERT INTO evc_schedule_history(visit_id, previous_start, previous_end, new_start, new_end, previous_status, new_status, schedule_version, actor_id, reason) VALUES ($1,$2,$3,$2,$3,$4,$5,$6,$7,$8)', [
              v.id,
              v.scheduled_start,
              v.scheduled_end,
              v.status,
              'SCHEDULED',
              v.schedule_version,
              u.id,
              'All members accepted; confirmed by the Regional Officer',
            ]);
            await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id) VALUES ($1,$2,$3)', [v.id, 'CONFIRMED', u.id]);
            await transition(t, req, actor, app, 'CONFIRM_EVC', { from: app.status }, `EVC confirmed for ${slotLabel(v.scheduled_start, v.scheduled_end)}`);
            await afterConfirm(t, v.id, v.scheduled_start, v.scheduled_end, v.mode, v.schedule_version);
          });
          break;
        }
        case 'ASSIGN_EVC_MEMBERS': {
          // "Send invitations": reserves each official's slot (database-enforced), notifies them, tracks responses.
          const b = body as { members: Array<{ expertId: string; seat: Seat }>; reason?: string };
          await db.tx(async (t) => Object.assign(result, await sendInvitations(t, u, app, b.members, b.reason ?? null)));
          break;
        }
        case 'RESCHEDULE_EVC': {
          const b = body as z.infer<NonNullable<typeof actionSchemas.RESCHEDULE_EVC>>;
          await db.tx(async (t) => {
            const v = await t.one<{ id: string }>("SELECT id FROM evc_visits WHERE application_id = $1 AND status IN ('PROPOSED','SCHEDULED','RESCHEDULED','MISSED') ORDER BY scheduled_at DESC LIMIT 1", [app.id]);
            if (!v) throw new HttpError(409, 'NO_VISIT', 'No visit to reschedule.');
            const out = await moveVisit(t, u, app, v.id, b.scheduledStart, b.scheduledEnd, b.reason);
            if (b.meetingLink || b.location) await t.query('UPDATE evc_visits SET meeting_link = coalesce($2, meeting_link), location = coalesce($3, location) WHERE id = $1', [v.id, b.meetingLink ?? null, b.location ?? null]);
            await t.query("UPDATE deadlines SET status = 'CANCELLED', completed_at = now() WHERE visit_id = $1 AND subject_type = 'EVC_VISIT_OUTCOME' AND status IN ('OPEN','OVERDUE','ESCALATED')", [v.id]);
            await transition(t, req, actor, app, 'RESCHEDULE_EVC', { from: app.status }, `Rescheduled to ${slotLabel(b.scheduledStart, b.scheduledEnd)}: ${b.reason}`);
            await notifyInstitution(t, app, 'EVC_RESCHEDULED', `EVC rescheduled for ${app.reference_no}`, `New time ${slotLabel(b.scheduledStart, b.scheduledEnd)}, subject to the committee's acceptance. Reason: ${b.reason}`, `visit:${v.id}:resched:v${out.version}`);
            result.reschedule = out;
          });
          break;
        }
        case 'CANCEL_EVC':
        case 'START_EVC': {
          const allowed = action === 'START_EVC' ? ['SCHEDULED'] : ['PROPOSED', 'SCHEDULED', 'RESCHEDULED', 'MISSED'];
          const v = await db.one<{ id: string; mode: string }>('SELECT id, mode FROM evc_visits WHERE application_id = $1 AND status = ANY($2) ORDER BY scheduled_at DESC LIMIT 1', [app.id, allowed]);
          if (!v) throw new HttpError(409, 'NO_VISIT', action === 'START_EVC' ? 'Only a confirmed visit (all members accepted) can start.' : 'No visit to cancel.');
          if (action === 'START_EVC' && !(await db.one("SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2 AND active AND response_status = 'ACCEPTED'", [v.id, u.id])))
            throw new HttpError(403, 'NOT_ASSIGNED', 'You are not an accepted member of this visit.');
          await db.tx(async (t) => {
            if (action === 'CANCEL_EVC') {
              const b = body as { reason: string };
              await t.query("UPDATE evc_visits SET status = 'CANCELLED', status_note = $2, updated_at = now() WHERE id = $1", [v.id, b.reason]);
              await releaseReservations(t, v.id);
              await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [v.id, 'CANCELLED', u.id, JSON.stringify(b)]);
              await t.query("UPDATE deadlines SET status = 'CANCELLED', completed_at = now() WHERE visit_id = $1 AND status IN ('OPEN','OVERDUE')", [v.id]);
              if (app.status === 'EVC_SCHEDULED') await transition(t, req, actor, app, 'CANCEL_EVC', {}, `Cancelled: ${b.reason}`);
              await notifyInstitution(t, app, 'EVC_CANCELLED', `EVC cancelled for ${app.reference_no}`, b.reason, `visit:${v.id}:cancelled`);
              const members = await t.query<{ user_id: string }>('SELECT user_id FROM evc_visit_members WHERE visit_id = $1 AND active', [v.id]);
              for (const m of members) await notify(t, { recipientUserId: m.user_id, applicationId: app.id, eventType: 'EVC_CANCELLED', title: `EVC cancelled: ${app.reference_no}`, message: b.reason, dedupeKey: `visit:${v.id}:cancelled` });
            } else {
              await t.query("UPDATE evc_visits SET status = 'IN_PROGRESS', updated_at = now() WHERE id = $1", [v.id]);
              await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id) VALUES ($1,$2,$3)', [v.id, 'STARTED', u.id]);
              await transition(t, req, actor, app, 'START_EVC');
            }
          });
          break;
        }
        case 'SUBMIT_EVC_REPORT': {
          const b = body as z.infer<NonNullable<typeof actionSchemas.SUBMIT_EVC_REPORT>>;
          const v = await db.one<{ id: string; status: string }>("SELECT id, status FROM evc_visits WHERE application_id = $1 AND status IN ('IN_PROGRESS','COMPLETED') ORDER BY scheduled_at DESC LIMIT 1", [app.id]);
          if (!v) throw new HttpError(409, 'NO_VISIT', 'No visit in progress or completed.');
          if (!(await db.one("SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2 AND active AND response_status = 'ACCEPTED'", [v.id, u.id]))) throw new HttpError(403, 'NOT_ASSIGNED', 'You are not an accepted member of this visit.');
          // A completed-visit report needs evidence that the visit took place: recorded attendance.
          if (!(await db.one("SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND active AND attendance = 'PRESENT'", [v.id])))
            throw new HttpError(409, 'VISIT_NOT_OCCURRED', 'Record the attendance of the committee before submitting the report.');
          await db.tx(async (t) => {
            const ver = await t.one<{ v: number | null }>('SELECT max(version) AS v FROM evc_reports WHERE visit_id = $1', [v.id]);
            const version = (ver?.v ?? 0) + 1;
            const receipt = `FG-EVCR-${app.reference_no}-v${version}`;
            const rep = await t.one<{ id: string; version: number; submitted_at: string }>(
              `INSERT INTO evc_reports(visit_id, application_id, version, observations, recommendation, disclosed_summary, evidence_refs, submitted_by, sections, receipt_no, declaration_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING id, version, submitted_at, receipt_no, declaration_at`,
              [v.id, app.id, version, b.observations, b.recommendation, b.disclosedSummary ?? null, JSON.stringify(b.evidenceRefs ?? []), u.id, b.sections ? JSON.stringify(b.sections) : null, receipt],
            );
            await t.query('UPDATE evc_report_evidence SET report_id = $2 WHERE visit_id = $1 AND report_id IS NULL', [v.id, rep!.id]);
            if (v.status !== 'COMPLETED') await t.query("UPDATE evc_visits SET status = 'COMPLETED', completed_at = coalesce(completed_at, now()), completed_by = coalesce(completed_by, $2), updated_at = now() WHERE id = $1", [v.id, u.id]);
            await t.query("UPDATE deadlines SET status = 'MET', completed_at = now() WHERE visit_id = $1 AND subject_type IN ('EVC_REPORT','EVC_VISIT_OUTCOME') AND status IN ('OPEN','OVERDUE','ESCALATED')", [v.id]);
            await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [v.id, 'REPORT_SUBMITTED', u.id, JSON.stringify({ version, receipt })]);
            await transition(t, req, actor, app, 'SUBMIT_EVC_REPORT', {}, 'EVC report submitted (visit completion does not grant approval)');
            result.evcStageValidation = await runValidation(t, app, { stage: 'EVC', actor: `user:${u.id}`, documentStage: 'EVC' });
            await notifyRole(t, 'REGIONAL_OFFICER', app.id, 'EVC_REPORT', `EVC report ${app.reference_no}`, `Report v${version} submitted (receipt ${receipt}); forward for the next stage.`);
            // The Executive Committee decides after the committee's recommendations and the Regulation Bureau's views.
            await notifyRole(t, 'REGULATION_BUREAU', app.id, 'EVC_REPORT', `EVC final report ${app.reference_no}`, `Final EVC report v${version} (receipt ${receipt}) is available for the Regulation Bureau's views before placement before the Executive Committee.`, `report:${rep!.id}:bureau`);
            await notify(t, { recipientUserId: u.id, applicationId: app.id, eventType: 'EVC_REPORT_RECEIPT', title: `Report received: ${receipt}`, message: `EVC report v${version} for ${app.reference_no} was recorded at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`, dedupeKey: `report:${rep!.id}:receipt` });
            result.report = rep;
          });
          break;
        }
        case 'FORWARD_AFTER_EVC':
          await db.tx(async (t) => {
            const to = await transition(t, req, actor, app, 'FORWARD_AFTER_EVC', body as Record<string, unknown>);
            if (to === 'AWAITING_COMMITTEE_REVIEW') await notifyRole(t, 'SHC_MEMBER', app.id, 'STAGE_READY', `${app.reference_no} ready`, STATE_LABELS[to]);
            else await notifyDecisionStage(t, app, 'STAGE_READY', `${app.reference_no} ready`, STATE_LABELS[to]);
          });
          break;
        case 'RECORD_SHC_OUTCOME': {
          const b = body as { outcome: string; notes: string };
          await db.tx(async (t) => {
            await t.query('INSERT INTO committee_reviews(application_id, committee, outcome, notes, recorded_by) VALUES ($1,$2,$3,$4,$5)', [app.id, 'SHC', b.outcome, b.notes, u.id]);
            await transition(t, req, actor, app, 'RECORD_SHC_OUTCOME', {}, `SHC: ${b.outcome}`);
            // The recommendation itself is internal; the institution is told only where the case now stands (Ch. II §2.23.3).
            await notifyInstitution(t, app, 'SHC_CONCLUDED', `Standing Hearing Committee concluded: ${app.reference_no}`, 'The SHC has made its recommendation. It is placed before the Executive Committee, whose decision will be uploaded with a speaking order.', `shc:${app.id}:concluded`);
            await notifyDecisionStage(t, app, 'AWAITING_DECISION', `Decision pending ${app.reference_no}`, 'SHC recommendation recorded');
          });
          break;
        }
        case 'ISSUE_DECISION': {
          const b = z
            .object({
              decisionType: z.enum(['LOA', 'EOA', 'LOD', 'LOR', 'CLOSURE_ORDER', 'OTHER']),
              referenceNo: z.string().trim().min(3).max(100),
              issuingAuthority: z.string().trim().min(3).max(200),
              decisionDate: dateStr,
              reasons: z.string().trim().max(8000).optional(),
              conditions: z.string().trim().max(8000).optional(),
              correctiveAction: z.string().trim().max(8000).optional(),
              nextSteps: z.string().trim().max(4000).optional(),
            })
            .parse(req.body);
          if ((b.decisionType === 'LOR' || b.decisionType === 'LOD') && !b.reasons) throw new HttpError(400, 'REASONS_REQUIRED', 'LoR / LoD must record reasons (speaking order — Ch. I §1.10(b)).');
          const appeal = await db.one<{ id: string; status: string }>('SELECT id, status FROM appeals WHERE application_id = $1', [app.id]);
          const isAppealOutcome = !!appeal && appeal.status !== 'DECIDED';
          // The Executive Committee decides first; on appeal only the Council decides (Ch. I §1.10-1.11; Ch. II §2.23.3, §2.24(f)).
          if (isAppealOutcome && u.activeRole !== 'COUNCIL_OFFICIAL') throw new HttpError(403, 'COUNCIL_DECIDES', 'An appeal is pending: the decision on it is recorded by the Council.');
          if (!isAppealOutcome && u.activeRole !== 'EC_OFFICIAL') throw new HttpError(403, 'EC_DECIDES', 'This decision is recorded by the Executive Committee.');
          if (appeal?.status === 'REFERRED') throw new HttpError(409, 'RETURN_TO_SAC', 'The SAC ordered a further Scrutiny / EVC; its reports go before another SAC before the Council decides (Ch. I §1.11(d)).');
          const chapterI = app.category_code === 'NEW_TECHNICAL_INSTITUTION';
          const aphReference = isAppealOutcome ? (chapterI ? 'Ch. I §1.11(e)' : 'Ch. II §2.24(f)') : chapterI ? 'Ch. I §1.10(a)-(b)' : 'Ch. II §2.23.3; Ch. I §1.10';
          const stored = await storeUpload(storage, req.file);
          await db.tx(async (t) => {
            const d = await t.one<{ id: string; decision_type: string; decision_date: string; uploaded_at: string; corrective_action: string | null }>(
              `INSERT INTO decisions(application_id, decision_type, decision_body, reference_no, issuing_authority, decision_date, reasons, conditions, corrective_action, next_steps,
                 document_storage_key, document_name, document_sha256, is_appeal_outcome, recorded_by, recorded_role, aph_reference)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, decision_type, decision_date::text AS decision_date, uploaded_at, corrective_action`,
              [app.id, b.decisionType, isAppealOutcome ? 'COUNCIL' : 'EXECUTIVE_COMMITTEE', b.referenceNo, b.issuingAuthority, b.decisionDate, b.reasons ?? null, b.conditions ?? null, b.correctiveAction ?? null, b.nextSteps ?? null, stored.key, stored.name, stored.sha256, isAppealOutcome, u.id, u.activeRole, aphReference],
            );
            if (isAppealOutcome) await t.query("UPDATE appeals SET status = 'DECIDED', updated_at = now() WHERE id = $1", [appeal!.id]);
            await transition(t, req, actor, app, 'ISSUE_DECISION', {}, `${b.decisionType} ${b.referenceNo} recorded (${isAppealOutcome ? 'Council decision on appeal' : 'Executive Committee decision'})`);
            await notifyInstitution(t, app, 'DECISION_ISSUED', `Decision issued on ${app.reference_no}`, `${b.decisionType} — ${b.referenceNo}. ${isAppealOutcome ? 'This Council decision is final.' : 'Check the Decisions page for appeal eligibility.'}`, `decision:${d!.id}`);
            await createObligations(t, app, decisionObligations(app, d!), d!.id);
            result.decision = d;
          });
          break;
        }
        case 'START_APPEAL_REVIEW':
          await db.tx(async (t) => {
            await t.query("UPDATE appeals SET status = 'UNDER_REVIEW', updated_at = now() WHERE application_id = $1", [app.id]);
            await transition(t, req, actor, app, 'START_APPEAL_REVIEW', {}, 'Appeal taken up by SAC');
          });
          break;
        case 'RECORD_SAC_RECOMMENDATION': {
          const b = body as { outcome: 'RECOMMEND' | 'NOT_RECOMMEND' | 'REFER_SCRUTINY' | 'REFER_EVC'; notes: string };
          await db.tx(async (t) => {
            await t.query('INSERT INTO committee_reviews(application_id, committee, outcome, notes, recorded_by) VALUES ($1,$2,$3,$4,$5)', [app.id, 'SAC', b.outcome, b.notes, u.id]);
            const st = b.outcome === 'RECOMMEND' ? 'RECOMMENDED' : b.outcome === 'NOT_RECOMMEND' ? 'NOT_RECOMMENDED' : 'REFERRED';
            await t.query('UPDATE appeals SET status = $2, sac_outcome = $3, sac_notes = $4, updated_at = now() WHERE application_id = $1', [app.id, st, b.outcome, b.notes]);
            const to = await transition(t, req, actor, app, 'RECORD_SAC_RECOMMENDATION', { outcome: b.outcome }, `SAC: ${b.outcome}`);
            await notifyInstitution(t, app, 'APPEAL_UPDATE', `Appeal update on ${app.reference_no}`, `The Standing Appellate Committee has made its recommendation. ${to === 'AWAITING_AUTHORISED_DECISION' ? 'It is placed before the Council, whose decision is final.' : 'A further Scrutiny / Expert Visit Committee will be conducted and its report placed before the SAC again.'}`);
            if (to === 'AWAITING_AUTHORISED_DECISION') await notifyRole(t, 'COUNCIL_OFFICIAL', app.id, 'AWAITING_DECISION', `Appeal ready for Council: ${app.reference_no}`, `SAC recommendation recorded (${b.outcome.replace(/_/g, ' ').toLowerCase()}).`);
          });
          break;
        }
        case 'RETURN_TO_SAC': {
          const appeal = await db.one<{ status: string }>('SELECT status FROM appeals WHERE application_id = $1', [app.id]);
          if (appeal?.status !== 'REFERRED') throw new HttpError(409, 'NOT_REFERRED', 'Only an appeal the SAC referred for a further Scrutiny / EVC returns to the SAC.');
          await db.tx(async (t) => {
            await t.query("UPDATE appeals SET status = 'UNDER_REVIEW', updated_at = now() WHERE application_id = $1", [app.id]);
            await transition(t, req, actor, app, 'RETURN_TO_SAC', {}, 'Reports of the further committee placed before the SAC');
            await notifyInstitution(t, app, 'APPEAL_UPDATE', `Appeal update on ${app.reference_no}`, 'The reports of the further committee are placed before the Standing Appellate Committee. Watch for the hearing schedule.');
          });
          break;
        }
        case 'CLOSE':
          await db.tx(async (t) => {
            const el = await appealEligibility(t, app);
            if (el.eligible) throw new HttpError(409, 'APPEAL_WINDOW_OPEN', 'The appeal period is still open; the application cannot be closed yet.');
            await transition(t, req, actor, app, 'CLOSE', {}, reason!);
          });
          break;
        case 'APPROVE_REOPEN':
          if (!app.reopen_requested_at) throw new HttpError(409, 'NO_REQUEST', 'There is no pending reopen request.');
          if (app.reopen_count >= 1) throw new HttpError(409, 'REOPEN_USED', 'Already reopened once.');
          await db.tx(async (t) => {
            await t.query('UPDATE applications SET reopen_count = reopen_count + 1, reopen_requested_at = NULL WHERE id = $1', [app.id]);
            await transition(t, req, actor, app, 'APPROVE_REOPEN', {}, `Reopened ONE time with competent authority approval. ${reason}`);
          });
          break;
        case 'DECLINE_REOPEN':
          if (!app.reopen_requested_at) throw new HttpError(409, 'NO_REQUEST', 'There is no pending reopen request.');
          await db.query('UPDATE applications SET reopen_requested_at = NULL WHERE id = $1', [app.id]);
          await audit(db, req, 'REOPEN_DECLINED', 'application', app.id, { reason }, app.institution_id);
          await notifyInstitution(db, app, 'REOPEN_DECLINED', `Reopen request declined for ${app.reference_no}`, reason!);
          break;
        default:
          throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
      }
      if (!['ASSIGN_EVC_MEMBERS'].includes(action)) await recordOfficerAction(db, u, app.id, action, reason, { body: action === 'ISSUE_DECISION' ? { decisionType: req.body?.decisionType } : body });
      const fresh = await db.one<AppRow>('SELECT * FROM applications WHERE id = $1', [app.id]);
      res.json({ application: fresh, ...result });
    }),
  );

  // ----------------------------------------------------------------- compliance review
  r.get(
    '/compliance',
    requireRole('DECISION_AUTHORITY', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (_req, res) => {
      const dueSoon = (await getPolicy(db, 'COMPLIANCE_DUE_SOON_DAYS')).value;
      const rows = await db.query<Record<string, any>>(
        `SELECT o.*, o.due_date::text AS due_date, a.reference_no, i.name AS institution_name, i.region_code,
                (SELECT json_agg(json_build_object('version', s.version, 'fileName', s.file_name, 'note', s.note, 'submittedAt', s.submitted_at) ORDER BY s.version DESC) FROM compliance_submissions s WHERE s.obligation_id = o.id) AS submissions,
                (SELECT json_agg(json_build_object('outcome', r.outcome, 'note', r.note, 'at', r.created_at, 'by', uu.full_name) ORDER BY r.id DESC) FROM compliance_reviews r JOIN users uu ON uu.id = r.reviewer_id WHERE r.obligation_id = o.id) AS reviews
         FROM compliance_obligations o LEFT JOIN applications a ON a.id = o.application_id JOIN institutions i ON i.id = o.institution_id
         ORDER BY (o.status IN ('SUBMITTED','UNDER_REVIEW')) DESC, o.due_date NULLS LAST`,
      );
      const today = todayIST();
      res.json({ obligations: rows.map((o) => ({ ...o, displayStatus: complianceDisplayStatus(o.status, o.due_date, today, dueSoon) })) });
    }),
  );
  r.post(
    '/compliance/:id/review',
    requireRole('DECISION_AUTHORITY'),
    ah(async (req, res) => {
      const u = user(req);
      const { outcome, note } = z.object({ outcome: z.enum(['UNDER_REVIEW', 'ACCEPTED_BY_AUTHORISED_REVIEWER', 'DEFICIENT', 'HUMAN_REVIEW_REQUIRED']), note: z.string().trim().min(3).max(2000) }).parse(req.body);
      const o = await db.one<{ id: string; institution_id: string; application_id: string | null; title: string; status: string }>('SELECT * FROM compliance_obligations WHERE id = $1', [req.params.id]);
      if (!o) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      if (!['SUBMITTED', 'UNDER_REVIEW', 'HUMAN_REVIEW_REQUIRED'].includes(o.status)) throw new HttpError(409, 'NOT_SUBMITTED', 'Only submitted evidence can be reviewed.');
      const sub = await db.one<{ id: string }>('SELECT id FROM compliance_submissions WHERE obligation_id = $1 ORDER BY version DESC LIMIT 1', [o.id]);
      await db.tx(async (t) => {
        await t.query('UPDATE compliance_obligations SET status = $2, updated_at = now() WHERE id = $1', [o.id, outcome]);
        await t.query('INSERT INTO compliance_reviews(obligation_id, submission_id, outcome, note, reviewer_id, reviewer_role) VALUES ($1,$2,$3,$4,$5,$6)', [o.id, sub?.id ?? null, outcome, note, u.id, u.activeRole]);
      });
      await audit(db, req, `COMPLIANCE_${outcome}`, 'obligation', o.id, { note }, o.institution_id);
      const msg = { UNDER_REVIEW: `Under review. ${note}`, ACCEPTED_BY_AUTHORISED_REVIEWER: `Accepted by an authorised reviewer. ${note}`, DEFICIENT: `Returned as deficient — resubmit evidence. ${note}`, HUMAN_REVIEW_REQUIRED: `Referred for further review. ${note}` }[outcome];
      if (o.application_id) await notifyInstitution(db, { id: o.application_id, institution_id: o.institution_id }, 'COMPLIANCE_REVIEWED', `Compliance: ${o.title}`, msg, `obl:${o.id}:review:${Date.now()}`);
      res.json({ ok: true, status: outcome });
    }),
  );
  r.get(
    '/compliance/:id/evidence',
    requireRole('DECISION_AUTHORITY', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (req, res) => {
      const o = await db.one<{ evidence_storage_key: string | null; evidence_name: string | null }>('SELECT evidence_storage_key, evidence_name FROM compliance_obligations WHERE id = $1', [req.params.id]);
      if (!o?.evidence_storage_key) throw new HttpError(404, 'NOT_FOUND', 'No evidence.');
      sendFile(res, await storage.read(o.evidence_storage_key), o.evidence_name ?? 'evidence', o.evidence_storage_key.endsWith('.pdf') ? 'application/pdf' : o.evidence_storage_key.endsWith('.png') ? 'image/png' : 'image/jpeg');
    }),
  );

  return r;
}

// ------------------------------------------------------------------- rules governance

const LIFECYCLE_NEXT: Record<string, string[]> = {
  DRAFT: ['NEEDS_VERIFICATION', 'VERIFIED', 'RETIRED'],
  NEEDS_VERIFICATION: ['VERIFIED', 'RETIRED'],
  VERIFIED: ['APPROVED_FOR_EXECUTION', 'NEEDS_VERIFICATION', 'RETIRED'],
  APPROVED_FOR_EXECUTION: ['RETIRED'],
  RETIRED: [],
};

export function rulesRouter(db: Db) {
  const r = Router();
  r.get(
    '/',
    requireRole(...OFFICIAL_ROLES, 'RULES_GOVERNANCE'),
    ah(async (req, res) => {
      const q = z.object({ type: z.string().max(60).optional(), lifecycle: z.string().max(40).optional() }).parse(req.query);
      const rows = await db.query(
        `SELECT rule_id, rule_version, application_type, rule_type, severity, aph_reference, source_evidence, verification_status, lifecycle_status, target_label, explanation, approved_by, approved_at, condition
         FROM regulatory_rules WHERE ($1::text IS NULL OR application_type = $1) AND ($2::text IS NULL OR lifecycle_status = $2) ORDER BY application_type, rule_id, rule_version`,
        [q.type ?? null, q.lifecycle ?? null],
      );
      const counts = await db.query('SELECT lifecycle_status, count(*)::int AS n FROM regulatory_rules GROUP BY 1');
      res.json({ rules: rows, counts });
    }),
  );
  r.post(
    '/:ruleId/:version/lifecycle',
    requireRole('RULES_GOVERNANCE'),
    ah(async (req, res) => {
      const u: AuthUser = user(req);
      const { to, note } = z.object({ to: z.enum(['NEEDS_VERIFICATION', 'VERIFIED', 'APPROVED_FOR_EXECUTION', 'RETIRED']), note: z.string().trim().min(3).max(1000) }).parse(req.body);
      const rule = await db.one<{ lifecycle_status: string; verified_by: string | null }>('SELECT lifecycle_status, verified_by FROM regulatory_rules WHERE rule_id = $1 AND rule_version = $2', [req.params.ruleId, Number(req.params.version)]);
      if (!rule) throw new HttpError(404, 'NOT_FOUND', 'Rule not found.');
      if (!LIFECYCLE_NEXT[rule.lifecycle_status]?.includes(to)) throw new HttpError(409, 'INVALID_LIFECYCLE', `Cannot move a ${rule.lifecycle_status} rule to ${to}.`);
      // Publication control (FlowGuard design): the official who verified a rule cannot also approve it for execution.
      if (to === 'APPROVED_FOR_EXECUTION' && (!rule.verified_by || rule.verified_by === u.id))
        throw new HttpError(409, 'SECOND_APPROVER_REQUIRED', 'A rule must be approved for execution by a different authorised official from the one who verified it.');
      await db.query(
        `UPDATE regulatory_rules SET lifecycle_status = $3, verification_status = CASE WHEN $3 IN ('VERIFIED','APPROVED_FOR_EXECUTION') THEN 'VERIFIED' ELSE verification_status END,
           verified_by = CASE WHEN $3 = 'VERIFIED' THEN $5 ELSE verified_by END,
           approved_by = CASE WHEN $3 = 'APPROVED_FOR_EXECUTION' THEN $4 ELSE approved_by END, approved_at = CASE WHEN $3 = 'APPROVED_FOR_EXECUTION' THEN now() ELSE approved_at END
         WHERE rule_id = $1 AND rule_version = $2`,
        [req.params.ruleId, Number(req.params.version), to, `${u.fullName} (${u.loginId})`, u.id],
      );
      await audit(db, req, 'RULE_LIFECYCLE_CHANGED', 'rule', `${req.params.ruleId}@${req.params.version}`, { from: rule.lifecycle_status, to, note });
      res.json({ ok: true });
    }),
  );
  return r;
}

export { ROLES };
