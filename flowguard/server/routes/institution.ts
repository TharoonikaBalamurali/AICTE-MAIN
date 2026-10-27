/**
 * Institutional applicant API. Every handler re-checks institution membership
 * (loadAppFor / primaryInstitution) — the client is never trusted for scoping.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { CATEGORIES } from '../catalogue/categories.ts';
import type { Db } from '../db/index.ts';
import { ah, audit, HttpError, requireRole, user } from '../http.ts';
import { RULESET_VERSION } from '../rules/ruleset.ts';
import {
  appealEligibility,
  categoryOrThrow,
  checklistFor,
  complianceDisplayStatus,
  createObligations,
  currentDocuments,
  loadAppFor,
  notifyInstitution,
  notifyRole,
  primaryInstitution,
  runValidation,
  submissionObligations,
  todayIST,
  transition,
  type AppRow,
} from '../services.ts';
import { MAX_UPLOAD_BYTES, inspectFile, sniffType, type Storage } from '../storage.ts';
import { createReScrutinyReport, createScrutinyReport } from '../reports.ts';
import { noticePdf, reportPdf } from '../pdf.ts';
import { pendingActor, routeStages, STATE_LABELS, stageOf, type AppState } from '../workflow/stateMachine.ts';
import { getPolicy } from '../policy.ts';
import { documentValidity } from '../validity.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 } });

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const metadataSchema = z
  .object({
    issueDate: dateStr.optional(),
    expiryDate: dateStr.optional(),
    issuer: z.string().max(200).optional(),
    signatory: z.string().max(200).optional(),
    referenceNumber: z.string().max(100).optional(),
    financialYear: z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-YY').optional(),
    dscDeclared: z.boolean().optional(),
  })
  .strict()
  .refine((m) => !m.issueDate || !m.expiryDate || m.expiryDate >= m.issueDate, { message: 'Expiry date cannot be before the issue date', path: ['expiryDate'] });

const courseRow = z
  .object({
    programme: z.string().max(120).optional().default(''),
    level: z.string().max(60).optional().default(''),
    course: z.string().max(200),
    currentIntake: z.union([z.number(), z.string().max(10)]).optional(),
    proposedIntake: z.union([z.number(), z.string().max(10)]).optional(),
  })
  .strict();
const fieldValue = z.union([z.string().max(5000), z.number(), z.boolean(), z.null(), z.array(courseRow).max(100), z.array(z.string().max(200)).max(50)]);

export const CORRECTION_STATES: AppState[] = ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'];

function cleanFields(code: string, input: Record<string, unknown>) {
  const cat = categoryOrThrow(code);
  const allowed = new Set(cat.fields.map((f) => f.id));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.has(k)) throw new HttpError(400, 'UNKNOWN_FIELD', `Field "${k}" does not belong to this application type.`);
    out[k] = fieldValue.parse(v);
  }
  return out;
}

export async function storeUpload(storage: Storage, file: Express.Multer.File | undefined) {
  if (!file) throw new HttpError(400, 'FILE_REQUIRED', 'Choose a file to upload.');
  const t = sniffType(file.buffer);
  if (!t) throw new HttpError(415, 'UNSUPPORTED_FILE', 'Only PDF, JPG or PNG files are accepted (checked from the file content).');
  const stored = await storage.put(file.buffer, t.ext);
  const safeName = file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 150) || `document.${t.ext}`;
  return { ...stored, mime: t.mime, name: safeName, integrity: inspectFile(file.buffer, t.ext) };
}

/** Builds the immutable correction-submission items for the current notice. */
async function buildCorrectionItems(db: Db, appId: string, since: string) {
  const defs = await db.query<Record<string, any>>("SELECT * FROM deficiencies WHERE application_id = $1 AND status = 'RESPONDED' ORDER BY raised_at", [appId]);
  const items = [];
  const changedFields = new Set<string>();
  const changedDocs = new Set<string>();
  for (const d of defs) {
    const ev = await db.query<Record<string, any>>('SELECT * FROM deficiency_events WHERE deficiency_id = $1 AND created_at >= $2 ORDER BY id', [d.id, since]);
    const response = [...ev].reverse().find((e) => e.event === 'RESPONSE')?.note ?? null;
    const fieldEvents = ev.filter((e) => e.event === 'FIELDS_CHANGED' && e.field_changes);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const fe of fieldEvents) {
      for (const [k, v] of Object.entries(fe.field_changes.before ?? {})) if (!(k in before)) before[k] = v;
      Object.assign(after, fe.field_changes.after ?? {});
    }
    Object.keys(after).forEach((k) => changedFields.add(k));
    const newDocs = await db.query<Record<string, any>>(
      'SELECT id, requirement_id, version, file_name, sha256, uploaded_at, metadata, integrity FROM documents WHERE deficiency_id = $1 AND uploaded_at >= $2 ORDER BY version',
      [d.id, since],
    );
    const documents = [];
    for (const nd of newDocs) {
      changedDocs.add(nd.requirement_id);
      const prev = await db.one<Record<string, any>>(
        'SELECT id, version, file_name, sha256, uploaded_at, metadata FROM documents WHERE application_id = $1 AND requirement_id = $2 AND version < $3 ORDER BY version DESC LIMIT 1',
        [appId, nd.requirement_id, nd.version],
      );
      documents.push({
        requirementId: nd.requirement_id,
        before: prev ? { documentId: prev.id, version: prev.version, fileName: prev.file_name, sha256: prev.sha256, uploadedAt: prev.uploaded_at, metadata: prev.metadata } : null,
        after: { documentId: nd.id, version: nd.version, fileName: nd.file_name, sha256: nd.sha256, uploadedAt: nd.uploaded_at, metadata: nd.metadata, integrity: nd.integrity },
      });
    }
    items.push({ deficiencyId: d.id, referenceNo: d.reference_no, response, documents, fieldChanges: { before, after } });
  }
  return { items, changedFields: [...changedFields], changedDocs: [...changedDocs] };
}

export function sendFile(res: import('express').Response, buf: Buffer, name: string, mime: string, inline = false) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
}

