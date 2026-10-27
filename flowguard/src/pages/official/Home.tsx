import { ArrowRight, Inbox, ListChecks, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Empty, FilterTabs, inputCls, Kpi, KpiRow, PageHeader, PageNote, Pager, Spinner, StatusBadge, Table, Tabs, tdCls, TextLink, Timeline, usePaged } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useCategories } from '../../lib/categories';
import { BarList, SegmentBar } from '../../components/Charts';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';
import { actionLabel } from '../../lib/roles';
import { WORKSPACE_TITLE } from './common';
import { SupervisorOverview } from './Oversight';
import { BureauOverview } from './Bureau';
import { MemberOverview } from './EvcMemberPages';
import { RegionalOverview } from './RegionalOverview';
import { ReScrutinyWorkspace } from './ReScrutiny';
import { CommitteeDashboard } from './CommitteeDesk';

const SUBTITLE: Record<string, string> = {
  SCRUTINY_OFFICIAL: 'Prioritise assigned applications, examine evidence and record your next action.',
  RE_SCRUTINY_OFFICIAL: 'Compare resubmitted evidence with the original notice, then record your recommendation.',
  REGIONAL_OFFICER: 'Applications forwarded after scrutiny, EVC scheduling and upcoming visits.',
  EVC_MEMBER: 'Visits you are assigned to and their reports.',
};

const GUIDANCE: Record<string, string> = {
  SCRUTINY_OFFICIAL: 'Automated checks flag potential issues for you to examine; they never decide an application.',
};

/** Role-specific KPI cards, computed from persisted counts returned by /api/official/dashboard. */
function RoleKpis({ role, d, queue }: { role: string; d: any; queue: any[] }) {
  const qc = d.queueCounts ?? {};
  const unassigned = queue.filter((a) => !a.assignment).length;
  if (role === 'SCRUTINY_OFFICIAL')
    return (
      <KpiRow>
        <Kpi label="Awaiting scrutiny" value={(qc.SUBMITTED ?? 0) + (qc.UNDER_SCRUTINY ?? 0)} caption={`${qc.UNDER_SCRUTINY ?? 0} in progress`} />
        <Kpi label="Assigned to me" value={d.assignedToMe} tone="blue" caption="Active applications" />
        <Kpi label="Unassigned" value={unassigned} tone={unassigned ? 'amber' : 'default'} caption="In your queue, not yet taken up" />
        <Kpi label="Corrections overdue" value={d.overdueDeficiencies} tone={d.overdueDeficiencies ? 'red' : 'default'} caption="Past their configured deadline" />
      </KpiRow>
    );
  if (role === 'RE_SCRUTINY_OFFICIAL')
    return (
      <KpiRow>
        <Kpi label="Ready for re-scrutiny" value={qc.READY_FOR_RE_SCRUTINY ?? 0} caption="Correction packages received" />
        <Kpi label="Under re-scrutiny" value={qc.UNDER_RE_SCRUTINY ?? 0} tone="blue" caption="Taken up by an official" />
        <Kpi label="Assigned to me" value={d.assignedToMe} tone="blue" caption="Active applications" />
        <Kpi label="Corrections overdue" value={d.overdueDeficiencies} tone={d.overdueDeficiencies ? 'red' : 'default'} caption="Still with institutions" />
      </KpiRow>
    );
  if (role === 'REGIONAL_OFFICER')
    return (
      <KpiRow>
        <Kpi label="Awaiting handoff" value={qc.SCRUTINY_COMPLETED ?? 0} caption="Scrutiny completed" />
        <Kpi label="Ready for scheduling" value={qc.AWAITING_EVC_SCHEDULING ?? 0} tone="amber" caption="Handoff approved" />
        <Kpi label="Visits scheduled" value={qc.EVC_SCHEDULED ?? 0} tone="blue" caption="Confirmed with the institution" />
        <Kpi label="Reports to forward" value={qc.EVC_REPORT_SUBMITTED ?? 0} tone="green" caption="EVC report submitted" />
      </KpiRow>
    );
  const entries = Object.entries(qc).slice(0, 3);
  return (
    <KpiRow>
      {entries.map(([s, n]) => (
        <Kpi key={s} label={d.stateLabels[s]} value={n as number} />
      ))}
      <Kpi label="Assigned to me" value={d.assignedToMe} tone="blue" caption="Active applications" />
    </KpiRow>
  );
}

