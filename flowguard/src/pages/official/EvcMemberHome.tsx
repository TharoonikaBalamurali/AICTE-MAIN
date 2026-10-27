import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, Eye, MapPin, Video, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, inputCls, Kpi, KpiRow, PageHeader, PageNote, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime, useApi } from '../../lib/hooks';
import { addDays, istDay, istLongDate, istRange, istTime, mondayOf } from './evcCoord';
import { MEMBER_STATUS, SEAT_SHORT } from './EvcMember';

type Assignment = Record<string, any>;
const ON_SCHEDULE = ['INVITED', 'ACCEPTED', 'VISIT_SCHEDULED', 'VISIT_IN_PROGRESS', 'HUMAN_REVIEW_REQUIRED'];

/** One invitation with accept / decline in place. A decline needs a reason (it is sent to the Regional Officer). */
export function InvitationRow({ r, category, onOpen, onDone }: { r: Assignment; category?: string; onOpen: () => void; onDone: (text: string, kind?: 'success' | 'error') => void }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  async function send(response: 'ACCEPTED' | 'REJECTED') {
    setBusy(response);
    try {
      await api.post(`/api/evc/visits/${r.visit_id}/respond`, { response, ...(response === 'REJECTED' ? { reason } : {}) });
      onDone(response === 'ACCEPTED' ? `You accepted the ${r.reference_no} visit on ${istLongDate(r.scheduled_start)}.` : `You declined the ${r.reference_no} visit; your time has been released.`);
    } catch (e: any) {
      onDone(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }
  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-semibold text-brand-600">{r.reference_no}</span>
            <Badge t="amber">Invitation</Badge>
            {r.visit_status === 'RESCHEDULED' && <Badge t="violet">New time</Badge>}
          </div>
          <div className="mt-1 text-sm font-medium text-slate-900">{r.institution_name}</div>
          <div className="text-xs text-slate-500">{[category, r.district && `${r.district}, ${r.state}`].filter(Boolean).join(' · ')}</div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-slate-700">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5 text-slate-400" /> {istLongDate(r.scheduled_start)}</span>
            <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-slate-400" /> {istRange(r.scheduled_start, r.scheduled_end)}</span>
            <span className="inline-flex items-center gap-1.5">{r.mode === 'ONLINE' ? <Video className="h-3.5 w-3.5 text-slate-400" /> : <MapPin className="h-3.5 w-3.5 text-slate-400" />} {r.mode === 'ONLINE' ? 'Virtual' : 'Physical'}</span>
            <span>Seat: {SEAT_SHORT[r.seat] ?? '—'}</span>
          </div>
          {r.instructions && <p className="mt-2 max-w-2xl text-[13px] text-slate-600">“{r.instructions}”</p>}
          {r.ack_due_at && <div className="mt-1 text-xs text-slate-500">Please respond by {fmtDateTime(r.ack_due_at)}</div>}
        </div>
        <div className="flex flex-wrap gap-2 lg:shrink-0 lg:justify-end">
          <Button className="flex-1 sm:flex-none" loading={busy === 'ACCEPTED'} disabled={!!busy} onClick={() => send('ACCEPTED')}>
            <CheckCircle2 className="h-4 w-4" /> Accept
          </Button>
          <Button variant="secondary" className="flex-1 sm:flex-none" disabled={!!busy} onClick={() => setDeclining((x) => !x)}>
            <XCircle className="h-4 w-4" /> Decline
          </Button>
          <Button variant="ghost" className="flex-1 sm:flex-none" onClick={onOpen}>
            <Eye className="h-4 w-4" /> Details
          </Button>
        </div>
      </div>
      {declining && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <label htmlFor={`why-${r.visit_id}`} className="mb-1.5 block text-[13px] font-semibold text-slate-800">
            Reason for declining <span className="font-normal text-slate-400">(sent to the Regional Officer)</span>
          </label>
          <textarea id={`why-${r.visit_id}`} rows={2} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. on examination duty that day" />
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeclining(false)}>Cancel</Button>
            <Button variant="danger" disabled={reason.trim().length < 5} loading={busy === 'REJECTED'} onClick={() => send('REJECTED')}>
              Decline invitation
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Calendar colour and label for each of the member's visit states (literal classes so Tailwind keeps them). */
const CAL: Record<string, { label: string; card: string; pill: string; text: string; dot: string }> = {
  INVITED: { label: 'Invitation', card: 'border-amber-500 bg-amber-50', pill: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  ACCEPTED: { label: 'Accepted', card: 'border-emerald-500 bg-emerald-50', pill: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  VISIT_SCHEDULED: { label: 'Confirmed', card: 'border-brand-600 bg-brand-50', pill: 'bg-brand-50', text: 'text-brand-700', dot: 'bg-brand-600' },
  VISIT_IN_PROGRESS: { label: 'In progress', card: 'border-violet-500 bg-violet-50', pill: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500' },
  HUMAN_REVIEW_REQUIRED: { label: 'Change requested', card: 'border-rose-500 bg-rose-50', pill: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500' },
  DONE: { label: 'Completed', card: 'border-slate-400 bg-slate-100', pill: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400' },
};
const LEGEND = ['VISIT_SCHEDULED', 'ACCEPTED', 'INVITED', 'VISIT_IN_PROGRESS', 'HUMAN_REVIEW_REQUIRED', 'DONE'];
const DONE = ['VISIT_COMPLETED', 'REPORT_DRAFT', 'REPORT_SUBMITTED', 'REPORT_OVERDUE'];
const calOf = (s: string) => CAL[DONE.includes(s) ? 'DONE' : s] ?? CAL.DONE;

/** The member's own visits as a Mon–Fri week calendar, coloured by status. With `detail`, selecting a visit shows it alongside. */
export function MemberSchedule({ rows, detail = false }: { rows: Assignment[]; detail?: boolean }) {
  const nav = useNavigate();
  const today = istDay(new Date());
  const visits = useMemo(
    () => rows.filter((r) => r.active && (ON_SCHEDULE.includes(r.memberStatus) || DONE.includes(r.memberStatus))).sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start)),
    [rows],
  );
  const [week, setWeek] = useState(mondayOf(today));
  const [selId, setSelId] = useState<string | null>(null);
  const [positioned, setPositioned] = useState(false);
  useEffect(() => {
    if (positioned || rows.length === 0) return;
    const next = visits.find((v) => istDay(v.scheduled_start) >= today) ?? visits.at(-1);
    if (next) {
      setWeek(mondayOf(istDay(next.scheduled_start)));
      setSelId(next.visit_id);
    }
    setPositioned(true);
  }, [rows, visits, positioned, today]);
  const days = Array.from({ length: 5 }, (_, i) => addDays(week, i));
  const inWeek = visits.filter((v) => istDay(v.scheduled_start) >= week && istDay(v.scheduled_start) <= addDays(week, 6));
  const weekend = inWeek.filter((v) => !days.includes(istDay(v.scheduled_start)));
  const sel = visits.find((v) => v.visit_id === selId) ?? inWeek[0] ?? null;
  const label = `${new Date(`${week}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(`${addDays(week, 4)}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const calendar = (
    <Card className="min-w-0">
      <CardHeader
        title="Visit calendar"
        subtitle={`${label} · IST`}
        action={
          <div className="flex items-center gap-1">
            <button aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))} className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => setWeek(mondayOf(today))} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-600" /> Today
            </button>
            <button aria-label="Next week" onClick={() => setWeek(addDays(week, 7))} className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <div className="overflow-x-auto px-5 pb-5">
        <div className="grid min-w-[640px] grid-cols-5 overflow-hidden rounded-lg border border-slate-200">
          {days.map((d) => {
            const dt = new Date(`${d}T12:00:00+05:30`);
            const list = inWeek.filter((v) => istDay(v.scheduled_start) === d);
            const isToday = d === today;
            return (
              <div key={d} className="min-w-0 border-r border-slate-200 last:border-r-0">
                <div className={cx('border-b border-slate-200 px-3 py-2', isToday ? 'bg-brand-600' : 'bg-slate-50')}>
                  <div className={cx('text-[11px] font-semibold tracking-wide uppercase', isToday ? 'text-brand-100' : 'text-slate-500')}>{dt.toLocaleDateString('en-IN', { weekday: 'short' })}</div>
                  <div className={cx('text-sm font-semibold', isToday ? 'text-white' : 'text-slate-900')}>{dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
                </div>
                <div className={cx('min-h-[220px] space-y-2 p-2', isToday && 'bg-brand-50/40')}>
                  {list.map((v) => {
                    const c = calOf(v.memberStatus);
                    return (
                      <button
                        key={v.visit_id}
                        onClick={() => (detail ? setSelId(v.visit_id) : nav(`/official/visits/${v.visit_id}`))}
                        className={cx('w-full rounded-md border-l-[3px] px-2.5 py-2 text-left text-xs transition hover:shadow-sm', c.card, detail && sel?.visit_id === v.visit_id && 'ring-2 ring-brand-300')}
                      >
                        <div className="font-semibold text-slate-900">
                          {istTime(v.scheduled_start)}
                          {v.scheduled_end && `–${istTime(v.scheduled_end)}`}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-brand-700">{v.reference_no}</div>
                        <div className="truncate text-slate-600">{v.institution_name}</div>
                        <div className={cx('mt-1 font-semibold', c.text)}>{c.label}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
          {LEGEND.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className={cx('h-2.5 w-2.5 rounded-sm', CAL[k].dot)} /> {CAL[k].label}
            </span>
          ))}
          {weekend.length > 0 && <span>{weekend.length} weekend visit(s) this week.</span>}
        </div>
      </div>
    </Card>
  );
  if (!detail) return calendar;

  const c = sel ? calOf(sel.memberStatus) : CAL.DONE;
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      {calendar}
      <Card className="self-start">
        <CardHeader title="Selected visit" divided />
        {!sel ? (
          <Empty icon={<CalendarDays className="h-5 w-5" />} title="No visit selected">Your visits appear on the calendar as soon as you are invited.</Empty>
        ) : (
          <div className="space-y-4 p-5">
            <div>
              <div className="font-mono text-sm font-semibold text-brand-600">{sel.reference_no}</div>
              <div className="mt-0.5 text-sm text-slate-800">{sel.institution_name}</div>
              <div className="text-xs text-slate-500">{[sel.district, sel.state].filter(Boolean).join(', ')}</div>
            </div>
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', c.pill, c.text)}>
              <span className={cx('h-1.5 w-1.5 rounded-full', c.dot)} /> {(MEMBER_STATUS[sel.memberStatus] ?? [c.label])[0]}
            </span>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-xs text-slate-500">Date</div>
                <div className="mt-1 font-medium text-slate-900">{istLongDate(sel.scheduled_start)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Time</div>
                <div className="mt-1 font-medium text-slate-900">{istRange(sel.scheduled_start, sel.scheduled_end)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Your seat</div>
                <div className="mt-1 font-medium text-slate-900">{SEAT_SHORT[sel.seat] ?? '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Mode</div>
                <div className="mt-1 inline-flex items-center gap-1.5 font-medium text-slate-900">
                  {sel.mode === 'ONLINE' ? <Video className="h-3.5 w-3.5 text-slate-400" /> : <MapPin className="h-3.5 w-3.5 text-slate-400" />} {sel.mode === 'ONLINE' ? 'Virtual' : 'Physical'}
                </div>
              </div>
            </div>
            {sel.mode === 'ONLINE' && sel.meeting_link && (
              <a href={sel.meeting_link} target="_blank" rel="noreferrer noopener" className="block truncate text-sm font-medium text-brand-600 hover:underline">
                {sel.meeting_link}
              </a>
            )}
            {sel.instructions && <p className="rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-slate-600">“{sel.instructions}”</p>}
            {sel.memberStatus === 'INVITED' && sel.ack_due_at && <p className="text-xs text-amber-700">Please respond by {fmtDateTime(sel.ack_due_at)}</p>}
            <Button className="w-full" onClick={() => nav(`/official/visits/${sel.visit_id}`)}>
              {sel.memberStatus === 'INVITED' ? 'Respond to invitation' : DONE.includes(sel.memberStatus) || sel.memberStatus === 'VISIT_IN_PROGRESS' ? 'Open report workspace' : 'Open visit'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

/** "EVC schedule" for members: their own visits on a calendar. */
export function MemberSchedulePage() {
  const { data, error, loading } = useApi<{ assignments: Assignment[] }>('/api/evc/my-assignments');
  const rows = (data?.assignments ?? []).filter((r) => r.active);
  const today = istDay(new Date());
  const mon = mondayOf(today);
  const upcoming = rows.filter((r) => istDay(r.scheduled_start) >= today && ON_SCHEDULE.includes(r.memberStatus)).sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));
  return (
    <>
      <PageHeader crumbs={['Workspace', 'EVC schedule']} title="My EVC schedule" subtitle="Your Expert Visit Committee visits (IST)." />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Visits this week" value={rows.filter((r) => istDay(r.scheduled_start) >= mon && istDay(r.scheduled_start) <= addDays(mon, 6)).length} tone="blue" caption="Monday to Sunday" />
            <Kpi label="Invitations to answer" value={rows.filter((r) => r.memberStatus === 'INVITED').length} tone="amber" caption="Accept or decline" />
            <Kpi label="Confirmed upcoming" value={upcoming.filter((r) => r.memberStatus === 'VISIT_SCHEDULED').length} tone="green" caption="Everyone accepted" />
            <Kpi
              label="Next visit"
              value={upcoming[0] ? new Date(upcoming[0].scheduled_start).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) : '—'}
              caption={upcoming[0] ? istRange(upcoming[0].scheduled_start, upcoming[0].scheduled_end) : 'Nothing scheduled'}
            />
          </KpiRow>
          <MemberSchedule rows={data.assignments} detail />
        </>
      )}
      <PageNote>Need a different date? Decline the invitation with a reason, or add your unavailability under My assignments.</PageNote>
    </>
  );
}

