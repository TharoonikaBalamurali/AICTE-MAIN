import type { Request } from 'express';
import { getCategory } from './catalogue/categories.ts';
import type { CategoryDef } from './catalogue/types.ts';
import type { Db } from './db/index.ts';
import { audit, HttpError, type AuthUser } from './http.ts';
import { notifyInstitutionMembers, notifyRoleOrAssignee } from './notify.ts';
import { evaluate } from './rules/conditions.ts';
import { runEngine, type EngineResult } from './rules/engine.ts';
import { RULESET_VERSION, type RuleDef } from './rules/ruleset.ts';
import { resolveTransition, STATE_LABELS, TRANSITIONS, type Action, type AppState, type Role } from './workflow/stateMachine.ts';

export interface AppRow {
  id: string;
  reference_no: string | null;
  institution_id: string;
  category_code: string;
  subtype: string | null;
  academic_year: string | null;
  status: AppState;
  field_values: Record<string, unknown>;
  institution_snapshot: Record<string, unknown> | null;
  applicant_name: string | null;
  applicant_designation: string | null;
  created_by: string;
  submitted_by: string | null;
  submitted_at: string | null;
  ruleset_version: string | null;
  reopen_count: number;
  reopen_requested_at: string | null;
  reopen_request_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------------ dates

const IST = 'Asia/Kolkata';
export function todayIST(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function subtractYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}
/** End of the given calendar day in IST, as an ISO instant. */
export function endOfDayIST(date: string): string {
  return new Date(`${date}T23:59:59.999+05:30`).toISOString();
}

// ------------------------------------------------------------------ access

export function categoryOrThrow(code: string): CategoryDef {
  const c = getCategory(code);
  if (!c) throw new HttpError(400, 'UNKNOWN_CATEGORY', 'Unknown application category.');
  return c;
}

/**
 * Loads an application and enforces record-level authorisation:
 * applicants only see applications of institutions they belong to;
 * officials see submitted applications (never drafts).
 */
export async function loadAppFor(db: Db, u: AuthUser, id: string, req?: Request): Promise<AppRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
  const app = await db.one<AppRow>('SELECT * FROM applications WHERE id = $1', [id]);
  const denied = async () => {
    if (app && req) await audit(db, req, 'ACCESS_DENIED', 'application', id, {}, app.institution_id);
    return new HttpError(404, 'NOT_FOUND', 'Application not found.');
  };
  if (!app) throw await denied();
  if (u.activeRole === 'INSTITUTION_APPLICANT') {
    if (!u.institutionIds.includes(app.institution_id)) throw await denied();
  } else if (app.status === 'DRAFT' || !(await officialCanView(db, u, app))) {
    throw await denied();
  }
  return app;
}

/**
 * Stages each official role handles. An official may view an application in these states, or one they
 * are assigned to or have already acted on. Supervisors, administrators and decision officials see all.
 */
export const VISIBLE_STATES: Partial<Record<Role, AppState[]>> = {
  SCRUTINY_OFFICIAL: ['SUBMITTED', 'UNDER_SCRUTINY', 'DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS', 'READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY', 'SCRUTINY_COMPLETED'],
  RE_SCRUTINY_OFFICIAL: ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS', 'READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY', 'SCRUTINY_COMPLETED'],
  REGIONAL_OFFICER: ['SCRUTINY_COMPLETED', 'AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED', 'EVC_IN_PROGRESS', 'EVC_REPORT_SUBMITTED'],
  // EVC members see only visits they are (or were) assigned to — no stage-wide visibility.
  SHC_MEMBER: ['AWAITING_COMMITTEE_REVIEW'],
  SAC_MEMBER: ['DECISION_ISSUED', 'APPEAL_SUBMITTED', 'APPEAL_UNDER_REVIEW'],
  EC_OFFICIAL: ['AWAITING_AUTHORISED_DECISION', 'DECISION_ISSUED'],
  // The Council sees only cases with an appeal (checked in officialCanView / councilSql).
  COUNCIL_OFFICIAL: ['AWAITING_AUTHORISED_DECISION', 'DECISION_ISSUED', 'APPEAL_SUBMITTED', 'APPEAL_UNDER_REVIEW', 'CLOSED'],
};
/** Cross-region roles. The Regulation Bureau's cross-region view is a FlowGuard configuration (see README). */
const SEE_ALL: Role[] = ['SUPERVISOR', 'SYSTEM_ADMIN', 'DECISION_AUTHORITY', 'RULES_GOVERNANCE', 'REGULATION_BUREAU'];