function Findings({ c, assessments }: { c: any; assessments?: Record<string, number> | null }) {
  if (!c && assessments) {
    // Latest report is a re-scrutiny report: summarise the automated assessment of each notice item.
    const total = Object.values(assessments).reduce((s, n) => s + n, 0);
    const resolved = assessments.RESOLVED ?? 0;
    return <Badge t={resolved === total ? 'green' : 'amber'}>{resolved}/{total} items pass</Badge>;
  }
  if (!c) return <span className="text-slate-400">—</span>;
  const issues = (c.DISCREPANCY_DETECTED ?? 0) + (c.UNABLE_TO_VERIFY ?? 0);
  if (issues > 0) return <Badge t="amber">{issues} issue{issues === 1 ? "" : "s"} flagged</Badge>;
  if (c.HUMAN_REVIEW_REQUIRED > 0) return <Badge t="violet">{c.HUMAN_REVIEW_REQUIRED} for review</Badge>;
  return <Badge t="green">None flagged</Badge>;
}

/** EVC assignment summary for the Regional Officer's queue. */
function EvcCell({ e }: { e: any }) {
  if (!e) return <span className="text-xs text-slate-400">No visit yet</span>;
  if (e.visitStatus === 'MISSED') return <Badge t="red">Visit missed</Badge>;
  if (e.reportVersion) return <Badge t="green">Report v{e.reportVersion}</Badge>;
  if (e.reportDueAt && new Date(e.reportDueAt) < new Date()) return <Badge t="red">Report overdue</Badge>;
  if (e.conflicts > 0) return <Badge t="violet">{e.conflicts} conflict(s)</Badge>;
  if (e.members === 0) return <Badge t="amber">Invitations not sent</Badge>;
  if (e.acknowledged < e.members) return <Badge t="amber">{e.acknowledged}/{e.members} accepted</Badge>;
  return <Badge t="blue">{e.visitStatus === 'PROPOSED' ? 'Proposed' : e.visitStatus.toLowerCase().replace('_', ' ')}</Badge>;
}

