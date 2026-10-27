import { ArrowRight, CalendarDays, Camera, CheckCircle2, ClipboardList, FileText, Film, Inbox, Lock, MailCheck, UserX } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BarList, ColumnChart, Meter, SegmentBar } from '../../components/Charts';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, FilterTabs, Kpi, KpiRow, PageHeader, PageNote, Spinner, Table, tdCls, TextLink } from '../../components/ui';
import { api } from '../../lib/api';
import { useCategories } from '../../lib/categories';
import { fmtDateTime, useApi } from '../../lib/hooks';
import { addDays, istDay, istLongDate, istRange, mondayOf, responsePill } from './evcCoord';
import { DOC_CATS, EVIDENCE_LABEL, MEMBER_STATUS, SEAT_SHORT, Unavailability } from './EvcMember';
import { InvitationRow, MemberSchedule } from './EvcMemberHome';

/**
 * EVC member workspace, one page per task: overview, invitations, inspection reports and unavailability (the
 * schedule lives at /official/evc). Every figure comes from /api/evc/my-assignments and /api/evc/visits/:id.
 */
type Assignment = Record<string, any>;
const REPORTING = ['VISIT_IN_PROGRESS', 'VISIT_COMPLETED', 'REPORT_DRAFT', 'REPORT_OVERDUE'];
const UPCOMING = ['ACCEPTED', 'VISIT_SCHEDULED'];

function useAssignments() {
  const res = useApi<{ assignments: Assignment[] }>('/api/evc/my-assignments');
  const rows = useMemo(() => (res.data?.assignments ?? []).filter((r) => r.active), [res.data]);
  return { ...res, rows, all: res.data?.assignments ?? [] };
}

// ------------------------------------------------------------------ overview

