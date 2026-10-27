/**
 * EVC registry, committee composition checks and the EVC member workspace.
 *
 * Registry: Regional Officers / administrators create and edit expert records; any edit to qualifications returns the
 * record to NEEDS_VERIFICATION. A Regulation Bureau officer — a different person from the one who last edited it —
 * records verification and its source (FlowGuard four-eyes design). Only VERIFIED records can pass §16.5 checks.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { ESCALATION_ACTIONS, raiseEscalation } from '../escalations.ts';
import { alternativeSlots, assignmentStatus, availability, checkComposition, EVIDENCE_CATEGORIES, EVIDENCE_FILE_TYPES, loadVisitFor, memberStatus, notifyRegionalOfficers, releaseReservations, REPORT_SECTIONS, respond, SECTION_FINDINGS, slotLabel } from '../evc/service.ts';
import { SEAT_LABEL, SEATS, seatEligibility, type Expert } from '../evc/composition.ts';
import { ah, audit, HttpError, requireRole, user, type AuthUser } from '../http.ts';
import { notify } from '../notify.ts';
import { getPolicy, policyLabel } from '../policy.ts';
import { loadAppFor, notifyInstitution, REGION_SCOPE_SQL } from '../services.ts';
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, sniffType, sniffVideo, type Storage } from '../storage.ts';
import { sendFile, storeUpload } from './institution.ts';

/** Visit evidence may include a video recording; per-category type and size checks follow in storeEvidence. */
const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 10 } });

const expertSchema = z.object({
  fullName: z.string().trim().min(3).max(160),
  officialEmail: z.string().trim().email().max(160),
  phone: z.string().trim().max(30).optional().nullable(),
  designationLevel: z.enum(['VICE_CHANCELLOR', 'DIRECTOR_IIT_NIT', 'PROFESSOR', 'ASSOCIATE_PROFESSOR', 'ASSISTANT_PROFESSOR', 'INDUSTRY_EXPERT', 'ARCHITECT', 'GOVT_TECHNICAL_OFFICER', 'OTHER']),
  discipline: z.enum(['ENGINEERING_TECHNOLOGY', 'MANAGEMENT', 'PHARMACY', 'ARCHITECTURE', 'PLANNING', 'CIVIL_STRUCTURAL', 'COMPUTER_APPLICATIONS', 'HOTEL_MANAGEMENT', 'APPLIED_ARTS', 'OTHER']),
  specialisation: z.string().trim().max(200).optional().nullable(),
  organisation: z.string().trim().min(2).max(200),
  organisationType: z.enum(['IIT', 'IIM', 'NIT', 'GOVERNMENT', 'GOVERNMENT_AIDED', 'UNIVERSITY', 'PRIVATE', 'INDUSTRY', 'CPWD', 'NBCC', 'DRDO', 'CSIR', 'OTHER']),
  experienceYears: z.number().min(0).max(70).optional().nullable(),
  coaRegistrationNo: z.string().trim().max(60).optional().nullable(),
  panelStatus: z.enum(['ON_APPROVED_PANEL', 'NOT_ON_PANEL', 'NEEDS_VERIFICATION']).default('NEEDS_VERIFICATION'),
  panelReference: z.string().trim().max(300).optional().nullable(),
  regionCode: z.string().trim().max(40).optional().nullable(),
  loginId: z.string().trim().max(120).optional().nullable(),
});

const withEligibility = (e: Expert & Record<string, unknown>) => ({
  ...e,
  seatEligibility: Object.fromEntries(SEATS.map((s) => [s, seatEligibility(e, s)])),
});