/** Regional Officers act only within the regions configured for them (user_regions ↔ institutions.region_code). */
export const REGION_SCOPE_SQL = `EXISTS (SELECT 1 FROM institutions ri JOIN user_regions ur ON ur.region_code = ri.region_code WHERE ri.id = a.institution_id AND ur.user_id = $2)`;
export const regionScoped = (role: Role) => role === 'REGIONAL_OFFICER';

export async function officialCanView(db: Db, u: AuthUser, app: Pick<AppRow, 'id' | 'status'>): Promise<boolean> {
  if (SEE_ALL.includes(u.activeRole)) return true;
  if (VISIBLE_STATES[u.activeRole]?.includes(app.status) && (u.activeRole !== 'COUNCIL_OFFICIAL' || (await db.one('SELECT 1 FROM appeals WHERE application_id = $1', [app.id])))) {
    if (!regionScoped(u.activeRole)) return true;
    const inRegion = await db.one(`SELECT 1 FROM applications a WHERE a.id = $1 AND ${REGION_SCOPE_SQL}`, [app.id, u.id]);
    if (inRegion) return true;
  }
  const linked = await db.one(
    `SELECT 1 FROM assignments WHERE application_id = $1 AND user_id = $2
     UNION SELECT 1 FROM workflow_events WHERE application_id = $1 AND actor_id = $2
     UNION SELECT 1 FROM evc_visit_members m JOIN evc_visits v ON v.id = m.visit_id WHERE v.application_id = $1 AND m.user_id = $2 AND m.active LIMIT 1`,
    [app.id, u.id],
  );
  return !!linked;
}

/** SQL fragment for queue listings, mirroring officialCanView. $1 = states[], $2 = user id. */
export const OFFICIAL_VISIBLE_SQL = `(a.status = ANY($1) OR EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id AND s.user_id = $2)
  OR EXISTS (SELECT 1 FROM workflow_events w WHERE w.application_id = a.id AND w.actor_id = $2)
  OR EXISTS (SELECT 1 FROM evc_visit_members m JOIN evc_visits v ON v.id = m.visit_id WHERE v.application_id = a.id AND m.user_id = $2 AND m.active))`;
/** "Pending for my role" queue condition ($1 = queue states, $2 = user id). */
export function mineSql(role: Role) {
  if (regionScoped(role)) return `(a.status = ANY($1) AND ${REGION_SCOPE_SQL})`;
  if (role === 'EVC_MEMBER') return `(a.status = ANY($1) AND EXISTS (SELECT 1 FROM evc_visit_members m JOIN evc_visits v ON v.id = m.visit_id WHERE v.application_id = a.id AND m.user_id = $2 AND m.active AND v.status <> 'CANCELLED'))`;
  return 'a.status = ANY($1)';
}
/** Visibility for a role, including the region restriction for Regional Officers. */
export function visibleSql(role: Role) {
  const base = regionScoped(role) ? `((a.status = ANY($1) AND ${REGION_SCOPE_SQL}) OR EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id AND s.user_id = $2)
  OR EXISTS (SELECT 1 FROM workflow_events w WHERE w.application_id = a.id AND w.actor_id = $2))` : OFFICIAL_VISIBLE_SQL;
  return role === 'EVC_MEMBER' ? `(EXISTS (SELECT 1 FROM evc_visit_members m JOIN evc_visits v ON v.id = m.visit_id WHERE v.application_id = a.id AND m.user_id = $2 AND m.active) AND $1::text[] IS NOT NULL)` : base;
}
export function canSeeAll(role: Role) {
  return SEE_ALL.includes(role);
}

/**
 * If an application is assigned to a specific official for a role, only that official (or a supervisor)
 * may act for that role.
 */
export async function assertAssignee(db: Db, u: AuthUser, appId: string, role: Role) {
  if (u.activeRole === 'SUPERVISOR') return;
  const a = await db.one<{ user_id: string; full_name: string }>(
    'SELECT a.user_id, u.full_name FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.application_id = $1 AND a.role = $2 AND a.active',
    [appId, role],
  );
  if (a && a.user_id !== u.id) throw new HttpError(403, 'NOT_ASSIGNED', `This application is assigned to ${a.full_name}.`);
}