export function MemberOverview() {
  const { rows, data, error, loading } = useAssignments();
  const today = istDay(new Date());
  const count = (s: string[]) => rows.filter((r) => s.includes(r.memberStatus)).length;
  const invites = count(['INVITED']);
  const completed = rows.filter((r) => ['VISIT_COMPLETED', 'REPORT_DRAFT', 'REPORT_OVERDUE', 'REPORT_SUBMITTED'].includes(r.memberStatus));
  const submitted = count(['REPORT_SUBMITTED']);
  const upcoming = rows.filter((r) => [...UPCOMING, 'INVITED'].includes(r.memberStatus) && istDay(r.scheduled_start) >= today).sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));
  const next = upcoming.find((r) => UPCOMING.includes(r.memberStatus)) ?? upcoming[0];
  const mon = mondayOf(today);
  const weeks = Array.from({ length: 4 }, (_, i) => addDays(mon, i * 7));

  return (
    <>
      <PageHeader crumbs={['Workspace', 'Overview']} title="My EVC overview" subtitle="Your invitations, visits and reports at a glance." />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Invitations to answer" value={invites} tone={invites ? 'amber' : 'default'} caption="Accept or decline" />
            <Kpi label="Upcoming visits" value={count(UPCOMING)} tone="blue" caption="Accepted by you" />
            <Kpi label="Reports due" value={count(REPORTING)} tone={count(['REPORT_OVERDUE']) ? 'red' : 'amber'} caption={`${count(['REPORT_OVERDUE'])} overdue`} />
            <Kpi label="Reports submitted" value={submitted} tone="green" caption="Final reports on record" />
          </KpiRow>

          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile to="/official/evc/invitations" icon={<MailCheck className="h-5 w-5" />} tone="amber" title="Invitations" meta={invites ? `${invites} awaiting your answer` : 'Nothing to answer'} />
            <Tile to="/official/evc" icon={<CalendarDays className="h-5 w-5" />} tone="blue" title="My schedule" meta={next ? `Next: ${istLongDate(next.scheduled_start)}` : 'No upcoming visit'} />
            <Tile to="/official/evc/reports" icon={<ClipboardList className="h-5 w-5" />} tone="violet" title="Inspection reports" meta={count(REPORTING) ? `${count(REPORTING)} to complete` : 'Nothing due'} />
            <Tile to="/official/evc/unavailability" icon={<UserX className="h-5 w-5" />} tone="slate" title="Unavailability" meta="Dates you cannot take visits" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
            <Card>
              <CardHeader title="My visits by status" subtitle="Every visit you are on" />
              <div className="px-5 pb-5">
                <SegmentBar
                  segments={[
                    { label: 'Invitation', value: count(['INVITED']), tone: 'amber' },
                    { label: 'Accepted', value: count(['ACCEPTED']), tone: 'green' },
                    { label: 'Confirmed', value: count(['VISIT_SCHEDULED']), tone: 'blue' },
                    { label: 'In progress / reporting', value: count(REPORTING), tone: 'violet' },
                    { label: 'Report submitted', value: submitted, tone: 'slate' },
                    { label: 'Change requested', value: count(['HUMAN_REVIEW_REQUIRED']), tone: 'red' },
                  ]}
                  empty="You have no visits yet."
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="Visits in the next four weeks" subtitle="By week starting Monday" />
              <div className="px-5 pb-5">
                <ColumnChart
                  height={150}
                  items={weeks.map((w) => ({
                    label: new Date(`${w}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
                    value: upcoming.filter((r) => istDay(r.scheduled_start) >= w && istDay(r.scheduled_start) <= addDays(w, 6)).length,
                  }))}
                />
              </div>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
            <Card>
              <CardHeader title="Next visit" action={<TextLink to="/official/evc">Schedule <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
              {next ? (
                <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-center">
                  <div className="w-20 shrink-0 rounded-xl bg-brand-600 py-3 text-center text-white">
                    <div className="text-xs font-semibold uppercase">{new Date(next.scheduled_start).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short' })}</div>
                    <div className="text-3xl leading-none font-bold">{new Date(next.scheduled_start).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric' })}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] font-semibold text-brand-600">{next.reference_no}</div>
                    <div className="truncate font-medium text-slate-900">{next.institution_name}</div>
                    <div className="text-[13px] text-slate-500">{istRange(next.scheduled_start, next.scheduled_end)} · {next.mode === 'ONLINE' ? 'Virtual' : 'Physical'} · {SEAT_SHORT[next.seat]}</div>
                    <Badge className="mt-2" t={MEMBER_STATUS[next.memberStatus]?.[1] ?? 'slate'}>{MEMBER_STATUS[next.memberStatus]?.[0] ?? next.memberStatus}</Badge>
                  </div>
                  <Link to={`/official/visits/${next.visit_id}`} className="shrink-0 text-sm font-semibold text-brand-600 hover:text-brand-700">Open →</Link>
                </div>
              ) : (
                <Empty icon={<CalendarDays className="h-5 w-5" />} title="No upcoming visit">Accepted invitations appear here.</Empty>
              )}
            </Card>
            <Card>
              <CardHeader title="Report progress" subtitle="Final reports for completed visits" />
              <div className="space-y-4 px-5 pb-5">
                <Meter label="Final reports submitted" done={submitted} total={completed.length} tone="green" />
                <Meter label="Invitations answered" done={rows.filter((r) => r.response_status && r.response_status !== 'INVITED').length} total={rows.length} />
              </div>
            </Card>
          </div>
        </>
      )}
      <PageNote>Visits are scheduled by the Regional Officer; you answer invitations and report on the visits you attend.</PageNote>
    </>
  );
}

function Tile({ to, icon, title, meta, tone }: { to: string; icon: ReactNode; title: string; meta: string; tone: 'amber' | 'blue' | 'violet' | 'slate' }) {
  const c = tone ? 'bg-brand-50 text-brand-700' : '';
  return (
    <Link to={to} className="group flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 transition hover:border-brand-300 hover:shadow-sm">
      <span className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', c)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-slate-900">{title}</span>
        <span className="block truncate text-[13px] text-slate-500">{meta}</span>
      </span>
      <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:text-brand-600" />
    </Link>
  );
}

// ------------------------------------------------------------------ invitations

export function MemberInvitations() {
  const nav = useNavigate();
  const cats = useCategories();
  const { rows, data, error, loading, reload } = useAssignments();
  const [tab, setTab] = useState<'open' | 'answered'>('open');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const open = rows.filter((r) => r.response_status === 'INVITED' && ['PROPOSED', 'SCHEDULED', 'RESCHEDULED'].includes(r.visit_status));
  const answered = rows.filter((r) => r.response_status && r.response_status !== 'INVITED');
  const by = (s: string) => rows.filter((r) => r.response_status === s).length;

  return (
    <>
      <PageHeader crumbs={['Expert visits', 'Invitations']} title="Invitations" subtitle="Accept or decline visits the Regional Officer invites you to." />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {msg && <div className="mb-5"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {data && (
        <>
          <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
            <Card>
              <div className="grid grid-cols-2 divide-x divide-slate-100">
                <div className="px-5 py-5">
                  <div className="text-[13px] text-slate-500">Awaiting your answer</div>
                  <div className={cx('num mt-1.5 text-[34px] leading-none font-bold', open.length ? 'text-brand-700' : 'text-slate-900')}>{open.length}</div>
                </div>
                <div className="px-5 py-5">
                  <div className="text-[13px] text-slate-500">Answered</div>
                  <div className="num mt-1.5 text-[34px] leading-none font-bold text-slate-900">{answered.length}</div>
                </div>
              </div>
            </Card>
            <Card>
              <CardHeader title="My responses" />
              <div className="px-5 pb-5">
                <SegmentBar
                  segments={[
                    { label: 'Awaiting answer', value: by('INVITED'), tone: 'amber' },
                    { label: 'Accepted', value: by('ACCEPTED'), tone: 'green' },
                    { label: 'Declined', value: by('REJECTED'), tone: 'slate' },
                    { label: 'Conflict / withdrawal', value: by('CONFLICT_REPORTED') + by('WITHDRAWAL_REQUESTED'), tone: 'red' },
                  ]}
                  empty="No invitations yet."
                />
              </div>
            </Card>
          </div>
          <Card>
            <div className="px-5 pt-4 pb-3">
              <FilterTabs
                value={tab}
                onChange={setTab}
                items={[
                  { value: 'open', label: 'Awaiting answer', count: open.length },
                  { value: 'answered', label: 'Answered', count: answered.length },
                ]}
              />
            </div>
            {tab === 'open' ? (
              open.length === 0 ? (
                <Empty icon={<Inbox className="h-5 w-5" />} title="No invitations waiting">New invitations appear here and in your notifications.</Empty>
              ) : (
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {open.map((r) => (
                    <InvitationRow
                      key={r.visit_id}
                      r={r}
                      category={cats?.find((c) => c.code === r.category_code)?.shortTitle}
                      onOpen={() => nav(`/official/visits/${r.visit_id}`)}
                      onDone={(text, kind = 'success') => {
                        setMsg({ kind, text });
                        reload();
                      }}
                    />
                  ))}
                </ul>
              )
            ) : (
              <Table head={['Application', 'Institution', 'Visit (IST)', 'Your response', '']} empty={answered.length === 0 && <Empty title="Nothing answered yet" />}>
                {answered.map((r) => (
                  <tr key={r.visit_id} className="hover:bg-slate-50/70">
                    <td className={`${tdCls} font-mono text-[13px] font-semibold whitespace-nowrap text-brand-600`}>{r.reference_no}</td>
                    <td className={tdCls}><div className="max-w-[240px] truncate">{r.institution_name}</div></td>
                    <td className={`${tdCls} text-[13px] whitespace-nowrap`}>
                      {istLongDate(r.scheduled_start)}
                      <div className="text-xs text-slate-500">{istRange(r.scheduled_start, r.scheduled_end)}</div>
                    </td>
                    <td className={tdCls}>
                      <Badge t={responsePill(r.response_status).tone}>{responsePill(r.response_status).label}</Badge>
                      {r.responded_at && <div className="mt-1 text-xs text-slate-500">{fmtDateTime(r.responded_at)}</div>}
                    </td>
                    <td className={`${tdCls} text-right`}><TextLink onClick={() => nav(`/official/visits/${r.visit_id}`)}>Open</TextLink></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ inspection reports

const STEPS = ['Accepted', 'Confirmed', 'Visit started', 'Report submitted'];
function stepOf(r: Assignment) {
  if (r.memberStatus === 'REPORT_SUBMITTED') return 4;
  if (REPORTING.includes(r.memberStatus)) return 3;
  if (r.memberStatus === 'VISIT_SCHEDULED') return 2;
  if (r.response_status === 'ACCEPTED') return 1;
  return 0;
}

export function MemberReports() {
  const nav = useNavigate();
  const { rows, data, error, loading } = useAssignments();
  const visits = rows.filter((r) => r.response_status === 'ACCEPTED' || REPORTING.includes(r.memberStatus) || r.memberStatus === 'REPORT_SUBMITTED');
  const [detail, setDetail] = useState<Record<string, any>>({});
  // Attachment counts per visit come from each visit record (members see only their own visits).
  useEffect(() => {
    const ids = visits.filter((v) => stepOf(v) >= 3).map((v) => v.visit_id);
    if (!ids.length) return;
    Promise.all(ids.map((id) => api.get(`/api/evc/visits/${id}`).then((d) => [id, d] as const).catch(() => [id, null] as const))).then((pairs) => setDetail(Object.fromEntries(pairs)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const evidence = Object.values(detail).flatMap((d: any) => d?.evidence ?? []);
  const typeCount = (cat: string) => evidence.filter((x: any) => x.category === cat).length;

  return (
    <>
      <PageHeader crumbs={['Expert visits', 'Inspection reports']} title="Inspection reports" subtitle="Report on your visits with documents, photographs and videos." />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Reports to complete" value={visits.filter((v) => stepOf(v) === 3).length} tone="amber" caption="Visit started or completed" />
            <Kpi label="Waiting for the visit" value={visits.filter((v) => stepOf(v) < 3).length} tone="blue" caption="Reporting opens when the visit starts" />
            <Kpi label="Final reports submitted" value={visits.filter((v) => stepOf(v) === 4).length} tone="green" caption="Sent for the Executive Committee" />
            <Kpi label="Files uploaded" value={evidence.length} caption={`${typeCount('VISIT_PHOTO')} photos · ${typeCount('VIDEO_RECORDING')} videos`} />
          </KpiRow>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Report status" />
              <div className="px-5 pb-5">
                <SegmentBar
                  segments={[
                    { label: 'Waiting for the visit', value: visits.filter((v) => stepOf(v) < 3).length, tone: 'blue' },
                    { label: 'To complete', value: visits.filter((v) => stepOf(v) === 3 && v.memberStatus !== 'REPORT_OVERDUE').length, tone: 'amber' },
                    { label: 'Overdue', value: visits.filter((v) => v.memberStatus === 'REPORT_OVERDUE').length, tone: 'red' },
                    { label: 'Submitted', value: visits.filter((v) => stepOf(v) === 4).length, tone: 'green' },
                  ]}
                  empty="No accepted visits yet."
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="Uploads by type" />
              <div className="px-5 pb-5">
                <BarList items={Object.keys(EVIDENCE_LABEL).map((k) => ({ label: EVIDENCE_LABEL[k], value: typeCount(k) }))} empty="No files uploaded yet." />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="My visits" subtitle="Reporting opens once a visit has started" />
            {visits.length === 0 ? (
              <Empty icon={<ClipboardList className="h-5 w-5" />} title="No visits to report on">Accept an invitation; once the visit is confirmed and started you can report here.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {visits.map((v) => {
                  const step = stepOf(v);
                  const d = detail[v.visit_id];
                  const ev: any[] = d?.evidence ?? [];
                  const open = step >= 3;
                  return (
                    <li key={v.visit_id} className="px-5 py-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                        <div className="min-w-0 lg:w-72">
                          <div className="font-mono text-[13px] font-semibold text-brand-600">{v.reference_no}</div>
                          <div className="truncate font-medium text-slate-900">{v.institution_name}</div>
                          <div className="text-xs text-slate-500">{istLongDate(v.scheduled_start)} · {istRange(v.scheduled_start, v.scheduled_end)}</div>
                        </div>
                        <ol className="flex flex-1 items-center gap-1.5">
                          {STEPS.map((s, i) => (
                            <li key={s} className="flex flex-1 flex-col gap-1">
                              <span className={cx('h-1.5 rounded-full', i < step ? 'bg-brand-700' : i === step ? 'bg-brand-300' : 'bg-slate-200')} />
                              <span className={cx('truncate text-[11px]', i < step ? 'text-slate-700' : i === step ? 'font-semibold text-brand-700' : 'text-slate-400')}>{s}</span>
                            </li>
                          ))}
                        </ol>
                        <div className="flex items-center gap-3 text-xs text-slate-600 lg:w-44">
                          {open ? (
                            <>
                              <span className="inline-flex items-center gap-1" title="Report documents"><FileText className="h-3.5 w-3.5 text-brand-600" /> {ev.filter((x) => DOC_CATS.includes(x.category)).length}</span>
                              <span className="inline-flex items-center gap-1" title="Photographs"><Camera className="h-3.5 w-3.5 text-violet-600" /> {ev.filter((x) => x.category === 'VISIT_PHOTO').length}</span>
                              <span className="inline-flex items-center gap-1" title="Videos"><Film className="h-3.5 w-3.5 text-violet-600" /> {ev.filter((x) => x.category === 'VIDEO_RECORDING').length}</span>
                            </>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-slate-400"><Lock className="h-3.5 w-3.5" /> Opens when the visit starts</span>
                          )}
                        </div>
                        <div className="lg:w-44 lg:text-right">
                          {step === 4 ? (
                            <Button variant="secondary" className="w-full lg:w-auto" onClick={() => nav(`/official/visits/${v.visit_id}`)}>
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> View report
                            </Button>
                          ) : open ? (
                            <Button className="w-full lg:w-auto" onClick={() => nav(`/official/visits/${v.visit_id}`)}>Write report</Button>
                          ) : (
                            <Button variant="secondary" className="w-full lg:w-auto" onClick={() => nav(`/official/visits/${v.visit_id}`)}>Open visit</Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
      <PageNote>Submitted reports go to the Regional Officer and the Regulation Bureau, and are placed before the Executive Committee.</PageNote>
    </>
  );
}

// ------------------------------------------------------------------ unavailability

export function MemberUnavailability() {
  const { rows } = useAssignments();
  return (
    <>
      <PageHeader crumbs={['Expert visits', 'Unavailability']} title="Unavailability" subtitle="Record dates you cannot take visits; you will not be invited for them." />
      <MemberSchedule rows={rows} />
      <Unavailability />
    </>
  );
}
