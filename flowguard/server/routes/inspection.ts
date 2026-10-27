/**
 * Standalone institutional inspection (APH Ch. II §2.3.5(a)): "Institutions at random shall be
 * subject to EVC (Inspection) for the fulfilment of the norms of the Approval Process Handbook."
 *
 * Deliberately separate from the application-scoped EVC (server/routes/evc.ts, evc_visits): this
 * targets an institution directly, with no pending application. Reuses the same committee-composition
 * rules (server/evc/composition.ts) and expert registry (evc_experts) as the application EVC.
 *
 * FlowGuard design, like the Regulation Bureau escalation queue: the APH names this inspection power
 * but prescribes no scheduling procedure, outcome states or escalation thresholds for it. This mirrors
 * the application-EVC and compliance-obligation lifecycles already in use elsewhere in FlowGuard.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import type { Expert } from '../evc/composition.ts';
import { validateComposition, type Seat } from '../evc/composition.ts';
import { ah, audit, HttpError, requireRole, user } from '../http.ts';
import { notify, notifyRoleOrAssignee } from '../notify.ts';
import { MAX_UPLOAD_BYTES, type Storage } from '../storage.ts';
import { storeUpload } from './institution.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

const MANAGE_ROLES = ['REGIONAL_OFFICER', 'REGULATION_BUREAU', 'SUPERVISOR'] as const;
const OPEN_STATUSES = ['PROPOSED', 'SCHEDULED', 'IN_PROGRESS'];

const memberSpec = z.object({ expertId: z.string().uuid(), seat: z.enum(['ACADEMICIAN', 'EXPERT', 'ARCHITECT_PLANNING', 'CO_OPTED']) });

interface InspectionRow {
  id: string;
  reference_no: string;
  institution_id: string;
  reason: string;
  mode: string;
  scheduled_start: string | null;
  status: string;
  outcome_note: string | null;
  institution_region_code?: string | null;
}

/** Regional Officers act only on institutions in their configured regions; the Bureau/Supervisor see all. */
async function loadInspectionFor(db: Db, u: { id: string; activeRole: string }, id: string): Promise<InspectionRow> {
  const row = await db.one<InspectionRow>(
    `SELECT ins.*, i.region_code AS institution_region_code FROM institution_inspections ins JOIN institutions i ON i.id = ins.institution_id WHERE ins.id = $1`,
    [id],
  );
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Inspection not found.');
  if (u.activeRole === 'REGIONAL_OFFICER') {
    const inRegion = await db.one('SELECT 1 FROM user_regions WHERE user_id = $1 AND region_code = $2', [u.id, row.institution_region_code]);
    if (!inRegion) throw new HttpError(403, 'OUT_OF_REGION', 'This institution is not in one of your configured regions.');
  }
  return row;
}

async function validateMembers(db: Db, members: Array<{ expertId: string; seat: Seat }>) {
  if (members.length === 0) return { valid: false, findings: [{ id: 'NO_MEMBERS', outcome: 'HUMAN_REVIEW_REQUIRED' as const, blocking: true, message: 'No committee members proposed yet.', reference: 'Portal system policy' }] };
  const experts = await db.query<Expert>('SELECT * FROM evc_experts WHERE id = ANY($1)', [members.map((m) => m.expertId)]);
  const byId = new Map(experts.map((e) => [e.id, e]));
  const missing = members.filter((m) => !byId.has(m.expertId));
  if (missing.length) throw new HttpError(400, 'UNKNOWN_EXPERT', 'One or more proposed members are not in the expert registry.');
  return validateComposition(
    members.map((m) => ({ expert: byId.get(m.expertId)!, seat: m.seat })),
    { deemedUniversity: null },
  );
}

