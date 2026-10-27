/**
 * EVC scheduling engine shared by the official action endpoint, the EVC router and the deadline sweep.
 *
 * Committee constitution here is the FlowGuard OPERATIONAL procedure (the Regional Officer selects from the verified
 * registry; the composition is checked against Annexure 16 §16.5). APH Ch. I §1.9(a) describes selection through
 * AICTE's automated web portal; this module does not claim to be that process.
 *
 * Scheduling rules
 *  A. An official never holds two overlapping reservations. Each committee seat that occupies an official's time
 *     carries `reserved_period` = [start - buffer, end + buffer) (half-open); an exclusion constraint in the database
 *     rejects any overlap, so concurrent requests cannot both succeed (the loser gets 409 MEMBER_SLOT_TAKEN).
 *  B. A requested slot is bookable only if every required §16.5 seat can be filled by a distinct available, eligible
 *     official; otherwise the request is refused with the "no eligible members" message and alternatives are offered.
 *  C. Availability comes from real records: active + verified registry entry, seat eligibility, existing reservations
 *     (INVITED / ACCEPTED / CONFLICT_REPORTED / WITHDRAWAL_REQUESTED hold time; REJECTED, removed, cancelled and missed
 *     visits release it) and recorded unavailability.
 *  D. Every consequential write runs in one transaction that locks the visit, re-validates eligibility, availability
 *     and composition, then writes; any failure rolls everything back.
 */
import type { Db } from '../db/index.ts';
import { HttpError, type AuthUser } from '../http.ts';
import { notify } from '../notify.ts';
import { getPolicy, policyLabel } from '../policy.ts';
import { recordOfficerAction, REGION_SCOPE_SQL } from '../services.ts';
import { REQUIRED_SEATS, seatEligibility, validateComposition, type Expert, type Seat } from './composition.ts';

export interface VisitRow {
  id: string;
  application_id: string;
  mode: 'ONLINE' | 'PHYSICAL';
  scheduled_start: string;
  scheduled_end: string | null;
  status: string;
  schedule_version: number;
  completed_at: string | null;
  institution_id: string;
  reference_no: string;
  institution_name: string;
}

/** Response statuses that hold the official's time. */
export const HOLDING = ['INVITED', 'ACCEPTED', 'CONFLICT_REPORTED', 'WITHDRAWAL_REQUESTED'];
/** Permitted member response transitions (member-initiated). */
export const RESPONSE_TRANSITIONS: Record<string, string[]> = {
  INVITED: ['ACCEPTED', 'REJECTED', 'CONFLICT_REPORTED'],
  CONFLICT_REPORTED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['WITHDRAWAL_REQUESTED'],
  REJECTED: [],
  WITHDRAWAL_REQUESTED: [],
};

export const fmtIST = (v: string | Date) => new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeIST = (v: string | Date) => new Date(v).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
export const slotLabel = (start: string, end: string | null) => `${fmtIST(start)}${end ? `–${timeIST(end)}` : ''} IST`;

/**
 * Loads a visit and checks the caller may see it: an active member, the Regional Officer of the institution's
 * region, or a cross-region oversight role. Unauthorised callers get 404 (no existence leak).
 */
export async function loadVisitFor(db: Db, u: AuthUser, visitId: string): Promise<VisitRow & { isMember: boolean; isRegionalOfficer: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(visitId)) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
  const v = await db.one<VisitRow>(
    `SELECT v.id, v.application_id, v.mode, v.scheduled_start, v.scheduled_end, v.status, v.schedule_version, v.completed_at, a.institution_id, a.reference_no, i.name AS institution_name
     FROM evc_visits v JOIN applications a ON a.id = v.application_id JOIN institutions i ON i.id = a.institution_id WHERE v.id = $1`,
    [visitId],
  );
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
  const isMember = !!(await db.one('SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2 AND active', [v.id, u.id]));
  const isRegionalOfficer = u.activeRole === 'REGIONAL_OFFICER' && !!(await db.one(`SELECT 1 FROM applications a WHERE a.id = $1 AND ${REGION_SCOPE_SQL}`, [v.application_id, u.id]));
  const oversight = ['REGULATION_BUREAU', 'SUPERVISOR', 'DECISION_AUTHORITY'].includes(u.activeRole);
  const ok = (u.activeRole === 'EVC_MEMBER' && isMember) || isRegionalOfficer || oversight;
  if (!ok) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
  return { ...v, isMember, isRegionalOfficer };
}

// ------------------------------------------------------------------ availability

interface Busy {
  user_id: string | null;
  expert_id: string | null;
  visit_id: string | null;
  reference_no: string | null;
  institution_name: string | null;
  start: string;
  end: string;
  response_status: string | null;
  kind: 'ASSIGNMENT' | 'UNAVAILABLE';
  reason: string | null;
}

