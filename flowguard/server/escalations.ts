/**
 * Regulation Bureau escalations — a controlled request for human review and follow-up.
 *
 * The APH names the Regulation Bureau (e.g. Ch. I §1.10(a)) but prescribes no escalation queue or thresholds:
 * this queue, its triggers and its statuses are a FlowGuard design. An escalation never penalises an EVC member,
 * rejects an application or alters a decision; it records who must look at what, and what they did.
 */
import type { Db } from './db/index.ts';
import { notify } from './notify.ts';

export const ESCALATION_KINDS = ['VISIT_MISSED', 'VISIT_OUTCOME_UNRESOLVED', 'REPORT_OVERDUE', 'ACKNOWLEDGEMENT_OVERDUE', 'SCHEDULING_DISPUTE', 'OTHER'] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];
export const ESCALATION_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'ACTION_ASSIGNED', 'RETURNED_FOR_INFORMATION', 'RESOLVED', 'CLOSED'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export const KIND_LABEL: Record<EscalationKind, string> = {
  VISIT_MISSED: 'Visit reported as missed',
  VISIT_OUTCOME_UNRESOLVED: 'Visit outcome not recorded',
  REPORT_OVERDUE: 'EVC report not submitted by its due time',
  ACKNOWLEDGEMENT_OVERDUE: 'Invitation not answered',
  SCHEDULING_DISPUTE: 'Scheduling conflict unresolved',
  OTHER: 'Other EVC blocker',
};

/** Bureau actions and the status each one leads to. RESOLVE and CLOSE require a reason. */
export const ESCALATION_ACTIONS: Record<string, { to: EscalationStatus; from: EscalationStatus[] }> = {
  ACKNOWLEDGE: { to: 'ACKNOWLEDGED', from: ['OPEN', 'RETURNED_FOR_INFORMATION'] },
  REQUEST_EXPLANATION: { to: 'EXPLANATION_REQUESTED', from: ['OPEN', 'ACKNOWLEDGED', 'ACTION_ASSIGNED', 'RETURNED_FOR_INFORMATION', 'EXPLANATION_REQUESTED'] },
  RECORD_FOLLOW_UP: { to: 'ACKNOWLEDGED', from: ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'ACTION_ASSIGNED', 'RETURNED_FOR_INFORMATION'] },
  ASSIGN_ACTION: { to: 'ACTION_ASSIGNED', from: ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'RETURNED_FOR_INFORMATION', 'ACTION_ASSIGNED'] },
  RETURN_FOR_INFORMATION: { to: 'RETURNED_FOR_INFORMATION', from: ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'ACTION_ASSIGNED'] },
  RESOLVE: { to: 'RESOLVED', from: ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'ACTION_ASSIGNED', 'RETURNED_FOR_INFORMATION'] },
  CLOSE: { to: 'CLOSED', from: ['RESOLVED'] },
};

export interface RaiseInput {
  applicationId: string;
  visitId: string | null;
  kind: EscalationKind;
  reason: string;
  dedupeKey: string;
  deadlineAt?: string | null;
  deadlineSource?: string | null;
  raisedBy?: { id: string; role: string } | null;
}

/** Idempotent: the same dedupe key never creates a second escalation. Returns the id when created. */
export async function raiseEscalation(db: Db, e: RaiseInput): Promise<string | null> {
  const seq = await db.one<{ n: string }>("SELECT nextval('escalation_ref_seq')::text AS n");
  const row = await db.one<{ id: string; reference_no: string }>(
    `INSERT INTO escalations(reference_no, application_id, visit_id, kind, reason, deadline_at, deadline_source, dedupe_key, raised_by, raised_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id, reference_no`,
    [`FG-ESC-${seq!.n.padStart(6, '0')}`, e.applicationId, e.visitId, e.kind, e.reason, e.deadlineAt ?? null, e.deadlineSource ?? null, e.dedupeKey, e.raisedBy?.id ?? null, e.raisedBy?.role ?? 'SYSTEM'],
  );
  if (!row) return null;
  await db.query('INSERT INTO escalation_actions(escalation_id, action, note, actor_id, actor_role) VALUES ($1,$2,$3,$4,$5)', [row.id, 'RAISED', e.reason, e.raisedBy?.id ?? null, e.raisedBy?.role ?? 'SYSTEM']);
  const app = await db.one<{ reference_no: string }>('SELECT reference_no FROM applications WHERE id = $1', [e.applicationId]);
  const bureau = await db.query<{ user_id: string }>("SELECT r.user_id FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.role = 'REGULATION_BUREAU' AND u.status = 'ACTIVE'");
  for (const b of bureau)
    await notify(db, {
      recipientUserId: b.user_id,
      applicationId: e.applicationId,
      eventType: 'BUREAU_ESCALATION',
      title: `Escalation ${row.reference_no}: ${KIND_LABEL[e.kind]}`,
      message: `${app?.reference_no ?? ''}: ${e.reason} No automatic action was taken.`,
      dedupeKey: `esc:${row.id}:raised`,
    });
  return row.id;
}
