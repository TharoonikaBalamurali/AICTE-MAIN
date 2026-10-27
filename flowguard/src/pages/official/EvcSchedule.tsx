import { AlertTriangle, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Download, Plus, Video } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, Kpi, KpiRow, KV, PageHeader, PageNote, Spinner, Table, tdCls, TextLink } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { fmtDate, useApi } from '../../lib/hooks';
import { ColumnChart, SegmentBar } from '../../components/Charts';
import { MemberSchedulePage } from './EvcMemberHome';
import { addDays, AWAITING, coordination, hasConflict, icsFor, istDay, istLongDate, istRange, istTime, modeLabel, mondayOf } from './evcCoord';

interface CalVisit {
  id: string;
  applicationId: string;
  referenceNo: string;
  institution: string;
  status: string;
  mode: string;
  start: string;
  end: string | null;
  assignmentStatus: string;
  conflicts: string[];
}
interface ReadyApp {
  id: string;
  reference_no: string;
  status: string;
  institution_name: string;
  district: string | null;
  state: string | null;
  forwarded_on: string | null;
  forwarded_by: string | null;
  visit: { id: string; status: string; mode: string; start: string; end: string | null; meetingLink: string | null } | null;
  assignmentStatus: string;
  conflicts: string[];
}

export function EvcSchedule() {
  const { user } = useAuth();
  // Members see only their own visits, read-only; the coordinator view is for Regional Officers and oversight roles.
  if (user?.activeRole === 'EVC_MEMBER') return <MemberSchedulePage />;
  return <CoordinatorSchedule />;
}