/** Loads every reservation and recorded unavailability that touches [from, to) in one query (avoids N+1 checks). */
async function loadBusy(db: Db, from: Date, to: Date): Promise<Busy[]> {
  return db.query<Busy>(
    `SELECT m.user_id, m.expert_id, v.id AS visit_id, a.reference_no, i.name AS institution_name,
            lower(m.reserved_period) AS start, upper(m.reserved_period) AS "end", m.response_status, 'ASSIGNMENT' AS kind, NULL AS reason
     FROM evc_visit_members m JOIN evc_visits v ON v.id = m.visit_id JOIN applications a ON a.id = v.application_id JOIN institutions i ON i.id = a.institution_id
     WHERE m.reserved_period IS NOT NULL AND m.reserved_period && tstzrange($1, $2, '[)')
     UNION ALL
     SELECT e.user_id, u.expert_id, NULL, NULL, NULL, u.starts_at, u.ends_at, NULL, 'UNAVAILABLE', u.reason
     FROM evc_member_unavailability u JOIN evc_experts e ON e.id = u.expert_id
     WHERE u.withdrawn_at IS NULL AND tstzrange(u.starts_at, u.ends_at, '[)') && tstzrange($1, $2, '[)')`,
    [from.toISOString(), to.toISOString()],
  );
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

export type AvailabilityStatus = 'AVAILABLE' | 'BUSY' | 'UNAVAILABLE' | 'INACTIVE' | 'NOT_VERIFIED' | 'NO_ACCOUNT';

export interface OfficialAvailability extends Expert {
  status: AvailabilityStatus;
  reason: string | null;
  conflicts: Array<{ visitId: string | null; referenceNo: string | null; institution: string | null; start: string; end: string; responseStatus: string | null; kind: string }>;
  dayAssignments: Array<{ visitId: string | null; referenceNo: string | null; institution: string | null; start: string; end: string; responseStatus: string | null }>;
  eligibleSeats: Seat[];
  seatEligibility: Record<Seat, { outcome: string; reasons: string[] }>;
}

function statusFor(e: Expert, busy: Busy[], s: number, en: number, excludeVisitId: string | null) {
  if (!e.active) return { status: 'INACTIVE' as const, reason: 'Registry record is inactive.', conflicts: [] as Busy[] };
  if (e.verification_status !== 'VERIFIED') return { status: 'NOT_VERIFIED' as const, reason: 'Qualifications not verified.', conflicts: [] as Busy[] };
  if (!e.user_id) return { status: 'NO_ACCOUNT' as const, reason: 'No portal account linked; cannot receive invitations.', conflicts: [] as Busy[] };
  const mine = busy.filter((b) => (b.user_id === e.user_id || b.expert_id === e.id) && !(excludeVisitId && b.visit_id === excludeVisitId));
  const hit = mine.filter((b) => overlaps(new Date(b.start).getTime(), new Date(b.end).getTime(), s, en));
  const leave = hit.find((b) => b.kind === 'UNAVAILABLE');
  if (leave) return { status: 'UNAVAILABLE' as const, reason: `Recorded unavailability: ${leave.reason}`, conflicts: hit };
  if (hit.length) return { status: 'BUSY' as const, reason: `Assigned to ${hit.map((h) => `${h.reference_no} (${timeIST(h.start)}–${timeIST(h.end)})`).join(', ')}`, conflicts: hit };
  return { status: 'AVAILABLE' as const, reason: null, conflicts: [] as Busy[] };
}

/** Whether every required seat can be filled by distinct available experts (small exact search). */
function canStaff(cands: Map<Seat, string[]>, fixed: Partial<Record<Seat, string>> = {}): boolean {
  const seats = REQUIRED_SEATS;
  const used = new Set(Object.values(fixed));
  const go = (i: number): boolean => {
    if (i === seats.length) return true;
    const seat = seats[i];
    if (fixed[seat]) return go(i + 1);
    for (const id of cands.get(seat) ?? []) {
      if (used.has(id)) continue;
      used.add(id);
      if (go(i + 1)) return true;
      used.delete(id);
    }
    return false;
  };
  return go(0);
}

export const NO_CAPACITY_MESSAGE = 'No eligible EVC committee members are available for the selected date and time. Please choose another date or time.';

/**
 * Availability of every registry official for [start, end). `excludeVisitId` ignores the visit being edited so its
 * own reservations do not count as conflicts.
 */
export async function availability(db: Db, start: string, end: string, excludeVisitId: string | null) {
  const s = new Date(start).getTime();
  const en = new Date(end).getTime();
  if (!(en > s)) throw new HttpError(400, 'INVALID_TIME_RANGE', 'The end time must be after the start time.');
  const buffer = (await getPolicy(db, 'EVC_SCHEDULING_BUFFER_MINUTES')).value * 60000;
  const dayStart = new Date(new Date(start).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const experts = await db.query<Expert & Record<string, unknown>>('SELECT * FROM evc_experts ORDER BY active DESC, full_name');
  const busy = await loadBusy(db, new Date(Math.min(s - buffer, dayStart.getTime())), new Date(Math.max(en + buffer, dayEnd.getTime())));
  const officials: OfficialAvailability[] = experts.map((e) => {
    const st = statusFor(e, busy, s - buffer, en + buffer, excludeVisitId);
    const elig = Object.fromEntries(['ACADEMICIAN', 'EXPERT', 'ARCHITECT_PLANNING', 'CO_OPTED', 'CHAIRMAN_DEEMED_UNIVERSITY'].map((seat) => [seat, seatEligibility(e, seat as Seat)])) as OfficialAvailability['seatEligibility'];
    const day = busy.filter((b) => b.kind === 'ASSIGNMENT' && (b.user_id === e.user_id || b.expert_id === e.id) && overlaps(new Date(b.start).getTime(), new Date(b.end).getTime(), dayStart.getTime(), dayEnd.getTime()));
    return {
      ...e,
      status: st.status,
      reason: st.reason,
      conflicts: st.conflicts.map((c) => ({ visitId: c.visit_id, referenceNo: c.reference_no, institution: c.institution_name, start: c.start, end: c.end, responseStatus: c.response_status, kind: c.kind })),
      dayAssignments: day.map((c) => ({ visitId: c.visit_id, referenceNo: c.reference_no, institution: c.institution_name, start: c.start, end: c.end, responseStatus: c.response_status })),
      eligibleSeats: (Object.keys(elig) as Seat[]).filter((k) => elig[k].outcome === 'PASS'),
      seatEligibility: elig,
    };
  });
  const cands = new Map<Seat, string[]>(REQUIRED_SEATS.map((seat) => [seat, officials.filter((o) => o.status === 'AVAILABLE' && o.eligibleSeats.includes(seat)).map((o) => o.id)]));
  const satisfiable = canStaff(cands);
  return {
    officials,
    capacity: {
      satisfiable,
      bySeat: Object.fromEntries(REQUIRED_SEATS.map((seat) => [seat, cands.get(seat)!.length])),
      message: satisfiable ? null : NO_CAPACITY_MESSAGE,
    },
    bufferMinutes: buffer / 60000,
  };
}

/**
 * Alternative slots of the same duration within the operational suggestion window. A slot is offered when the
 * proposed panel (if any) is fully available, otherwise when the required seats can still be staffed.
 */
export async function alternativeSlots(db: Db, start: string, end: string, excludeVisitId: string | null, panel: Array<{ expertId: string; seat: Seat }>, limit = 4) {
  const dur = new Date(end).getTime() - new Date(start).getTime();
  if (!(dur > 0)) return [];
  const [buf, wStart, wEnd, days] = await Promise.all([
    getPolicy(db, 'EVC_SCHEDULING_BUFFER_MINUTES'),
    getPolicy(db, 'EVC_SLOT_WINDOW_START_HOUR'),
    getPolicy(db, 'EVC_SLOT_WINDOW_END_HOUR'),
    getPolicy(db, 'EVC_ALTERNATIVE_SEARCH_DAYS'),
  ]);
  const buffer = buf.value * 60000;
  const day0 = new Date(start).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const from = new Date(`${day0}T00:00:00+05:30`);
  const to = new Date(from.getTime() + (days.value + 1) * 86400000);
  const experts = await db.query<Expert>('SELECT * FROM evc_experts');
  const busy = await loadBusy(db, from, to);
  const now = Date.now();
  const out: Array<{ start: string; end: string; panelAvailable: boolean; basis: string }> = [];
  for (let d = 0; d <= days.value && out.length < limit; d++) {
    const date = new Date(from.getTime() + d * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    for (let m = wStart.value * 60; m + dur / 60000 <= wEnd.value * 60 && out.length < limit; m += 30) {
      const s = new Date(`${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+05:30`).getTime();
      const en = s + dur;
      if (s <= now || s === new Date(start).getTime()) continue;
      const avail = (e: Expert) => statusFor(e, busy, s - buffer, en + buffer, excludeVisitId).status === 'AVAILABLE';
      if (panel.length) {
        const ok = panel.every((p) => {
          const e = experts.find((x) => x.id === p.expertId);
          return !!e && avail(e);
        });
        if (ok) out.push({ start: new Date(s).toISOString(), end: new Date(en).toISOString(), panelAvailable: true, basis: `All ${panel.length} panel members available` });
      } else {
        const cands = new Map<Seat, string[]>(REQUIRED_SEATS.map((seat) => [seat, experts.filter((e) => avail(e) && seatEligibility(e, seat).outcome === 'PASS').map((e) => e.id)]));
        if (canStaff(cands)) out.push({ start: new Date(s).toISOString(), end: new Date(en).toISOString(), panelAvailable: false, basis: 'Required committee seats can be staffed' });
      }
      if (out.length && out.at(-1)!.start === new Date(s).toISOString()) m += dur / 60000 - 30; // next suggestion after this slot
    }
  }
  return out;
}

// ------------------------------------------------------------------ composition

export async function checkComposition(db: Db, members: Array<{ expertId: string; seat: Seat }>) {
  const experts = await db.query<Expert>('SELECT * FROM evc_experts WHERE id = ANY($1)', [members.map((m) => m.expertId)]);
  if (members.some((m) => !experts.some((e) => e.id === m.expertId))) throw new HttpError(400, 'UNKNOWN_EXPERT', 'One or more officials are not in the registry.');
  const proposed = members.map((m) => ({ expert: experts.find((e) => e.id === m.expertId)!, seat: m.seat }));
  return { ...validateComposition(proposed, { deemedUniversity: null }), experts };
}

/** Current committee: active, not rejected (rejected seats must be replaced). */
async function currentCommittee(db: Db, visitId: string) {
  return db.query<{ user_id: string; expert_id: string | null; seat: Seat | null; response_status: string }>(
    "SELECT user_id, expert_id, seat, response_status FROM evc_visit_members WHERE visit_id = $1 AND active AND response_status <> 'REJECTED'",
    [visitId],
  );
}

// ------------------------------------------------------------------ assignment status

export const ASSIGNMENT_STATUSES = ['DRAFT', 'PENDING_RESPONSES', 'PARTIALLY_ACCEPTED', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'RESCHEDULING_REQUIRED', 'IN_PROGRESS', 'REPORTS_PENDING', 'COMPLETED', 'CANCELLED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * Assignment (committee) status, derived from the visit lifecycle and the members' independent responses — a single
 * source of truth, so one member's response can never overwrite another's.
 */
export function assignmentStatus(visit: { status: string; invitations_sent_at?: string | null }, members: Array<{ active: boolean; response_status: string }>, reportCount: number): AssignmentStatus {
  if (visit.status === 'CANCELLED') return 'CANCELLED';
  if (visit.status === 'COMPLETED') return reportCount > 0 ? 'COMPLETED' : 'REPORTS_PENDING';
  if (visit.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (visit.status === 'MISSED') return 'RESCHEDULING_REQUIRED';
  const act = members.filter((m) => m.active);
  if (!act.length || !visit.invitations_sent_at) return 'DRAFT';
  if (act.some((m) => ['REJECTED', 'CONFLICT_REPORTED', 'WITHDRAWAL_REQUESTED'].includes(m.response_status))) return 'RESCHEDULING_REQUIRED';
  const accepted = act.filter((m) => m.response_status === 'ACCEPTED').length;
  if (accepted === act.length) return visit.status === 'SCHEDULED' ? 'CONFIRMED' : 'AWAITING_CONFIRMATION';
  return accepted > 0 ? 'PARTIALLY_ACCEPTED' : 'PENDING_RESPONSES';
}

// ------------------------------------------------------------------ notifications to the region's Regional Officers

export async function notifyRegionalOfficers(t: Db, appId: string, eventType: string, title: string, message: string, key: string) {
  const ros = await t.query<{ user_id: string }>(
    `SELECT ur.user_id FROM user_regions ur JOIN user_roles r ON r.user_id = ur.user_id AND r.role = 'REGIONAL_OFFICER' JOIN applications a ON a.id = $1 JOIN institutions i ON i.id = a.institution_id WHERE ur.region_code = i.region_code`,
    [appId],
  );
  for (const x of ros) await notify(t, { recipientUserId: x.user_id, applicationId: appId, eventType, title, message, dedupeKey: key });
}

const reserved = (start: string, end: string, bufferMin: number) => `[${new Date(new Date(start).getTime() - bufferMin * 60000).toISOString()},${new Date(new Date(end).getTime() + bufferMin * 60000).toISOString()})`;

async function history(t: Db, visitId: string, prev: { start: string | null; end: string | null; status: string | null }, next: { start: string | null; end: string | null; status: string | null }, version: number, actor: string | null, reason: string | null) {
  await t.query(
    'INSERT INTO evc_schedule_history(visit_id, previous_start, previous_end, new_start, new_end, previous_status, new_status, schedule_version, actor_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [visitId, prev.start, prev.end, next.start, next.end, prev.status, next.status, version, actor, reason],
  );
}

/** Re-checks each official's eligibility and availability inside the transaction (Rule C / D). */
async function assertBookable(t: Db, visit: { id: string; scheduled_start: string; scheduled_end: string }, members: Array<{ expertId: string; seat: Seat }>) {
  const av = await availability(t, visit.scheduled_start, visit.scheduled_end, visit.id);
  const problems = members
    .map((m) => {
      const o = av.officials.find((x) => x.id === m.expertId);
      if (!o) return `Unknown official ${m.expertId}.`;
      if (o.status !== 'AVAILABLE') return `${o.full_name} (${o.member_code}): ${o.status.toLowerCase().replace('_', ' ')} — ${o.reason}`;
      const el = o.seatEligibility[m.seat];
      if (m.seat !== 'CO_OPTED' && el.outcome !== 'PASS') return `${o.full_name} is not eligible for the ${m.seat.toLowerCase().replace(/_/g, ' ')} seat: ${el.reasons.join(' ')}`;
      return null;
    })
    .filter(Boolean) as string[];
  if (problems.length) throw new HttpError(409, 'MEMBER_UNAVAILABLE', 'One or more selected officials cannot take this slot.', problems);
  return av;
}

// ------------------------------------------------------------------ invitations (create / replace)

/**
 * Sends (or re-sends after replacement) invitations for the visit's current time range. Idempotent: officials already
 * holding the slot are kept without a new notification; removed officials are released and told.
 */
export async function sendInvitations(t: Db, u: AuthUser, app: { id: string; reference_no: string | null; status: string; institution_id: string }, members: Array<{ expertId: string; seat: Seat }>, reason: string | null) {
  if (!['AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED'].includes(app.status)) throw new HttpError(409, 'WRONG_STAGE', 'Invitations are sent before the visit starts.');
  const v = await t.one<{ id: string; scheduled_start: string; scheduled_end: string | null; status: string; schedule_version: number; invitations_sent_at: string | null }>(
    "SELECT id, scheduled_start, scheduled_end, status, schedule_version, invitations_sent_at FROM evc_visits WHERE application_id = $1 AND status IN ('PROPOSED','SCHEDULED','RESCHEDULED') ORDER BY scheduled_at DESC LIMIT 1 FOR UPDATE",
    [app.id],
  );
  if (!v) throw new HttpError(409, 'NO_VISIT', 'Save the proposed visit (date, start and end time) first.');
  if (!v.scheduled_end) throw new HttpError(409, 'END_TIME_REQUIRED', 'Set the visit end time before inviting the committee.');
  const changingConfirmed = v.status !== 'PROPOSED';
  if (changingConfirmed && (!reason || reason.trim().length < 5)) throw new HttpError(400, 'REASON_REQUIRED', 'Replacing members of a confirmed visit requires a reason.');
  const comp = await checkComposition(t, members);
  if (!comp.valid) throw new HttpError(409, 'COMPOSITION_INVALID', 'The committee does not satisfy the required composition.', comp.findings.filter((f) => f.blocking));

  const current = await t.query<{ user_id: string; expert_id: string | null; response_status: string; active: boolean; invited_version: number | null; full_name: string }>(
    'SELECT m.user_id, m.expert_id, m.response_status, m.active, m.invited_version, uu.full_name FROM evc_visit_members m JOIN users uu ON uu.id = m.user_id WHERE m.visit_id = $1',
    [v.id],
  );
  const keep = new Set(members.map((m) => m.expertId));
  const holding = (r: { active: boolean; response_status: string }) => r.active && HOLDING.includes(r.response_status);
  // A decline stands for the time it was given; re-inviting the same official is possible only for a new time (reschedule).
  const decliners = current.filter((c) => c.response_status === 'REJECTED' && c.invited_version === v.schedule_version && c.expert_id && keep.has(c.expert_id));
  if (decliners.length) throw new HttpError(409, 'MEMBER_DECLINED', 'An official who declined this slot cannot be re-invited to the same time. Choose another official or reschedule.', decliners.map((d) => `${d.full_name} declined this slot`));
  const newcomers = members.filter((m) => !current.some((c) => c.expert_id === m.expertId && holding(c)));
  if (newcomers.length) await assertBookable(t, { id: v.id, scheduled_start: v.scheduled_start, scheduled_end: v.scheduled_end }, newcomers);
  // Kept members must also still be eligible for the seat they now occupy.
  for (const m of members) {
    const e = comp.experts.find((x) => x.id === m.expertId)!;
    if (m.seat !== 'CO_OPTED' && seatEligibility(e, m.seat).outcome !== 'PASS') throw new HttpError(409, 'MEMBER_NOT_ELIGIBLE', `${e.full_name} is not eligible for the selected seat.`);
  }
  const buffer = (await getPolicy(t, 'EVC_SCHEDULING_BUFFER_MINUTES')).value;
  const ack = await getPolicy(t, 'EVC_ACK_FOLLOWUP_HOURS');
  const range = reserved(v.scheduled_start, v.scheduled_end, buffer);
  const when = slotLabel(v.scheduled_start, v.scheduled_end);
  const invited: string[] = [];
  const removed: string[] = [];

  for (const c of current)
    if (c.active && (!c.expert_id || !keep.has(c.expert_id))) {
      await t.query('UPDATE evc_visit_members SET active = false, reserved_period = NULL, removed_at = now(), removed_reason = $3 WHERE visit_id = $1 AND user_id = $2', [v.id, c.user_id, reason ?? 'Committee revised before confirmation']);
      await t.query("UPDATE deadlines SET status = 'CANCELLED', completed_at = now() WHERE subject_type = 'EVC_ACKNOWLEDGEMENT' AND subject_id = $1 AND status IN ('OPEN','OVERDUE')", [`${v.id}:${c.user_id}`]);
      await notify(t, { recipientUserId: c.user_id, applicationId: app.id, eventType: 'EVC_UNASSIGNED', title: `Released from EVC ${app.reference_no}`, message: `You are no longer on the committee for the ${when} visit. ${reason ?? ''}`.trim(), dedupeKey: `visit:${v.id}:removed:${c.user_id}:v${v.schedule_version}` });
      removed.push(c.user_id);
    }

  for (const m of members) {
    const e = comp.experts.find((x) => x.id === m.expertId)!;
    const existing = current.find((c) => c.user_id === e.user_id);
    if (existing && holding(existing)) {
      await t.query('UPDATE evc_visit_members SET seat = $3, expert_id = $4 WHERE visit_id = $1 AND user_id = $2', [v.id, e.user_id, m.seat, e.id]);
      continue;
    }
    await t.query(
      `INSERT INTO evc_visit_members(visit_id, user_id, assigned_by, expert_id, seat, response_status, active, assigned_at, reserved_period, invited_version, responded_at, rejection_reason, conflict_note)
       VALUES ($1,$2,$3,$4,$5,'INVITED',true,now(),$6::tstzrange,$7,NULL,NULL,NULL)
       ON CONFLICT (visit_id, user_id) DO UPDATE SET active = true, removed_at = NULL, removed_reason = NULL, seat = EXCLUDED.seat, expert_id = EXCLUDED.expert_id,
         response_status = 'INVITED', responded_at = NULL, rejection_reason = NULL, conflict_note = NULL, assigned_by = EXCLUDED.assigned_by, assigned_at = now(),
         reserved_period = EXCLUDED.reserved_period, invited_version = EXCLUDED.invited_version`,
      [v.id, e.user_id, u.id, e.id, m.seat, range, v.schedule_version],
    );
    await t.query(
      `INSERT INTO deadlines(subject_type, subject_id, application_id, visit_id, responsible_role, responsible_user_id, due_at, source_type, source_reference, policy_key, policy_version)
       VALUES ('EVC_ACKNOWLEDGEMENT',$1,$2,$3,'EVC_MEMBER',$4, now() + ($5 || ' hours')::interval, 'AUTHORISED_OPERATIONAL_CONFIGURATION',$6,$7,$8)
       ON CONFLICT (subject_type, subject_id) DO UPDATE SET status = 'OPEN', due_at = EXCLUDED.due_at, completed_at = NULL`,
      [`${v.id}:${e.user_id}`, app.id, v.id, e.user_id, String(ack.value), policyLabel(ack), ack.key, ack.version],
    );
    await notify(t, {
      recipientUserId: e.user_id!,
      applicationId: app.id,
      eventType: 'EVC_ASSIGNED',
      title: `EVC invitation: ${app.reference_no}`,
      message: `You are invited as ${m.seat.replace(/_/g, ' ').toLowerCase()} for the visit on ${when}. Accept or decline in your EVC workspace.`,
      dedupeKey: `visit:${v.id}:invite:${e.user_id}:v${v.schedule_version}`,
    });
    invited.push(e.user_id!);
  }
  const first = !v.invitations_sent_at;
  await t.query('UPDATE evc_visits SET invitations_sent_at = coalesce(invitations_sent_at, now()), draft_panel = NULL, composition = $2, updated_at = now() WHERE id = $1', [
    v.id,
    JSON.stringify({ valid: comp.valid, findings: comp.findings, checkedAt: new Date().toISOString(), procedure: 'Portal operational: Regional Officer selection from the verified registry' }),
  ]);
  if (first) await history(t, v.id, { start: v.scheduled_start, end: v.scheduled_end, status: 'DRAFT' }, { start: v.scheduled_start, end: v.scheduled_end, status: 'PENDING_RESPONSES' }, v.schedule_version, u.id, 'Invitations sent');
  await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [v.id, first ? 'INVITATIONS_SENT' : 'COMMITTEE_REVISED', u.id, JSON.stringify({ members, invited, removed, reason })]);
  await recordOfficerAction(t, u, app.id, 'SEND_EVC_INVITATIONS', reason, { visitId: v.id, members, invited, removed });
  return { visitId: v.id, invited: invited.length, removed: removed.length, findings: comp.findings };
}

// ------------------------------------------------------------------ member responses

export async function respond(t: Db, u: AuthUser, visitId: string, to: 'ACCEPTED' | 'REJECTED' | 'CONFLICT_REPORTED' | 'WITHDRAWAL_REQUESTED', note: string | null) {
  const v = await t.one<{ id: string; application_id: string; status: string; scheduled_start: string; scheduled_end: string | null; schedule_version: number; reference_no: string }>(
    'SELECT v.id, v.application_id, v.status, v.scheduled_start, v.scheduled_end, v.schedule_version, a.reference_no FROM evc_visits v JOIN applications a ON a.id = v.application_id WHERE v.id = $1 FOR UPDATE OF v',
    [visitId],
  );
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
  const m = await t.one<{ response_status: string; active: boolean }>('SELECT response_status, active FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2 FOR UPDATE', [visitId, u.id]);
  if (!m || !m.active) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
  if (!['PROPOSED', 'SCHEDULED', 'RESCHEDULED'].includes(v.status)) throw new HttpError(409, 'WRONG_STAGE', 'Responses are recorded before the visit takes place.');
  if (m.response_status === to) throw new HttpError(409, 'ALREADY_RECORDED', `Your response is already recorded as ${to.toLowerCase().replace('_', ' ')}.`);
  if (!RESPONSE_TRANSITIONS[m.response_status]?.includes(to))
    throw new HttpError(409, 'INVALID_RESPONSE', `A ${m.response_status.toLowerCase().replace('_', ' ')} assignment cannot be changed to ${to.toLowerCase().replace('_', ' ')}. Contact the Regional Officer.`);
  if ((to === 'REJECTED' || to === 'CONFLICT_REPORTED' || to === 'WITHDRAWAL_REQUESTED') && (!note || note.trim().length < 5)) throw new HttpError(400, 'REASON_REQUIRED', 'Give a reason (at least 5 characters).');
  await t.query(
    `UPDATE evc_visit_members SET response_status = $3, responded_at = now(),
       rejection_reason = CASE WHEN $3 = 'REJECTED' THEN $4 ELSE rejection_reason END,
       conflict_note = CASE WHEN $3 IN ('CONFLICT_REPORTED','WITHDRAWAL_REQUESTED') THEN $4 ELSE conflict_note END,
       reserved_period = CASE WHEN $3 = 'REJECTED' THEN NULL ELSE reserved_period END
     WHERE visit_id = $1 AND user_id = $2`,
    [visitId, u.id, to, note],
  );
  if (to === 'ACCEPTED' || to === 'REJECTED') await t.query("UPDATE deadlines SET status = 'MET', completed_at = now() WHERE subject_type = 'EVC_ACKNOWLEDGEMENT' AND subject_id = $1 AND status <> 'CANCELLED'", [`${visitId}:${u.id}`]);
  await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [visitId, `MEMBER_${to}`, u.id, JSON.stringify({ note })]);
  const when = slotLabel(v.scheduled_start, v.scheduled_end);
  const label = { ACCEPTED: 'accepted', REJECTED: 'declined', CONFLICT_REPORTED: 'reported a scheduling conflict for', WITHDRAWAL_REQUESTED: 'requested withdrawal from' }[to];
  await notifyRegionalOfficers(t, v.application_id, `EVC_MEMBER_${to}`, `${v.reference_no}: ${u.fullName} ${label} the visit`, `${when}.${note ? ` Reason: ${note}.` : ''}${to === 'ACCEPTED' ? '' : ' Replace the member or reschedule.'}`, `visit:${visitId}:resp:${u.id}:${to}:v${v.schedule_version}`);
  const members = await t.query<{ active: boolean; response_status: string }>('SELECT active, response_status FROM evc_visit_members WHERE visit_id = $1', [visitId]);
  const vis = await t.one<{ status: string; invitations_sent_at: string | null }>('SELECT status, invitations_sent_at FROM evc_visits WHERE id = $1', [visitId]);
  const st = assignmentStatus(vis!, members, 0);
  if (st === 'AWAITING_CONFIRMATION')
    await notifyRegionalOfficers(t, v.application_id, 'EVC_COMMITTEE_ACCEPTED', `${v.reference_no}: whole committee accepted`, `All members accepted the ${when} visit. Confirm the visit to notify the institution.`, `visit:${visitId}:all-accepted:v${v.schedule_version}`);
  if (st === 'RESCHEDULING_REQUIRED' && to === 'REJECTED')
    await notifyRegionalOfficers(t, v.application_id, 'EVC_COMMITTEE_INCOMPLETE', `${v.reference_no}: committee incomplete`, 'A seat is vacant after a declined invitation. Replace the member or reschedule; nothing changes until you act.', `visit:${visitId}:incomplete:${u.id}:v${v.schedule_version}`);
  return { responseStatus: to, assignmentStatus: st };
}

// ------------------------------------------------------------------ confirmation, rescheduling, cancellation

/** A visit is confirmed only after every current committee member has accepted and the composition is valid. */
export async function assertReadyToConfirm(t: Db, visitId: string) {
  const all = await t.query<{ response_status: string; active: boolean }>('SELECT response_status, active FROM evc_visit_members WHERE visit_id = $1', [visitId]);
  const act = all.filter((m) => m.active);
  if (!act.length) throw new HttpError(409, 'NO_COMMITTEE', 'Invite the committee before confirming the visit.');
  if (act.some((m) => m.response_status === 'REJECTED')) throw new HttpError(409, 'COMMITTEE_INCOMPLETE', 'A member declined. Replace the member before confirming.');
  const pending = act.filter((m) => m.response_status !== 'ACCEPTED');
  if (pending.length) throw new HttpError(409, 'RESPONSES_PENDING', `${pending.length} committee member(s) have not accepted yet. A visit is confirmed only after every member accepts.`);
  const comm = await currentCommittee(t, visitId);
  if (comm.some((m) => !m.expert_id || !m.seat)) throw new HttpError(409, 'COMMITTEE_NOT_FROM_REGISTRY', 'Every member must be selected from the verified registry with a seat.');
  const comp = await checkComposition(t, comm.map((m) => ({ expertId: m.expert_id!, seat: m.seat! })));
  if (!comp.valid) throw new HttpError(409, 'COMPOSITION_INVALID', 'The committee does not satisfy the required composition.', comp.findings.filter((f) => f.blocking));
  return comp;
}

/**
 * Moves the visit to a new time range. Every holding member's reservation moves atomically (the exclusion
 * constraint re-checks each one), responses reset to INVITED and everyone is notified of the new version.
 */
export async function moveVisit(t: Db, u: AuthUser, app: { id: string; reference_no: string | null; institution_id: string }, visitId: string, start: string, end: string, reason: string) {
  const v = await t.one<{ id: string; scheduled_start: string; scheduled_end: string | null; status: string; schedule_version: number; invitations_sent_at: string | null }>(
    'SELECT id, scheduled_start, scheduled_end, status, schedule_version, invitations_sent_at FROM evc_visits WHERE id = $1 FOR UPDATE',
    [visitId],
  );
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'Visit not found.');
  if (!(new Date(end) > new Date(start))) throw new HttpError(400, 'INVALID_TIME_RANGE', 'The end time must be after the start time.');
  if (new Date(start) <= new Date()) throw new HttpError(400, 'PAST_TIME', 'Choose a future time.');
  const holders = await t.query<{ user_id: string; expert_id: string | null; seat: Seat | null }>(
    `SELECT user_id, expert_id, seat FROM evc_visit_members WHERE visit_id = $1 AND active AND response_status = ANY($2)`,
    [visitId, HOLDING],
  );
  const next = { ...v, scheduled_start: start, scheduled_end: end };
  if (holders.length) await assertBookable(t, next as { id: string; scheduled_start: string; scheduled_end: string }, holders.filter((h) => h.expert_id && h.seat).map((h) => ({ expertId: h.expert_id!, seat: h.seat! })));
  const buffer = (await getPolicy(t, 'EVC_SCHEDULING_BUFFER_MINUTES')).value;
  const version = v.schedule_version + 1;
  const newStatus = v.status === 'PROPOSED' ? 'PROPOSED' : 'RESCHEDULED';
  await t.query('UPDATE evc_visits SET scheduled_start = $2, scheduled_end = $3, status = $4, status_note = $5, schedule_version = $6, updated_at = now() WHERE id = $1', [visitId, start, end, newStatus, reason, version]);
  await t.query(
    `UPDATE evc_visit_members SET reserved_period = $2::tstzrange, response_status = 'INVITED', responded_at = NULL, conflict_note = NULL, invited_version = $3
     WHERE visit_id = $1 AND active AND response_status = ANY($4)`,
    [visitId, reserved(start, end, buffer), version, HOLDING],
  );
  await history(t, visitId, { start: v.scheduled_start, end: v.scheduled_end, status: v.status }, { start, end, status: newStatus }, version, u.id, reason);
  await t.query('INSERT INTO evc_visit_events(visit_id, event, actor_id, details) VALUES ($1,$2,$3,$4)', [visitId, 'RESCHEDULED', u.id, JSON.stringify({ start, end, reason, version })]);
  const when = slotLabel(start, end);
  for (const h of holders)
    await notify(t, { recipientUserId: h.user_id, applicationId: app.id, eventType: 'EVC_RESCHEDULED', title: `EVC rescheduled: ${app.reference_no}`, message: `New time ${when}. Reason: ${reason}. Please accept or decline the revised time.`, dedupeKey: `visit:${visitId}:invite:${h.user_id}:v${version}` });
  return { version, status: newStatus, membersReinvited: holders.length };
}

/** Releases every reservation of a visit (cancelled / missed). */
export async function releaseReservations(t: Db, visitId: string) {
  await t.query('UPDATE evc_visit_members SET reserved_period = NULL WHERE visit_id = $1', [visitId]);
}

export const MEMBER_STATUSES = ['INVITED', 'ACCEPTED', 'VISIT_SCHEDULED', 'VISIT_IN_PROGRESS', 'VISIT_COMPLETED', 'REPORT_DRAFT', 'REPORT_SUBMITTED', 'REPORT_OVERDUE', 'VISIT_MISSED', 'HUMAN_REVIEW_REQUIRED', 'DECLINED', 'REMOVED', 'CANCELLED'] as const;

/** Derived per-member status. A visit is never treated as completed or missed because its time has passed. */
export function memberStatus(m: { active: boolean; response_status: string }, v: { status: string }, x: { reportSubmitted: boolean; draft: boolean; reportDueAt: string | null; now?: Date }) {
  if (!m.active) return 'REMOVED';
  if (v.status === 'CANCELLED') return 'CANCELLED';
  if (m.response_status === 'REJECTED') return 'DECLINED';
  if (['CONFLICT_REPORTED', 'WITHDRAWAL_REQUESTED'].includes(m.response_status)) return 'HUMAN_REVIEW_REQUIRED';
  if (v.status === 'MISSED') return 'VISIT_MISSED';
  if (x.reportSubmitted) return 'REPORT_SUBMITTED';
  if (v.status === 'COMPLETED') {
    if (x.reportDueAt && new Date(x.reportDueAt) < (x.now ?? new Date())) return 'REPORT_OVERDUE';
    return x.draft ? 'REPORT_DRAFT' : 'VISIT_COMPLETED';
  }
  if (v.status === 'IN_PROGRESS') return x.draft ? 'REPORT_DRAFT' : 'VISIT_IN_PROGRESS';
  if (m.response_status === 'INVITED') return 'INVITED';
  if (v.status === 'SCHEDULED') return 'VISIT_SCHEDULED';
  return 'ACCEPTED';
}

/**
 * EVC report sections — taken from what APH Ch. I §1.9(c)-(g) says the EVC verifies. Each section records
 * the committee's finding; FlowGuard does not score or decide anything from them.
 */
export const REPORT_SECTIONS = [
  { key: 'INSTRUCTIONAL', label: 'Instructional area readiness' },
  { key: 'ADMINISTRATIVE', label: 'Administrative area readiness' },
  { key: 'AMENITIES', label: 'Amenities' },
  { key: 'LAB_EQUIPMENT', label: 'Laboratory equipment as per curriculum and syllabus' },
  { key: 'DOCUMENTS', label: 'Relevant documents' },
  { key: 'ESSENTIAL_DESIRABLE', label: 'Essential and desirable requirements' },
  { key: 'FACULTY', label: 'Appointment of Principal / Director and faculty against norms' },
  { key: 'COMPUTING_LIBRARY', label: 'Computers, software, internet, printers, books, journals and stock registers' },
  { key: 'VIDEO_RECORDING', label: 'Institution video recording of the visit / facilities (link shared)' },
] as const;
export const SECTION_FINDINGS = ['VERIFIED_AVAILABLE', 'DEFICIENT', 'NOT_VERIFIED', 'NOT_APPLICABLE'] as const;
/** Kinds of material a member attaches to the report (labels only; FlowGuard does not score them). */
export const EVIDENCE_CATEGORIES = ['INSPECTION_REPORT', 'SUPPORTING_DOCUMENT', 'ATTENDANCE_SHEET', 'VISIT_PHOTO', 'VIDEO_RECORDING', 'OTHER'] as const;
/** Report documents (go with the final report) are kept apart from visit evidence (photos, video). */
export const REPORT_DOCUMENT_CATEGORIES = ['INSPECTION_REPORT', 'SUPPORTING_DOCUMENT', 'ATTENDANCE_SHEET'] as const;
/** File types accepted per category, checked from the file content. */
export const EVIDENCE_FILE_TYPES: Record<(typeof EVIDENCE_CATEGORIES)[number], string[]> = {
  INSPECTION_REPORT: ['pdf'],
  SUPPORTING_DOCUMENT: ['pdf', 'jpg', 'png'],
  ATTENDANCE_SHEET: ['pdf', 'jpg', 'png'],
  VISIT_PHOTO: ['jpg', 'png'],
  VIDEO_RECORDING: ['mp4', 'mov', 'webm'],
  OTHER: ['pdf', 'jpg', 'png'],
};