export function evcRouter(db: Db, storage: Storage) {
  const r = Router();

  // ------------------------------------------------------------------ registry
  r.get(
    '/experts',
    requireRole('REGIONAL_OFFICER', 'REGULATION_BUREAU', 'SUPERVISOR', 'SYSTEM_ADMIN'),
    ah(async (req, res) => {
      const q = z.object({ q: z.string().max(100).optional(), verification: z.string().max(40).optional(), active: z.enum(['true', 'false']).optional() }).parse(req.query);
      const rows = await db.query<Expert & Record<string, unknown>>(
        `SELECT e.*, uu.login_id, vb.full_name AS verified_by_name,
                (SELECT count(*)::int FROM evc_visit_members m WHERE m.expert_id = e.id) AS assignments,
                (SELECT count(*)::int FROM evc_reports rp JOIN evc_visit_members m ON m.visit_id = rp.visit_id AND m.user_id = rp.submitted_by WHERE m.expert_id = e.id) AS reports
         FROM evc_experts e LEFT JOIN users uu ON uu.id = e.user_id LEFT JOIN users vb ON vb.id = e.verified_by
         WHERE ($1::text IS NULL OR e.full_name ILIKE $1 OR e.member_code ILIKE $1 OR e.organisation ILIKE $1)
           AND ($2::text IS NULL OR e.verification_status = $2) AND ($3::boolean IS NULL OR e.active = $3)
         ORDER BY e.active DESC, e.full_name`,
        [q.q ? `%${q.q}%` : null, q.verification ?? null, q.active ? q.active === 'true' : null],
      );
      res.json({
        experts: rows.map(withEligibility),
        seats: SEATS.map((s) => ({ seat: s, label: SEAT_LABEL[s] })),
        note: 'Member selection through this registry is a portal operational procedure, in line with AICTE\'s automated web portal selection process.',
      });
    }),
  );

  r.get(
    '/experts/:id',
    requireRole('REGIONAL_OFFICER', 'REGULATION_BUREAU', 'SUPERVISOR', 'SYSTEM_ADMIN'),
    ah(async (req, res) => {
      const e = await db.one<Expert & Record<string, unknown>>('SELECT * FROM evc_experts WHERE id = $1', [req.params.id]);
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'Expert not found.');
      const events = await db.query('SELECT x.*, uu.full_name AS actor_name FROM evc_expert_events x LEFT JOIN users uu ON uu.id = x.actor_id WHERE x.expert_id = $1 ORDER BY x.id DESC', [e.id]);
      const history = await db.query(
        `SELECT m.seat, m.active, m.assigned_at, m.attendance, v.status AS visit_status, v.scheduled_start, a.reference_no FROM evc_visit_members m
         JOIN evc_visits v ON v.id = m.visit_id JOIN applications a ON a.id = v.application_id WHERE m.expert_id = $1 ORDER BY m.assigned_at DESC`,
        [e.id],
      );
      res.json({ expert: withEligibility(e), events, assignments: history });
    }),
  );

  const linkUser = async (loginId: string | null | undefined) => {
    if (!loginId) return null;
    const u = await db.one<{ id: string }>("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'EVC_MEMBER' WHERE u.login_id = $1", [loginId]);
    if (!u) throw new HttpError(400, 'NO_EVC_ACCOUNT', 'No EVC member account exists with that login ID.');
    return u.id;
  };

  r.post(
    '/experts',
    requireRole('REGIONAL_OFFICER', 'SYSTEM_ADMIN'),
    ah(async (req, res) => {
      const u = user(req);
      const b = expertSchema.parse(req.body);
      const userId = await linkUser(b.loginId);
      const seq = await db.one<{ n: string }>("SELECT nextval('evc_expert_seq')::text AS n");
      const e = await db.one<{ id: string }>(
        `INSERT INTO evc_experts(member_code, user_id, full_name, official_email, phone, designation_level, discipline, specialisation, organisation, organisation_type,
           experience_years, coa_registration_no, panel_status, panel_reference, region_code, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id, member_code`,
        [`EVC-${seq!.n.padStart(5, '0')}`, userId, b.fullName, b.officialEmail, b.phone ?? null, b.designationLevel, b.discipline, b.specialisation ?? null, b.organisation, b.organisationType, b.experienceYears ?? null, b.coaRegistrationNo ?? null, b.panelStatus, b.panelReference ?? null, b.regionCode ?? null, u.id],
      );
      await db.query('INSERT INTO evc_expert_events(expert_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [e!.id, 'CREATED', u.id, JSON.stringify(b)]);
      await audit(db, req, 'EVC_EXPERT_CREATED', 'evc_expert', e!.id, {});
      res.status(201).json({ expert: e });
    }),
  );

  r.patch(
    '/experts/:id',
    requireRole('REGIONAL_OFFICER', 'SYSTEM_ADMIN'),
    ah(async (req, res) => {
      const u = user(req);
      const b = expertSchema.parse(req.body);
      const userId = await linkUser(b.loginId);
      const e = await db.one<{ id: string }>(
        `UPDATE evc_experts SET user_id=$2, full_name=$3, official_email=$4, phone=$5, designation_level=$6, discipline=$7, specialisation=$8, organisation=$9, organisation_type=$10,
           experience_years=$11, coa_registration_no=$12, panel_status=$13, panel_reference=$14, region_code=$15, updated_by=$16, updated_at=now(),
           verification_status='NEEDS_VERIFICATION', verification_source=NULL, verified_by=NULL, verified_at=NULL
         WHERE id = $1 RETURNING id`,
        [req.params.id, userId, b.fullName, b.officialEmail, b.phone ?? null, b.designationLevel, b.discipline, b.specialisation ?? null, b.organisation, b.organisationType, b.experienceYears ?? null, b.coaRegistrationNo ?? null, b.panelStatus, b.panelReference ?? null, b.regionCode ?? null, u.id],
      );
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'Expert not found.');
      await db.query('INSERT INTO evc_expert_events(expert_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [e.id, 'UPDATED_VERIFICATION_RESET', u.id, JSON.stringify(b)]);
      await audit(db, req, 'EVC_EXPERT_UPDATED', 'evc_expert', e.id, {});
      res.json({ expert: e });
    }),
  );

  r.post(
    '/experts/:id/verify',
    requireRole('REGULATION_BUREAU'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z
        .object({ status: z.enum(['VERIFIED', 'REJECTED']), source: z.string().trim().min(5).max(500), panelStatus: z.enum(['ON_APPROVED_PANEL', 'NOT_ON_PANEL', 'NEEDS_VERIFICATION']).optional(), panelReference: z.string().trim().max(300).optional() })
        .parse(req.body);
      const e = await db.one<{ id: string; created_by: string | null; updated_by: string | null }>('SELECT id, created_by, updated_by FROM evc_experts WHERE id = $1', [req.params.id]);
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'Expert not found.');
      if (e.updated_by === u.id || e.created_by === u.id) throw new HttpError(409, 'SAME_PERSON', 'The person who entered or last edited a record cannot verify it.');
      await db.query(
        `UPDATE evc_experts SET verification_status = $2, verification_source = $3, verified_by = $4, verified_at = now(),
           panel_status = coalesce($5, panel_status), panel_reference = coalesce($6, panel_reference) WHERE id = $1`,
        [e.id, b.status, b.source, u.id, b.panelStatus ?? null, b.panelReference ?? null],
      );
      await db.query('INSERT INTO evc_expert_events(expert_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [e.id, b.status, u.id, JSON.stringify(b)]);
      await audit(db, req, 'EVC_EXPERT_VERIFIED', 'evc_expert', e.id, b);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/experts/:id/active',
    requireRole('REGIONAL_OFFICER', 'SYSTEM_ADMIN', 'REGULATION_BUREAU'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z.object({ active: z.boolean(), reason: z.string().trim().min(5).max(500) }).parse(req.body);
      const e = await db.one<{ id: string }>('UPDATE evc_experts SET active = $2, updated_at = now() WHERE id = $1 RETURNING id', [req.params.id, b.active]);
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'Expert not found.');
      await db.query('INSERT INTO evc_expert_events(expert_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [e.id, b.active ? 'ACTIVATED' : 'DEACTIVATED', u.id, JSON.stringify(b)]);
      await audit(db, req, 'EVC_EXPERT_STATUS', 'evc_expert', e.id, b);
      res.json({ ok: true });
    }),
  );

  // ------------------------------------------------------------------ composition check (no side effects)
  r.post(
    '/applications/:id/composition-check',
    requireRole('REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const b = z.object({ members: z.array(z.object({ expertId: z.string().uuid(), seat: z.enum(SEATS) })).max(10) }).parse(req.body);
      if (!app) throw new HttpError(404, 'NOT_FOUND', 'Application not found.');
      const c = await checkComposition(db, b.members);
      res.json({ valid: c.valid, findings: c.findings });
    }),
  );

  // ------------------------------------------------------------------ member workspace
  r.get(
    '/my-assignments',
    requireRole('EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const rows = await db.query<Record<string, any>>(
        `SELECT m.visit_id, m.seat, m.response_status, m.responded_at, m.rejection_reason, m.conflict_note, m.attendance, m.active, m.removed_reason, m.assigned_at,
                v.application_id, v.mode, v.scheduled_start, v.scheduled_end, v.schedule_version, v.status AS visit_status, v.instructions, v.agenda, v.completed_at, v.meeting_link, v.location,
                a.reference_no, a.category_code, a.status AS application_status, i.name AS institution_name, i.district, i.state,
                (SELECT max(version) FROM evc_reports r WHERE r.visit_id = v.id) AS report_version,
                (SELECT 1 FROM evc_report_drafts d WHERE d.visit_id = v.id AND d.author_id = $1) IS NOT NULL AS has_draft,
                (SELECT due_at FROM deadlines d WHERE d.subject_type = 'EVC_REPORT' AND d.subject_id = v.id::text) AS report_due_at,
                (SELECT due_at FROM deadlines d WHERE d.subject_type = 'EVC_ACKNOWLEDGEMENT' AND d.subject_id = v.id::text || ':' || $1::text) AS ack_due_at
         FROM evc_visit_members m JOIN evc_visits v ON v.id = m.visit_id JOIN applications a ON a.id = v.application_id JOIN institutions i ON i.id = a.institution_id
         WHERE m.user_id = $1 ORDER BY m.active DESC, v.scheduled_start`,
        [u.id],
      );
      res.json({
        assignments: rows.map((x) => ({
          ...x,
          memberStatus: memberStatus(x as { active: boolean; response_status: string }, { status: x.visit_status }, { reportSubmitted: !!x.report_version, draft: !!x.has_draft, reportDueAt: x.report_due_at }),
          // Removed members keep a history line but lose access to the visit details.
          meeting_link: x.active ? x.meeting_link : null,
          location: x.active ? x.location : null,
        })),
      });
    }),
  );

  r.get(
    '/visits/:visitId',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER', 'REGULATION_BUREAU', 'SUPERVISOR', 'DECISION_AUTHORITY'),
    ah(async (req, res) => {
      const u = user(req);
      const v = await loadVisitFor(db, u, req.params.visitId);
      // None of these queries depend on each other (all keyed off v.id/v.application_id/v.institution_id
      // already known), so run them concurrently rather than paying eleven serial round trips — each
      // one costs real latency against a remote (e.g. Supabase) database.
      const [visit, app, institution, members, events, reports, draft, evidence, deadlines, documents, escalations] = await Promise.all([
        db.one('SELECT * FROM evc_visits WHERE id = $1', [v.id]),
        db.one<Record<string, any>>('SELECT id, reference_no, category_code, subtype, status, field_values, submission_version FROM applications WHERE id = $1', [v.application_id]),
        db.one('SELECT name, aicte_institution_id, address, district, state, pincode, region_code FROM institutions WHERE id = $1', [v.institution_id]),
        db.query(
          `SELECT m.user_id, m.seat, m.response_status, m.responded_at, m.rejection_reason, m.conflict_note, m.attendance, m.attendance_recorded_at, m.active, m.removed_reason, uu.full_name, e.member_code, e.designation_level, e.organisation
           FROM evc_visit_members m JOIN users uu ON uu.id = m.user_id LEFT JOIN evc_experts e ON e.id = m.expert_id WHERE m.visit_id = $1 ORDER BY m.active DESC, m.assigned_at`,
          [v.id],
        ),
        db.query('SELECT e.event, e.details, e.created_at, uu.full_name AS actor_name FROM evc_visit_events e LEFT JOIN users uu ON uu.id = e.actor_id WHERE e.visit_id = $1 ORDER BY e.id DESC', [v.id]),
        db.query('SELECT r.id, r.version, r.observations, r.recommendation, r.disclosed_summary, r.sections, r.receipt_no, r.submitted_at, r.declaration_at, uu.full_name AS submitted_by_name FROM evc_reports r JOIN users uu ON uu.id = r.submitted_by WHERE r.visit_id = $1 ORDER BY r.version DESC', [v.id]),
        db.one('SELECT sections, recommendation, disclosed_summary, updated_at FROM evc_report_drafts WHERE visit_id = $1 AND author_id = $2', [v.id, u.id]),
        db.query('SELECT x.id, x.file_name, x.mime_type, x.size_bytes, x.note, x.category, x.uploaded_at, x.report_id, uu.full_name AS uploaded_by_name FROM evc_report_evidence x JOIN users uu ON uu.id = x.uploaded_by WHERE x.visit_id = $1 ORDER BY x.uploaded_at DESC', [v.id]),
        db.query('SELECT subject_type, subject_id, responsible_role, responsible_user_id, due_at, source_type, source_reference, status FROM deadlines WHERE visit_id = $1 ORDER BY due_at', [v.id]),
        db.query('SELECT id, requirement_id, file_name, version, uploaded_at FROM documents WHERE application_id = $1 AND is_current ORDER BY requirement_id', [v.application_id]),
        db.query('SELECT id, reference_no, kind, status, reason, created_at FROM escalations WHERE visit_id = $1 ORDER BY created_at DESC', [v.id]),
      ]);
      const me = members.find((m: any) => m.user_id === u.id && m.active) as any;
      const reportDue = (deadlines as any[]).find((d) => d.subject_type === 'EVC_REPORT')?.due_at ?? null;
      res.json({
        visit,
        application: app,
        institution,
        members,
        events,
        reports,
        draft,
        evidence,
        deadlines,
        documents,
        escalations,
        reportSections: REPORT_SECTIONS,
        sectionFindings: SECTION_FINDINGS,
        evidenceCategories: EVIDENCE_CATEGORIES,
        evidenceFileTypes: EVIDENCE_FILE_TYPES,
        role: { isMember: v.isMember, isRegionalOfficer: v.isRegionalOfficer },
        myStatus: me ? memberStatus(me, { status: (visit as any).status }, { reportSubmitted: reports.length > 0, draft: !!draft, reportDueAt: reportDue }) : null,
      });
    }),
  );

  /** Stores a report document or piece of visit evidence after checking its real type against the category. */
  const storeEvidence = async (file: Express.Multer.File | undefined, category: (typeof EVIDENCE_CATEGORIES)[number]) => {
    if (!file) throw new HttpError(400, 'FILE_REQUIRED', 'Choose a file to upload.');
    const allowed = EVIDENCE_FILE_TYPES[category];
    const video = sniffVideo(file.buffer);
    const t = video ?? sniffType(file.buffer);
    const label = allowed.map((x) => x.toUpperCase()).join(', ');
    if (!t || !allowed.includes(t.ext)) throw new HttpError(415, 'UNSUPPORTED_FILE', `This section accepts ${label} files (checked from the file content).`);
    if (!video && file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'Documents and photos can be up to 10 MB.');
    if (!video) return storeUpload(storage, file);
    const stored = await storage.put(file.buffer, video.ext);
    return { ...stored, mime: video.mime, name: file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 150) || `recording.${video.ext}` };
  };
  const memberOnly = async (u: AuthUser, visitId: string) => {
    const v = await loadVisitFor(db, u, visitId);
    if (!v.isMember) throw new HttpError(403, 'NOT_ASSIGNED', 'Only an assigned committee member can do this.');
    return v;
  };
  const visitEvent = (t: Db, visitId: string, event: string, actor: string, details: unknown = null) =>
    t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [visitId, event, actor, details === null ? null : JSON.stringify(details)]);
  /**
   * Member response: accept / decline / report a conflict / request withdrawal. One member's response never touches
   * another member's record; transitions are validated inside a transaction that locks the visit and the member row.
   */
  const responseHandler = (fixed?: 'ACCEPTED') =>
    ah(async (req, res) => {
      const u = user(req);
      const b = z
        .object({ response: z.enum(['ACCEPTED', 'REJECTED', 'CONFLICT_REPORTED', 'WITHDRAWAL_REQUESTED']).optional(), reason: z.string().trim().max(1000).optional(), note: z.string().trim().max(1000).optional() })
        .parse(req.body ?? {});
      const to = fixed ?? b.response;
      if (!to) throw new HttpError(400, 'RESPONSE_REQUIRED', 'Choose a response.');
      await memberOnly(u, req.params.visitId);
      const out = await db.tx((t) => respond(t, u, req.params.visitId, to, b.reason ?? b.note ?? null));
      await audit(db, req, `EVC_RESPONSE_${to}`, 'evc_visit', req.params.visitId, { reason: b.reason ?? b.note ?? null });
      res.json({ ok: true, ...out });
    });
  r.post('/visits/:visitId/respond', requireRole('EVC_MEMBER'), responseHandler());
  /** Backwards-compatible alias: acknowledging an invitation means accepting it. */
  r.post('/visits/:visitId/acknowledge', requireRole('EVC_MEMBER'), responseHandler('ACCEPTED'));
  r.post(
    '/visits/:visitId/conflict',
    requireRole('EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const { note } = z.object({ note: z.string().trim().min(5).max(1000) }).parse(req.body);
      await memberOnly(u, req.params.visitId);
      const cur = await db.one<{ response_status: string }>('SELECT response_status FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2', [req.params.visitId, u.id]);
      const to = cur?.response_status === 'ACCEPTED' ? 'WITHDRAWAL_REQUESTED' : 'CONFLICT_REPORTED';
      const out = await db.tx((t) => respond(t, u, req.params.visitId, to, note));
      await audit(db, req, 'EVC_CONFLICT_REPORTED', 'evc_visit', req.params.visitId, { note, recordedAs: to });
      res.json({ ok: true, ...out });
    }),
  );

  r.post(
    '/visits/:visitId/attendance',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z.object({ userId: z.string().uuid().optional(), attendance: z.enum(['PRESENT', 'ABSENT']), note: z.string().trim().max(500).optional() }).parse(req.body);
      const v = await loadVisitFor(db, u, req.params.visitId);
      const target = b.userId ?? u.id;
      if (u.activeRole === 'EVC_MEMBER' && (target !== u.id || !v.isMember)) throw new HttpError(403, 'FORBIDDEN', 'Members record their own attendance.');
      if (u.activeRole === 'REGIONAL_OFFICER' && !v.isRegionalOfficer) throw new HttpError(403, 'FORBIDDEN', 'Outside your region.');
      if (!['IN_PROGRESS', 'COMPLETED'].includes(v.status)) throw new HttpError(409, 'WRONG_STAGE', 'Attendance is recorded once the visit has started.');
      const m = await db.one('SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2 AND active', [v.id, target]);
      if (!m) throw new HttpError(404, 'NOT_FOUND', 'Member not found on this visit.');
      await db.tx(async (t) => {
        await t.query('UPDATE evc_visit_members SET attendance = $3, attendance_recorded_by = $4, attendance_recorded_at = now() WHERE visit_id = $1 AND user_id = $2', [v.id, target, b.attendance, u.id]);
        await visitEvent(t, v.id, 'ATTENDANCE_RECORDED', u.id, { userId: target, attendance: b.attendance, note: b.note });
      });
      await audit(db, req, 'EVC_ATTENDANCE_RECORDED', 'evc_visit', v.id, { userId: target, attendance: b.attendance });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/visits/:visitId/complete',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const { note } = z.object({ note: z.string().trim().min(5).max(2000) }).parse(req.body);
      const v = await loadVisitFor(db, u, req.params.visitId);
      if (!(v.isMember || v.isRegionalOfficer)) throw new HttpError(403, 'FORBIDDEN', 'Only the committee or the Regional Officer can record the visit outcome.');
      if (v.status !== 'IN_PROGRESS') throw new HttpError(409, 'WRONG_STAGE', 'Only a visit that has started can be recorded as completed.');
      const present = await db.one('SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND active AND attendance = $2', [v.id, 'PRESENT']);
      if (!present) throw new HttpError(409, 'NO_ATTENDANCE', 'Record the attendance of at least one committee member first.');
      const due = await getPolicy(db, 'EVC_REPORT_DUE_DAYS');
      await db.tx(async (t) => {
        await t.query("UPDATE evc_visits SET status = 'COMPLETED', completed_at = now(), completed_by = $2, updated_at = now() WHERE id = $1", [v.id, u.id]);
        await t.query("UPDATE deadlines SET status = 'MET', completed_at = now() WHERE subject_type = 'EVC_VISIT_OUTCOME' AND subject_id = $1 AND status <> 'CANCELLED'", [v.id]);
        await t.query(
          `INSERT INTO deadlines(subject_type, subject_id, application_id, visit_id, responsible_role, due_at, source_type, source_reference, policy_key, policy_version)
           VALUES ('EVC_REPORT',$1,$2,$7::uuid,'EVC_MEMBER', now() + ($3 || ' days')::interval, 'AUTHORISED_OPERATIONAL_CONFIGURATION',$4,$5,$6)
           ON CONFLICT (subject_type, subject_id) DO NOTHING`,
          [v.id, v.application_id, String(due.value), policyLabel(due), due.key, due.version, v.id],
        );
        await visitEvent(t, v.id, 'VISIT_COMPLETED', u.id, { note });
        const members = await t.query<{ user_id: string }>('SELECT user_id FROM evc_visit_members WHERE visit_id = $1 AND active', [v.id]);
        for (const m of members)
          await notify(t, { recipientUserId: m.user_id, applicationId: v.application_id, eventType: 'EVC_REPORT_DUE', title: `Report due: ${v.reference_no}`, message: `The visit was recorded as completed. Submit the EVC report within ${due.value} day(s) (${policyLabel(due)}).`, dedupeKey: `visit:${v.id}:report-due` });
        await notifyRegionalOfficers(t, v.application_id, 'EVC_VISIT_COMPLETED', `${v.reference_no}: visit completed`, note, `visit:${v.id}:completed`);
      });
      await audit(db, req, 'EVC_VISIT_COMPLETED', 'evc_visit', v.id, { note });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/visits/:visitId/missed',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const { reason } = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
      const v = await loadVisitFor(db, u, req.params.visitId);
      if (!(v.isMember || v.isRegionalOfficer)) throw new HttpError(403, 'FORBIDDEN', 'Only the committee or the Regional Officer can report a missed visit.');
      if (!['SCHEDULED', 'RESCHEDULED'].includes(v.status)) throw new HttpError(409, 'WRONG_STAGE', 'Only a scheduled visit can be reported as missed.');
      if (new Date(v.scheduled_start) > new Date()) throw new HttpError(409, 'NOT_YET', 'The scheduled time has not been reached; cancel or reschedule instead.');
      await db.tx(async (t) => {
        await t.query("UPDATE evc_visits SET status = 'MISSED', missed_reason = $2, updated_at = now() WHERE id = $1", [v.id, reason]);
        // The officials' time is released; a reschedule re-reserves (and re-checks) their new slot.
        await releaseReservations(t, v.id);
        await t.query("UPDATE deadlines SET status = 'MET', completed_at = now() WHERE subject_type = 'EVC_VISIT_OUTCOME' AND subject_id = $1 AND status <> 'CANCELLED'", [v.id]);
        await visitEvent(t, v.id, 'VISIT_REPORTED_MISSED', u.id, { reason });
        await raiseEscalation(t, { applicationId: v.application_id, visitId: v.id, kind: 'VISIT_MISSED', reason: `Visit reported as missed by ${u.fullName}: ${reason}`, dedupeKey: `visit:${v.id}:missed:${v.scheduled_start}`, raisedBy: { id: u.id, role: u.activeRole } });
        await notifyRegionalOfficers(t, v.application_id, 'EVC_VISIT_MISSED', `${v.reference_no}: visit reported missed`, `${reason}. Reschedule the visit; the case was escalated to the Regulation Bureau for review.`, `visit:${v.id}:missed`);
        await notifyInstitution(t, { id: v.application_id, institution_id: v.institution_id }, 'EVC_VISIT_MISSED', `EVC visit did not take place: ${v.reference_no}`, 'The Regional Officer will arrange a new date. No decision has been taken on your application.', `visit:${v.id}:missed:inst`);
      });
      await audit(db, req, 'EVC_VISIT_MISSED', 'evc_visit', v.id, { reason });
      res.json({ ok: true });
    }),
  );

  r.put(
    '/visits/:visitId/draft',
    requireRole('EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z
        .object({
          sections: z.record(z.enum(REPORT_SECTIONS.map((s) => s.key) as [string, ...string[]]), z.object({ finding: z.enum(SECTION_FINDINGS).optional(), observation: z.string().max(4000).optional() })),
          recommendation: z.string().max(2000).optional(),
          disclosedSummary: z.string().max(4000).optional(),
        })
        .parse(req.body);
      const v = await memberOnly(u, req.params.visitId);
      if (!['IN_PROGRESS', 'COMPLETED'].includes(v.status)) throw new HttpError(409, 'WRONG_STAGE', 'Report drafts are written once the visit has started.');
      await db.query(
        `INSERT INTO evc_report_drafts(visit_id, author_id, sections, recommendation, disclosed_summary) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (visit_id, author_id) DO UPDATE SET sections = EXCLUDED.sections, recommendation = EXCLUDED.recommendation, disclosed_summary = EXCLUDED.disclosed_summary, updated_at = now()`,
        [v.id, u.id, JSON.stringify(b.sections), b.recommendation ?? null, b.disclosedSummary ?? null],
      );
      res.json({ ok: true, savedAt: new Date().toISOString() });
    }),
  );

  r.post(
    '/visits/:visitId/evidence',
    requireRole('EVC_MEMBER'),
    evidenceUpload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const v = await memberOnly(u, req.params.visitId);
      if (!['IN_PROGRESS', 'COMPLETED'].includes(v.status)) throw new HttpError(409, 'WRONG_STAGE', 'Evidence is uploaded once the visit has started.');
      const note = z.string().trim().max(500).optional().parse(req.body?.note || undefined);
      const category = z.enum(EVIDENCE_CATEGORIES).default('OTHER').parse(req.body?.category || undefined);
      if (await db.one('SELECT 1 FROM evc_reports WHERE visit_id = $1', [v.id])) throw new HttpError(409, 'REPORT_SUBMITTED', 'The final report was already submitted; its evidence can no longer change.');
      const f = await storeEvidence(req.file, category);
      const row = await db.one(
        'INSERT INTO evc_report_evidence(visit_id, application_id, file_name, mime_type, size_bytes, sha256, storage_key, note, uploaded_by, category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, file_name, category, uploaded_at',
        [v.id, v.application_id, f.name, f.mime, req.file!.size, f.sha256, f.key, note ?? null, u.id, category],
      );
      await db.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [v.id, 'EVIDENCE_UPLOADED', u.id, JSON.stringify({ file: f.name, category, sha256: f.sha256 })]);
      await audit(db, req, 'EVC_EVIDENCE_UPLOADED', 'evc_visit', v.id, { sha256: f.sha256 });
      res.status(201).json({ evidence: row });
    }),
  );

  /** Inspection update from a committee member while the visit is under way or being reported; the Regional Officer is told. */
  r.post(
    '/visits/:visitId/updates',
    requireRole('EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const { note } = z.object({ note: z.string().trim().min(5).max(2000) }).parse(req.body);
      const v = await memberOnly(u, req.params.visitId);
      if (!['IN_PROGRESS', 'COMPLETED'].includes(v.status)) throw new HttpError(409, 'WRONG_STAGE', 'Inspection updates are posted once the visit has started.');
      const me = await db.one("SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2 AND active AND response_status = 'ACCEPTED'", [v.id, u.id]);
      if (!me) throw new HttpError(403, 'NOT_ASSIGNED', 'Only an accepted member can post inspection updates.');
      const row = await db.tx(async (t) => {
        const e = await t.one<{ id: string; created_at: string }>('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4) RETURNING id, created_at', [v.id, 'INSPECTION_UPDATE', u.id, JSON.stringify({ note })]);
        await notifyRegionalOfficers(t, v.application_id, 'EVC_INSPECTION_UPDATE', `${v.reference_no}: inspection update`, `${u.fullName}: ${note}`, `visit:${v.id}:update:${e!.id}`);
        return e;
      });
      await audit(db, req, 'EVC_INSPECTION_UPDATE', 'evc_visit', v.id, { note });
      res.status(201).json({ update: row });
    }),
  );

  r.get(
    '/evidence/:id/download',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER', 'REGULATION_BUREAU', 'SUPERVISOR', 'DECISION_AUTHORITY'),
    ah(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Evidence not found.');
      const x = await db.one<{ visit_id: string; storage_key: string; file_name: string; mime_type: string }>('SELECT visit_id, storage_key, file_name, mime_type FROM evc_report_evidence WHERE id = $1', [req.params.id]);
      if (!x) throw new HttpError(404, 'NOT_FOUND', 'Evidence not found.');
      await loadVisitFor(db, user(req), x.visit_id);
      await audit(db, req, 'EVC_EVIDENCE_DOWNLOADED', 'evc_evidence', req.params.id, {});
      sendFile(res, await storage.read(x.storage_key), x.file_name, x.mime_type, req.query.inline === '1');
    }),
  );

  // ------------------------------------------------------------------ escalations seen by the Regional Officer / committee
  r.post(
    '/visits/:visitId/escalate',
    requireRole('REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z.object({ kind: z.enum(['SCHEDULING_DISPUTE', 'OTHER']), reason: z.string().trim().min(10).max(2000) }).parse(req.body);
      const v = await loadVisitFor(db, u, req.params.visitId);
      if (!v.isRegionalOfficer) throw new HttpError(403, 'FORBIDDEN', 'Outside your region.');
      const id = await raiseEscalation(db, { applicationId: v.application_id, visitId: v.id, kind: b.kind, reason: b.reason, dedupeKey: `visit:${v.id}:manual:${Date.now()}`, raisedBy: { id: u.id, role: u.activeRole } });
      await audit(db, req, 'ESCALATION_RAISED', 'escalation', id, b);
      res.status(201).json({ id });
    }),
  );

  r.get(
    '/escalations',
    requireRole('REGIONAL_OFFICER', 'EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const rows = await db.query(
        `SELECT e.id, e.reference_no, e.kind, e.status, e.reason, e.created_at, e.updated_at, a.reference_no AS application_ref, a.id AS application_id,
                (SELECT x.note FROM escalation_actions x WHERE x.escalation_id = e.id AND x.action = 'REQUEST_EXPLANATION' ORDER BY x.id DESC LIMIT 1) AS explanation_request
         FROM escalations e JOIN applications a ON a.id = e.application_id
         WHERE ($1 = 'REGIONAL_OFFICER' AND ${REGION_SCOPE_SQL})
            OR ($1 = 'EVC_MEMBER' AND EXISTS (SELECT 1 FROM evc_visit_members m WHERE m.visit_id = e.visit_id AND m.user_id = $2))
            OR e.owner_id = $2 OR EXISTS (SELECT 1 FROM escalation_actions x WHERE x.escalation_id = e.id AND x.assigned_to = $2)
         ORDER BY (e.status IN ('RESOLVED','CLOSED')), e.created_at DESC`,
        [u.activeRole, u.id],
      );
      res.json({ escalations: rows });
    }),
  );

  r.post(
    '/escalations/:id/respond',
    requireRole('REGIONAL_OFFICER', 'EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const { note } = z.object({ note: z.string().trim().min(5).max(4000) }).parse(req.body);
      const e = await db.one<{ id: string; reference_no: string; visit_id: string | null; application_id: string; status: string; owner_id: string | null }>('SELECT * FROM escalations WHERE id = $1', [req.params.id]);
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'Escalation not found.');
      const allowed =
        e.owner_id === u.id ||
        (u.activeRole === 'REGIONAL_OFFICER' && !!(await db.one(`SELECT 1 FROM applications a WHERE a.id = $1 AND ${REGION_SCOPE_SQL}`, [e.application_id, u.id]))) ||
        (u.activeRole === 'EVC_MEMBER' && !!e.visit_id && !!(await db.one('SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2', [e.visit_id, u.id]))) ||
        !!(await db.one('SELECT 1 FROM escalation_actions WHERE escalation_id = $1 AND assigned_to = $2', [e.id, u.id]));
      if (!allowed) throw new HttpError(404, 'NOT_FOUND', 'Escalation not found.');
      if (['RESOLVED', 'CLOSED'].includes(e.status)) throw new HttpError(409, 'CLOSED', 'This escalation is already resolved.');
      await db.tx(async (t) => {
        await t.query('INSERT INTO escalation_actions(escalation_id, action, note, actor_id, actor_role) VALUES ($1,$2,$3,$4,$5)', [e.id, 'RESPONSE', note, u.id, u.activeRole]);
        await t.query('UPDATE escalations SET updated_at = now() WHERE id = $1', [e.id]);
        const bureau = await t.query<{ user_id: string }>("SELECT user_id FROM user_roles WHERE role = 'REGULATION_BUREAU'");
        for (const b of bureau) await notify(t, { recipientUserId: b.user_id, applicationId: e.application_id, eventType: 'ESCALATION_RESPONSE', title: `Response on ${e.reference_no}`, message: `${u.fullName}: ${note}`, dedupeKey: `esc:${e.id}:resp:${Date.now()}` });
      });
      await audit(db, req, 'ESCALATION_RESPONSE', 'escalation', e.id, {});
      res.json({ ok: true, actions: Object.keys(ESCALATION_ACTIONS) });
    }),
  );

  return r;
}
