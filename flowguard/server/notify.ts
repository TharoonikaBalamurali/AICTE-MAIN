/**
 * In-app notifications with de-duplication and delivery tracking.
 * Channel: IN_APP only (no email/SMS integration). A delivery fails when the recipient account
 * cannot receive it (inactive) or a configured channel hook throws; failures are retried by the sweep.
 */
import type { Db } from './db/index.ts';
import { POLICY } from './policy.ts';
import type { Role } from './workflow/stateMachine.ts';

export interface NotifyInput {
  recipientUserId: string;
  institutionId?: string | null;
  applicationId?: string | null;
  eventType: string;
  title: string;
  message: string;
  /** Same key + same recipient ⇒ the notification is created once only. */
  dedupeKey?: string | null;
}

/** Test seam to simulate a channel failure. Returns an error message to fail the delivery. */
let deliveryHook: ((n: NotifyInput) => string | null) | null = null;
export function setDeliveryHook(h: typeof deliveryHook) {
  deliveryHook = h;
}

async function attemptDelivery(db: Db, n: NotifyInput): Promise<string | null> {
  const u = await db.one<{ status: string }>('SELECT status FROM users WHERE id = $1', [n.recipientUserId]);
  if (!u) return 'Recipient does not exist';
  if (u.status !== 'ACTIVE') return `Recipient account is ${u.status.toLowerCase()}`;
  try {
    return deliveryHook ? deliveryHook(n) : null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Returns the notification id, or null when it was a duplicate. */
export async function notify(db: Db, n: NotifyInput): Promise<string | null> {
  const err = await attemptDelivery(db, n);
  const row = await db.one<{ id: string }>(
    `INSERT INTO notifications(recipient_user_id, institution_id, application_id, event_type, title, message, dedupe_key, delivery_status, last_error, delivered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (recipient_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [n.recipientUserId, n.institutionId ?? null, n.applicationId ?? null, n.eventType, n.title, n.message, n.dedupeKey ?? null, err ? 'FAILED' : 'DELIVERED', err, err ? null : new Date().toISOString()],
  );
  return row?.id ?? null;
}

export async function notifyInstitutionMembers(db: Db, app: { id: string; institution_id: string }, eventType: string, title: string, message: string, dedupeKey?: string) {
  const members = await db.query<{ user_id: string }>('SELECT user_id FROM institution_memberships WHERE institution_id = $1', [app.institution_id]);
  const ids: string[] = [];
  for (const m of members) {
    const id = await notify(db, { recipientUserId: m.user_id, institutionId: app.institution_id, applicationId: app.id, eventType, title, message, dedupeKey });
    if (id) ids.push(id);
  }
  return ids;
}

/** Notifies the assigned official for the role if there is one, otherwise everyone holding the role. */
export async function notifyRoleOrAssignee(db: Db, role: Role, appId: string | null, eventType: string, title: string, message: string, dedupeKey?: string) {
  let users: Array<{ user_id: string }> = [];
  if (appId) users = await db.query('SELECT user_id FROM assignments WHERE application_id = $1 AND role = $2 AND active', [appId, role]);
  if (!users.length) users = await db.query('SELECT user_id FROM user_roles WHERE role = $1', [role]);
  const ids: string[] = [];
  for (const u of users) {
    const id = await notify(db, { recipientUserId: u.user_id, applicationId: appId, eventType, title, message, dedupeKey });
    if (id) ids.push(id);
  }
  return { recipients: users.map((u) => u.user_id), created: ids };
}

/** Retries failed deliveries (bounded attempts). */
export async function retryFailedDeliveries(db: Db) {
  const failed = await db.query<{ id: string; recipient_user_id: string; event_type: string; title: string; message: string; attempts: number }>(
    "SELECT id, recipient_user_id, event_type, title, message, attempts FROM notifications WHERE delivery_status = 'FAILED' AND attempts < $1",
    [POLICY.maxDeliveryAttempts],
  );
  let delivered = 0;
  for (const f of failed) {
    const err = await attemptDelivery(db, { recipientUserId: f.recipient_user_id, eventType: f.event_type, title: f.title, message: f.message });
    await db.query(
      `UPDATE notifications SET attempts = attempts + 1, delivery_status = $2, last_error = $3, delivered_at = CASE WHEN $2 = 'DELIVERED' THEN now() ELSE delivered_at END WHERE id = $1`,
      [f.id, err ? 'FAILED' : 'DELIVERED', err],
    );
    if (!err) delivered++;
  }
  return { retried: failed.length, delivered };
}
