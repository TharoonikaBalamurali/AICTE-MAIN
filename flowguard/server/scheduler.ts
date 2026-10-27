/**
 * Background deadline monitor. Sends reminders, flags overdue items and escalates to the configured
 * supervisory role. It NEVER changes an application status, rejects, cancels or penalises anything.
 * Every event is idempotent (unique dedupe key), so repeated sweeps do not duplicate notifications.
 */
import type { Db } from './db/index.ts';
import { notify, notifyInstitutionMembers, notifyRoleOrAssignee, retryFailedDeliveries } from './notify.ts';
import { getPolicy, POLICY } from './policy.ts';
import { raiseEscalation, type EscalationKind } from './escalations.ts';
import { documentValidity } from './validity.ts';
import { todayIST } from './services.ts';

const dayDiff = (due: string, today: string) => Math.round((new Date(`${due}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000);

async function recordEvent(db: Db, e: { entityType: string; entityId: string; applicationId: string | null; type: 'REMINDER' | 'OVERDUE' | 'ESCALATED'; key: string; recipients: string[]; details: Record<string, unknown> }) {
  const r = await db.one<{ id: string }>(
    `INSERT INTO deadline_events(entity_type, entity_id, application_id, event_type, dedupe_key, recipients, details) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [e.entityType, e.entityId, e.applicationId, e.type, e.key, JSON.stringify(e.recipients), JSON.stringify(e.details)],
  );
  return !!r;
}

export async function runDeadlineSweep(db: Db, now = new Date()) {
  const today = todayIST(now);
  const summary: Record<string, unknown> & { reminders: number; overdue: number; escalations: number } = { reminders: 0, overdue: 0, escalations: 0, evcFlagged: 0, evcEscalations: 0, validityAlerts: 0, retries: { retried: 0, delivered: 0 } };

  // ---- deficiencies awaiting institutional correction
  const defs = await db.query<{ id: string; reference_no: string; deadline: string; deadline_type: string; raised_by: string; target_label: string; application_id: string; institution_id: string; app_ref: string }>(
    `SELECT d.id, d.reference_no, d.deadline::text AS deadline, d.deadline_type, d.raised_by, d.target_label, d.application_id, a.institution_id, a.reference_no AS app_ref
     FROM deficiencies d JOIN applications a ON a.id = d.application_id
     WHERE d.status IN ('OPEN','UNRESOLVED','PARTIALLY_RESOLVED') AND d.deadline IS NOT NULL AND a.status IN ('DEFICIENCY_RAISED','CORRECTION_IN_PROGRESS')`,
  );
  for (const d of defs) {
    const left = dayDiff(d.deadline, today);
    const app = { id: d.application_id, institution_id: d.institution_id };
    const kind = d.deadline_type === 'APH' ? 'APH-prescribed' : 'operational (system-configured)';
    if (left >= 0) {
      const t = POLICY.reminderDaysBefore.filter((x) => left <= x).sort((a, b) => a - b)[0];
      if (t !== undefined && (await recordEvent(db, { entityType: 'deficiency', entityId: d.id, applicationId: d.application_id, type: 'REMINDER', key: `def:${d.id}:reminder:${t}`, recipients: [], details: { daysLeft: left } }))) {
        await notifyInstitutionMembers(db, app, 'DEADLINE_REMINDER', `Correction due in ${left} day(s): ${d.app_ref}`, `${d.reference_no} (${d.target_label}) has a ${kind} deadline of ${d.deadline}.`, `def:${d.id}:reminder:${t}`);
        summary.reminders++;
      }
      continue;
    }
    const overdueDays = -left;
    if (await recordEvent(db, { entityType: 'deficiency', entityId: d.id, applicationId: d.application_id, type: 'OVERDUE', key: `def:${d.id}:overdue`, recipients: [d.raised_by], details: { overdueDays } })) {
      await notifyInstitutionMembers(db, app, 'DEADLINE_OVERDUE', `Correction overdue: ${d.app_ref}`, `${d.reference_no} passed its ${kind} deadline (${d.deadline}). Submit the correction; an official will decide the next step.`, `def:${d.id}:overdue`);
      await notify(db, { recipientUserId: d.raised_by, applicationId: d.application_id, eventType: 'DEADLINE_OVERDUE', title: `Deficiency overdue: ${d.reference_no}`, message: `${d.app_ref}: correction not received by ${d.deadline}. No automatic action has been taken.`, dedupeKey: `def:${d.id}:overdue:officer` });
      summary.overdue++;
    }
    if (overdueDays >= POLICY.escalateAfterOverdueDays) {
      const key = `def:${d.id}:escalated`;
      if (!(await db.one('SELECT 1 FROM deadline_events WHERE dedupe_key = $1', [key]))) {
        const r = await notifyRoleOrAssignee(db, POLICY.escalationRole, null, 'ESCALATION', `Escalation: ${d.reference_no} overdue ${overdueDays} day(s)`, `${d.app_ref}: unresolved deficiency past its ${kind} deadline. Review and decide the next step; nothing was changed automatically.`, key);
        await recordEvent(db, { entityType: 'deficiency', entityId: d.id, applicationId: d.application_id, type: 'ESCALATED', key, recipients: r.recipients, details: { overdueDays, policy: 'SYSTEM_POLICY' } });
        summary.escalations++;
      }
    }
  }

  // ---- compliance obligations with APH-derived due dates (includes lease renewals, kind = LEASE_RENEWAL)
  const obls = await db.query<{ id: string; title: string; due_date: string; application_id: string | null; institution_id: string; aph_reference: string; kind: string }>(
    "SELECT id, title, due_date::text AS due_date, application_id, institution_id, aph_reference, kind FROM compliance_obligations WHERE status = 'OPEN' AND due_date IS NOT NULL",
  );
  for (const o of obls) {
    const left = dayDiff(o.due_date, today);
    const app = { id: o.application_id as string, institution_id: o.institution_id };
    const schedule = o.kind === 'LEASE_RENEWAL' ? POLICY.leaseReminderDaysBefore : POLICY.reminderDaysBefore;
    if (left >= 0) {
      const t = schedule.filter((x) => left <= x).sort((a, b) => a - b)[0];
      if (t !== undefined && (await recordEvent(db, { entityType: 'obligation', entityId: o.id, applicationId: o.application_id, type: 'REMINDER', key: `obl:${o.id}:reminder:${t}`, recipients: [], details: { daysLeft: left } }))) {
        await notifyInstitutionMembers(db, app, 'COMPLIANCE_REMINDER', `Compliance due in ${left} day(s)`, `${o.title} is due on ${o.due_date} (${o.aph_reference}).`, `obl:${o.id}:reminder:${t}`);
        summary.reminders++;
      }
    } else if (await recordEvent(db, { entityType: 'obligation', entityId: o.id, applicationId: o.application_id, type: 'OVERDUE', key: `obl:${o.id}:overdue`, recipients: [], details: { overdueDays: -left } })) {
      await notifyInstitutionMembers(db, app, 'COMPLIANCE_OVERDUE', 'Compliance obligation overdue', `${o.title} was due on ${o.due_date} (${o.aph_reference}).`, `obl:${o.id}:overdue`);
      await notifyRoleOrAssignee(db, POLICY.escalationRole, o.application_id, 'ESCALATION', 'Compliance obligation overdue', `${o.title} (due ${o.due_date}) is overdue.`, `obl:${o.id}:overdue:supervisor`);
      summary.overdue++;
    }
  }

  Object.assign(summary, await runEvcSweep(db, now));
  summary.validityAlerts = await runValidityAlerts(db, now);
  summary.retries = await retryFailedDeliveries(db);
  return summary;
}

/**
 * EVC follow-up. Deadlines here come from operational configuration (see policy.ts). Passing a deadline only
 * flags, notifies and escalates for human review: a visit is never marked completed or missed, no member is
 * penalised and no application changes state.
 */
async function runEvcSweep(db: Db, now: Date) {
  const out = { evcFlagged: 0, evcEscalations: 0 };
  const due = await db.query<{ id: string; subject_type: string; subject_id: string; application_id: string; visit_id: string; responsible_user_id: string | null; due_at: string; source_reference: string; reference_no: string; full_name: string | null; response_status: string | null; member_active: boolean | null; visit_status: string }>(
    `SELECT d.id, d.subject_type, d.subject_id, d.application_id, d.visit_id, d.responsible_user_id, d.due_at, d.source_reference, a.reference_no, uu.full_name, m.response_status, m.active AS member_active, v.status AS visit_status
     FROM deadlines d JOIN applications a ON a.id = d.application_id JOIN evc_visits v ON v.id = d.visit_id
     LEFT JOIN users uu ON uu.id = d.responsible_user_id LEFT JOIN evc_visit_members m ON m.visit_id = d.visit_id AND m.user_id = d.responsible_user_id
     WHERE d.status = 'OPEN' AND d.due_at < $1`,
    [now.toISOString()],
  );
  for (const d of due) {
    // Skip follow-ups that no longer apply (member removed, visit cancelled).
    if (d.visit_status === 'CANCELLED' || (d.subject_type === 'EVC_ACKNOWLEDGEMENT' && (!d.member_active || !['INVITED', 'CONFLICT_REPORTED'].includes(d.response_status ?? '')))) {
      await db.query("UPDATE deadlines SET status = 'CANCELLED', completed_at = now() WHERE id = $1", [d.id]);
      continue;
    }
    const ros = await db.query<{ user_id: string }>(
      `SELECT ur.user_id FROM user_regions ur JOIN user_roles r ON r.user_id = ur.user_id AND r.role = 'REGIONAL_OFFICER' JOIN applications a ON a.id = $1 JOIN institutions i ON i.id = a.institution_id WHERE ur.region_code = i.region_code`,
      [d.application_id],
    );
    const tellRo = async (title: string, message: string) => {
      for (const r of ros) await notify(db, { recipientUserId: r.user_id, applicationId: d.application_id, eventType: 'EVC_FOLLOW_UP', title, message, dedupeKey: `deadline:${d.id}:ro` });
    };
    let kind: EscalationKind;
    let reason: string;
    if (d.subject_type === 'EVC_ACKNOWLEDGEMENT') {
      kind = d.response_status === 'CONFLICT_REPORTED' ? 'SCHEDULING_DISPUTE' : 'ACKNOWLEDGEMENT_OVERDUE';
      reason = d.response_status === 'CONFLICT_REPORTED' ? `${d.full_name ?? 'A member'} reported a scheduling conflict that is still unresolved.` : `${d.full_name ?? 'A member'} has not responded to the EVC invitation.`;
      if (d.responsible_user_id && kind === 'ACKNOWLEDGEMENT_OVERDUE')
        await notify(db, { recipientUserId: d.responsible_user_id, applicationId: d.application_id, eventType: 'EVC_ACK_REMINDER', title: `Please respond: ${d.reference_no}`, message: 'Your EVC invitation is awaiting your acceptance or decline.', dedupeKey: `deadline:${d.id}:member` });
    } else if (d.subject_type === 'EVC_VISIT_OUTCOME') {
      kind = 'VISIT_OUTCOME_UNRESOLVED';
      reason = 'The scheduled visit time has passed and no outcome (completed / missed) has been recorded. The visit status was not changed automatically.';
    } else {
      kind = 'REPORT_OVERDUE';
      reason = 'The EVC report has not been submitted by its due time.';
    }
    await tellRo(`${d.reference_no}: follow-up needed`, `${reason} Basis: ${d.source_reference}.`);
    await db.query("UPDATE deadlines SET status = 'ESCALATED' WHERE id = $1", [d.id]);
    out.evcFlagged++;
    const id = await raiseEscalation(db, { applicationId: d.application_id, visitId: d.visit_id, kind, reason, dedupeKey: `deadline:${d.id}:${kind}`, deadlineAt: d.due_at, deadlineSource: d.source_reference });
    if (id) out.evcEscalations++;
  }
  return out;
}

/** Alerts institutions before a recorded document expiry — only where a verified validity rule applies. */
async function runValidityAlerts(db: Db, now: Date) {
  const alert = await getPolicy(db, 'DOCUMENT_EXPIRY_ALERT_DAYS');
  const rows = await documentValidity(db, {}, alert.value, now);
  let n = 0;
  for (const r of rows.filter((x) => x.status === 'EXPIRING_SOON' || x.status === 'EXPIRED')) {
    const key = `doc:${r.documentId}:${r.status}`;
    if (!(await recordEvent(db, { entityType: 'document', entityId: r.documentId, applicationId: r.applicationId, type: r.status === 'EXPIRED' ? 'OVERDUE' : 'REMINDER', key, recipients: [], details: { expiresOn: r.expiresOn, basis: r.aphReference } }))) continue;
    await notifyInstitutionMembers(
      db,
      { id: r.applicationId, institution_id: r.institutionId },
      'DOCUMENT_VALIDITY',
      r.status === 'EXPIRED' ? `Document expired: ${r.name}` : `Document expires in ${r.daysRemaining} day(s): ${r.name}`,
      `${r.referenceNo ?? ''}: ${r.name} ${r.status === 'EXPIRED' ? 'expired' : 'expires'} on ${r.expiresOn} (${r.aphReference ?? 'verified validity rule'}). This is flagged for review; nothing was changed automatically.`,
      key,
    );
    n++;
  }
  return n;
}

/** Runs a job with a job_runs record; failures are logged and do not crash the server. */
export async function runJob<T>(db: Db, job: string, fn: () => Promise<T>) {
  const run = await db.one<{ id: string }>('INSERT INTO job_runs(job) VALUES ($1) RETURNING id', [job]);
  try {
    const r = await fn();
    await db.query("UPDATE job_runs SET status = 'SUCCEEDED', finished_at = now(), summary = $2 WHERE id = $1", [run!.id, JSON.stringify(r)]);
    return r;
  } catch (e) {
    await db.query("UPDATE job_runs SET status = 'FAILED', finished_at = now(), error = $2 WHERE id = $1", [run!.id, (e as Error).message]);
    throw e;
  }
}

export function startScheduler(db: Db, log: (m: string, meta?: unknown) => void) {
  let running = false;
  const tick = async () => {
    if (running) return; // no overlapping sweeps
    running = true;
    try {
      const s = await runJob(db, 'deadline-sweep', () => runDeadlineSweep(db));
      log('deadline_sweep', s);
    } catch (e) {
      log('deadline_sweep_failed', { message: (e as Error).message });
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 5_000);
  return setInterval(tick, POLICY.sweepIntervalMs);
}
