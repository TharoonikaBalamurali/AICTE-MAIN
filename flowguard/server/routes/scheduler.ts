/**
 * Regional Officer EVC scheduler: dashboard data, per-application scheduling context, live availability with
 * alternative slots, and recorded member unavailability. Reads only; every write goes through the workflow
 * action endpoint (`/api/official/applications/:id/actions/...`) so it is authorised, transactional and audited.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { SEATS, SEAT_LABEL, type Seat } from '../evc/composition.ts';
import { alternativeSlots, assignmentStatus, availability, checkComposition, HOLDING, NO_CAPACITY_MESSAGE } from '../evc/service.ts';
import { ah, audit, HttpError, requireRole, user, type AuthUser } from '../http.ts';
import { getPolicy } from '../policy.ts';
import { loadAppFor, REGION_SCOPE_SQL } from '../services.ts';

const ACTIVE_VISIT = "('PROPOSED','SCHEDULED','RESCHEDULED','IN_PROGRESS','COMPLETED','MISSED')";

/** Assignment status plus the reason a visit needs attention (panel member busy, declined, conflict reported). */
async function visitState(db: Db, v: { id: string; status: string; scheduled_start: string; scheduled_end: string | null; invitations_sent_at: string | null; draft_panel: Array<{ expertId: string; seat: Seat }> | null }) {
  const members = await db.query<{ active: boolean; response_status: string; full_name: string }>(
    'SELECT m.active, m.response_status, uu.full_name FROM evc_visit_members m JOIN users uu ON uu.id = m.user_id WHERE m.visit_id = $1',
    [v.id],
  );
  const reports = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM evc_reports WHERE visit_id = $1', [v.id]);
  const status = assignmentStatus(v, members, reports?.n ?? 0);
  const conflicts: string[] = [];
  for (const m of members.filter((x) => x.active)) {
    if (m.response_status === 'REJECTED') conflicts.push(`${m.full_name} declined`);
    if (m.response_status === 'CONFLICT_REPORTED') conflicts.push(`${m.full_name} reported a conflict`);
    if (m.response_status === 'WITHDRAWAL_REQUESTED') conflicts.push(`${m.full_name} requested withdrawal`);
  }
  if (!v.invitations_sent_at && v.draft_panel?.length && v.scheduled_end && ['PROPOSED'].includes(v.status)) {
    const av = await availability(db, v.scheduled_start, v.scheduled_end, v.id);
    for (const p of v.draft_panel) {
      const o = av.officials.find((x) => x.id === p.expertId);
      if (o && o.status !== 'AVAILABLE') conflicts.push(`${o.full_name}: ${o.reason}`);
    }
  }
  return { status, conflicts, members: members.length };
}

const scopeClause = (u: AuthUser) => (u.activeRole === 'REGIONAL_OFFICER' ? REGION_SCOPE_SQL : '($2::uuid IS NOT NULL)');