export function inspectionRouter(db: Db, storage: Storage) {
  const r = Router();

  r.get(
    '/inspections',
    requireRole(...MANAGE_ROLES),
    ah(async (req, res) => {
      const u = user(req);
      const rows = await db.query<Record<string, any>>(
        `SELECT ins.*, i.name AS institution_name, i.aicte_institution_id, i.region_code
         FROM institution_inspections ins JOIN institutions i ON i.id = ins.institution_id
         WHERE $1::text IS NULL OR EXISTS (SELECT 1 FROM user_regions ur WHERE ur.user_id = $2 AND ur.region_code = i.region_code)
         ORDER BY (ins.status = ANY($3)) DESC, ins.scheduled_start NULLS LAST, ins.created_at DESC`,
        [u.activeRole === 'REGIONAL_OFFICER' ? u.id : null, u.id, OPEN_STATUSES],
      );
      res.json({ inspections: rows });
    }),
  );

  r.post(
    '/inspections',
    requireRole(...MANAGE_ROLES),
    ah(async (req, res) => {
      const u = user(req);
      const body = z.object({ institutionId: z.string().uuid(), reason: z.string().trim().min(10).max(2000), mode: z.enum(['ONLINE', 'PHYSICAL']) }).parse(req.body);
      const inst = await db.one<{ id: string; region_code: string | null }>('SELECT id, region_code FROM institutions WHERE id = $1', [body.institutionId]);
      if (!inst) throw new HttpError(404, 'NOT_FOUND', 'Institution not found.');
      if (u.activeRole === 'REGIONAL_OFFICER') {
        const inRegion = await db.one('SELECT 1 FROM user_regions WHERE user_id = $1 AND region_code = $2', [u.id, inst.region_code]);
        if (!inRegion) throw new HttpError(403, 'OUT_OF_REGION', 'This institution is not in one of your configured regions.');
      }
      const seq = await db.one<{ n: string }>("SELECT nextval('inspection_ref_seq')::text AS n");
      const ref = `FG-INSP-${seq!.n.padStart(6, '0')}`;
      const row = await db.one<InspectionRow>(
        'INSERT INTO institution_inspections(reference_no, institution_id, reason, mode, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [ref, inst.id, body.reason, body.mode, u.id],
      );
      await db.query('INSERT INTO inspection_events(inspection_id, event, details, actor_id) VALUES ($1,$2,$3,$4)', [row!.id, 'CREATED', JSON.stringify({ reason: body.reason }), u.id]);
      await audit(db, req, 'INSPECTION_CREATED', 'inspection', row!.id, { institutionId: inst.id }, inst.id);
      res.status(201).json({ inspection: row });
    }),
  );

  r.get(
    '/inspections/:id',
    requireRole(...MANAGE_ROLES, 'EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const insp = u.activeRole === 'EVC_MEMBER' ? await db.one<InspectionRow>('SELECT * FROM institution_inspections WHERE id = $1', [req.params.id]) : await loadInspectionFor(db, u, req.params.id);
      if (!insp) throw new HttpError(404, 'NOT_FOUND', 'Inspection not found.');
      const [institution, members, events, report] = await Promise.all([
        db.one('SELECT name, aicte_institution_id, address, district, state, pincode, region_code FROM institutions WHERE id = $1', [insp.institution_id]),
        db.query(
          `SELECT m.id, m.expert_id, m.seat, m.response_status, m.active, m.assigned_at, m.responded_at, e.member_code, e.full_name, e.designation_level, e.organisation
           FROM inspection_members m JOIN evc_experts e ON e.id = m.expert_id WHERE m.inspection_id = $1 ORDER BY m.active DESC, m.assigned_at`,
          [insp.id],
        ),
        db.query('SELECT e.event, e.details, e.created_at, uu.full_name AS actor_name FROM inspection_events e LEFT JOIN users uu ON uu.id = e.actor_id WHERE e.inspection_id = $1 ORDER BY e.id DESC', [insp.id]),
        db.one('SELECT observations, recommendation, evidence_name, submitted_at FROM inspection_reports WHERE inspection_id = $1', [insp.id]),
      ]);
      if (u.activeRole === 'EVC_MEMBER') {
        const mine = await db.one('SELECT 1 FROM inspection_members WHERE inspection_id = $1 AND user_id = $2 AND active', [insp.id, u.id]);
        if (!mine) throw new HttpError(403, 'NOT_ASSIGNED', 'Only an assigned committee member can view this inspection.');
      }
      res.json({ inspection: insp, institution, members, events, report });
    }),
  );

  r.post(
    '/inspections/:id/members',
    requireRole(...MANAGE_ROLES),
    ah(async (req, res) => {
      const u = user(req);
      const insp = await loadInspectionFor(db, u, req.params.id);
      if (!OPEN_STATUSES.includes(insp.status)) throw new HttpError(409, 'NOT_OPEN', 'This inspection is no longer open for committee changes.');
      const body = z.object({ members: z.array(memberSpec).max(6) }).parse(req.body);
      const check = await validateMembers(db, body.members);
      if (!check.valid) return res.status(422).json({ valid: false, findings: check.findings });
      const experts = await db.query<{ id: string; user_id: string | null }>('SELECT id, user_id FROM evc_experts WHERE id = ANY($1)', [body.members.map((m) => m.expertId)]);
      const userById = new Map(experts.map((e) => [e.id, e.user_id]));
      await db.tx(async (t) => {
        await t.query('UPDATE inspection_members SET active = false WHERE inspection_id = $1', [insp.id]);
        for (const m of body.members) {
          await t.query(
            `INSERT INTO inspection_members(inspection_id, expert_id, user_id, seat) VALUES ($1,$2,$3,$4)
             ON CONFLICT (inspection_id, expert_id) DO UPDATE SET active = true, seat = EXCLUDED.seat, response_status = 'INVITED', responded_at = NULL`,
            [insp.id, m.expertId, userById.get(m.expertId) ?? null, m.seat],
          );
        }
        await t.query('INSERT INTO inspection_events(inspection_id, event, details, actor_id) VALUES ($1,$2,$3,$4)', [insp.id, 'MEMBERS_ASSIGNED', JSON.stringify({ members: body.members }), u.id]);
      });
      for (const m of body.members) {
        const uid = userById.get(m.expertId);
        if (uid) await notify(db, { recipientUserId: uid, eventType: 'INSPECTION_INVITED', title: `Inspection ${insp.reference_no}: committee invitation`, message: `You have been proposed for an institutional inspection (${insp.reason}).`, dedupeKey: `insp:${insp.id}:invite:${m.expertId}` });
      }
      await audit(db, req, 'INSPECTION_MEMBERS_ASSIGNED', 'inspection', insp.id, { members: body.members }, insp.institution_id);
      res.json({ ok: true, findings: check.findings });
    }),
  );

  r.post(
    '/inspections/:id/schedule',
    requireRole(...MANAGE_ROLES),
    ah(async (req, res) => {
      const u = user(req);
      const insp = await loadInspectionFor(db, u, req.params.id);
      if (!OPEN_STATUSES.includes(insp.status)) throw new HttpError(409, 'NOT_OPEN', 'This inspection is no longer open.');
      const body = z.object({ scheduledStart: z.string().datetime() }).parse(req.body);
      const active = await db.query<{ expert_id: string; seat: Seat }>('SELECT expert_id, seat FROM inspection_members WHERE inspection_id = $1 AND active', [insp.id]);
      const check = await validateMembers(db, active.map((m) => ({ expertId: m.expert_id, seat: m.seat })));
      if (!check.valid) return res.status(422).json({ valid: false, findings: check.findings });
      await db.query("UPDATE institution_inspections SET status = 'SCHEDULED', scheduled_start = $2, updated_at = now() WHERE id = $1", [insp.id, body.scheduledStart]);
      await db.query('INSERT INTO inspection_events(inspection_id, event, details, actor_id) VALUES ($1,$2,$3,$4)', [insp.id, 'SCHEDULED', JSON.stringify({ scheduledStart: body.scheduledStart }), u.id]);
      const members = await db.query<{ user_id: string | null }>('SELECT user_id FROM inspection_members WHERE inspection_id = $1 AND active', [insp.id]);
      for (const m of members) if (m.user_id) await notify(db, { recipientUserId: m.user_id, eventType: 'INSPECTION_SCHEDULED', title: `Inspection ${insp.reference_no} scheduled`, message: `Scheduled for ${body.scheduledStart}.`, dedupeKey: `insp:${insp.id}:scheduled` });
      await notifyRoleOrAssignee(db, 'REGULATION_BUREAU', null, 'INSPECTION_SCHEDULED', `Inspection ${insp.reference_no} scheduled`, `Standalone inspection scheduled for ${body.scheduledStart}.`, `insp:${insp.id}:bureau:scheduled`);
      await audit(db, req, 'INSPECTION_SCHEDULED', 'inspection', insp.id, { scheduledStart: body.scheduledStart }, insp.institution_id);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/inspections/:id/respond',
    requireRole('EVC_MEMBER'),
    ah(async (req, res) => {
      const u = user(req);
      const body = z.object({ response: z.enum(['ACCEPTED', 'DECLINED']), reason: z.string().trim().max(1000).optional() }).parse(req.body);
      const m = await db.one<{ id: string; inspection_id: string }>('SELECT id, inspection_id FROM inspection_members WHERE inspection_id = $1 AND user_id = $2 AND active', [req.params.id, u.id]);
      if (!m) throw new HttpError(403, 'NOT_ASSIGNED', 'You are not an assigned member of this inspection.');
      await db.query("UPDATE inspection_members SET response_status = $2, responded_at = now() WHERE id = $1", [m.id, body.response]);
      await db.query('INSERT INTO inspection_events(inspection_id, event, details, actor_id) VALUES ($1,$2,$3,$4)', [m.inspection_id, 'MEMBER_RESPONDED', JSON.stringify(body), u.id]);
      await notifyRoleOrAssignee(db, 'REGIONAL_OFFICER', null, 'INSPECTION_RESPONSE', 'Inspection committee response', `${u.fullName} ${body.response.toLowerCase()} the invitation.`, `insp:${m.inspection_id}:resp:${m.id}:${Date.now()}`);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/inspections/:id/outcome',
    requireRole(...MANAGE_ROLES),
    ah(async (req, res) => {
      const u = user(req);
      const insp = await loadInspectionFor(db, u, req.params.id);
      if (!['SCHEDULED', 'IN_PROGRESS'].includes(insp.status)) throw new HttpError(409, 'NOT_SCHEDULED', 'Only a scheduled inspection can have an outcome recorded.');
      const body = z.object({ outcome: z.enum(['COMPLETED', 'MISSED']), note: z.string().trim().min(3).max(2000) }).parse(req.body);
      await db.query('UPDATE institution_inspections SET status = $2, outcome_note = $3, updated_at = now() WHERE id = $1', [insp.id, body.outcome, body.note]);
      await db.query('INSERT INTO inspection_events(inspection_id, event, details, actor_id) VALUES ($1,$2,$3,$4)', [insp.id, `OUTCOME_${body.outcome}`, JSON.stringify({ note: body.note }), u.id]);
      await audit(db, req, `INSPECTION_${body.outcome}`, 'inspection', insp.id, { note: body.note }, insp.institution_id);
      if (body.outcome === 'MISSED') await notifyRoleOrAssignee(db, 'REGULATION_BUREAU', null, 'INSPECTION_MISSED', `Inspection ${insp.reference_no} missed`, body.note, `insp:${insp.id}:missed`);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/inspections/:id/report',
    requireRole('EVC_MEMBER'),
    upload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const insp = await db.one<InspectionRow>('SELECT * FROM institution_inspections WHERE id = $1', [req.params.id]);
      if (!insp) throw new HttpError(404, 'NOT_FOUND', 'Inspection not found.');
      const mine = await db.one('SELECT 1 FROM inspection_members WHERE inspection_id = $1 AND user_id = $2 AND active', [insp.id, u.id]);
      if (!mine) throw new HttpError(403, 'NOT_ASSIGNED', 'Only an assigned committee member can submit a report.');
      if (insp.status !== 'COMPLETED') throw new HttpError(409, 'NOT_COMPLETED', 'A report can be submitted only after the inspection outcome is recorded as completed.');
      const body = z.object({ observations: z.string().trim().min(10).max(10000), recommendation: z.string().trim().min(10).max(5000) }).parse(req.body);
      const stored = req.file ? await storeUpload(storage, req.file) : null;
      const row = await db.one<{ id: string }>(
        'INSERT INTO inspection_reports(inspection_id, observations, recommendation, evidence_storage_key, evidence_name, submitted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [insp.id, body.observations, body.recommendation, stored?.key ?? null, stored?.name ?? null, u.id],
      );
      await db.query('INSERT INTO inspection_events(inspection_id, event, details, actor_id) VALUES ($1,$2,$3,$4)', [insp.id, 'REPORT_SUBMITTED', JSON.stringify({ reportId: row!.id }), u.id]);
      await audit(db, req, 'INSPECTION_REPORT_SUBMITTED', 'inspection', insp.id, { reportId: row!.id }, insp.institution_id);
      await notifyRoleOrAssignee(db, 'REGULATION_BUREAU', null, 'INSPECTION_REPORT', `Inspection ${insp.reference_no} report submitted`, body.recommendation.slice(0, 200), `insp:${insp.id}:report`);
      res.status(201).json({ ok: true });
    }),
  );

  r.post(
    '/inspections/:id/cancel',
    requireRole(...MANAGE_ROLES),
    ah(async (req, res) => {
      const u = user(req);
      const insp = await loadInspectionFor(db, u, req.params.id);
      if (!OPEN_STATUSES.includes(insp.status)) throw new HttpError(409, 'NOT_OPEN', 'This inspection is no longer open.');
      const body = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
      await db.query("UPDATE institution_inspections SET status = 'CANCELLED', outcome_note = $2, updated_at = now() WHERE id = $1", [insp.id, body.reason]);
      await db.query('INSERT INTO inspection_events(inspection_id, event, details, actor_id) VALUES ($1,$2,$3,$4)', [insp.id, 'CANCELLED', JSON.stringify({ reason: body.reason }), u.id]);
      await audit(db, req, 'INSPECTION_CANCELLED', 'inspection', insp.id, { reason: body.reason }, insp.institution_id);
      res.json({ ok: true });
    }),
  );

  return r;
}
