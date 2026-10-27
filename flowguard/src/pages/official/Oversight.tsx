import { ArrowRight, ListChecks, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Empty, FilterTabs, Kpi, KpiRow, PageHeader, PageNote, Pager, Spinner, StatusBadge, Table, Tabs, tdCls, TextLink, usePaged } from '../../components/ui';
import { BarList, SegmentBar } from '../../components/Charts';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';
import { actionLabel, initialsOf, WORKSPACE_NAME } from '../../lib/roles';

const STAGE_ORDER: Array<[string, string]> = [
  ['SUBMITTED', 'Submitted'],
  ['SELF_DISCLOSURE', 'Self-disclosure'],
  ['SCRUTINY', 'Scrutiny & correction'],
  ['EVC', 'EVC'],
  ['SHC', 'SHC'],
  ['DECISION', 'Decision pending'],
  ['APPEAL', 'Appeal'],
  ['DECIDED', 'Decision issued / closed'],
];
const stageKey = (status: string, stage: string) => (['DECISION_ISSUED', 'CLOSED'].includes(status) ? 'DECIDED' : stage);

/** Supervisor home: pipeline, assignment monitoring and governance — all counted from persisted records. */
export function SupervisorOverview() {
  const nav = useNavigate();
  const dash = useApi('/api/official/dashboard');
  const queue = useApi('/api/official/queue?scope=all');
  const [filter, setFilter] = useState<'active' | 'unassigned' | 'overdue'>('active');
  const d = dash.data;
  const sv = d?.supervisor;
  const apps: any[] = queue.data?.applications ?? [];
  const active = apps.filter((a) => !['DECISION_ISSUED', 'CLOSED'].includes(a.status));
  const today = new Date().toISOString().slice(0, 10);
  const monitored = active.filter((a) => (filter === 'unassigned' ? !a.assigned_any : filter === 'overdue' ? a.next_deadline && a.next_deadline < today : true));
  const paged = usePaged(monitored, 6);

  const pipeline = STAGE_ORDER.map(([k, label]) => ({ k, label, n: (d?.pipeline ?? []).filter((p: any) => stageKey(p.status, p.stage) === k).reduce((s: number, p: any) => s + p.n, 0) })).filter((x) => x.n > 0);
  const totalActive = (d?.pipeline ?? []).filter((p: any) => !['DECISION_ISSUED', 'CLOSED'].includes(p.status)).reduce((s: number, p: any) => s + p.n, 0);
  const rules = Object.fromEntries((sv?.ruleCounts ?? []).map((r: any) => [r.lifecycle_status, r.n]));

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Overview']}
        title="Operations oversight"
        subtitle="Monitor handoffs, balance assignments and administer access within your authority."
        action={
          <>
            <Button variant="secondary" onClick={() => nav('/official/escalations')}>
              <ShieldCheck className="h-4 w-4" /> Escalations
            </Button>
            <Button onClick={() => nav('/official/queue')}>
              <ListChecks className="h-4 w-4" /> Review queue
            </Button>
          </>
        }
      />
      {(dash.loading && !d) || (queue.loading && !queue.data) ? <Spinner /> : null}
      {dash.error && <Alert kind="error">{dash.error}</Alert>}
      {d && sv && queue.data && (
        <>
          <KpiRow>
            <Kpi label="Active applications" value={totalActive} caption="Submitted, not yet decided" />
            <Kpi label="Unassigned at a review stage" value={sv.unassigned ?? 0} tone={sv.unassigned ? 'amber' : 'default'} caption="Scrutiny, re-scrutiny or EVC scheduling" />
            <Kpi label="Corrections overdue" value={d.overdueDeficiencies} tone={d.overdueDeficiencies ? 'red' : 'default'} caption="Past their operational target" />
            <Kpi label="Visits scheduled" value={(d.upcomingVisits ?? []).filter((v: any) => ['SCHEDULED', 'RESCHEDULED', 'IN_PROGRESS'].includes(v.status)).length} tone="blue" caption={`${(d.upcomingVisits ?? []).filter((v: any) => v.status === 'PROPOSED').length} proposed · ${d.openVerificationRequests} verification request(s)`} />
          </KpiRow>

          <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
            <Card>
              <CardHeader title="Application pipeline" subtitle="Current stage of every submitted application" />
              <div className="px-5 pb-5">
                <BarList items={pipeline.map((p) => ({ label: p.label, value: p.n }))} empty="No submitted applications yet." />
                <p className="mt-4 text-xs text-slate-500">Stage counts describe workflow progress, not approval outcomes.</p>
              </div>
            </Card>
            <Card>
              <CardHeader title="Source governance" subtitle="Rules the automated checks may use" action={<TextLink to="/official/rules">Rules <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
              <div className="px-5 pb-5">
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3">
                  <div>
                    <div className="text-xs text-slate-500">Active rule set</div>
                    <div className="font-mono text-sm font-semibold text-slate-900">{sv.rulesetVersion}</div>
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  {[
                    ['APPROVED_FOR_EXECUTION', 'Approved for execution'],
                    ['VERIFIED', 'Verified'],
                    ['NEEDS_VERIFICATION', 'Needs verification'],
                    ['RETIRED', 'Retired'],
                  ].map(([k, label]) => (
                    <div key={k}>
                      <dt className="text-xs text-slate-500">{label}</dt>
                      <dd className="num mt-0.5 text-lg font-semibold text-slate-900">{rules[k] ?? 0}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-xs text-slate-500">Only approved rules can block a submission; other rules are advisory and routed to human review.</p>
              </div>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Workload by officer" subtitle="Active assignments on undecided applications" action={<TextLink to="/official/people">People <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
              <div className="px-5 pb-5">
                <BarList items={(sv.people ?? []).map((p: any) => ({ label: p.full_name, value: p.active_assignments, hint: (p.roles ?? []).map((r: string) => WORKSPACE_NAME[r] ?? r).join(", ") }))} empty="No active assignments." />
              </div>
            </Card>
            <Card>
              <CardHeader title="Assignment status" subtitle="Active applications by ownership and target" />
              <div className="px-5 pb-5">
                <SegmentBar
                  segments={[
                    { label: "Assigned, on target", value: active.filter((a) => a.assigned_any && !(a.next_deadline && a.next_deadline < today)).length, tone: "blue" },
                    { label: "Unassigned", value: active.filter((a) => !a.assigned_any).length, tone: "amber" },
                    { label: "Past response target", value: active.filter((a) => a.assigned_any && a.next_deadline && a.next_deadline < today).length, tone: "red" },
                  ]}
                  empty="No active applications."
                />
              </div>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader
              title="Assignment & target monitoring"
              subtitle="Active applications, their owner for the current stage and the nearest correction deadline"
              action={
                <FilterTabs
                  value={filter}
                  onChange={(v) => { setFilter(v); paged.setPage(1); }}
                  items={[
                    { value: 'active', label: 'All active', count: active.length },
                    { value: 'unassigned', label: 'Unassigned', count: active.filter((a) => !a.assigned_any).length },
                    { value: 'overdue', label: 'Past deadline', count: active.filter((a) => a.next_deadline && a.next_deadline < today).length },
                  ]}
                />
              }
            />
            <Table head={['Application ID', 'Institution', 'Stage', 'Assigned to', 'Outstanding items', 'Response target', '']} empty={monitored.length === 0 && <Empty title="Nothing to show" />}>
              {paged.slice.map((a) => {
                const late = a.next_deadline && a.next_deadline < today;
                return (
                  <tr key={a.id} className="hover:bg-slate-50/70">
                    <td className={`${tdCls} font-mono text-[13px] font-semibold whitespace-nowrap text-brand-600`}>{a.reference_no}</td>
                    <td className={tdCls}><div className="max-w-[220px] truncate">{a.institution_name}</div></td>
                    <td className={tdCls}><StatusBadge status={a.status} label={a.statusLabel} /></td>
                    <td className={`${tdCls} text-[13px]`}>{a.assigned_any ?? <span className="text-slate-400">Unassigned</span>}</td>
                    <td className={`${tdCls} text-[13px]`}>{a.outstanding_deficiencies || '—'}</td>
                    <td className={`${tdCls} text-[13px] whitespace-nowrap`}>{a.next_deadline ? <span className={late ? 'font-semibold text-rose-600' : ''}>{fmtDate(a.next_deadline)}{late && ' · overdue'}</span> : '—'}</td>
                    <td className={`${tdCls} text-right`}><TextLink onClick={() => nav(`/official/applications/${a.id}`)}>{a.assigned_any ? 'Reassign' : 'Assign'}</TextLink></td>
                  </tr>
                );
              })}
            </Table>
            <Pager {...paged} shown={paged.slice.length} />
          </Card>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Recent workflow activity" />
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {(d.recentActivity ?? []).length === 0 && <li className="px-5 py-4 text-sm text-slate-500">No activity yet.</li>}
                {(d.recentActivity ?? []).map((e: any) => (
                  <li key={e.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-slate-900">{actionLabel(e.action)}</span>
                      <span className="text-slate-500"> · </span>
                      <Link to={`/official/applications/${e.application_id}`} className="font-mono text-[13px] text-brand-600">{e.reference_no}</Link>
                    </span>
                    <span className="text-xs whitespace-nowrap text-slate-500">{fmtDateTime(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Latest audit event" subtitle="Append-only audit log" />
              <div className="px-5 pb-5">
                {sv.latestAudit ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                    <div className="font-mono text-[13px] font-semibold text-slate-900">{sv.latestAudit.action}</div>
                    <div className="mt-1 text-slate-600">
                      {sv.latestAudit.actor_name ?? 'System'}
                      {sv.latestAudit.actor_role && ` · ${WORKSPACE_NAME[sv.latestAudit.actor_role] ?? sv.latestAudit.actor_role}`}
                      {sv.latestAudit.entity_type && ` · ${sv.latestAudit.entity_type}`}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{fmtDateTime(sv.latestAudit.created_at)}</div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No audit events yet.</p>
                )}
                <p className="mt-3 text-xs text-slate-500">
                  {d.failedNotifications > 0 ? `${d.failedNotifications} notification delivery failure(s) awaiting retry.` : 'No failed notification deliveries.'}{' '}
                  {d.lastSweep && `Deadline monitor last ran ${fmtDateTime(d.lastSweep.started_at)}.`}
                </p>
              </div>
            </Card>
          </div>
        </>
      )}
      <PageNote>Supervisor visibility covers all applications; every reassignment is recorded with its reason.</PageNote>
    </>
  );
}

/** Officials and the workspaces they are authorised for. */
export function PeoplePermissions() {
  const dash = useApi('/api/official/dashboard');
  const people: any[] = dash.data?.supervisor?.people ?? [];
  const paged = usePaged(people, 12);
  return (
    <>
      <PageHeader crumbs={['Workspace', 'People & permissions']} title="People & permissions" subtitle="Official accounts, authorised workspaces and workload." />
      {dash.loading && !dash.data && <Spinner />}
      {dash.error && <Alert kind="error">{dash.error}</Alert>}
      {dash.data && (
        <Card>
          <CardHeader title="Official accounts" subtitle={`${people.length} account${people.length === 1 ? '' : 's'}`} />
          <Table head={['Official', 'Authorised workspaces', 'Active assignments', 'Last sign-in', 'Status']} empty={people.length === 0 && <Empty title="No official accounts" />}>
            {paged.slice.map((p) => (
              <tr key={p.id}>
                <td className={tdCls}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{initialsOf(p.full_name)}</span>
                    <div>
                      <div className="font-medium text-slate-900">{p.full_name}</div>
                      <div className="text-xs text-slate-500">{p.designation}</div>
                    </div>
                  </div>
                </td>
                <td className={tdCls}>
                  <div className="flex flex-wrap gap-1">
                    {p.roles.map((r: string) => (
                      <Badge key={r}>{WORKSPACE_NAME[r] ?? r}</Badge>
                    ))}
                  </div>
                </td>
                <td className={`${tdCls} num`}>{p.active_assignments}</td>
                <td className={`${tdCls} text-[13px] whitespace-nowrap text-slate-500`}>{p.last_login_at ? fmtDateTime(p.last_login_at) : 'Never'}</td>
                <td className={tdCls}><Badge t={p.status === 'ACTIVE' ? 'green' : 'red'}>{p.status.toLowerCase()}</Badge></td>
              </tr>
            ))}
          </Table>
          <Pager {...paged} shown={paged.slice.length} noun="accounts" />
        </Card>
      )}
      <PageNote>Role changes are made by an administrator outside this screen; this view is read-only.</PageNote>
    </>
  );
}

export function Escalations() {
  const { data, error, loading, reload } = useApi('/api/official/escalations');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Escalations']}
        title="Escalations & verification requests"
        subtitle="Overdue corrections, deadline events and verification requests."
        action={
          <Button
            variant="secondary"
            loading={busy === 'sweep'}
            onClick={async () => {
              setBusy('sweep');
              try {
                const r = await api.post('/api/official/admin/run-sweep');
                setMsg({ kind: 'success', text: `Sweep done: ${r.reminders} reminder(s), ${r.overdue} overdue, ${r.escalations} escalation(s).` });
                reload();
              } catch (e: any) {
                setMsg({ kind: 'error', text: e.message });
              } finally {
                setBusy(null);
              }
            }}
          >
            Run deadline monitor now
          </Button>
        }
      />
      {data?.policy && (
        <div className="mb-6">
          <Alert kind="info" title="Operational policy (system-configured)">
            <ul className="list-disc pl-4">{data.policy.map((p: string) => <li key={p}>{p}</li>)}</ul>
          </Alert>
        </div>
      )}
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {loading && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <div className="space-y-6">
          <Card>
            <CardHeader title="Overdue corrections" subtitle="Open items past their configured deadline" />
            <Table head={['Item', 'Application', 'Institution', 'Deadline', 'Type', 'Raised by']} empty={data.overdue.length === 0 && <Empty title="Nothing overdue" />}>
              {data.overdue.map((d: any) => (
                <tr key={d.id}>
                  <td className={tdCls}><div className="font-mono text-xs">{d.reference_no}</div><div className="text-xs text-slate-500">{d.target_label}</div></td>
                  <td className={tdCls}><Link className="font-mono text-[13px] font-semibold text-brand-600" to={`/official/applications/${d.application_id}`}>{d.application_ref}</Link></td>
                  <td className={`${tdCls} text-sm`}>{d.institution_name}</td>
                  <td className={`${tdCls} text-[13px]`}>{fmtDate(d.deadline)}</td>
                  <td className={tdCls}><Badge t={d.deadline_type === 'APH' ? 'red' : 'amber'}>{d.deadline_type === 'APH' ? 'regulatory' : 'operational'}</Badge></td>
                  <td className={`${tdCls} text-[13px]`}>{d.raised_by_name}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="Verification requests" />
            <ul className="divide-y divide-slate-100 border-t border-slate-200">
              {data.requests.length === 0 && <li className="p-5 text-sm text-slate-500">None.</li>}
              {data.requests.map((v: any) => (
                <li key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <Badge t={v.status === 'OPEN' ? 'violet' : 'green'}>{v.status.toLowerCase()}</Badge>
                  <Link className="font-mono text-[13px] font-semibold text-brand-600" to={`/official/applications/${v.application_id}`}>{v.application_ref}</Link>
                  <span className="min-w-0 flex-1">
                    {v.requested_by_name} ({WORKSPACE_NAME[v.requested_role] ?? v.requested_role}): {v.reason}
                    {v.resolution && <span className="text-slate-500"> → {v.resolution}</span>}
                  </span>
                  {v.status === 'OPEN' && (
                    <Button
                      variant="secondary"
                      className="px-3 py-1 text-xs"
                      loading={busy === v.id}
                      onClick={async () => {
                        const resolution = prompt('Resolution / instruction');
                        if (!resolution) return;
                        setBusy(v.id);
                        try {
                          await api.post(`/api/official/verification-requests/${v.id}/resolve`, { resolution });
                          reload();
                        } catch (e: any) {
                          setMsg({ kind: 'error', text: e.message });
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Resolve
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Deadline events" subtitle="Every reminder, overdue notice and escalation (de-duplicated)" />
            <Table head={['When', 'Event', 'Application', 'Key', 'Recipients']} empty={data.events.length === 0 && <Empty title="No events yet" />}>
              {data.events.map((e: any) => (
                <tr key={e.id}>
                  <td className={`${tdCls} text-xs whitespace-nowrap`}>{fmtDateTime(e.created_at)}</td>
                  <td className={tdCls}><Badge t={e.event_type === 'ESCALATED' ? 'red' : e.event_type === 'OVERDUE' ? 'amber' : 'blue'}>{e.event_type.toLowerCase()}</Badge></td>
                  <td className={`${tdCls} font-mono text-xs`}>{e.application_ref ?? '—'}</td>
                  <td className={`${tdCls} font-mono text-[10px]`}>{e.dedupe_key}</td>
                  <td className={`${tdCls} text-xs`}>{(e.recipients ?? []).length}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}

export function AdminConsole() {
  const [status, setStatus] = useState<'ALL' | 'FAILED' | 'DELIVERED'>('ALL');
  const n = useApi(`/api/official/admin/notifications${status === 'ALL' ? '' : `?status=${status}`}`);
  const jobs = useApi('/api/official/admin/jobs');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const count = (s: string) => (n.data?.counts ?? []).find((c: any) => c.delivery_status === s)?.n ?? 0;
  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Notifications & jobs']}
        title="Notifications & background jobs"
        subtitle="In-app delivery tracking (no email/SMS channel is configured) and deadline-monitor runs."
        action={
          <>
            <Button
              variant="secondary"
              loading={busy === 'retry'}
              disabled={!!busy}
              onClick={async () => {
                setBusy('retry');
                try {
                  const r = await api.post('/api/official/admin/notifications/retry');
                  setMsg(`Retried ${r.retried}; delivered ${r.delivered}.`);
                  n.reload();
                } finally {
                  setBusy(null);
                }
              }}
            >
              Retry failed deliveries
            </Button>
            <Button
              loading={busy === 'sweep'}
              disabled={!!busy}
              onClick={async () => {
                setBusy('sweep');
                try {
                  const r = await api.post('/api/official/admin/run-sweep');
                  setMsg(`Sweep: ${r.reminders} reminders, ${r.overdue} overdue, ${r.escalations} escalations.`);
                  jobs.reload();
                  n.reload();
                } finally {
                  setBusy(null);
                }
              }}
            >
              Run deadline monitor
            </Button>
          </>
        }
      />
      {msg && <div className="mb-4"><Alert kind="success">{msg}</Alert></div>}
      <KpiRow>
        <Kpi label="Delivered" value={count('DELIVERED')} tone="green" caption="In-app notifications" />
        <Kpi label="Failed" value={count('FAILED')} tone={count('FAILED') ? 'red' : 'default'} caption="Awaiting retry" />
        <Kpi label="Pending" value={count('PENDING')} caption="Queued" />
        <Kpi label="Job runs" value={jobs.data?.jobs.length ?? 0} caption={jobs.data ? `Every ${Math.round(jobs.data.intervalMs / 60000)} min` : undefined} />
      </KpiRow>
      <Card>
        <div className="px-5"><Tabs value={status} onChange={setStatus} items={[{ value: 'ALL', label: 'All' }, { value: 'FAILED', label: 'Failed' }, { value: 'DELIVERED', label: 'Delivered' }]} /></div>
        {n.loading && !n.data && <Spinner />}
        <Table head={['Created', 'Recipient', 'Event', 'Title', 'Delivery', 'Error']} empty={n.data?.notifications.length === 0 && <Empty title="No notifications" />}>
          {n.data?.notifications.map((x: any) => (
            <tr key={x.id}>
              <td className={`${tdCls} text-xs whitespace-nowrap`}>{fmtDateTime(x.created_at)}</td>
              <td className={`${tdCls} text-xs`}>{x.recipient}</td>
              <td className={`${tdCls} text-xs`}>{x.event_type}</td>
              <td className={`${tdCls} text-xs`}><div className="max-w-[260px] truncate">{x.title}</div></td>
              <td className={tdCls}><Badge t={x.delivery_status === 'FAILED' ? 'red' : 'green'}>{x.delivery_status.toLowerCase()}</Badge><div className="mt-0.5 text-[11px] text-slate-400">{x.attempts} attempt{x.attempts === 1 ? '' : 's'}</div></td>
              <td className={`${tdCls} text-xs text-rose-700`}>{x.last_error ?? ''}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card className="mt-6">
        <CardHeader title="Background job runs" />
        <Table head={['Job', 'Started', 'Status', 'Summary / error']}>
          {jobs.data?.jobs.map((j: any) => (
            <tr key={j.id}>
              <td className={`${tdCls} text-xs`}>{j.job}</td>
              <td className={`${tdCls} text-xs whitespace-nowrap`}>{fmtDateTime(j.started_at)}</td>
              <td className={tdCls}><Badge t={j.status === 'FAILED' ? 'red' : j.status === 'RUNNING' ? 'amber' : 'green'}>{j.status.toLowerCase()}</Badge></td>
              <td className={`${tdCls} font-mono text-[10px]`}>{j.error ?? JSON.stringify(j.summary)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