export async function recordOfficerAction(db: Db, u: AuthUser, appId: string, action: string, reason: string | null, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO officer_actions(application_id, actor_id, actor_role, action, reason, details) VALUES ($1,$2,$3,$4,$5,$6)', [
    appId,
    u.id,
    u.activeRole,
    action,
    reason,
    JSON.stringify(details),
  ]);
}

export function primaryInstitution(u: AuthUser): string {
  const id = u.institutionIds[0];
  if (!id) throw new HttpError(403, 'NO_INSTITUTION', 'Your account is not linked to an institution.');
  return id;
}

// ------------------------------------------------------------------ rules

export async function loadRules(db: Db, applicationType: string): Promise<RuleDef[]> {
  const rows = await db.query<Record<string, unknown>>('SELECT * FROM regulatory_rules WHERE application_type = $1', [applicationType]);
  return rows.map((r) => ({
    ruleId: r.rule_id as string,
    ruleVersion: r.rule_version as number,
    applicationType: r.application_type as string,
    actionSubtype: (r.action_subtype as string) ?? null,
    ruleType: r.rule_type as RuleDef['ruleType'],
    condition: (typeof r.condition === 'string' ? JSON.parse(r.condition) : r.condition) as Record<string, unknown>,
    expectedResult: r.expected_result as string,
    severity: r.severity as RuleDef['severity'],
    aphReference: (r.aph_reference as string) ?? null,
    sourceEvidence: r.source_evidence as string,
    verificationStatus: r.verification_status as RuleDef['verificationStatus'],
    lifecycleStatus: r.lifecycle_status as RuleDef['lifecycleStatus'],
    targetType: r.target_type as RuleDef['targetType'],
    targetId: (r.target_id as string) ?? null,
    targetLabel: r.target_label as string,
    explanation: r.explanation as string,
    correctiveAction: r.corrective_action as string,
  }));
}

/** Keeps only the latest version of each rule id that is not retired/draft. */
export function latestVersions(rules: RuleDef[]): RuleDef[] {
  const m = new Map<string, RuleDef>();
  for (const r of rules) {
    if (r.lifecycleStatus === 'RETIRED' || r.lifecycleStatus === 'DRAFT') continue;
    const cur = m.get(r.ruleId);
    if (!cur || r.ruleVersion > cur.ruleVersion) m.set(r.ruleId, r);
  }
  return [...m.values()];
}

export async function currentDocuments(db: Db, appId: string) {
  return db.query<{ id: string; requirement_id: string; version: number; sha256: string; metadata: Record<string, unknown>; integrity: Record<string, unknown>; file_name: string; uploaded_at: string; mime_type: string; size_bytes: number; deficiency_id: string | null }>(
    'SELECT id, requirement_id, version, sha256, metadata, integrity, file_name, uploaded_at, mime_type, size_bytes, deficiency_id FROM documents WHERE application_id = $1 AND is_current ORDER BY requirement_id',
    [appId],
  );
}