export function schedulerRouter(db: Db) {
  const r = Router();

  r.get(
    '/',
    requireRole('REGIONAL_OFFICER', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (req, res) => {
      const u = user(req);
      const q = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).parse(req.query);
      const apps = await db.query<Record<string, any>>(
        `SELECT a.id, a.reference_no, a.status, a.category_code, i.name AS institution_name, i.district, i.state,
                h.created_at AS forwarded_on, fb.full_name AS forwarded_by
         FROM applications a JOIN institutions i ON i.id = a.institution_id
         LEFT JOIN LATERAL (SELECT * FROM evc_handoffs x WHERE x.application_id = a.id ORDER BY x.created_at DESC LIMIT 1) h ON true
         LEFT JOIN users fb ON fb.id = h.approved_by
         WHERE a.status IN ('AWAITING_EVC_SCHEDULING','EVC_SCHEDULED','EVC_IN_PROGRESS') AND $1::text IS NOT NULL AND ${scopeClause(u)}
         ORDER BY h.created_at NULLS LAST`,
        ['x', u.id],
      );
      const out = [];
      for (const a of apps) {
        const v = await db.one<any>(`SELECT id, status, mode, scheduled_start, scheduled_end, meeting_link, invitations_sent_at, draft_panel FROM evc_visits WHERE application_id = $1 AND status IN ${ACTIVE_VISIT} ORDER BY scheduled_at DESC LIMIT 1`, [a.id]);
        const st = v ? await visitState(db, v) : null;
        out.push({ ...a, visit: v ? { id: v.id, status: v.status, mode: v.mode, start: v.scheduled_start, end: v.scheduled_end, meetingLink: v.meeting_link } : null, assignmentStatus: st?.status ?? 'NOT_SCHEDULED', conflicts: st?.conflicts ?? [] });
      }
      const from = q.from ?? new Date(Date.now() - 7 * 86400000).toISOString();
      const to = q.to ?? new Date(Date.now() + 60 * 86400000).toISOString();
      const visitRows = await db.query<any>(
        `SELECT v.id, v.application_id, v.status, v.mode, v.scheduled_start, v.scheduled_end, v.invitations_sent_at, v.draft_panel, a.reference_no, i.name AS institution_name
         FROM evc_visits v JOIN applications a ON a.id = v.application_id JOIN institutions i ON i.id = a.institution_id
         WHERE v.status <> 'CANCELLED' AND v.scheduled_start < $3 AND coalesce(v.scheduled_end, v.scheduled_start) >= $4 AND $1::text IS NOT NULL AND ${scopeClause(u)}
         ORDER BY v.scheduled_start`,
        ['x', u.id, to, from],
      );
      const visits = [];
      for (const v of visitRows) {
        const st = await visitState(db, v);
        visits.push({ id: v.id, applicationId: v.application_id, referenceNo: v.reference_no, institution: v.institution_name, status: v.status, mode: v.mode, start: v.scheduled_start, end: v.scheduled_end, assignmentStatus: st.status, conflicts: st.conflicts });
      }
      res.json({ applications: out, visits, range: { from, to } });
    }),
  );

  /** Everything the "Schedule EVC visit" screen needs, computed from persisted records. */
  r.get(
    '/applications/:id',
    requireRole('REGIONAL_OFFICER', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      // These three are independent of each other (only keyed off app.id/app.institution_id), so
      // run concurrently rather than paying three serial round trips.
      const [institution, handoff, v] = await Promise.all([
        db.one('SELECT name, aicte_institution_id, district, state, region_code FROM institutions WHERE id = $1', [app.institution_id]),
        db.one('SELECT h.created_at, h.note, uu.full_name AS forwarded_by FROM evc_handoffs h JOIN users uu ON uu.id = h.approved_by WHERE h.application_id = $1 ORDER BY h.created_at DESC LIMIT 1', [app.id]),
        db.one<any>(`SELECT * FROM evc_visits WHERE application_id = $1 AND status IN ${ACTIVE_VISIT} ORDER BY scheduled_at DESC LIMIT 1`, [app.id]),
      ]);
      const members = v
        ? await db.query<any>(
            `SELECT m.user_id, m.expert_id, m.seat, m.response_status, m.responded_at, m.rejection_reason, m.conflict_note, m.active, m.removed_reason, m.attendance,
                    lower(m.reserved_period) AS reserved_from, upper(m.reserved_period) AS reserved_to,
                    e.member_code, e.full_name, e.designation_level, e.discipline, e.organisation
             FROM evc_visit_members m LEFT JOIN evc_experts e ON e.id = m.expert_id WHERE m.visit_id = $1 ORDER BY m.active DESC, m.assigned_at`,
            [v.id],
          )
        : [];
      const panel: Array<{ expertId: string; seat: Seat }> = v?.invitations_sent_at
        ? members.filter((m: any) => m.active && HOLDING.includes(m.response_status) && m.expert_id).map((m: any) => ({ expertId: m.expert_id, seat: m.seat }))
        : (v?.draft_panel ?? []);
      const av = v?.scheduled_end ? await availability(db, v.scheduled_start, v.scheduled_end, v.id) : null;
      const alternatives = v?.scheduled_end ? await alternativeSlots(db, v.scheduled_start, v.scheduled_end, v.id, panel) : [];
      const composition = panel.length ? await checkComposition(db, panel) : null;
      const reports = v ? await db.one<{ n: number }>('SELECT count(*)::int AS n FROM evc_reports WHERE visit_id = $1', [v.id]) : null;
      const history = v ? await db.query('SELECT h.*, uu.full_name AS actor_name FROM evc_schedule_history h LEFT JOIN users uu ON uu.id = h.actor_id WHERE h.visit_id = $1 ORDER BY h.id DESC', [v.id]) : [];
      const st = v ? await visitState(db, v) : null;
      res.json({
        application: { id: app.id, reference_no: app.reference_no, status: app.status, category_code: app.category_code },
        institution,
        handoff,
        visit: v,
        members,
        panel,
        availability: av,
        alternatives,
        composition: composition ? { valid: composition.valid, findings: composition.findings } : null,
        assignmentStatus: st?.status ?? 'NOT_SCHEDULED',
        conflicts: st?.conflicts ?? [],
        reportCount: reports?.n ?? 0,
        history,
        seats: SEATS.map((s) => ({ seat: s, label: SEAT_LABEL[s] })),
        canEdit: u.activeRole === 'REGIONAL_OFFICER',
        policy: { bufferMinutes: (await getPolicy(db, 'EVC_SCHEDULING_BUFFER_MINUTES')).value },
      });
    }),
  );

  /** Live availability for a candidate slot (no side effects). */
  r.post(
    '/availability',
    requireRole('REGIONAL_OFFICER', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (req, res) => {
      const b = z
        .object({
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
          visitId: z.string().uuid().optional(),
          panel: z.array(z.object({ expertId: z.string().uuid(), seat: z.enum(SEATS) })).max(10).default([]),
        })
        .parse(req.body);
      const av = await availability(db, b.start, b.end, b.visitId ?? null);
      const alternatives = await alternativeSlots(db, b.start, b.end, b.visitId ?? null, b.panel);
      const panelStatus = b.panel.map((p) => {
        const o = av.officials.find((x) => x.id === p.expertId);
        return { ...p, status: o?.status ?? 'UNKNOWN', reason: o?.reason ?? 'Not in registry' };
      });
      const panelConflict = panelStatus.some((p) => p.status !== 'AVAILABLE');
      res.json({ ...av, alternatives, panelStatus, panelConflict, message: !av.capacity.satisfiable ? NO_CAPACITY_MESSAGE : null });
    }),
  );

  // ------------------------------------------------------------------ recorded unavailability
  r.get(
    '/unavailability',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const rows = await db.query(
        `SELECT x.id, x.expert_id, x.starts_at, x.ends_at, x.reason, x.created_at, e.full_name, e.member_code FROM evc_member_unavailability x JOIN evc_experts e ON e.id = x.expert_id
         WHERE x.withdrawn_at IS NULL AND x.ends_at > now() AND ($1::uuid IS NULL OR e.user_id = $1) ORDER BY x.starts_at`,
        [u.activeRole === 'EVC_MEMBER' ? u.id : null],
      );
      res.json({ unavailability: rows });
    }),
  );
  r.post(
    '/unavailability',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z.object({ expertId: z.string().uuid().optional(), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().trim().min(3).max(500) }).parse(req.body);
      if (!(new Date(b.endsAt) > new Date(b.startsAt))) throw new HttpError(400, 'INVALID_TIME_RANGE', 'The end must be after the start.');
      const expert =
        u.activeRole === 'EVC_MEMBER'
          ? await db.one<{ id: string }>('SELECT id FROM evc_experts WHERE user_id = $1', [u.id])
          : b.expertId
            ? await db.one<{ id: string }>('SELECT id FROM evc_experts WHERE id = $1', [b.expertId])
            : null;
      if (!expert) throw new HttpError(404, 'NOT_FOUND', 'Registry record not found.');
      if (u.activeRole === 'EVC_MEMBER' && b.expertId && b.expertId !== expert.id) throw new HttpError(403, 'FORBIDDEN', 'Members record their own unavailability.');
      const row = await db.one('INSERT INTO evc_member_unavailability(expert_id, starts_at, ends_at, reason, recorded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [expert.id, b.startsAt, b.endsAt, b.reason, u.id]);
      await audit(db, req, 'EVC_UNAVAILABILITY_RECORDED', 'evc_expert', expert.id, b);
      res.status(201).json({ unavailability: row, note: 'Existing invitations are not changed automatically; the Regional Officer decides any replacement.' });
    }),
  );
  r.delete(
    '/unavailability/:id',
    requireRole('EVC_MEMBER', 'REGIONAL_OFFICER'),
    ah(async (req, res) => {
      const u = user(req);
      const row = await db.one<{ id: string; user_id: string | null }>('SELECT x.id, e.user_id FROM evc_member_unavailability x JOIN evc_experts e ON e.id = x.expert_id WHERE x.id = $1 AND x.withdrawn_at IS NULL', [req.params.id]);
      if (!row || (u.activeRole === 'EVC_MEMBER' && row.user_id !== u.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      await db.query('UPDATE evc_member_unavailability SET withdrawn_at = now() WHERE id = $1', [row.id]);
      await audit(db, req, 'EVC_UNAVAILABILITY_WITHDRAWN', 'evc_unavailability', row.id, {});
      res.json({ ok: true });
    }),
  );

  return r;
}
