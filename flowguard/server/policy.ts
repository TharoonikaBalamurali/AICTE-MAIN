/**
 * OPERATIONAL SETTINGS — FlowGuard SYSTEM_POLICY, not APH requirements.
 *
 * The APH does not prescribe a correction deadline for scrutiny deficiencies, reminder intervals,
 * EVC acknowledgement or report periods, or an escalation hierarchy. These values only drive reminders,
 * deadline records and escalations for human follow-up; they never change an application's status or
 * impose a penalty. They are stored in `operational_policies` (versioned, with history) so an authorised
 * administrator can review and authorise them; until then each is marked DEMO_UNAUTHORISED.
 */
import type { Db } from './db/index.ts';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const POLICY = {
  /** Send a reminder when a deadline is this many days away (smallest matching threshold wins). */
  reminderDaysBefore: [7, 3, 1],
  /**
   * Reminder schedule for lease-renewal obligations (Ch. VI §6.17(a); Ch. II §2.1(e)). A much longer
   * lead time than reminderDaysBefore: arranging a registered lease renewal is not a short
   * administrative task, so the first alert fires a year out.
   */
  leaseReminderDaysBefore: [365, 180, 90, 30, 7],
  /** Notify the supervisor when an item has been overdue for at least this many days. */
  escalateAfterOverdueDays: num(process.env.ESCALATE_AFTER_OVERDUE_DAYS, 2),
  /** "Due soon" badge window for compliance items. */
  dueSoonDays: 14,
  /** Background sweep interval. */
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 5 * 60_000),
  /** Retry failed in-app deliveries up to this many attempts. */
  maxDeliveryAttempts: 3,
  /** Role that receives escalations (FlowGuard design decision; no APH escalation hierarchy is defined). */
  escalationRole: 'SUPERVISOR' as const,
};

export const POLICY_DESCRIPTION = [
  `Reminders are sent ${POLICY.reminderDaysBefore.join(' / ')} day(s) before a deadline.`,
  `Unresolved items overdue by ${POLICY.escalateAfterOverdueDays}+ day(s) are escalated to the ${POLICY.escalationRole.toLowerCase()} role.`,
  'Deadlines never change an application status automatically; officials decide every outcome.',
];

/** Operational policies stored in the database. Defaults are demonstration values awaiting authorisation. */
export const OPERATIONAL_DEFAULTS: Record<string, { value: number; description: string }> = {
  EVC_ACK_FOLLOWUP_HOURS: { value: 48, description: 'Hours after an EVC invitation within which the member is asked to accept or decline; unanswered invitations are then flagged to the Regional Officer and the Regulation Bureau.' },
  EVC_VISIT_OUTCOME_GRACE_HOURS: { value: 24, description: 'Hours after the scheduled visit start after which a visit with no recorded outcome (completed / missed) is flagged for follow-up. The visit is never marked completed or missed automatically.' },
  EVC_REPORT_DUE_DAYS: { value: 3, description: 'Days after the visit is recorded as completed within which the EVC report is expected.' },
  DOCUMENT_EXPIRY_ALERT_DAYS: { value: 30, description: 'Days before a recorded document expiry date at which the institution is alerted (only for documents whose validity is established by a verified rule).' },
  COMPLIANCE_DUE_SOON_DAYS: { value: 14, description: 'Window in which a compliance item with a recorded due date is shown as "due soon".' },
  EVC_SCHEDULING_BUFFER_MINUTES: { value: 0, description: 'Minutes kept free before and after each visit for an official (travel / changeover). 0 means consecutive visits are allowed: [10:00, 12:00) does not overlap [12:00, 13:00).' },
  EVC_SLOT_WINDOW_START_HOUR: { value: 9, description: 'Earliest start hour (IST) used when suggesting alternative visit slots. Suggestions only; officers may choose any time.' },
  EVC_SLOT_WINDOW_END_HOUR: { value: 18, description: 'Latest end hour (IST) used when suggesting alternative visit slots.' },
  EVC_ALTERNATIVE_SEARCH_DAYS: { value: 7, description: 'Number of days, from the requested date, searched when suggesting alternative slots.' },
};

export interface OperationalValue {
  key: string;
  value: number;
  status: 'DEMO_UNAUTHORISED' | 'AUTHORISED';
  version: number;
  description: string;
}

/** Reads one operational policy (falls back to the demonstration default if the row is missing). */
export async function getPolicy(db: Db, key: keyof typeof OPERATIONAL_DEFAULTS): Promise<OperationalValue> {
  const row = await db.one<{ value: number; status: OperationalValue['status']; version: number; description: string }>(
    'SELECT value, status, version, description FROM operational_policies WHERE key = $1',
    [key],
  );
  const d = OPERATIONAL_DEFAULTS[key];
  return row ? { key, value: Number(row.value), status: row.status, version: row.version, description: row.description } : { key, value: d.value, status: 'DEMO_UNAUTHORISED', version: 0, description: d.description };
}

export async function seedOperationalPolicies(db: Db) {
  for (const [key, d] of Object.entries(OPERATIONAL_DEFAULTS)) {
    const r = await db.one('INSERT INTO operational_policies(key, value, description) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING RETURNING key', [key, JSON.stringify(d.value), d.description]);
    if (r) await db.query('INSERT INTO operational_policy_history(key, version, value, status, reason) VALUES ($1,1,$2,$3,$4)', [key, JSON.stringify(d.value), 'DEMO_UNAUTHORISED', 'Demonstration default']);
  }
}

/** Label used in deadline records and notices. */
export const policyLabel = (p: OperationalValue) => `Portal operational configuration ${p.key} v${p.version} (${p.status === 'AUTHORISED' ? 'authorised' : 'demonstration value — not yet authorised'})`;
