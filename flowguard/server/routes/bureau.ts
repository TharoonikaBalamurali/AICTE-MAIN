/**
 * Regulation Bureau workspace: escalation queue and cross-region oversight.
 * FlowGuard design — the APH names the Regulation Bureau (Ch. I §1.10(a)) but does not define this queue.
 * Bureau actions record follow-up only; they never change an application's workflow state or a decision.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { ESCALATION_ACTIONS, ESCALATION_KINDS, ESCALATION_STATUSES, KIND_LABEL } from '../escalations.ts';
import { ah, audit, HttpError, requireRole, user } from '../http.ts';
import { notify } from '../notify.ts';
import { STATE_LABELS, stageOf, type AppState } from '../workflow/stateMachine.ts';

export function bureauRouter(db: Db) {
  const r = Router();
  r.use(requireRole('REGULATION_BUREAU', 'SUPERVISOR'));

  r.get(
    '/escalations',
    ah(async (req, res) => {
      const q = z.object({ status: z.string().max(40).optional(), kind: z.string().max(40).optional(), region: z.string().max(40).optional(), open: z.enum(['true', 'false']).optional() }).parse(req.query);
      const [rows, counts] = await Promise.all([
        db.query(
          `SELECT e.id, e.reference_no, e.kind, e.status, e.reason, e.deadline_at, e.deadline_source, e.created_at, e.updated_at, e.raised_role,
                  a.id AS application_id, a.reference_no AS application_ref, i.name AS institution_name, i.region_code,
                  ow.full_name AS owner_name, v.scheduled_start, v.mode, v.status AS visit_status,
                  (SELECT count(*)::int FROM escalation_actions x WHERE x.escalation_id = e.id) AS actions
           FROM escalations e JOIN applications a ON a.id = e.application_id JOIN institutions i ON i.id = a.institution_id
           LEFT JOIN users ow ON ow.id = e.owner_id LEFT JOIN evc_visits v ON v.id = e.visit_id
           WHERE ($1::text IS NULL OR e.status = $1) AND ($2::text IS NULL OR e.kind = $2) AND ($3::text IS NULL OR i.region_code = $3)
             AND ($4::boolean IS NULL OR (e.status NOT IN ('RESOLVED','CLOSED')) = $4)
           ORDER BY (e.status IN ('RESOLVED','CLOSED')), e.created_at DESC LIMIT 500`,
          [q.status ?? null, q.kind ?? null, q.region ?? null, q.open ? q.open === 'true' : null],
        ),
        db.query('SELECT status, count(*)::int AS n FROM escalations GROUP BY status'),
      ]);
      res.json({ escalations: rows, counts, kinds: ESCALATION_KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })), statuses: ESCALATION_STATUSES, actions: Object.keys(ESCALATION_ACTIONS) });
    }),
  );

  r.get(
    '/escalations/:id',
    ah(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Escalation not found.');
      const e = await db.one<Record<string, any>>(
        `SELECT e.*, a.reference_no AS application_ref, a.status AS application_status, a.category_code, i.name AS institution_name, i.region_code, ow.full_name AS owner_name
         FROM escalations e JOIN applications a ON a.id = e.application_id JOIN institutions i ON i.id = a.institution_id LEFT JOIN users ow ON ow.id = e.owner_id WHERE e.id = $1`,
        [req.params.id],
      );
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'Escalation not found.');
      const actions = await db.query('SELECT x.*, uu.full_name AS actor_name, at.full_name AS assigned_to_name FROM escalation_actions x LEFT JOIN users uu ON uu.id = x.actor_id LEFT JOIN users at ON at.id = x.assigned_to WHERE x.escalation_id = $1 ORDER BY x.id', [e.id]);
      const visit = e.visit_id ? await db.one('SELECT id, mode, scheduled_start, scheduled_end, status, missed_reason, completed_at, offline_justification FROM evc_visits WHERE id = $1', [e.visit_id]) : null;
      const members = e.visit_id
        ? await db.query('SELECT m.user_id, m.seat, m.response_status, m.responded_at, m.rejection_reason, m.conflict_note, m.attendance, m.active, uu.full_name FROM evc_visit_members m JOIN users uu ON uu.id = m.user_id WHERE m.visit_id = $1 ORDER BY m.active DESC', [e.visit_id])
        : [];
      const visitEvents = e.visit_id ? await db.query('SELECT x.event, x.created_at, x.details, uu.full_name AS actor_name FROM evc_visit_events x LEFT JOIN users uu ON uu.id = x.actor_id WHERE x.visit_id = $1 ORDER BY x.id DESC', [e.visit_id]) : [];
      const reports = e.visit_id ? await db.query('SELECT id, version, receipt_no, submitted_at FROM evc_reports WHERE visit_id = $1 ORDER BY version DESC', [e.visit_id]) : [];
      const evidence = e.visit_id ? await db.query('SELECT id, file_name, uploaded_at FROM evc_report_evidence WHERE visit_id = $1 ORDER BY uploaded_at DESC', [e.visit_id]) : [];
      const deadlines = e.visit_id ? await db.query('SELECT subject_type, due_at, source_type, source_reference, status FROM deadlines WHERE visit_id = $1 ORDER BY due_at', [e.visit_id]) : [];
      const notifications = await db.query(
        `SELECT n.event_type, n.title, n.created_at, n.delivery_status, n.read_at, uu.full_name AS recipient FROM notifications n JOIN users uu ON uu.id = n.recipient_user_id
         WHERE n.application_id = $1 AND (n.event_type LIKE 'EVC_%' OR n.event_type IN ('BUREAU_ESCALATION','ESCALATION_RESPONSE','ESCALATION_UPDATE')) ORDER BY n.created_at DESC LIMIT 100`,
        [e.application_id],
      );
      const assignable = await db.query("SELECT DISTINCT u.id, u.full_name, r.role FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role IN ('REGIONAL_OFFICER','SUPERVISOR') AND u.status = 'ACTIVE' ORDER BY u.full_name");
      res.json({ escalation: e, label: KIND_LABEL[e.kind as keyof typeof KIND_LABEL], actions, visit, members, visitEvents, reports, evidence, deadlines, notifications, assignable, allowedActions: Object.entries(ESCALATION_ACTIONS).filter(([, d]) => d.from.includes(e.status)).map(([k]) => k) });
    }),
  );

  r.post(
    '/escalations/:id/actions',
    requireRole('REGULATION_BUREAU'),
    ah(async (req, res) => {
      const u = user(req);
      const b = z.object({ action: z.enum(Object.keys(ESCALATION_ACTIONS) as [string, ...string[]]), note: z.string().trim().min(5).max(4000), assignTo: z.string().uuid().optional() }).parse(req.body);
      const e = await db.one<{ id: string; reference_no: string; status: string; application_id: string; visit_id: string | null }>('SELECT * FROM escalations WHERE id = $1', [req.params.id]);
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'Escalation not found.');
      const def = ESCALATION_ACTIONS[b.action];
      if (!def.from.includes(e.status as never)) throw new HttpError(409, 'INVALID_ESCALATION_ACTION', `${b.action} is not available while the escalation is ${e.status.toLowerCase().replace(/_/g, ' ')}.`);
      if (b.action === 'ASSIGN_ACTION') {
        if (!b.assignTo) throw new HttpError(400, 'ASSIGNEE_REQUIRED', 'Choose who the corrective action is assigned to.');
        const ok = await db.one("SELECT 1 FROM user_roles WHERE user_id = $1 AND role IN ('REGIONAL_OFFICER','SUPERVISOR')", [b.assignTo]);
        if (!ok) throw new HttpError(400, 'INVALID_ASSIGNEE', 'Corrective actions can be assigned to Regional Officers or Supervisors.');
      }
      await db.tx(async (t) => {
        await t.query(
          `UPDATE escalations SET status = $2, owner_id = coalesce(owner_id, $3), resolution = CASE WHEN $2 IN ('RESOLVED','CLOSED') THEN coalesce($4, resolution) ELSE resolution END,
             closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE closed_at END, updated_at = now() WHERE id = $1`,
          [e.id, def.to, u.id, b.action === 'RESOLVE' ? b.note : null],
        );
        await t.query('INSERT INTO escalation_actions(escalation_id, action, note, actor_id, actor_role, assigned_to) VALUES ($1,$2,$3,$4,$5,$6)', [e.id, b.action, b.note, u.id, u.activeRole, b.assignTo ?? null]);
        // Who is asked to respond: the assignee, or for explanation / information requests the committee and the region's officers.
        const recipients = new Set<string>();
        if (b.assignTo) recipients.add(b.assignTo);
        if (['REQUEST_EXPLANATION', 'RETURN_FOR_INFORMATION'].includes(b.action)) {
          if (e.visit_id) for (const m of await t.query<{ user_id: string }>('SELECT user_id FROM evc_visit_members WHERE visit_id = $1 AND active', [e.visit_id])) recipients.add(m.user_id);
          for (const ro of await t.query<{ user_id: string }>(
            `SELECT ur.user_id FROM user_regions ur JOIN applications a ON a.id = $1 JOIN institutions i ON i.id = a.institution_id WHERE ur.region_code = i.region_code`,
            [e.application_id],
          ))
            recipients.add(ro.user_id);
        }
        for (const id of recipients)
          await notify(t, { recipientUserId: id, applicationId: e.application_id, eventType: 'ESCALATION_UPDATE', title: `${e.reference_no}: ${b.action.replace(/_/g, ' ').toLowerCase()}`, message: b.note, dedupeKey: `esc:${e.id}:${b.action}:${id}:${Date.now()}` });
      });
      await audit(db, req, `ESCALATION_${b.action}`, 'escalation', e.id, { note: b.note, assignTo: b.assignTo ?? null });
      res.json({ ok: true, status: def.to });
    }),
  );

  /** Cross-region pendency, bottlenecks and delays — counted from persisted records. */
  r.get(
    '/overview',
    ah(async (_req, res) => {
      // No request params and none of these queries depend on each other, so they run concurrently
      // rather than paying six serial round trips — each one costs real latency against a remote
      // (e.g. Supabase) database.
      const [byStage, overdueDeadlines, missingReports, complianceDelays, escalations, regions] = await Promise.all([
        db.query<{ status: AppState; region_code: string | null; n: number; avg_days: number; max_days: number }>(
          `SELECT a.status, i.region_code, count(*)::int AS n,
                  round(avg(extract(epoch FROM now() - coalesce((SELECT max(w.created_at) FROM workflow_events w WHERE w.application_id = a.id), a.submitted_at)) / 86400)::numeric, 1)::float AS avg_days,
                  round(max(extract(epoch FROM now() - coalesce((SELECT max(w.created_at) FROM workflow_events w WHERE w.application_id = a.id), a.submitted_at)) / 86400)::numeric, 1)::float AS max_days
           FROM applications a JOIN institutions i ON i.id = a.institution_id WHERE a.status NOT IN ('DRAFT','CLOSED') GROUP BY a.status, i.region_code`,
        ),
        db.query<{ subject_type: string; n: number }>("SELECT subject_type, count(*)::int AS n FROM deadline_register WHERE status = 'OPEN' AND due_at < now() GROUP BY subject_type"),
        db.query(
          `SELECT v.id AS visit_id, a.id AS application_id, a.reference_no, i.name AS institution_name, i.region_code, d.due_at FROM deadlines d JOIN evc_visits v ON v.id = d.visit_id
           JOIN applications a ON a.id = v.application_id JOIN institutions i ON i.id = a.institution_id
           WHERE d.subject_type = 'EVC_REPORT' AND d.status IN ('OPEN','OVERDUE','ESCALATED') AND d.due_at < now() ORDER BY d.due_at`,
        ),
        db.query(
          `SELECT o.id, o.title, o.kind, o.due_date::text AS due_date, o.status, o.aph_reference, a.reference_no, i.name AS institution_name, i.region_code
           FROM compliance_obligations o JOIN institutions i ON i.id = o.institution_id LEFT JOIN applications a ON a.id = o.application_id
           WHERE o.due_date IS NOT NULL AND o.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND o.status IN ('OPEN','DEFICIENT') ORDER BY o.due_date LIMIT 100`,
        ),
        db.query<{ kind: string; status: string; n: number }>('SELECT kind, status, count(*)::int AS n FROM escalations GROUP BY kind, status'),
        db.query('SELECT code, name, is_demo FROM regions ORDER BY code'),
      ]);
      res.json({
        byStage: byStage.map((s) => ({ ...s, label: STATE_LABELS[s.status], stage: stageOf(s.status) })),
        overdueDeadlines,
        missingReports,
        complianceDelays,
        escalations,
        regions,
        note: 'Cross-region visibility for the Regulation Bureau is a portal configuration. Days at stage are measured from the last workflow event.',
      });
    }),
  );

  return r;
}