export async function applicationDetail(db: Db, app: AppRow, opts: { official: boolean }) {
  const cat = categoryOrThrow(app.category_code);
  const docs = await db.query<Record<string, unknown>>(
    'SELECT d.id, d.requirement_id, d.version, d.file_name, d.mime_type, d.size_bytes, d.sha256, d.metadata, d.integrity, d.is_current, d.uploaded_at, d.superseded_at, d.deficiency_id, u.full_name AS uploaded_by_name FROM documents d JOIN users u ON u.id = d.uploaded_by WHERE d.application_id = $1 ORDER BY d.requirement_id, d.version DESC',
    [app.id],
  );
  const events = await db.query(
    'SELECT e.id, e.from_status, e.to_status, e.action, e.actor_role, e.note, e.aph_reference, e.created_at, u.full_name AS actor_name FROM workflow_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.application_id = $1 ORDER BY e.id',
    [app.id],
  );
  const runs = await db.query<{ id: string }>('SELECT * FROM validation_runs WHERE application_id = $1 ORDER BY run_at DESC LIMIT 10', [app.id]);
  const latest = runs[0] ? await db.query('SELECT * FROM validation_findings WHERE run_id = $1 ORDER BY blocking DESC, outcome, id', [runs[0].id]) : [];
  const deficiencies = await db.query(
    `SELECT d.*, u.full_name AS raised_by_name, n.notice_no, n.version AS notice_version FROM deficiencies d JOIN users u ON u.id = d.raised_by
     LEFT JOIN deficiency_notices n ON n.id = d.notice_id
     WHERE d.application_id = $1 ${opts.official ? '' : "AND d.status NOT IN ('DRAFT','WITHDRAWN')"} ORDER BY d.raised_at`,
    [app.id],
  );
  const notices = await db.query(
    'SELECT n.id, n.notice_no, n.version, n.kind, n.submission_version, n.issued_at, n.sha256, n.content, u.full_name AS issued_by_name FROM deficiency_notices n JOIN users u ON u.id = n.issued_by WHERE n.application_id = $1 ORDER BY n.version DESC',
    [app.id],
  );
  const corrections = await db.query('SELECT id, version, submission_version, items, changed_fields, changed_docs, submitted_at FROM correction_submissions WHERE application_id = $1 ORDER BY version DESC', [app.id]);
  const defEvents = await db.query(
    'SELECT e.*, u.full_name AS actor_name FROM deficiency_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.deficiency_id IN (SELECT id FROM deficiencies WHERE application_id = $1) ORDER BY e.id',
    [app.id],
  );
  const visits = await db.query('SELECT * FROM evc_visits WHERE application_id = $1 ORDER BY scheduled_at DESC', [app.id]);
  const reports = await db.query<Record<string, unknown>>(
    'SELECT r.*, u.full_name AS submitted_by_name FROM evc_reports r JOIN users u ON u.id = r.submitted_by WHERE r.application_id = $1 ORDER BY r.submitted_at DESC',
    [app.id],
  );
  const committee = await db.query('SELECT c.*, u.full_name AS recorded_by_name FROM committee_reviews c JOIN users u ON u.id = c.recorded_by WHERE c.application_id = $1 ORDER BY c.recorded_at', [app.id]);
  const decisions = await db.query(
    'SELECT id, decision_type, decision_body, reference_no, issuing_authority, decision_date::text AS decision_date, uploaded_at, reasons, conditions, corrective_action, next_steps, document_name, is_appeal_outcome, aph_reference FROM decisions WHERE application_id = $1 ORDER BY uploaded_at',
    [app.id],
  );
  const appealRow = await db.one<Record<string, unknown>>('SELECT * FROM appeals WHERE application_id = $1', [app.id]);
  // Committee deliberations stay internal: institutions see that a recommendation was recorded, not its content.
  const appeal = appealRow && !opts.official ? (({ sac_outcome: _o, sac_notes: _n, ...rest }) => rest)(appealRow) : appealRow;
  const proceedings = await db.query(
    `SELECT p.id, p.committee, p.kind, p.body, p.hearing_at, p.hearing_mode, p.hearing_venue, p.disclosed, p.created_at, p.created_role, u.full_name AS created_by_name
     FROM committee_proceedings p JOIN users u ON u.id = p.created_by WHERE p.application_id = $1 ${opts.official ? '' : 'AND p.disclosed'} ORDER BY p.created_at`,
    [app.id],
  );
  const submissions = await db.query(
    'SELECT s.id, s.committee, s.responds_to, s.note, s.file_name, s.size_bytes, s.submitted_at, u.full_name AS submitted_by_name FROM committee_submissions s JOIN users u ON u.id = s.submitted_by WHERE s.application_id = $1 ORDER BY s.submitted_at',
    [app.id],
  );
  const obligations = await db.query('SELECT * FROM compliance_obligations WHERE application_id = $1 ORDER BY due_date NULLS LAST', [app.id]);
  return {
    application: {
      ...app,
      statusLabel: STATE_LABELS[app.status],
      stage: stageOf(app.status),
      pendingAction: pendingActor(app.status),
    },
    category: {
      code: cat.code,
      title: cat.title,
      subtypes: cat.subtypes ?? [],
      route: cat.route,
      stages: routeStages(cat.route),
      submissionEnabled: cat.submissionEnabled,
      verificationStatus: cat.verificationStatus,
      verificationNotes: cat.verificationNotes,
      reviewGuidance: cat.reviewGuidance,
    },
    checklist: checklistFor(cat, app).map((d) => ({ id: d.id, name: d.name, state: d.state, stage: d.stage, aphReference: d.aphReference })),
    documents: docs,
    timeline: events,
    validation: runs[0] ? { run: runs[0], findings: latest, history: runs } : null,
    deficiencies: deficiencies.map((d) => ({ ...d, events: defEvents.filter((e) => e.deficiency_id === d.id) })),
    notices,
    corrections,
    nextAction: nextActionFor(app.status),
    evcVisits: visits,
    // Disclosure policy (SYSTEM_POLICY): institutions see report text per Ch. I §1.9(h), not internal evidence references.
    evcReports: opts.official ? reports : reports.map(({ evidence_refs: _e, submitted_by: _s, submitted_by_name: _n, ...rest }) => rest),
    committeeReviews: opts.official ? committee : committee.map((c: any) => ({ id: c.id, committee: c.committee, recorded_at: c.recorded_at })),
    committeeProceedings: proceedings,
    committeeSubmissions: submissions,
    decisions,
    appeal,
    appealEligibility: await appealEligibility(db, app),
    obligations,
  };
}

export function nextActionFor(status: AppState): string {
  switch (status) {
    case 'DRAFT':
      return 'Complete and submit the application.';
    case 'DEFICIENCY_RAISED':
    case 'CORRECTION_IN_PROGRESS':
      return 'Respond to each deficiency in the latest notice, then submit corrections for re-scrutiny.';
    case 'READY_FOR_RE_SCRUTINY':
    case 'UNDER_RE_SCRUTINY':
      return 'No action — the Re-Scrutiny Committee is reviewing your corrections.';
    case 'AWAITING_EVC_SCHEDULING':
      return 'Prepare the EVC-stage evidence; the Regional Officer will schedule the visit.';
    case 'EVC_SCHEDULED':
      return 'Prepare for the scheduled EVC visit.';
    case 'AWAITING_COMMITTEE_REVIEW':
      return 'Submit your compliance for the shortcomings to the Standing Hearing Committee and follow any hearing notice.';
    case 'APPEAL_SUBMITTED':
    case 'APPEAL_UNDER_REVIEW':
      return 'Follow the Standing Appellate Committee schedule and keep the supporting documents ready.';
    case 'DECISION_ISSUED':
      return 'Review the decision and its eligibility for appeal shown on the Decisions page.';
    default:
      return 'No action required from the institution at this stage.';
  }
}

