import { ArrowRight, Building2, CalendarDays, CheckCircle2, ChevronRight, Clock, FileText, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarList, Meter, PairedColumns, SegmentBar } from '../../components/Charts';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, FilterTabs, inputCls, PageNote, Pager, Spinner, StatusBadge, Table, tdCls, usePaged } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { daysUntil, fmtDate, useApi } from '../../lib/hooks';

/** Regional oversight: every submitted application in the officer's regions, at every stage (GET /api/region/overview). */
const STAGE_ORDER = ['SUBMITTED', 'SCRUTINY', 'EVC', 'SHC', 'DECISION', 'APPEAL', 'CLOSED'];
const DECISION_LABEL: Record<string, string> = { LOA: 'Letter of Approval', EOA: 'Extension of Approval', LOD: 'Letter of Deficiency', LOR: 'Letter of Rejection', CLOSURE_ORDER: 'Closure order', OTHER: 'Other' };

export function RegionalOverview() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [cycle, setCycle] = useState('');
  const { data, error, loading } = useApi<any>(`/api/region/overview${cycle ? `?cycle=${encodeURIComponent(cycle)}` : ''}`);
  const [stage, setStage] = useState('ALL');
  const [q, setQ] = useState('');
  const apps: any[] = data?.applications ?? [];
  const filtered = useMemo(
    () =>
      apps.filter(
        (a) =>
          (stage === 'ALL' || a.stage === stage) &&
          (!q || `${a.reference_no} ${a.institution_name} ${a.aicte_institution_id} ${a.applicant_name ?? ''} ${a.submitted_by_name ?? ''}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [apps, stage, q],
  );
  const paged = usePaged(filtered, 8);
  const k = data?.kpis;
  const hour = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const regionNames = (data?.scope.regions ?? []).map((r: any) => r.name).join(', ');
  const months = (data?.monthly ?? []).map((m: any) => ({ label: new Date(`${m.month}-01T12:00:00Z`).toLocaleDateString('en-IN', { month: 'short' }), a: m.submitted, b: m.decided }));

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
            {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <h1 className="text-[26px] leading-tight font-bold tracking-tight text-slate-900">
            {greeting}, {user?.fullName?.split(' ')[0]}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">{data ? `Here’s what’s happening across ${data.scope.allRegions ? 'all regions' : regionNames || 'your regions'}${cycle ? ` in ${cycle}` : ''}.` : ' '}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Approval cycle
            <select className={cx(inputCls, 'w-36 font-medium normal-case')} value={cycle} onChange={(e) => { setCycle(e.target.value); paged.setPage(1); }}>
              <option value="">All cycles</option>
              {(data?.cycles ?? []).map((c: string) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <Button onClick={() => nav('/official/evc')}>
            <CalendarDays className="h-4 w-4" /> EVC scheduling
          </Button>
        </div>
      </div>

      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard icon={<Building2 className="h-5 w-5" />} tone="blue" label="Institutions" value={k.institutions} caption={data.scope.allRegions ? 'Across all regions' : `In ${regionNames || 'your regions'}`} />
            <StatCard icon={<FileText className="h-5 w-5" />} tone="amber" label="Active applications" value={k.active} caption={`${k.submitted} submitted in total`} />
            <StatCard icon={<CheckCircle2 className="h-5 w-5" />} tone="green" label="Approvals issued" value={k.approvals} caption={`${k.decided} decision(s) recorded`} />
            <StatCard icon={<Clock className="h-5 w-5" />} tone="violet" label="Pending official review" value={k.withOfficials} caption={`${k.awaitingInstitution} awaiting institution`} />
          </div>

          <div className="mb-6 grid gap-6 xl:grid-cols-[1.65fr_1fr]">
            <Card>
              <CardHeader title="Application overview" subtitle="Monthly activity · last 12 months" />
              <div className="px-5 pb-5">
                <PairedColumns items={months} a="Submitted" b="Decisions issued" />
              </div>
            </Card>
            <Card>
              <CardHeader title="Upcoming deadlines" subtitle="Recorded deadlines only" />
              {data.deadlines.length === 0 ? (
                <p className="px-5 pb-4 text-sm text-slate-500">No upcoming deadlines on record.</p>
              ) : (
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {data.deadlines.map((d: any, i: number) => {
                    const left = daysUntil(d.due_at);
                    const dt = new Date(d.due_at);
                    const tone = d.kind === 'CORRECTION' ? 'bg-brand-700 text-white' : 'bg-brand-50 text-brand-800';
                    return (
                      <li key={i} className="flex items-center gap-3 px-5 py-3">
                        <div className={cx('w-11 shrink-0 rounded-lg py-1 text-center', tone)}>
                          <div className="text-[10px] font-semibold uppercase">{dt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short' })}</div>
                          <div className="text-lg leading-none font-bold">{dt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric' })}</div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-slate-900">{d.title}</div>
                          <div className="truncate text-xs text-slate-500">{d.reference_no} · {d.institution_name}</div>
                        </div>
                        {left !== null && <Badge t={left <= 3 ? 'red' : left <= 7 ? 'amber' : 'slate'}>{left === 0 ? 'Today' : `${left} day${left === 1 ? '' : 's'} left`}</Badge>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="border-t border-slate-100 px-5 py-4">
                <Meter label="Cycle completion · decisions issued" done={k.decided} total={k.submitted} />
              </div>
            </Card>
          </div>

          <div className="mb-6 grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader title="Applications by stage" subtitle="Submitted applications at each stage" />
              <div className="px-5 pb-5">
                <BarList items={STAGE_ORDER.map((s) => ({ label: data.stages.find((x: any) => x.stage === s)?.label ?? s, value: data.stages.find((x: any) => x.stage === s)?.n ?? 0 }))} empty="No submitted applications." />
              </div>
            </Card>
            <Card>
              <CardHeader title="Who holds the application" />
              <div className="px-5 pb-5">
                <SegmentBar
                  segments={[
                    { label: 'With officials', value: k.withOfficials, tone: 'blue' },
                    { label: 'Awaiting institution', value: k.awaitingInstitution, tone: 'amber' },
                    { label: 'Decided / closed', value: k.decided, tone: 'green' },
                  ]}
                  empty="No submitted applications."
                  columns={1}
                />
                <div className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm">
                  <div>
                    <div className="text-xs text-slate-500">Unassigned at review</div>
                    <div className={cx('num text-xl font-semibold', k.unassigned ? 'text-brand-700' : 'text-slate-900')}>{k.unassigned}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">EVC visits</div>
                    <div className="num text-xl font-semibold text-slate-900">
                      {k.visitsScheduled} <span className="text-xs font-normal text-slate-500">confirmed · {k.visitsProposed} proposed</span>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <Card>
              <CardHeader title="Decisions issued" subtitle="Latest decision per application" />
              <div className="px-5 pb-5">
                <BarList items={data.decisionMix.map((d: any) => ({ label: DECISION_LABEL[d.type] ?? d.type, value: d.n }))} empty="No decisions issued yet." />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="All applications" subtitle={`${filtered.length} of ${apps.length} · every stage, most recent first`} />
            <div className="flex flex-col gap-3 px-5 pb-4 lg:flex-row lg:items-center lg:justify-between">
              <FilterTabs
                value={stage}
                onChange={(v) => { setStage(v); paged.setPage(1); }}
                items={[{ value: 'ALL', label: 'All', count: apps.length }, ...STAGE_ORDER.filter((s) => apps.some((a) => a.stage === s)).map((s) => ({ value: s, label: data.stages.find((x: any) => x.stage === s)?.label ?? s, count: apps.filter((a) => a.stage === s).length }))]}
              />
              <div className="relative w-full lg:w-72">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input aria-label="Search applications" className={`${inputCls} pl-9`} placeholder="Institution, application or applicant" value={q} onChange={(e) => { setQ(e.target.value); paged.setPage(1); }} />
              </div>
            </div>
            <Table head={['Institution', 'Applied by', 'Application type', 'Submitted', 'Status', 'Pending with', '']} empty={filtered.length === 0 && <Empty title="No applications match">Change the stage or search.</Empty>}>
              {paged.slice.map((a) => (
                <tr key={a.id} className={cx('hover:bg-slate-50/70', a.canOpen && 'cursor-pointer')} onClick={() => a.canOpen && nav(`/official/applications/${a.id}`)}>
                  <td className={tdCls}>
                    <div className="max-w-[230px] truncate font-semibold text-slate-900">{a.institution_name}</div>
                    <div className="font-mono text-[11px] text-slate-500">{a.reference_no} · {a.aicte_institution_id}</div>
                  </td>
                  <td className={tdCls}>
                    <div className="max-w-[170px] truncate text-[13px]">{a.applicant_name || a.submitted_by_name || '—'}</div>
                    {a.applicant_designation && <div className="text-xs text-slate-500">{a.applicant_designation}</div>}
                  </td>
                  <td className={tdCls}>
                    <div className="max-w-[200px] truncate text-[13px] text-slate-700">{a.categoryTitle}</div>
                    {a.academic_year && <div className="text-xs text-slate-500">{a.academic_year}</div>}
                  </td>
                  <td className={`${tdCls} text-[13px] whitespace-nowrap text-slate-600`}>{fmtDate(a.submitted_at)}</td>
                  <td className={tdCls}>
                    <StatusBadge status={a.status} label={a.statusLabel} />
                    {a.daysAtStage !== null && <div className="mt-1 text-xs text-slate-500">{a.daysAtStage} day{a.daysAtStage === 1 ? '' : 's'} at stage</div>}
                  </td>
                  <td className={`${tdCls} text-[13px]`}>
                    {a.pendingWith === 'APPLICANT' ? <span className="text-amber-700">Institution{a.correction_due ? ` · due ${fmtDate(a.correction_due)}` : ''}</span> : a.pendingWith === 'OFFICIAL' ? 'AICTE officials' : <span className="text-slate-400">—</span>}
                  </td>
                  <td className={`${tdCls} text-right`}>{a.canOpen ? <ChevronRight className="ml-auto h-4 w-4 text-slate-400" /> : <span className="text-[11px] whitespace-nowrap text-slate-400" title="Opened by the official handling this stage">View only</span>}</td>
                </tr>
              ))}
            </Table>
            <Pager {...paged} shown={paged.slice.length} />
          </Card>
          <div className="mt-6 flex justify-end">
            <Button variant="secondary" onClick={() => nav('/official/reports')}>
              Pendency report <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </>
      )}
      <PageNote>Counted from submitted applications in the portal. Stage counts describe progress; only decisions record outcomes.</PageNote>
    </>
  );
}

function StatCard({ icon, tone, label, value, caption }: { icon: ReactNode; tone: 'blue' | 'amber' | 'green' | 'violet'; label: string; value: number; caption: string }) {
  const chip = tone ? 'bg-brand-50 text-brand-700' : '';
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] text-slate-500">{label}</div>
        <span className={cx('flex h-9 w-9 items-center justify-center rounded-lg', chip)}>{icon}</span>
      </div>
      <div className="num -mt-1 text-[28px] leading-none font-bold text-slate-900">{value.toLocaleString('en-IN')}</div>
      <div className="mt-2 text-xs text-slate-500">{caption}</div>
    </div>
  );
}