function CoordinatorSchedule() {
  const nav = useNavigate();
  const { user } = useAuth();
  const isRO = user?.activeRole === 'REGIONAL_OFFICER';
  const data = useApi<{ applications: ReadyApp[]; visits: CalVisit[] }>('/api/evc/scheduler');
  const today = istDay(new Date());
  const [week, setWeek] = useState(mondayOf(today));
  const [selId, setSelId] = useState<string | null>(null);
  const [positioned, setPositioned] = useState(false);

  const visits = useMemo(() => (data.data?.visits ?? []).filter((v) => v.status !== 'CANCELLED'), [data.data]);
  const apps = data.data?.applications ?? [];
  const appById = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  // Open on the week of the next visit that needs attention (else the next upcoming one).
  useEffect(() => {
    if (positioned || !data.data) return;
    const upcoming = visits.filter((v) => istDay(v.start) >= today).sort((x, y) => x.start.localeCompare(y.start));
    const next = upcoming.find((v) => hasConflict(v.assignmentStatus, v.conflicts)) ?? upcoming[0];
    const dow = new Date(`${today}T12:00:00+05:30`).getUTCDay();
    setWeek(next ? mondayOf(istDay(next.start)) : dow === 0 || dow === 6 ? addDays(mondayOf(today), 7) : mondayOf(today));
    if (next) setSelId(next.id);
    setPositioned(true);
  }, [data.data, visits, positioned, today]);

  const days = Array.from({ length: 5 }, (_, i) => addDays(week, i));
  const inWeek = visits.filter((v) => istDay(v.start) >= week && istDay(v.start) <= addDays(week, 6));
  const weekend = inWeek.filter((v) => !days.includes(istDay(v.start)));
  // On a weekend "this week" means the coming working week.
  const kpiWeek = [0, 6].includes(new Date(`${today}T12:00:00+05:30`).getUTCDay()) ? addDays(mondayOf(today), 7) : mondayOf(today);
  const thisWeek = visits.filter((v) => istDay(v.start) >= kpiWeek && istDay(v.start) <= addDays(kpiWeek, 6));
  const sel = visits.find((v) => v.id === selId) ?? inWeek[0] ?? null;
  const selApp = sel ? appById.get(sel.applicationId) : undefined;
  const readyRows = apps.filter((a) => a.status === 'AWAITING_EVC_SCHEDULING' || hasConflict(a.assignmentStatus, a.conflicts));
  const weekLabel = `${new Date(`${week}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(`${addDays(week, 4)}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const schedule = (appId: string) => nav(`/official/evc/schedule/${appId}`);

  function exportIcs() {
    const rows = visits.filter((v) => istDay(v.start) >= today && !['COMPLETED', 'MISSED'].includes(v.status));
    const blob = new Blob([icsFor(rows)], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `flowguard-evc-schedule-${today}.ics`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'EVC scheduling']}
        title="EVC scheduling"
        subtitle="Coordinate visits for applications forwarded by authorised officials."
        action={
          <>
            <Button variant="secondary" disabled={visits.length === 0} onClick={exportIcs}>
              <Download className="h-4 w-4" /> Calendar export
            </Button>
            {isRO && (
              <Button disabled={readyRows.length === 0} onClick={() => readyRows[0] && schedule(readyRows[0].id)}>
                <Plus className="h-4 w-4" /> Schedule visit
              </Button>
            )}
          </>
        }
      />
      {data.loading && !data.data && <Spinner />}
      {data.error && <Alert kind="error">{data.error}</Alert>}
      {data.data && (
        <>
          <KpiRow>
            <Kpi label="Ready to schedule" value={apps.filter((a) => a.assignmentStatus === 'NOT_SCHEDULED' || a.assignmentStatus === 'DRAFT').length} tone="blue" caption="Forwarded, invitations not sent" />
            <Kpi label="Visits this week" value={thisWeek.length} caption={`${thisWeek.filter((v) => v.assignmentStatus === 'CONFIRMED').length} confirmed`} />
            <Kpi label="Awaiting confirmation" value={apps.filter((a) => AWAITING.includes(a.assignmentStatus)).length} tone="amber" caption="Committee responses pending" />
            <Kpi label="Scheduling conflicts" value={apps.filter((a) => hasConflict(a.assignmentStatus, a.conflicts)).length} tone="red" caption="Need a decision from you" />
          </KpiRow>

          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <Card>
              <CardHeader
                title="Visit calendar"
                subtitle={`${weekLabel} · IST`}
                action={
                  <div className="flex items-center gap-1">
                    <button aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))} className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50">
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button onClick={() => setWeek(mondayOf(today))} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                      <span className="h-1.5 w-1.5 rounded-full bg-brand-600" /> Week
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
                    const list = inWeek.filter((v) => istDay(v.start) === d).sort((x, y) => x.start.localeCompare(y.start));
                    return (
                      <div key={d} className="border-r border-slate-200 last:border-r-0">
                        <div className={cx('border-b border-slate-200 px-3 py-2', d === today ? 'bg-brand-50' : 'bg-slate-50')}>
                          <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{dt.toLocaleDateString('en-IN', { weekday: 'short' })}</div>
                          <div className={cx('text-sm font-semibold', d === today ? 'text-brand-700' : 'text-slate-900')}>{dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
                        </div>
                        <div className="min-h-[240px] space-y-2 p-2">
                          {list.map((v) => {
                            const conflict = hasConflict(v.assignmentStatus, v.conflicts);
                            const confirmed = ['CONFIRMED', 'IN_PROGRESS', 'REPORTS_PENDING', 'COMPLETED'].includes(v.assignmentStatus);
                            return (
                              <button
                                key={v.id}
                                onClick={() => setSelId(v.id)}
                                className={cx(
                                  'w-full rounded-md border-l-[3px] px-2.5 py-2 text-left text-xs transition',
                                  conflict ? 'border-rose-500 bg-rose-50' : confirmed ? 'border-brand-600 bg-brand-50' : 'border-amber-500 bg-amber-50',
                                  sel?.id === v.id && 'ring-2 ring-brand-300',
                                )}
                              >
                                <div className="font-semibold text-slate-900">{istTime(v.start)}{v.end && `–${istTime(v.end)}`}</div>
                                <div className="mt-0.5 truncate font-mono text-[11px] text-brand-700">{v.referenceNo}</div>
                                <div className="truncate text-slate-600">{v.institution}</div>
                                <div className={cx('mt-1 font-medium', conflict ? 'text-rose-700' : confirmed ? 'text-brand-700' : 'text-amber-700')}>{confirmed ? 'Confirmed' : 'Proposed'}</div>
                                {conflict && (
                                  <div className="mt-1 inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                                    <AlertTriangle className="h-3 w-3" /> Panel conflict
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-600" /> Confirmed</span>
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-amber-500" /> Proposed</span>
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-500" /> Panel conflict</span>
                  {weekend.length > 0 && <span>{weekend.length} weekend visit(s) this week — open them from the table below.</span>}
                </div>
              </div>
            </Card>

            <Card className="self-start">
              <CardHeader title="Selected visit" divided />
              {!sel ? (
                <Empty icon={<CalendarDays className="h-5 w-5" />} title="No visit selected">Select a visit on the calendar to see its details.</Empty>
              ) : (
                <div className="space-y-4 p-5">
                  <div>
                    <div className="font-mono text-sm font-semibold text-brand-600">{sel.referenceNo}</div>
                    <div className="mt-0.5 text-sm text-slate-700">{sel.institution}</div>
                  </div>
                  <SelectedPill v={sel} />
                  {sel.conflicts.length > 0 && (
                    <ul className="space-y-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                      {sel.conflicts.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <KV k={sel.assignmentStatus === 'CONFIRMED' ? 'Visit date' : 'Proposed date'} v={istLongDate(sel.start)} />
                    <KV k="Time range" v={istRange(sel.start, sel.end)} />
                  </div>
                  <KV k="Forwarded by" v={selApp?.forwarded_by ? `${selApp.forwarded_by}${selApp.forwarded_on ? ` · ${fmtDate(selApp.forwarded_on)}` : ''}` : '—'} />
                  <KV
                    k="Visit mode"
                    v={
                      <span className="inline-flex items-center gap-1.5">
                        <Video className="h-3.5 w-3.5 text-slate-400" /> {modeLabel(sel.mode)}
                        {sel.mode === 'ONLINE' && <span className="text-slate-500">· {selApp?.visit?.meetingLink ? 'Link created' : 'Link not created'}</span>}
                      </span>
                    }
                  />
                  <div className="border-t border-slate-100 pt-4">
                    <Button className="w-full" onClick={() => schedule(sel.applicationId)}>
                      {isRO ? (hasConflict(sel.assignmentStatus, sel.conflicts) ? 'Resolve & schedule' : 'Open scheduling') : 'View scheduling'} <ArrowRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Visits by day" subtitle={`${weekLabel} · proposed and confirmed`} />
              <div className="px-5 pb-5">
                <ColumnChart
                  highlight={days.includes(today) ? new Date(`${today}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' }) : undefined}
                  items={days.map((d) => ({ label: new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' }), value: inWeek.filter((v) => istDay(v.start) === d).length }))}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="Coordination status" subtitle="Applications at the EVC stage" />
              <div className="px-5 pb-5">
                <SegmentBar
                  segments={[
                    { label: 'Not scheduled', value: apps.filter((a) => a.assignmentStatus === 'NOT_SCHEDULED').length, tone: 'slate' },
                    { label: 'Proposed · not sent', value: apps.filter((a) => a.assignmentStatus === 'DRAFT' && !hasConflict(a.assignmentStatus, a.conflicts)).length, tone: 'amber' },
                    { label: 'Awaiting responses', value: apps.filter((a) => AWAITING.includes(a.assignmentStatus)).length, tone: 'violet' },
                    { label: 'Confirmed', value: apps.filter((a) => ['CONFIRMED', 'IN_PROGRESS', 'REPORTS_PENDING', 'COMPLETED'].includes(a.assignmentStatus)).length, tone: 'blue' },
                    { label: 'Conflict', value: apps.filter((a) => hasConflict(a.assignmentStatus, a.conflicts)).length, tone: 'red' },
                  ]}
                  empty="No applications at the EVC stage."
                />
              </div>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader title="Ready for scheduling" subtitle="Applications forwarded after scrutiny, and visits that need your decision" />
            <Table
              head={['Application', 'Institution', 'Forwarded on', 'Coordination', '']}
              empty={readyRows.length === 0 && <Empty title="Nothing waiting">Applications appear here once scrutiny forwards them to the EVC coordinator.</Empty>}
            >
              {readyRows.map((a) => {
                const c = coordination(a.assignmentStatus, a.conflicts);
                const conflict = hasConflict(a.assignmentStatus, a.conflicts);
                return (
                  <tr key={a.id} className="hover:bg-slate-50/70">
                    <td className={`${tdCls} font-mono text-[13px] font-semibold whitespace-nowrap text-brand-600`}>{a.reference_no}</td>
                    <td className={tdCls}>
                      <div className="max-w-[260px] truncate">{a.institution_name}</div>
                      <div className="text-xs text-slate-500">{[a.district, a.state].filter(Boolean).join(', ')}</div>
                    </td>
                    <td className={`${tdCls} text-[13px] whitespace-nowrap text-slate-500`}>{a.forwarded_on ? fmtDate(a.forwarded_on) : '—'}</td>
                    <td className={tdCls}>
                      <span title={a.conflicts.join('\n') || undefined}>
                        <Badge t={c.tone}>{c.label}</Badge>
                      </span>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <TextLink onClick={() => schedule(a.id)}>{!isRO ? 'Open' : conflict ? 'Resolve' : a.assignmentStatus === 'NOT_SCHEDULED' ? 'Schedule' : 'Open'} →</TextLink>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        </>
      )}
      <PageNote>Times are shown in India Standard Time (IST). A visit is confirmed only after every committee member accepts.</PageNote>
    </>
  );
}

function SelectedPill({ v }: { v: CalVisit }) {
  const conflict = hasConflict(v.assignmentStatus, v.conflicts);
  const c = coordination(v.assignmentStatus, v.conflicts);
  if (conflict) return <Badge t="red">{v.assignmentStatus === 'CONFIRMED' ? 'Confirmed' : 'Proposed'} · Conflict detected</Badge>;
  return <Badge t={c.tone}>{c.label}</Badge>;
}
