import type { Tone } from '../../components/ui';

/** Shared IST date helpers and coordination labels for the EVC scheduling screens. */
export const IST = 'Asia/Kolkata';
/** Calendar date (YYYY-MM-DD) of an instant in IST. */
export const istDay = (v: string | Date) => new Date(v).toLocaleDateString('en-CA', { timeZone: IST });
export const istTime = (v: string) => new Date(v).toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });
/** HH:MM (24 h) in IST — the value of an <input type="time">. */
export const istHHMM = (v: string) => istTime(v).slice(0, 5);
export const istLongDate = (v: string) => new Date(v).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const istRange = (s: string, e: string | null) => `${istTime(s)}${e ? ` – ${istTime(e)}` : ''} IST`;
/** ISO instant for a YYYY-MM-DD date and HH:MM time in IST. */
export const fromIST = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
export const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00+05:30`);
  x.setUTCDate(x.getUTCDate() + n);
  return istDay(x);
};
export const mondayOf = (d: string) => {
  const dow = new Date(`${d}T12:00:00+05:30`).getUTCDay(); // 0 = Sunday
  return addDays(d, dow === 0 ? -6 : 1 - dow);
};
export const modeLabel = (m: string) => (m === 'ONLINE' ? 'Virtual' : 'Physical');

/** Assignment status (derived on the server) → what the coordinator sees. */
export function coordination(status: string, conflicts: string[] = []): { label: string; tone: Tone } {
  if (status === 'NOT_SCHEDULED') return { label: 'Not scheduled', tone: 'slate' };
  if (status === 'DRAFT') return conflicts.length ? { label: 'Proposed slot · Conflict', tone: 'red' } : { label: 'Proposed · Not sent', tone: 'amber' };
  const map: Record<string, { label: string; tone: Tone }> = {
    PENDING_RESPONSES: { label: 'Awaiting responses', tone: 'amber' },
    PARTIALLY_ACCEPTED: { label: 'Partially accepted', tone: 'amber' },
    AWAITING_CONFIRMATION: { label: 'All accepted · Confirm', tone: 'blue' },
    RESCHEDULING_REQUIRED: { label: 'Action needed · Conflict', tone: 'red' },
    CONFIRMED: { label: 'Confirmed', tone: 'green' },
    IN_PROGRESS: { label: 'Visit in progress', tone: 'blue' },
    REPORTS_PENDING: { label: 'Report pending', tone: 'violet' },
    COMPLETED: { label: 'Completed', tone: 'green' },
    CANCELLED: { label: 'Cancelled', tone: 'slate' },
  };
  return map[status] ?? { label: status.replace(/_/g, ' ').toLowerCase(), tone: 'slate' };
}
export const hasConflict = (status: string, conflicts: string[] = []) => conflicts.length > 0 || status === 'RESCHEDULING_REQUIRED';
export const AWAITING = ['PENDING_RESPONSES', 'PARTIALLY_ACCEPTED', 'AWAITING_CONFIRMATION'];

/** Member response → pill. */
export function responsePill(r: string | null | undefined): { label: string; tone: Tone } {
  const map: Record<string, { label: string; tone: Tone }> = {
    INVITED: { label: 'Invited · Awaiting', tone: 'amber' },
    ACCEPTED: { label: 'Accepted', tone: 'green' },
    REJECTED: { label: 'Declined', tone: 'red' },
    CONFLICT_REPORTED: { label: 'Conflict reported', tone: 'red' },
    WITHDRAWAL_REQUESTED: { label: 'Withdrawal requested', tone: 'red' },
  };
  return map[r ?? ''] ?? { label: 'Not invited', tone: 'slate' };
}

export function icsFor(visits: Array<{ id: string; start: string; end: string | null; status: string; referenceNo: string; institution: string; mode: string }>) {
  const stamp = (v: string) => new Date(v).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AICTE Approval Portal//EVC schedule//EN'];
  for (const v of visits) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${v.id}@flowguard`,
      `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(v.start)}`,
      `DTEND:${stamp(v.end ?? new Date(new Date(v.start).getTime() + 3600000).toISOString())}`,
      `SUMMARY:${esc(`EVC visit · ${v.referenceNo} (${v.status === 'SCHEDULED' ? 'confirmed' : 'proposed'})`)}`,
      `DESCRIPTION:${esc(`${v.institution} · ${modeLabel(v.mode)}`)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