/** Collects every string literal referenced by a rule condition (field names, requirement ids). */
function referencedKeys(x: unknown, out = new Set<string>()): Set<string> {
  if (typeof x === 'string') out.add(x);
  else if (Array.isArray(x)) x.forEach((v) => referencedKeys(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => referencedKeys(v, out));
  return out;
}

export async function runValidation(
  db: Db,
  app: AppRow,
  opts: { stage: string; actor: string; scope?: { changedFields: string[]; changedDocs: string[] }; documentStage?: 'SUBMISSION' | 'EVC'; includeNotApplicable?: boolean },
): Promise<EngineResult & { runId: string; scope: string }> {
  let rules = latestVersions(await loadRules(db, app.category_code));
  let scopeLabel = 'FULL';
  if (opts.scope) {
    // Re-scrutiny: changed fields/documents plus every rule that depends on them.
    const changed = new Set([...opts.scope.changedFields, ...opts.scope.changedDocs]);
    rules = rules.filter((r) => (r.targetId && changed.has(r.targetId)) || [...referencedKeys(r.condition)].some((k) => changed.has(k)) || r.ruleType === 'HUMAN_REVIEW_NOTICE');
    scopeLabel = `CHANGED:${[...changed].sort().join(',') || 'none'}`;
  }
  const docs = await currentDocuments(db, app.id);
  const result = runEngine(
    {
      applicationType: app.category_code,
      subtype: app.subtype,
      fields: { ...app.field_values, academicYear: app.academic_year ?? app.field_values.academicYear },
      documents: docs.map((d) => ({ requirementId: d.requirement_id, documentId: d.id, version: d.version, sha256: d.sha256, metadata: d.metadata, integrity: d.integrity as never })),
      evaluationDate: todayIST(),
      documentStage: opts.documentStage ?? 'SUBMISSION',
      includeNotApplicable: opts.includeNotApplicable,
    },
    rules,
  );
  const sv = (await db.one<{ submission_version: number }>('SELECT submission_version FROM applications WHERE id = $1', [app.id]))?.submission_version ?? 0;
  const run = await db.one<{ id: string }>(
    `INSERT INTO validation_runs(application_id, ruleset_version, input_hash, evaluation_date, stage, rules_evaluated, summary, scope, run_by, submission_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [app.id, RULESET_VERSION, result.inputHash, result.evaluationDate, opts.stage, result.rulesEvaluated, JSON.stringify(result.summary), scopeLabel, opts.actor, sv],
  );
  if (result.findings.length > 0) {
    // Batched as one multi-row insert (unnest) instead of one round trip per finding — a run can
    // produce dozens to hundreds of findings, and each round trip costs real latency against a
    // remote (e.g. Supabase) database.
    const f = result.findings;
    await db.query(
      `INSERT INTO validation_findings(run_id, rule_id, rule_version, rule_type, outcome, blocking, target_type, target_id, target_label, aph_reference, explanation, corrective_action, stage, actor, status, human_verification)
       SELECT $1, * FROM unnest(
         $2::text[], $3::int[], $4::text[], $5::text[], $6::bool[], $7::text[], $8::text[], $9::text[],
         $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::bool[]
       )`,
      [
        run!.id,
        f.map((x) => x.ruleId), f.map((x) => x.ruleVersion), f.map((x) => x.ruleType), f.map((x) => x.outcome), f.map((x) => x.blocking),
        f.map((x) => x.targetType), f.map((x) => x.targetId), f.map((x) => x.targetLabel), f.map((x) => x.aphReference),
        f.map((x) => x.explanation), f.map((x) => x.correctiveAction), f.map(() => opts.stage), f.map(() => opts.actor), f.map((x) => x.status), f.map((x) => x.humanVerification),
      ],
    );
  }
  return { ...result, runId: run!.id, scope: scopeLabel };
}

// ------------------------------------------------------------------ checklist (display)

export function checklistFor(cat: CategoryDef, app: Pick<AppRow, 'subtype' | 'field_values' | 'academic_year'>) {
  const ctx = { fields: { ...app.field_values, academicYear: app.academic_year }, subtype: app.subtype, evaluationDate: todayIST() };
  return cat.documents.map((d) => {
    let state: 'REQUIRED' | 'NOT_REQUIRED' | 'OPTIONAL' | 'ONE_OF';
    if (d.level === 'OPTIONAL') state = 'OPTIONAL';
    else if (d.oneOfGroup) state = 'ONE_OF';
    else if (d.level === 'MANDATORY') state = 'REQUIRED';
    else state = d.trigger && !evaluate(d.trigger, ctx) ? 'NOT_REQUIRED' : 'REQUIRED';
    return { ...d, state };
  });
}

// ------------------------------------------------------------------ workflow

export async function transition(
  db: Db,
  req: Request | null,
  actor: { id: string | null; role: Role | 'SYSTEM' },
  app: AppRow,
  action: Action,
  params: Record<string, unknown> = {},
  note?: string,
): Promise<AppState> {
  const cat = categoryOrThrow(app.category_code);
  const to = actor.role === 'SYSTEM' ? (params.to as AppState) : resolveTransition(app.status, action, actor.role, cat.route, params);
  // Optimistic concurrency: the status must still be what we read.
  const updated = await db.query('UPDATE applications SET status = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = $3 RETURNING id', [app.id, to, app.status]);
  if (updated.length === 0) throw new HttpError(409, 'CONFLICT', 'The application was changed by someone else. Reload and try again.');
  const ev = await db.one<{ id: string }>(
    'INSERT INTO workflow_events(application_id, from_status, to_status, action, actor_id, actor_role, note, aph_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [app.id, app.status, to, action, actor.id, actor.role, note ?? null, TRANSITIONS[action]?.aphReference ?? null],
  );
  await audit(db, req, `WORKFLOW_${action}`, 'application', app.id, { from: app.status, to }, app.institution_id);
  const from = app.status;
  app.status = to;
  if (from !== to) {
    const received = to === 'SUBMITTED';
    await notifyInstitutionMembers(
      db,
      app,
      received ? 'APPLICATION_RECEIVED' : `STATUS_${to}`,
      received ? `Application received: ${app.reference_no}` : `${app.reference_no ?? 'Application'}: ${STATE_LABELS[to]}`,
      received
        ? 'Your application has been received and is pending scrutiny. Automated checks have been run and the results are with the Scrutiny Committee.'
        : `Status changed from ${STATE_LABELS[from]} to ${STATE_LABELS[to]}.${note ? ` ${note}` : ''}`,
      `wf:${ev!.id}`,
    );
  }
  return to;
}

// ------------------------------------------------------------------ notifications

export async function notifyInstitution(db: Db, app: Pick<AppRow, 'id' | 'institution_id'>, eventType: string, title: string, message: string, dedupeKey?: string) {
  await notifyInstitutionMembers(db, app, eventType, title, message, dedupeKey);
}

export async function notifyRole(db: Db, role: Role, appId: string | null, eventType: string, title: string, message: string, dedupeKey?: string) {
  await notifyRoleOrAssignee(db, role, appId, eventType, title, message, dedupeKey);
}

// ------------------------------------------------------------------ compliance obligations

interface ObligationSpec {
  key: string;
  title: string;
  description: string;
  aphReference: string;
  triggerEvent: string;
  dueDate: string | null;
  kind?: 'COMPLIANCE' | 'UNDERTAKING' | 'LEASE_RENEWAL';
}

/**
 * Status shown to users. Stored statuses: OPEN, SUBMITTED, UNDER_REVIEW, ACCEPTED_BY_AUTHORISED_REVIEWER, DEFICIENT,
 * HUMAN_REVIEW_REQUIRED. Open items are further shown as NOT_YET_DUE / DUE_SOON / OVERDUE only when an APH-derived
 * due date exists; SUBMITTED is never shown as accepted.
 */
export function complianceDisplayStatus(status: string, dueDate: string | null, today: string, dueSoonDays: number) {
  if (status !== 'OPEN' && status !== 'DEFICIENT') return status;
  if (!dueDate) return status === 'DEFICIENT' ? 'DEFICIENT' : 'NO_FIXED_DATE';
  const left = Math.round((new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000);
  if (left < 0) return 'OVERDUE';
  if (status === 'DEFICIENT') return 'DEFICIENT';
  return left <= dueSoonDays ? 'DUE_SOON' : 'NOT_YET_DUE';
}

export async function createObligations(db: Db, app: AppRow, specs: ObligationSpec[], decisionId: string | null = null) {
  for (const s of specs) {
    await db.query(
      `INSERT INTO compliance_obligations(institution_id, application_id, decision_id, obligation_key, title, description, aph_reference, trigger_event, due_date, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (application_id, obligation_key) DO NOTHING`,
      [app.institution_id, app.id, decisionId, s.key, s.title, s.description, s.aphReference, s.triggerEvent, s.dueDate, s.kind ?? 'COMPLIANCE'],
    );
  }
  if (specs.length) await notifyInstitution(db, app, 'COMPLIANCE_CREATED', 'New compliance obligation', `${specs.length} compliance obligation(s) were recorded for ${app.reference_no}.`);
}

/** Obligations that arise when an application is submitted (application-validity clocks). */
export function submissionObligations(app: AppRow): ObligationSpec[] {
  const out: ObligationSpec[] = [];
  const submittedDate = todayIST(new Date(app.submitted_at ?? Date.now()));
  const years = (v: unknown) => (typeof v === 'number' ? v : Number(v));
  const isCourseClosure = app.category_code === 'PROGRAMME_COURSE_CLOSURE' || (app.category_code === 'COURSE_CHANGES' && app.subtype === 'CLOSURE');
  if (isCourseClosure && years(app.field_values.courseDurationYears) > 0) {
    const y = years(app.field_values.courseDurationYears);
    out.push({
      key: 'CLOSURE_APPLICATION_VALIDITY',
      title: 'Submit mandatory documents within the course duration',
      description: `The application for closure of programme(s)/course(s) is valid for the duration of the respective course (${y} year(s)). The required mandatory documents must be submitted within that period, otherwise AICTE shall initiate action to close. This is application validity, not document expiry.`,
      aphReference: 'Ch. II §2.18(f)',
      triggerEvent: 'Application submitted',
      dueDate: addDays(submittedDate, Math.round(365.25 * y)),
    });
  }
  if (app.field_values.occupancyCertificateType === 'PARTIAL' && typeof app.field_values.partialOcFirstAcademicYear === 'string') {
    const first = Number(app.field_values.partialOcFirstAcademicYear.slice(0, 4));
    const last = `${first + 1}-${String(first + 2).slice(2)}`;
    out.push({
      key: 'FULL_OC_AFTER_PARTIAL',
      title: 'Full Occupancy / Completion Certificate after the partial-OC period',
      description: `A partial / provisional Occupancy Certificate is considered only for 2 consecutive academic years. The institution relied on it from ${app.field_values.partialOcFirstAcademicYear}, so it can be considered up to academic year ${last}; the full certificate is needed for later years. The APH states no calendar date, so none is set.`,
      aphReference: 'Annexure 3 §3.1(c)',
      triggerEvent: 'Application submitted with a partial / provisional OC',
      dueDate: null,
    });
  }
  if (app.category_code === 'CLOSURE_OF_INSTITUTION' && years(app.field_values.maxProgrammeDurationYears) > 0) {
    const y = years(app.field_values.maxProgrammeDurationYears);
    out.push({
      key: 'CLOSURE_APPLICATION_VALIDITY',
      title: 'Submit mandatory closure documents within the programme duration',
      description: `The application for Closure of the Institution is valid for the duration of the respective programme (${y} year(s)); mandatory documents must be submitted within it (otherwise AICTE may close the institution and a 10% Security Deposit penalty applies on release).`,
      aphReference: 'Ch. II §2.21(h)',
      triggerEvent: 'Application submitted',
      dueDate: addDays(submittedDate, Math.round(365.25 * y)),
    });
  }
  return out;
}

/**
 * Lease renewal obligation (Ch. VI §6.17(a); Ch. II §2.1(e)): the live lease must remain at least
 * equal to the maximum programme duration. Due date is the date from which that would no longer
 * hold — the same point the submission-time LEASE_LIVE_MAX_DURATION check guards against — so the
 * institution is tracked and reminded long before the lease actually becomes insufficient, rather
 * than only being checked once at submission. Only created when the application actually recorded
 * a lease (landTenure GOVT_LEASE/PRIVATE_LEASE) with both dates present.
 */
function leaseRenewalObligation(app: AppRow): ObligationSpec[] {
  const tenure = app.field_values.landTenure;
  if (tenure !== 'GOVT_LEASE' && tenure !== 'PRIVATE_LEASE') return [];
  const leaseEndDate = app.field_values.leaseEndDate;
  const years = Number(app.field_values.maxProgrammeDurationYears);
  if (typeof leaseEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(leaseEndDate) || !Number.isFinite(years) || years <= 0) return [];
  return [
    {
      key: 'LEASE_RENEWAL',
      kind: 'LEASE_RENEWAL',
      title: 'Renew the registered lease before it becomes insufficient',
      description: `The registered lease ends ${leaseEndDate}. The live lease must remain at least equal to the maximum programme duration (${years} year(s)), so renewal is needed before ${subtractYears(leaseEndDate, years)}. Upload the registered lease extension (minimum a further 30 years) as evidence.`,
      aphReference: 'Ch. VI §6.17(a); Ch. II §2.1(e)',
      triggerEvent: 'Approval issued with a leased site',
      dueDate: subtractYears(leaseEndDate, years),
    },
  ];
}

/** Obligations that arise from an authorised decision. Only source-supported deadlines are given dates. */
export function decisionObligations(app: AppRow, d: { decision_type: string; decision_date: string; uploaded_at: string; corrective_action: string | null }): ObligationSpec[] {
  const out: ObligationSpec[] = [];
  const approved = d.decision_type === 'LOA' || d.decision_type === 'EOA';
  const uploadDay = todayIST(new Date(d.uploaded_at));
  const govt = ['GOVERNMENT', 'GOVERNMENT_AIDED'].includes(String(app.field_values.institutionCategory ?? app.field_values.legalEntityType ?? ''));
  if (app.category_code === 'NEW_TECHNICAL_INSTITUTION' && d.decision_type === 'LOA') {
    const y = Number(d.decision_date.slice(0, 4)) + 2;
    out.push(
      {
        key: 'LOA_VALIDITY',
        title: 'LoA validity — two academic years from issue',
        description: 'The LoA is valid for two academic years from the date of issue for obtaining affiliation and fulfilling State/UT requirements; on expiry it stands cancelled. Due date computed as two calendar years from issue (academic-year boundary to be verified).',
        aphReference: 'Ch. I §1.10(b)(ii)',
        triggerEvent: 'LoA issued',
        dueDate: `${y}${d.decision_date.slice(4)}`,
      },
      {
        key: 'APPLY_EOA_NEXT_YEAR',
        title: 'Apply for Extension of Approval from the next academic year',
        description: 'Institutions issued an LoA shall apply for EoA from the next academic year onwards, irrespective of admissions.',
        aphReference: 'Ch. I §1.10(b)(ii)',
        triggerEvent: 'LoA issued',
        dueDate: null,
      },
      {
        key: 'FACULTY_APPOINTMENTS',
        title: 'Upload Principal/Director, faculty and staff appointments',
        description: 'Appoint Principal/Director and faculty as per norms and upload appointment details in the prescribed format. Courses may not start until all faculty and staff are appointed.',
        aphReference: 'Ch. I §1.6; Annexure 1 §1.3',
        triggerEvent: 'LoA issued',
        dueDate: null,
      },
    );
    if (!govt)
      out.push({
        key: 'SECURITY_DEPOSIT',
        title: 'Create the Security Deposit with Affidavit 3',
        description: 'Applicants other than Government / Government-aided institutions recommended for LoA are informed to create the Security Deposit (Table 1.4) with Affidavit 3. No day-count is stated in Chapter I.',
        aphReference: 'Ch. I §1.11(f), §1.12',
        triggerEvent: 'LoA issued',
        dueDate: null,
      });
  }
  const depositCats = ['NEW_PROGRAMME_LEVEL', 'LEVEL_CONVERSION', 'WOMEN_COED_CONVERSION'];
  if (approved && depositCats.includes(app.category_code) && !(app.category_code === 'NEW_PROGRAMME_LEVEL' && govt)) {
    out.push({
      key: 'SECURITY_DEPOSIT',
      title: 'Submit Security Deposit payment proof with Affidavit 3',
      description: 'Submit payment proof of the Security Deposit with Affidavit 3 within 15 days from the date of intimation; penalties of 10% / 20% apply up to 31 May / 31 July, beyond which approval is withdrawn. The portal treats the decision upload as the intimation date (interpretation — verify).',
      aphReference: 'Ch. II §2.25(d)-(f)',
      triggerEvent: 'Decision uploaded (intimation)',
      dueDate: addDays(uploadDay, 15),
    });
  }
  if (d.decision_type === 'EOA') {
    const year = Number(uploadDay.slice(0, 4));
    const nov30 = `${year}-11-30`;
    out.push({
      key: 'STUDENT_ENROLMENT',
      title: 'Upload student enrolment details',
      description: 'Student enrolment details shall be uploaded on the Web-Portal before 30 November of the calendar year.',
      aphReference: 'Ch. II §2.25(n)',
      triggerEvent: 'EoA issued',
      dueDate: uploadDay <= nov30 ? nov30 : `${year + 1}-11-30`,
    });
  }
  if (d.decision_type === 'EOA' || (app.category_code === 'NEW_TECHNICAL_INSTITUTION' && d.decision_type === 'LOA')) {
    out.push(
      {
        key: 'UNDERTAKING_INTERNSHIP_POLICY',
        kind: 'UNDERTAKING',
        title: 'Affidavit: implementation of the AICTE Internship Policy',
        description: 'An Affidavit is to be uploaded on the Portal for compliance of implementation of the Internship Policy of AICTE. The Ch. VI §6.53 Note states such documents are uploaded before downloading the EoA; the Council may verify implementation at any time. No calendar date is stated.',
        aphReference: 'Ch. VI §6.53(m) and the Note following §6.53',
        triggerEvent: `${d.decision_type === 'EOA' ? 'EoA' : 'LoA'} issued`,
        dueDate: null,
      },
      {
        key: 'UNDERTAKING_EXAM_REFORMS',
        kind: 'UNDERTAKING',
        title: 'Undertaking: internal assessment and laboratory work per AICTE Exam Reforms',
        description: 'An Undertaking is to be uploaded on the Portal that internal assessment and laboratory work shall be carried out following AICTE Exam Reforms and that all existing faculty shall be trained for the same (listed under Desirable Requirements). No calendar date is stated.',
        aphReference: 'Ch. VI §6.54, Note-1',
        triggerEvent: `${d.decision_type === 'EOA' ? 'EoA' : 'LoA'} issued`,
        dueDate: null,
      },
    );
  }
  if (d.corrective_action && d.corrective_action.trim()) {
    out.push({
      key: 'DEFICIENCY_COMPLIANCE_NEXT_EOA',
      title: 'Comply with noted deficiencies before next year’s EoA',
      description: `Deficiencies noted must be fulfilled and submitted as compliance before the issue of EoA for the next academic year. Corrective action recorded: ${d.corrective_action}`,
      aphReference: 'Ch. II §2.25(c)',
      triggerEvent: 'Decision issued with corrective action',
      dueDate: null,
    });
  }
  if (approved && app.category_code === 'COLLABORATION_TWINNING') {
    out.push({
      key: 'COLLAB_ANNUAL_REPORT',
      title: 'Submit the Collaboration & Twinning Annual Report',
      description: 'Upload an Annual Report with students admitted, programmes conducted, fees collected, amounts transferred to the parent country, investments and awards. No due date is stated in the APH.',
      aphReference: 'Ch. III §3.5(b)',
      triggerEvent: 'Approval issued',
      dueDate: null,
    });
  }
  if (approved) out.push(...leaseRenewalObligation(app));
  if (app.category_code === 'CLOSURE_OF_INSTITUTION' && app.subtype === 'PROGRESSIVE' && d.decision_type === 'CLOSURE_ORDER') {
    out.push({
      key: 'AFFIDAVIT4_FINAL_CLOSURE',
      title: 'Submit Affidavit 4 after completion of programmes for the final closure order',
      description: 'For progressive closure, the final closure order is issued after completion of the programmes and submission of Affidavit 4.',
      aphReference: 'Ch. II §2.21(c)',
      triggerEvent: 'Progressive closure approved',
      dueDate: null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ appeals

export interface AppealEligibility {
  eligible: boolean;
  reason: string;
  decisionId: string | null;
  deadlineAt: string | null;
  deadlineBasis: string | null;
  aphReference: string;
}

export async function appealEligibility(db: Db, app: AppRow, now = new Date()): Promise<AppealEligibility> {
  const chapterI = app.category_code === 'NEW_TECHNICAL_INSTITUTION';
  const aphReference = chapterI ? 'Ch. I §1.11(a)' : 'Ch. II §2.24(a)';
  const base = { decisionId: null, deadlineAt: null, deadlineBasis: null, aphReference };
  const existing = await db.one('SELECT 1 FROM appeals WHERE application_id = $1', [app.id]);
  if (existing) return { ...base, eligible: false, reason: 'An appeal has already been filed. Only one appeal is allowed.' };
  const d = await db.one<{ id: string; decision_type: string; decision_body: string; decision_date: string; uploaded_at: string; is_appeal_outcome: boolean }>(
    'SELECT id, decision_type, decision_body, decision_date::text AS decision_date, uploaded_at, is_appeal_outcome FROM decisions WHERE application_id = $1 ORDER BY uploaded_at DESC LIMIT 1',
    [app.id],
  );
  if (!d) return { ...base, eligible: false, reason: 'No decision has been issued yet.' };
  if (d.is_appeal_outcome || d.decision_body !== 'EXECUTIVE_COMMITTEE') return { ...base, eligible: false, reason: 'The Council’s decision on appeal is final.' };
  if (app.status !== 'DECISION_ISSUED') return { ...base, eligible: false, reason: 'Appeals can be filed only while the decision stands issued.' };
  let start: string;
  let basis: string;
  if (chapterI) {
    if (d.decision_type !== 'LOD')
      return {
        ...base,
        eligible: false,
        reason: 'For new institutions, an appeal is allowed within 7 days from the issue of a Letter of Deficiency (LoD). Appeals against other decisions are not configured pending verification.',
      };
    start = d.decision_date;
    basis = `7 days from the date of issue of the LoD (${d.decision_date})`;
  } else {
    start = todayIST(new Date(d.uploaded_at));
    basis = `7 days from the date the Executive Committee decision was uploaded (${start})`;
  }
  const deadlineAt = endOfDayIST(addDays(start, 7));
  const open = now.getTime() <= new Date(deadlineAt).getTime();
  return {
    eligible: open,
    reason: open ? 'You may file one appeal to the Council (considered by the Standing Appellate Committee).' : 'The 7-day appeal period has ended.',
    decisionId: d.id,
    deadlineAt,
    deadlineBasis: `${basis}; deadline taken as end of that day IST (system interpretation).`,
    aphReference,
  };
}