/** Queue table shared by the overview (preview) and the full review queue. */
export function QueueTable({ rows, pageSize = 8, compact }: { rows: any[]; pageSize?: number; compact?: boolean }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const paged = usePaged(rows, pageSize);
  useEffect(() => paged.setPage(1), [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Table
        head={['Application ID', 'Institution', ...(compact ? [] : ['Application type']), 'Stage', 'Assigned to', user?.activeRole === 'REGIONAL_OFFICER' ? 'EVC status' : 'Automated checks', '']}
        empty={rows.length === 0 && <Empty icon={<Inbox className="h-5 w-5" />} title="Nothing waiting">No application matches.</Empty>}
      >
        {paged.slice.map((a) => {
          const mine = a.assignment?.userId === user?.id;
          return (
            <tr key={a.id} className="hover:bg-slate-50/70">
              <td className={`${tdCls} whitespace-nowrap`}>
                <div className="font-mono text-[13px] font-semibold text-brand-600">{a.reference_no}</div>
                <div className="text-[11px] text-slate-500">Updated {fmtDate(a.updated_at)}{a.submission_version > 1 && ` · v${a.submission_version}`}</div>
              </td>
              <td className={tdCls}>
                <div className="max-w-[160px] truncate font-medium text-slate-900">{a.institution_name}</div>
                <div className="text-xs text-slate-500">{a.aicte_institution_id}</div>
              </td>
              {!compact && (
                <td className={tdCls}>
                  <div className="max-w-[160px] truncate text-[13px] text-slate-600">{a.categoryTitle}</div>
                </td>
              )}
              <td className={tdCls}>
                <StatusBadge status={a.status} label={a.statusLabel} />
                {a.reopen_requested_at && <div className="mt-1"><Badge t="amber">reopen requested</Badge></div>}
              </td>
              <td className={`${tdCls} text-[13px]`}><div className="max-w-[140px] truncate">{a.assignment ? (mine ? "You" : a.assignment.name) : a.assigned_any ?? <span className="text-slate-400">Unassigned</span>}</div></td>
              <td className={tdCls}>{user?.activeRole === 'REGIONAL_OFFICER' ? <EvcCell e={a.evc} /> : <Findings c={a.latest_counts} assessments={a.latest_assessments} />}</td>
              <td className={`${tdCls} text-right`}>
                <TextLink onClick={() => nav(`/official/applications/${a.id}`)}>{!a.assignment ? 'Open' : mine ? 'Review' : 'View'}</TextLink>
              </td>
            </tr>
          );
        })}
      </Table>
      <Pager {...paged} shown={paged.slice.length} />
    </>
  );
}

export function OfficialQueue() {
  const { user } = useAuth();
  const role = user?.activeRole ?? '';
  if (role === 'SUPERVISOR') return <SupervisorOverview />;
  if (role === 'REGULATION_BUREAU') return <BureauOverview />;
  if (role === 'EVC_MEMBER') return <MemberOverview />;
  if (role === 'REGIONAL_OFFICER') return <RegionalOverview />;
  if (role === 'RE_SCRUTINY_OFFICIAL') return <ReScrutinyWorkspace />;
  if (['EC_OFFICIAL', 'SHC_MEMBER', 'SAC_MEMBER', 'COUNCIL_OFFICIAL'].includes(role)) return <CommitteeDashboard />;
  return <RoleOverview role={role} />;
}

function RoleOverview({ role }: { role: string }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const dash = useApi('/api/official/dashboard');
  const queue = useApi('/api/official/queue?scope=mine');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const d = dash.data;
  const rows: any[] = queue.data?.applications ?? [];
  const filtered = rows.filter((a) => (status === 'all' || a.status === status) && (!q || `${a.reference_no} ${a.institution_name}`.toLowerCase().includes(q.toLowerCase())));
  const mine = rows.filter((a) => a.assignment?.userId === user?.id);
  const next = mine[0] ?? rows.find((a) => !a.assignment);

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Overview']}
        title={WORKSPACE_TITLE[role] ?? 'Workspace'}
        subtitle={SUBTITLE[role] ?? 'Applications at a stage where your role can act.'}
        action={
          <>
            <Button variant="secondary" onClick={() => nav('/official/queue')}>
              <ListChecks className="h-4 w-4" /> Review queue
            </Button>
            <Button disabled={!next} onClick={() => next && nav(`/official/applications/${next.id}`)}>
              Open next application <ArrowRight className="h-4 w-4" />
            </Button>
          </>
        }
      />
      {(dash.loading && !d) || (queue.loading && !queue.data) ? <Spinner /> : null}
      {dash.error && <Alert kind="error">{dash.error}</Alert>}
      {d && queue.data && (
        <>
          <RoleKpis role={role} d={d} queue={rows} />
          {GUIDANCE[role] && (
            <div className="mb-6">
              <Alert kind="info">{GUIDANCE[role]}</Alert>
            </div>
          )}
          <Card>
            <CardHeader title="Applications awaiting your review" subtitle="Pending at a stage your role handles" action={<TextLink to="/official/queue">View all <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-4">
              <FilterTabs
                value={status}
                onChange={setStatus}
                items={[{ value: 'all', label: 'All', count: rows.length }, ...Object.keys(d.queueCounts).map((s) => ({ value: s, label: d.stateLabels[s].split(' — ')[0], count: rows.filter((a) => a.status === s).length }))]}
              />
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input aria-label="Filter applications" className={`${inputCls} pl-9`} placeholder="Filter by ID or institution" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            <QueueTable rows={filtered} pageSize={6} compact />
          </Card>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Workload by stage" subtitle="Applications pending for your role" />
              <div className="px-5 pb-5">
                <BarList
                  items={Object.entries(d.queueCounts as Record<string, number>).map(([k, n]) => ({ label: (d.stateLabels[k] ?? k).split(' — ')[0], value: n, to: `/official/queue?status=${k}` }))}
                  empty="Nothing pending for your role."
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="Assignment" subtitle="Who holds the applications in your queue" />
              <div className="px-5 pb-5">
                <SegmentBar
                  segments={[
                    { label: 'Assigned to me', value: mine.length, tone: 'blue' },
                    { label: 'Assigned to others', value: rows.filter((a) => a.assignment && a.assignment.userId !== user?.id).length, tone: 'violet' },
                    { label: 'Unassigned', value: rows.filter((a) => !a.assignment).length, tone: 'amber' },
                  ]}
                  empty="Your queue is empty."
                />
              </div>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Continue your review" subtitle={next ? (mine[0] ? 'Most recent application assigned to you' : 'Next unassigned application in your queue') : undefined} />
              {next ? (
                <div className="px-5 pb-5">
                  <div className="rounded-lg border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-brand-600">{next.reference_no}</span>
                      <StatusBadge status={next.status} label={next.statusLabel} />
                    </div>
                    <div className="mt-1 text-sm font-medium text-slate-900">{next.institution_name}</div>
                    <div className="text-[13px] text-slate-500">{next.categoryTitle}</div>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
                      <span>Updated {fmtDate(next.updated_at)}</span>
                      {next.outstanding_deficiencies > 0 && <span>{next.outstanding_deficiencies} outstanding item(s)</span>}
                      {next.next_deadline && <span>Next deadline {fmtDate(next.next_deadline)}</span>}
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button onClick={() => nav(`/official/applications/${next.id}`)}>{mine[0] ? 'Resume review' : 'Open application'}</Button>
                    <Button variant="secondary" onClick={() => nav('/official/queue')}>Choose another</Button>
                  </div>
                </div>
              ) : (
                <Empty title="Your queue is clear">Nothing is waiting for your role right now.</Empty>
              )}
            </Card>
            <Card>
              <CardHeader title="Recent workflow activity" subtitle="On applications you can view" />
              <Timeline
                items={(d.recentActivity ?? []).map((e: any, i: number) => ({
                  id: e.id,
                  title: (
                    <>
                      {actionLabel(e.action)} <span className="font-mono text-[13px] font-normal text-slate-500">· {e.reference_no}</span>
                    </>
                  ),
                  meta: `${e.actor_name ?? 'System'} · ${fmtDateTime(e.created_at)}`,
                  tone: ['ISSUE_DEFICIENCY_NOTICE', 'REQUEST_FURTHER_CORRECTION'].includes(e.action) ? 'warn' : i === 0 ? 'current' : 'done',
                }))}
              />
            </Card>
          </div>
        </>
      )}
      <PageNote>{d?.lastSweep ? `Deadline monitor last ran ${fmtDateTime(d.lastSweep.started_at)}. Missed deadlines are escalated, never auto-rejected.` : 'All figures are counted from persisted records.'}</PageNote>
    </>
  );
}

/** Full review queue with server-side filters. */
export function ReviewQueue() {
  const { user } = useAuth();
  const role = user?.activeRole ?? '';
  const cats = useCategories();
  const [sp] = useSearchParams();
  // Sidebar shortcuts open this page pre-filtered (?status=…&scope=…); the filters stay editable.
  const fromUrl = () => ({ q: sp.get('q') ?? '', category: '', status: sp.get('status') ?? '', assigned: sp.get('assigned') ?? 'any' });
  const [scope, setScope] = useState<'mine' | 'all'>(sp.get('scope') === 'all' ? 'all' : 'mine');
  const [filters, setFilters] = useState(fromUrl);
  const [applied, setApplied] = useState(filters);
  useEffect(() => {
    const f = fromUrl();
    setFilters(f);
    setApplied(f);
    setScope(sp.get('scope') === 'all' ? 'all' : 'mine');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  const qs = new URLSearchParams({ scope, ...Object.fromEntries(Object.entries(applied).filter(([, v]) => v && v !== 'any')) });
  const queue = useApi(`/api/official/queue?${qs}`);
  const meta = useApi('/api/meta');

  return (
    <>
      <PageHeader crumbs={['Workspace', 'Review queue']} title="Review queue" subtitle={`${WORKSPACE_TITLE[role] ?? 'Official'} · applications you can act on or view.`} />
      <Card>
        <div className="px-5">
          <Tabs value={scope} onChange={setScope} items={[{ value: 'mine', label: 'Pending for my role' }, { value: 'all', label: 'All I can view' }]} />
        </div>
        <form
          className="grid gap-3 px-5 py-4 md:grid-cols-[1.5fr_1.5fr_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filters);
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input aria-label="Search" className={`${inputCls} pl-9`} placeholder="Application ID or institution" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
          <select aria-label="Category" className={inputCls} value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
            <option value="">All application types</option>
            {cats?.map((c) => (
              <option key={c.code} value={c.code}>{c.title}</option>
            ))}
          </select>
          <select aria-label="Status" className={inputCls} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">All stages</option>
            {meta.data &&
              Object.entries(meta.data.states as Record<string, string>)
                .filter(([k]) => k !== 'DRAFT')
                .map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
          </select>
          <select aria-label="Assignment" className={inputCls} value={filters.assigned} onChange={(e) => setFilters({ ...filters, assigned: e.target.value })}>
            <option value="any">Any assignment</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>
          <Button type="submit" variant="secondary">Apply</Button>
        </form>
        {queue.loading && !queue.data && <Spinner />}
        {queue.error && <div className="p-5"><Alert kind="error">{queue.error}</Alert></div>}
        {queue.data && <QueueTable rows={queue.data.applications} pageSize={12} />}
      </Card>
      <PageNote>Automated check badges summarise the latest report; they are not outcomes.</PageNote>
    </>
  );
}