export function institutionRouter(db: Db, storage: Storage) {
  const r = Router();
  r.use(requireRole('INSTITUTION_APPLICANT'));

  // ---------------------------------------------------------------- profile
  const profileSchema = z.object({
    name: z.string().trim().min(3).max(200),
    address: z.string().trim().min(5).max(600),
    state: z.string().trim().min(2).max(80),
    district: z.string().trim().min(2).max(80),
    pincode: z.string().regex(/^\d{6}$/, 'PIN code must be 6 digits'),
    official_email: z.string().trim().email().max(160),
    applicant_name: z.string().trim().min(3).max(120),
    applicant_designation: z.string().trim().min(2).max(120),
    legal_entity_type: z.enum(['TRUST', 'SOCIETY', 'SECTION_8_COMPANY', 'GOVERNMENT', 'PPP_BOT']).nullable().optional(),
    legal_entity_name: z.string().trim().max(200).nullable().optional(),
    legal_entity_reg_no: z.string().trim().max(80).nullable().optional(),
    signatory_name: z.string().trim().max(120).nullable().optional(),
    signatory_designation: z.string().trim().max(120).nullable().optional(),
  });

  r.get(
    '/institution/profile',
    ah(async (req, res) => {
      const inst = await db.one('SELECT * FROM institutions WHERE id = $1', [primaryInstitution(user(req))]);
      res.json({ institution: inst });
    }),
  );

  r.put(
    '/institution/profile',
    ah(async (req, res) => {
      const id = primaryInstitution(user(req));
      const p = profileSchema.parse(req.body);
      const inst = await db.one(
        `UPDATE institutions SET name=$2, address=$3, state=$4, district=$5, pincode=$6, official_email=$7, applicant_name=$8, applicant_designation=$9,
          legal_entity_type=$10, legal_entity_name=$11, legal_entity_reg_no=$12, signatory_name=$13, signatory_designation=$14, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, p.name, p.address, p.state, p.district, p.pincode, p.official_email, p.applicant_name, p.applicant_designation, p.legal_entity_type ?? null, p.legal_entity_name ?? null, p.legal_entity_reg_no ?? null, p.signatory_name ?? null, p.signatory_designation ?? null],
      );
      await audit(db, req, 'PROFILE_UPDATED', 'institution', id, {}, id);
      res.json({ institution: inst });
    }),
  );

  // ---------------------------------------------------------------- dashboard
  r.get(
    '/dashboard',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      // None of these queries depend on each other, so they run concurrently rather than paying
      // nine serial round trips — each one costs real latency against a remote (e.g. Supabase) database.
      const [byStatus, monthly, upcomingEvc, obligations, notifications, recent, openDef, recentActivity, current] = await Promise.all([
        db.query<{ status: AppState; n: number }>('SELECT status, count(*)::int AS n FROM applications WHERE institution_id = $1 GROUP BY status', [inst]),
        db.query<{ month: string; n: number }>(
          `SELECT to_char(date_trunc('month', submitted_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, count(*)::int AS n
           FROM applications WHERE institution_id = $1 AND submitted_at >= now() - interval '12 months' GROUP BY 1 ORDER BY 1`,
          [inst],
        ),
        db.query(
          `SELECT v.id, v.mode, v.scheduled_start, v.status, a.reference_no, a.id AS application_id FROM evc_visits v JOIN applications a ON a.id = v.application_id
           WHERE a.institution_id = $1 AND v.status IN ('SCHEDULED','RESCHEDULED') AND v.scheduled_start >= now() - interval '1 day' ORDER BY v.scheduled_start LIMIT 5`,
          [inst],
        ),
        db.query(
          `SELECT o.id, o.title, o.due_date::text AS due_date, o.status, o.aph_reference, a.reference_no FROM compliance_obligations o LEFT JOIN applications a ON a.id = o.application_id
           WHERE o.institution_id = $1 AND o.status <> 'ACCEPTED_BY_AUTHORISED_REVIEWER' ORDER BY o.due_date NULLS LAST LIMIT 5`,
          [inst],
        ),
        db.query('SELECT id, title, message, event_type, created_at, read_at, application_id FROM notifications WHERE recipient_user_id = $1 ORDER BY created_at DESC LIMIT 5', [user(req).id]),
        db.query(
          `SELECT id, reference_no, category_code, subtype, status, submitted_at, updated_at FROM applications WHERE institution_id = $1 ORDER BY updated_at DESC LIMIT 6`,
          [inst],
        ),
        db.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM deficiencies d JOIN applications a ON a.id = d.application_id WHERE a.institution_id = $1 AND d.status IN ('OPEN','UNRESOLVED')`,
          [inst],
        ),
        db.query(
          `SELECT e.id, e.action, e.to_status, e.actor_role, e.created_at, a.id AS application_id, a.reference_no
           FROM workflow_events e JOIN applications a ON a.id = e.application_id WHERE a.institution_id = $1 ORDER BY e.id DESC LIMIT 5`,
          [inst],
        ),
        // The application needing attention first: one awaiting the institution's correction, otherwise the latest in processing.
        db.one<Record<string, any>>(
          `SELECT a.id, a.reference_no, a.category_code, a.status, a.submitted_at, a.updated_at, a.submission_version,
                  (SELECT count(*)::int FROM deficiencies d WHERE d.application_id = a.id AND d.status IN ('OPEN','UNRESOLVED','PARTIALLY_RESOLVED')) AS open_items,
                  (SELECT count(*)::int FROM deficiencies d WHERE d.application_id = a.id AND d.status NOT IN ('DRAFT','WITHDRAWN')) AS total_items,
                  (SELECT min(d.deadline)::text FROM deficiencies d WHERE d.application_id = a.id AND d.status = 'OPEN' AND d.deadline IS NOT NULL) AS next_deadline,
                  (SELECT n.id FROM deficiency_notices n WHERE n.application_id = a.id ORDER BY n.version DESC LIMIT 1) AS latest_notice_id
           FROM applications a WHERE a.institution_id = $1 AND a.status NOT IN ('DRAFT','CLOSED')
           ORDER BY (a.status IN ('DEFICIENCY_RAISED','CORRECTION_IN_PROGRESS')) DESC, a.updated_at DESC LIMIT 1`,
          [inst],
        ),
      ]);
      const count = (pred: (s: AppState) => boolean) => byStatus.filter((r) => pred(r.status)).reduce((a, r) => a + r.n, 0);
      const stageDist: Record<string, number> = {};
      for (const r of byStatus) stageDist[stageOf(r.status)] = (stageDist[stageOf(r.status)] ?? 0) + r.n;
      res.json({
        recentActivity,
        currentApplication: current
          ? { ...current, categoryTitle: CATEGORIES.find((c) => c.code === current.category_code)?.title, statusLabel: STATE_LABELS[current.status as AppState], stage: stageOf(current.status as AppState), stages: routeStages(categoryOrThrow(current.category_code).route) }
          : null,
        kpis: {
          total: count(() => true),
          drafts: count((s) => s === 'DRAFT'),
          processing: count((s) => !['DRAFT', 'DECISION_ISSUED', 'CLOSED'].includes(s) && pendingActor(s) === 'OFFICIAL'),
          actionRequired: count((s) => s === 'DEFICIENCY_RAISED' || s === 'CORRECTION_IN_PROGRESS'),
          withDecision: count((s) => s === 'DECISION_ISSUED' || s === 'CLOSED'),
          openDeficiencies: openDef?.n ?? 0,
        },
        stageDistribution: stageDist,
        monthlySubmissions: monthly,
        upcomingEvc,
        obligations,
        notifications,
        recentApplications: recent.map((a) => ({ ...a, categoryTitle: CATEGORIES.find((c) => c.code === a.category_code)?.title, statusLabel: STATE_LABELS[a.status as AppState] })),
      });
    }),
  );

  // ---------------------------------------------------------------- applications
  r.get(
    '/applications',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      const q = z
        .object({
          q: z.string().max(100).optional(),
          category: z.string().max(60).optional(),
          status: z.string().max(40).optional(),
          view: z.enum(['all', 'drafts', 'submitted']).optional(),
          from: dateStr.optional(),
          to: dateStr.optional(),
        })
        .parse(req.query);
      const where = ['a.institution_id = $1'];
      const params: unknown[] = [inst];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.q) add('(a.reference_no ILIKE ? )', `%${q.q}%`);
      if (q.category) add('a.category_code = ?', q.category);
      if (q.status) add('a.status = ?', q.status);
      if (q.view === 'drafts') where.push(`a.status = 'DRAFT'`);
      if (q.view === 'submitted') where.push(`a.status <> 'DRAFT'`);
      if (q.from) add(`(a.submitted_at AT TIME ZONE 'Asia/Kolkata')::date >= ?::date`, q.from);
      if (q.to) add(`(a.submitted_at AT TIME ZONE 'Asia/Kolkata')::date <= ?::date`, q.to);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT a.id, a.reference_no, a.category_code, a.subtype, a.academic_year, a.status, a.submitted_at, a.created_at, a.updated_at,
                i.name AS institution_name, i.aicte_institution_id, su.full_name AS submitted_by_name,
                (SELECT max(created_at) FROM workflow_events e WHERE e.application_id = a.id) AS last_event_at,
                (SELECT min(deadline)::text FROM deficiencies d WHERE d.application_id = a.id AND d.status IN ('OPEN','UNRESOLVED') AND d.deadline IS NOT NULL) AS deficiency_deadline,
                (SELECT deadline_at FROM appeals p WHERE p.application_id = a.id) AS appeal_deadline
         FROM applications a JOIN institutions i ON i.id = a.institution_id LEFT JOIN users su ON su.id = a.submitted_by
         WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC LIMIT 500`,
        params,
      );
      res.json({
        applications: rows.map((a) => {
          const cat = CATEGORIES.find((c) => c.code === a.category_code);
          return {
            ...a,
            categoryTitle: cat?.title,
            subtypeLabel: cat?.subtypes?.find((s) => s.value === a.subtype)?.label ?? null,
            statusLabel: STATE_LABELS[a.status as AppState],
            stage: stageOf(a.status as AppState),
            pendingAction: pendingActor(a.status as AppState),
          };
        }),
      });
    }),
  );

  r.post(
    '/applications',
    ah(async (req, res) => {
      const u = user(req);
      const inst = primaryInstitution(u);
      const body = z.object({ categoryCode: z.string(), subtype: z.string().nullable().optional() }).parse(req.body);
      const cat = categoryOrThrow(body.categoryCode);
      if (body.subtype && !cat.subtypes?.some((s) => s.value === body.subtype)) throw new HttpError(400, 'INVALID_SUBTYPE', 'Invalid subtype for this category.');
      const profile = await db.one<{ signatory_name: string | null; signatory_designation: string | null }>('SELECT signatory_name, signatory_designation FROM institutions WHERE id = $1', [inst]);
      const initial: Record<string, unknown> = {};
      if (profile?.signatory_name) initial.authorisedSignatoryName = profile.signatory_name;
      const app = await db.one<AppRow>(
        'INSERT INTO applications(institution_id, category_code, subtype, field_values, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [inst, cat.code, body.subtype ?? null, JSON.stringify(initial), u.id],
      );
      await db.query('INSERT INTO workflow_events(application_id, from_status, to_status, action, actor_id, actor_role, note) VALUES ($1,NULL,$2,$3,$4,$5,$6)', [
        app!.id,
        'DRAFT',
        'CREATE_DRAFT',
        u.id,
        u.activeRole,
        `Draft created for ${cat.title}`,
      ]);
      await audit(db, req, 'DRAFT_CREATED', 'application', app!.id, { category: cat.code }, inst);
      res.status(201).json({ application: app });
    }),
  );

  r.get(
    '/applications/:id',
    ah(async (req, res) => {
      const app = await loadAppFor(db, user(req), req.params.id, req);
      res.json(await applicationDetail(db, app, { official: false }));
    }),
  );

  r.patch(
    '/applications/:id',
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      if (app.status !== 'DRAFT') throw new HttpError(409, 'NOT_EDITABLE', 'Only drafts can be edited. After final submission, data cannot be edited while processing is ongoing.');
      const body = z
        .object({
          rowVersion: z.number().int(),
          subtype: z.string().nullable().optional(),
          academicYear: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
          fields: z.record(z.unknown()).optional(),
        })
        .parse(req.body);
      const cat = categoryOrThrow(app.category_code);
      if (body.subtype !== undefined && body.subtype !== null && !cat.subtypes?.some((s) => s.value === body.subtype)) throw new HttpError(400, 'INVALID_SUBTYPE', 'Invalid subtype.');
      const fields = body.fields ? { ...app.field_values, ...cleanFields(app.category_code, body.fields) } : app.field_values;
      const academicYear = body.academicYear !== undefined ? body.academicYear : (fields.academicYear as string) ?? app.academic_year;
      const updated = await db.one<AppRow>(
        `UPDATE applications SET field_values = $2, subtype = $3, academic_year = $4, updated_at = now(), row_version = row_version + 1
         WHERE id = $1 AND row_version = $5 AND status = 'DRAFT' RETURNING *`,
        [app.id, JSON.stringify({ ...fields, academicYear }), body.subtype !== undefined ? body.subtype : app.subtype, academicYear ?? null, body.rowVersion],
      );
      if (!updated) throw new HttpError(409, 'CONFLICT', 'This draft was updated elsewhere. Reload to get the latest version.');
      await audit(db, req, 'DRAFT_SAVED', 'application', app.id, { fields: Object.keys(body.fields ?? {}) }, app.institution_id);
      res.json({ application: updated });
    }),
  );

  r.get(
    '/applications/:id/checklist',
    ah(async (req, res) => {
      const app = await loadAppFor(db, user(req), req.params.id, req);
      const cat = categoryOrThrow(app.category_code);
      const docs = await currentDocuments(db, app.id);
      res.json({
        checklist: checklistFor(cat, app).map((d) => ({ ...d, trigger: undefined, uploaded: docs.find((x) => x.requirement_id === d.id) ?? null })),
      });
    }),
  );

  r.post(
    '/applications/:id/documents',
    upload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const cat = categoryOrThrow(app.category_code);
      const body = z.object({ requirementId: z.string().max(80), metadata: z.string().max(4000).optional(), deficiencyId: z.string().uuid().optional() }).parse(req.body);
      const reqDef = cat.documents.find((d) => d.id === body.requirementId);
      if (!reqDef) throw new HttpError(400, 'UNKNOWN_REQUIREMENT', 'This document is not part of the checklist for this application type.');
      const metadata = metadataSchema.parse(body.metadata ? JSON.parse(body.metadata) : {});

      let deficiencyId: string | null = null;
      if (app.status === 'DRAFT') {
        if (reqDef.stage === 'POST_APPROVAL') throw new HttpError(409, 'WRONG_STAGE', 'Post-approval documents are uploaded after the decision, through Compliance.');
      } else if (CORRECTION_STATES.includes(app.status)) {
        if (!body.deficiencyId) throw new HttpError(409, 'DEFICIENCY_REQUIRED', 'After submission, documents can only be replaced in response to a deficiency.');
        const d = await db.one<{ id: string; target_type: string; target_id: string | null; status: string }>('SELECT id, target_type, target_id, status FROM deficiencies WHERE id = $1 AND application_id = $2', [body.deficiencyId, app.id]);
        if (!d || !['OPEN', 'RESPONDED'].includes(d.status)) throw new HttpError(409, 'DEFICIENCY_CLOSED', 'This deficiency is not open for correction.');
        if (d.target_type === 'DOCUMENT' && d.target_id !== body.requirementId) throw new HttpError(409, 'WRONG_DOCUMENT', 'This deficiency concerns a different document.');
        if (d.target_type === 'FIELD') throw new HttpError(409, 'WRONG_TARGET', 'This deficiency concerns a form field, not a document.');
        deficiencyId = d.id;
      } else if (['AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED'].includes(app.status) && reqDef.stage === 'EVC') {
        // EVC-stage evidence (Annexure 1 §1.2) may be added before the visit.
      } else {
        throw new HttpError(409, 'NOT_EDITABLE', `Documents cannot be changed while the application is ${STATE_LABELS[app.status]}.`);
      }

      const stored = await storeUpload(storage, req.file);
      const doc = await db.tx(async (t) => {
        const prev = await t.one<{ v: number | null }>('SELECT max(version) AS v FROM documents WHERE application_id = $1 AND requirement_id = $2', [app.id, body.requirementId]);
        await t.query('UPDATE documents SET is_current = false, superseded_at = now() WHERE application_id = $1 AND requirement_id = $2 AND is_current', [app.id, body.requirementId]);
        const d = await t.one<Record<string, unknown>>(
          `INSERT INTO documents(application_id, institution_id, requirement_id, version, file_name, mime_type, size_bytes, sha256, storage_key, metadata, deficiency_id, uploaded_by, integrity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, requirement_id, version, file_name, mime_type, size_bytes, sha256, metadata, integrity, uploaded_at, deficiency_id`,
          [app.id, app.institution_id, body.requirementId, (prev?.v ?? 0) + 1, stored.name, stored.mime, stored.size, stored.sha256, stored.key, JSON.stringify(metadata), deficiencyId, u.id, JSON.stringify(stored.integrity)],
        );
        if (deficiencyId) {
          await t.query('INSERT INTO deficiency_events(deficiency_id, event, actor_id, note, document_id) VALUES ($1,$2,$3,$4,$5)', [deficiencyId, 'DOCUMENT_UPLOADED', u.id, `Uploaded ${stored.name} (v${d!.version})`, d!.id]);
          if (app.status === 'DEFICIENCY_RAISED') await transition(t, req, { id: u.id, role: 'INSTITUTION_APPLICANT' }, app, 'BEGIN_CORRECTION');
        }
        await t.query('UPDATE applications SET updated_at = now() WHERE id = $1', [app.id]);
        return d;
      });
      await audit(db, req, 'DOCUMENT_UPLOADED', 'document', doc!.id as string, { requirementId: body.requirementId, version: doc!.version, sha256: stored.sha256 }, app.institution_id);
      res.status(201).json({
        document: doc,
        confirmation: `Received ${stored.name} — version ${doc!.version}, SHA-256 ${stored.sha256.slice(0, 16)}…${stored.integrity.readable ? '' : ' Warning: the file appears unreadable or truncated.'}`,
      });
    }),
  );

  r.post(
    '/applications/:id/validate',
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      if (app.status !== 'DRAFT') throw new HttpError(409, 'NOT_DRAFT', 'Pre-checks are available for drafts only.');
      const result = await runValidation(db, app, { stage: 'PRECHECK', actor: `user:${u.id}` });
      res.json(result);
    }),
  );

  r.post(
    '/applications/:id/submit',
    ah(async (req, res) => {
      const u = user(req);
      z.object({ declaration: z.literal(true) }).parse(req.body);
      const app0 = await loadAppFor(db, u, req.params.id, req);
      const cat = categoryOrThrow(app0.category_code);
      if (!cat.submissionEnabled)
        throw new HttpError(409, 'CATEGORY_NOT_VERIFIED', 'Final submission is disabled for this category until its checklist is verified. Your draft is saved.');
      const inst = await db.one<Record<string, string>>('SELECT * FROM institutions WHERE id = $1', [app0.institution_id]);
      const missingProfile = ['name', 'address', 'official_email', 'applicant_name', 'applicant_designation'].filter((k) => !inst?.[k]);
      if (missingProfile.length) throw new HttpError(422, 'PROFILE_INCOMPLETE', 'Complete your Institution Profile (address, official email, applicant name and designation) before submitting.', { missing: missingProfile });

      const outcome = await db.tx(async (t) => {
        const app = await t.one<AppRow>('SELECT * FROM applications WHERE id = $1 FOR UPDATE', [app0.id]);
        if (!app || app.status !== 'DRAFT') throw new HttpError(409, 'ALREADY_SUBMITTED', 'This application has already been submitted.');
        const result = await runValidation(t, app, { stage: 'SUBMISSION', actor: `user:${u.id}`, includeNotApplicable: true });
        if (result.summary.blocking > 0) return { blocked: true as const, result };
        const seq = await t.one<{ n: string }>("SELECT nextval('application_ref_seq')::text AS n");
        const ay = (app.academic_year ?? todayIST().slice(0, 4)).replace('-', '');
        const ref = app.reference_no ?? `FG-${ay}-${seq!.n.padStart(6, '0')}`;
        const snapshot = { name: inst!.name, aicteInstitutionId: inst!.aicte_institution_id, idVerification: inst!.id_verification_status, address: inst!.address, officialEmail: inst!.official_email };
        const sv = await t.one<{ submission_version: number }>(
          `UPDATE applications SET reference_no = $2, submitted_at = now(), submitted_by = $3, ruleset_version = $4, institution_snapshot = $5,
             applicant_name = $6, applicant_designation = $7, submission_version = submission_version + 1 WHERE id = $1 RETURNING submission_version`,
          [app.id, ref, u.id, RULESET_VERSION, JSON.stringify(snapshot), inst!.applicant_name, inst!.applicant_designation],
        );
        await t.query('UPDATE validation_runs SET submission_version = $2 WHERE id = $1', [result.runId, sv!.submission_version]);
        Object.assign(app, { reference_no: ref, submitted_at: new Date().toISOString(), ruleset_version: RULESET_VERSION, institution_snapshot: snapshot, applicant_name: inst!.applicant_name, applicant_designation: inst!.applicant_designation });
        await transition(t, req, { id: u.id, role: 'INSTITUTION_APPLICANT' }, app, 'SUBMIT', {}, `Submitted (submission version ${sv!.submission_version}) with rule set ${RULESET_VERSION}`);
        const report = await createScrutinyReport(t, app, result.runId, 'system:submission');
        await createObligations(t, app, submissionObligations(app));
        await notifyRole(
          t,
          'SCRUTINY_OFFICIAL',
          app.id,
          'NEW_SUBMISSION',
          `New application for scrutiny: ${ref}`,
          `${cat.title} submitted by ${inst!.name}. Scrutiny report v${report.version}: ${report.content.summary.counts.DISCREPANCY_DETECTED} discrepancy finding(s), ${report.content.summary.counts.HUMAN_REVIEW_REQUIRED + report.content.summary.counts.UNABLE_TO_VERIFY} for human verification.`,
          `submit:${app.id}:${sv!.submission_version}`,
        );
        return { blocked: false as const, result, ref };
      });
      if (outcome.blocked) {
        res.status(422).json({ error: 'VALIDATION_FAILED', message: 'Submission blocked: resolve the failing requirements listed below.', validation: outcome.result });
        return;
      }
      const fresh = await db.one<AppRow>('SELECT * FROM applications WHERE id = $1', [app0.id]);
      res.json({ application: fresh, validation: outcome.result });
    }),
  );

  r.post(
    '/applications/:id/reopen-request',
    upload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const { reason } = z.object({ reason: z.string().trim().min(10).max(2000) }).parse(req.body);
      if (app.status !== 'SUBMITTED') throw new HttpError(409, 'NOT_REOPENABLE', 'Reopening can be requested only before processing has started.');
      if (app.reopen_count >= 1) throw new HttpError(409, 'REOPEN_USED', 'An application can be reopened only ONE time.');
      const stored = await storeUpload(storage, req.file);
      await db.query('UPDATE applications SET reopen_requested_at = now(), reopen_request_reason = $2 WHERE id = $1', [app.id, reason]);
      await audit(db, req, 'REOPEN_REQUESTED', 'application', app.id, { reason, resolutionKey: stored.key, resolutionName: stored.name, sha256: stored.sha256 }, app.institution_id);
      await notifyRole(db, 'DECISION_AUTHORITY', app.id, 'REOPEN_REQUEST', `Reopen request ${app.reference_no}`, reason);
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- deficiencies & corrections
  r.get(
    '/deficiencies',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      const rows = await db.query(
        `SELECT d.*, a.reference_no AS application_ref, a.category_code, a.status AS application_status, n.notice_no, n.version AS notice_version
         FROM deficiencies d JOIN applications a ON a.id = d.application_id LEFT JOIN deficiency_notices n ON n.id = d.notice_id
         WHERE a.institution_id = $1 AND d.status NOT IN ('DRAFT','WITHDRAWN') ORDER BY (d.status = 'OPEN') DESC, d.raised_at DESC`,
        [inst],
      );
      res.json({ deficiencies: rows });
    }),
  );

  r.post(
    '/deficiencies/:id/respond',
    ah(async (req, res) => {
      const u = user(req);
      const body = z.object({ note: z.string().trim().min(3).max(4000), fieldChanges: z.record(z.unknown()).optional() }).parse(req.body);
      const d = await db.one<{ id: string; application_id: string; target_type: string; target_id: string | null; status: string; reference_no: string }>('SELECT * FROM deficiencies WHERE id = $1', [req.params.id]);
      if (!d) throw new HttpError(404, 'NOT_FOUND', 'Deficiency not found.');
      const app = await loadAppFor(db, u, d.application_id, req);
      if (!CORRECTION_STATES.includes(app.status)) throw new HttpError(409, 'NOT_IN_CORRECTION', 'Corrections are not open for this application.');
      if (!['OPEN', 'RESPONDED'].includes(d.status)) throw new HttpError(409, 'DEFICIENCY_CLOSED', 'This deficiency is not open for correction.');
      let changes: Record<string, unknown> = {};
      if (body.fieldChanges && Object.keys(body.fieldChanges).length) {
        changes = cleanFields(app.category_code, body.fieldChanges);
        if (d.target_type === 'FIELD' && Object.keys(changes).some((k) => k !== d.target_id)) throw new HttpError(409, 'WRONG_FIELD', 'Only the field named in this deficiency can be changed.');
        if (d.target_type === 'DOCUMENT') throw new HttpError(409, 'WRONG_TARGET', 'This deficiency concerns a document; upload a replacement instead.');
      }
      if (d.target_type === 'DOCUMENT') {
        const up = await db.one('SELECT 1 FROM documents WHERE deficiency_id = $1', [d.id]);
        if (!up) throw new HttpError(409, 'UPLOAD_REQUIRED', 'Upload the corrected document before responding.');
      }
      await db.tx(async (t) => {
        if (Object.keys(changes).length) {
          const before = Object.fromEntries(Object.keys(changes).map((k) => [k, app.field_values[k] ?? null]));
          await t.query('UPDATE applications SET field_values = field_values || $2::jsonb, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [app.id, JSON.stringify(changes)]);
          await t.query('INSERT INTO deficiency_events(deficiency_id, event, actor_id, note, field_changes) VALUES ($1,$2,$3,$4,$5)', [d.id, 'FIELDS_CHANGED', u.id, null, JSON.stringify({ before, after: changes })]);
        }
        await t.query('INSERT INTO deficiency_events(deficiency_id, event, actor_id, note) VALUES ($1,$2,$3,$4)', [d.id, 'RESPONSE', u.id, body.note]);
        await t.query("UPDATE deficiencies SET status = 'RESPONDED', updated_at = now() WHERE id = $1", [d.id]);
        if (app.status === 'DEFICIENCY_RAISED') await transition(t, req, { id: u.id, role: 'INSTITUTION_APPLICANT' }, app, 'BEGIN_CORRECTION');
      });
      await audit(db, req, 'DEFICIENCY_RESPONDED', 'deficiency', d.id, { fields: Object.keys(changes) }, app.institution_id);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/applications/:id/corrections/submit',
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const open = await db.query<{ reference_no: string }>("SELECT reference_no FROM deficiencies WHERE application_id = $1 AND status = 'OPEN'", [app.id]);
      if (open.length) throw new HttpError(422, 'DEFICIENCIES_OPEN', `Respond to every open deficiency first: ${open.map((o) => o.reference_no).join(', ')}.`);
      const notice = await db.one<{ id: string; issued_at: string }>('SELECT id, issued_at FROM deficiency_notices WHERE application_id = $1 ORDER BY version DESC LIMIT 1', [app.id]);
      if (!notice) throw new HttpError(409, 'NO_NOTICE', 'There is no deficiency notice to respond to.');
      const out = await db.tx(async (t) => {
        const { items, changedFields, changedDocs } = await buildCorrectionItems(t, app.id, notice.issued_at);
        const sv = await t.one<{ submission_version: number }>('UPDATE applications SET submission_version = submission_version + 1 WHERE id = $1 RETURNING submission_version', [app.id]);
        const ver = await t.one<{ n: number }>('SELECT coalesce(max(version),0)::int AS n FROM correction_submissions WHERE application_id = $1', [app.id]);
        const cs = await t.one<{ id: string; version: number }>(
          `INSERT INTO correction_submissions(application_id, version, submission_version, notice_id, items, changed_fields, changed_docs, submitted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, version`,
          [app.id, (ver?.n ?? 0) + 1, sv!.submission_version, notice.id, JSON.stringify(items), changedFields, changedDocs, u.id],
        );
        await transition(t, req, { id: u.id, role: 'INSTITUTION_APPLICANT' }, app, 'SUBMIT_CORRECTIONS', {}, `Correction submission v${cs!.version} (submission version ${sv!.submission_version})`);
        // Targeted re-evaluation: only rules affected by the changed fields/documents and their dependants.
        const fresh = (await t.one<AppRow>('SELECT * FROM applications WHERE id = $1', [app.id]))!;
        const run = await runValidation(t, fresh, { stage: 'RE_SCRUTINY', actor: 'system:correction', scope: { changedFields, changedDocs } });
        await t.query('UPDATE correction_submissions SET validation_run_id = $2 WHERE id = $1', [cs!.id, run.runId]);
        const report = await createReScrutinyReport(t, fresh, cs!.id, run.runId, 'system:correction');
        await notifyRole(
          t,
          'RE_SCRUTINY_OFFICIAL',
          app.id,
          'CORRECTIONS_SUBMITTED',
          `Corrections received for re-scrutiny: ${app.reference_no}`,
          `Correction submission v${cs!.version}; re-scrutiny report v${report.version} is ready (${items.length} deficiency response(s)).`,
          `correction:${cs!.id}`,
        );
        return { correctionSubmission: cs, reportVersion: report.version };
      });
      res.json({ ok: true, status: app.status, ...out });
    }),
  );

  // ---------------------------------------------------------------- EVC, decisions, appeals
  r.get(
    '/evc-visits',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      const visits = await db.query(
        `SELECT v.id, v.application_id, v.mode, v.scheduled_start, v.location, v.meeting_link, v.agenda, v.prepare_items, v.instructions, v.committee_disclosure,
                v.status, v.status_note, v.scheduled_at, v.updated_at, v.institution_video_link, v.offline_justification, a.reference_no, a.category_code
         FROM evc_visits v JOIN applications a ON a.id = v.application_id WHERE a.institution_id = $1 ORDER BY v.scheduled_start DESC`,
        [inst],
      );
      const reports = await db.query(
        `SELECT r.id, r.visit_id, r.version, r.observations, r.recommendation, r.disclosed_summary, r.submitted_at FROM evc_reports r
         JOIN applications a ON a.id = r.application_id WHERE a.institution_id = $1`,
        [inst],
      );
      res.json({ visits: visits.map((v) => ({ ...v, reports: reports.filter((r) => r.visit_id === v.id) })) });
    }),
  );

  r.get(
    '/decisions',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      const rows = await db.query<Record<string, unknown>>(
        `SELECT d.id, d.application_id, d.decision_type, d.decision_body, d.reference_no, d.issuing_authority, d.decision_date::text AS decision_date, d.uploaded_at,
                d.reasons, d.conditions, d.corrective_action, d.next_steps, d.document_name, d.is_appeal_outcome, a.reference_no AS application_ref, a.category_code
         FROM decisions d JOIN applications a ON a.id = d.application_id WHERE a.institution_id = $1 ORDER BY d.uploaded_at DESC`,
        [inst],
      );
      const out = [];
      for (const d of rows) {
        const app = await db.one<AppRow>('SELECT * FROM applications WHERE id = $1', [d.application_id]);
        out.push({ ...d, appealEligibility: await appealEligibility(db, app!) });
      }
      res.json({ decisions: out });
    }),
  );

  r.get(
    '/decisions/:id/document',
    ah(async (req, res) => {
      const d = await db.one<{ application_id: string; document_storage_key: string | null; document_name: string | null }>('SELECT application_id, document_storage_key, document_name FROM decisions WHERE id = $1', [req.params.id]);
      if (!d) throw new HttpError(404, 'NOT_FOUND', 'Decision not found.');
      await loadAppFor(db, user(req), d.application_id, req);
      if (!d.document_storage_key) throw new HttpError(404, 'NO_DOCUMENT', 'No decision document was uploaded.');
      sendFile(res, await storage.read(d.document_storage_key), d.document_name ?? 'decision.pdf', d.document_storage_key.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    }),
  );

  r.get(
    '/appeals',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      const rows = await db.query(
        `SELECT p.*, a.reference_no AS application_ref, a.category_code, a.status AS application_status, d.reference_no AS decision_ref, d.decision_type, d.uploaded_at AS decision_uploaded_at
         FROM appeals p JOIN applications a ON a.id = p.application_id JOIN decisions d ON d.id = p.decision_id WHERE a.institution_id = $1 ORDER BY p.submitted_at DESC`,
        [inst],
      );
      res.json({ appeals: rows });
    }),
  );

  r.get(
    '/applications/:id/appeal-eligibility',
    ah(async (req, res) => {
      const app = await loadAppFor(db, user(req), req.params.id, req);
      res.json(await appealEligibility(db, app));
    }),
  );

  r.post(
    '/applications/:id/appeal',
    upload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const { grounds } = z.object({ grounds: z.string().trim().min(20).max(8000) }).parse(req.body);
      const el = await appealEligibility(db, app);
      if (!el.eligible || !el.decisionId) throw new HttpError(409, 'APPEAL_NOT_ELIGIBLE', el.reason);
      const stored = req.file ? await storeUpload(storage, req.file) : null;
      const appeal = await db.tx(async (t) => {
        const seq = await t.one<{ n: string }>("SELECT nextval('appeal_ref_seq')::text AS n");
        const a = await t.one(
          `INSERT INTO appeals(reference_no, application_id, decision_id, grounds, supporting_storage_key, supporting_name, deadline_at, deadline_basis, submitted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [`FG-APL-${seq!.n.padStart(5, '0')}`, app.id, el.decisionId, grounds, stored?.key ?? null, stored?.name ?? null, el.deadlineAt, el.deadlineBasis, u.id],
        );
        await transition(t, req, { id: u.id, role: 'INSTITUTION_APPLICANT' }, app, 'SUBMIT_APPEAL', {}, 'Appeal filed to the Council (SAC)');
        await notifyRole(t, 'SAC_MEMBER', app.id, 'APPEAL_SUBMITTED', `Appeal ${(a as { reference_no: string }).reference_no}`, `Appeal against decision on ${app.reference_no}.`);
        return a;
      });
      res.status(201).json({ appeal });
    }),
  );

  // ---------------------------------------------------------------- compliance
  r.get(
    '/compliance',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      const dueSoon = (await getPolicy(db, 'COMPLIANCE_DUE_SOON_DAYS')).value;
      const rows = await db.query<Record<string, any>>(
        `SELECT o.*, o.due_date::text AS due_date, a.reference_no,
                (SELECT json_agg(json_build_object('version', s.version, 'fileName', s.file_name, 'note', s.note, 'submittedAt', s.submitted_at) ORDER BY s.version DESC) FROM compliance_submissions s WHERE s.obligation_id = o.id) AS submissions,
                (SELECT json_agg(json_build_object('outcome', r.outcome, 'note', r.note, 'at', r.created_at) ORDER BY r.id DESC) FROM compliance_reviews r WHERE r.obligation_id = o.id) AS reviews
         FROM compliance_obligations o LEFT JOIN applications a ON a.id = o.application_id
         WHERE o.institution_id = $1 ORDER BY (o.status = 'ACCEPTED_BY_AUTHORISED_REVIEWER'), o.due_date NULLS LAST, o.created_at`,
        [inst],
      );
      const today = todayIST();
      res.json({ obligations: rows.map((o) => ({ ...o, displayStatus: complianceDisplayStatus(o.status, o.due_date, today, dueSoon) })), today, dueSoonDays: dueSoon });
    }),
  );

  r.post(
    '/compliance/:id/evidence',
    upload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const inst = primaryInstitution(u);
      const { note } = z.object({ note: z.string().trim().max(2000).optional() }).parse(req.body);
      const o = await db.one<{ id: string; institution_id: string; status: string; application_id: string | null; title: string }>('SELECT * FROM compliance_obligations WHERE id = $1', [req.params.id]);
      if (!o || o.institution_id !== inst) throw new HttpError(404, 'NOT_FOUND', 'Obligation not found.');
      if (o.status === 'ACCEPTED_BY_AUTHORISED_REVIEWER') throw new HttpError(409, 'ACCEPTED', 'This item was already accepted by an authorised reviewer.');
      if (o.status === 'UNDER_REVIEW') throw new HttpError(409, 'UNDER_REVIEW', 'The submission is under review; wait for the reviewer to return it.');
      const stored = await storeUpload(storage, req.file);
      await db.tx(async (t) => {
        const ver = await t.one<{ v: number | null }>('SELECT max(version) AS v FROM compliance_submissions WHERE obligation_id = $1', [o.id]);
        await t.query('INSERT INTO compliance_submissions(obligation_id, version, storage_key, file_name, sha256, note, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [o.id, (ver?.v ?? 0) + 1, stored.key, stored.name, stored.sha256, note ?? null, u.id]);
        // Latest-submission pointer kept on the obligation for listing; the history lives in compliance_submissions.
        await t.query("UPDATE compliance_obligations SET status = 'SUBMITTED', evidence_storage_key = $2, evidence_name = $3, evidence_note = $4, updated_at = now() WHERE id = $1", [o.id, stored.key, stored.name, note ?? null]);
      });
      await audit(db, req, 'COMPLIANCE_EVIDENCE_SUBMITTED', 'obligation', o.id, { sha256: stored.sha256 }, inst);
      await notifyRole(db, 'DECISION_AUTHORITY', o.application_id, 'COMPLIANCE_EVIDENCE', 'Compliance evidence submitted', `Evidence submitted for "${o.title}". Submission is not acceptance; review it.`);
      res.json({ ok: true, status: 'SUBMITTED' });
    }),
  );

  // ---------------------------------------------------------------- document validity
  r.get(
    '/document-validity',
    ah(async (req, res) => {
      const inst = primaryInstitution(user(req));
      const alert = await getPolicy(db, 'DOCUMENT_EXPIRY_ALERT_DAYS');
      res.json({ documents: await documentValidity(db, { institutionId: inst }, alert.value), alertDays: alert.value, policy: alert });
    }),
  );

  // ---------------------------------------------------------------- EVC video link (APH Ch. I §1.9(f)-(g))
  r.post(
    '/evc-visits/:visitId/video-link',
    ah(async (req, res) => {
      const u = user(req);
      const { url } = z.object({ url: z.string().trim().url().max(500).refine((x) => /^https:\/\//i.test(x), 'Use an https:// link') }).parse(req.body);
      if (!/^[0-9a-f-]{36}$/i.test(req.params.visitId)) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
      const v = await db.one<{ id: string; application_id: string; status: string }>('SELECT v.id, v.application_id, v.status FROM evc_visits v JOIN applications a ON a.id = v.application_id WHERE v.id = $1 AND a.institution_id = ANY($2)', [req.params.visitId, u.institutionIds]);
      if (!v) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
      if (v.status === 'CANCELLED') throw new HttpError(409, 'CANCELLED', 'This visit was cancelled.');
      await db.query('UPDATE evc_visits SET institution_video_link = $2, updated_at = now() WHERE id = $1', [v.id, url]);
      await db.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [v.id, 'INSTITUTION_VIDEO_LINK', u.id, JSON.stringify({ url })]);
      await audit(db, req, 'EVC_VIDEO_LINK_SHARED', 'evc_visit', v.id, {}, u.institutionIds[0]);
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- audit (own applications)
  r.get(
    '/applications/:id/audit',
    ah(async (req, res) => {
      const app = await loadAppFor(db, user(req), req.params.id, req);
      const rows = await db.query(
        `SELECT l.id, l.action, l.actor_role, l.created_at, u.full_name AS actor_name FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
         WHERE (l.entity_type = 'application' AND l.entity_id = $1) OR (l.entity_type = 'document' AND l.entity_id IN (SELECT id::text FROM documents WHERE application_id = $2)) ORDER BY l.id DESC LIMIT 200`,
        [app.id, app.id],
      );
      res.json({ audit: rows });
    }),
  );

  return r;
}

/** Shared endpoints for any authenticated user (documents, notifications). */
export function sharedRouter(db: Db, storage: Storage) {
  const r = Router();
  r.get(
    '/documents/:id/download',
    ah(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
      const d = await db.one<{ application_id: string; storage_key: string; file_name: string; mime_type: string }>('SELECT application_id, storage_key, file_name, mime_type FROM documents WHERE id = $1', [req.params.id]);
      if (!d) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
      const app = await loadAppFor(db, user(req), d.application_id, req);
      await audit(db, req, 'DOCUMENT_DOWNLOADED', 'document', req.params.id, {}, app.institution_id);
      sendFile(res, await storage.read(d.storage_key), d.file_name, d.mime_type, req.query.inline === '1');
    }),
  );
  r.get(
    '/notices/:id/pdf',
    ah(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Notice not found.');
      const n = await db.one<{ application_id: string; storage_key: string; notice_no: string; version: number }>('SELECT application_id, storage_key, notice_no, version FROM deficiency_notices WHERE id = $1', [req.params.id]);
      if (!n) throw new HttpError(404, 'NOT_FOUND', 'Notice not found.');
      await loadAppFor(db, user(req), n.application_id, req);
      sendFile(res, await storage.read(n.storage_key), `${n.notice_no}-v${n.version}.pdf`, 'application/pdf', req.query.inline === '1');
    }),
  );
  r.get(
    '/reports/:id/pdf',
    ah(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Report not found.');
      const rep = await db.one<{ application_id: string; content: any; kind: string; version: number }>('SELECT application_id, content, kind, version FROM workflow_reports WHERE id = $1', [req.params.id]);
      if (!rep) throw new HttpError(404, 'NOT_FOUND', 'Report not found.');
      if (user(req).activeRole === 'INSTITUTION_APPLICANT') throw new HttpError(404, 'NOT_FOUND', 'Report not found.');
      await loadAppFor(db, user(req), rep.application_id, req);
      sendFile(res, await reportPdf(rep.content), `${rep.kind.toLowerCase()}-report-v${rep.version}.pdf`, 'application/pdf', req.query.inline === '1');
    }),
  );
  r.get(
    '/notifications',
    ah(async (req, res) => {
      const rows = await db.query(
        `SELECT n.*, a.reference_no, i.name AS institution_name FROM notifications n
         LEFT JOIN applications a ON a.id = n.application_id LEFT JOIN institutions i ON i.id = a.institution_id
         WHERE n.recipient_user_id = $1 ORDER BY n.created_at DESC LIMIT 200`,
        [user(req).id],
      );
      const unread = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL', [user(req).id]);
      res.json({ notifications: rows, unread: unread?.n ?? 0 });
    }),
  );
  r.post(
    '/notifications/read-all',
    ah(async (req, res) => {
      await db.query('UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL', [user(req).id]);
      res.json({ ok: true });
    }),
  );
  r.post(
    '/notifications/:id/read',
    ah(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      await db.query('UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND recipient_user_id = $2', [req.params.id, user(req).id]);
      res.json({ ok: true });
    }),
  );
  return r;
}

export { notifyInstitution };
