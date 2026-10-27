import { ArrowLeft, ArrowRight, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Empty, FilterTabs, inputCls, Kpi, KpiRow, KV, Label, PageHeader, PageNote, Pager, Spinner, Table, tdCls, TextLink, Timeline, usePaged, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';
import { istRange, responsePill } from './evcCoord';
import { SEAT_SHORT } from './EvcMember';

export const ESC_TONE: Record<string, Tone> = {
  OPEN: 'red',
  ACKNOWLEDGED: 'amber',
  EXPLANATION_REQUESTED: 'violet',
  ACTION_ASSIGNED: 'blue',
  RETURNED_FOR_INFORMATION: 'violet',
  RESOLVED: 'green',
  CLOSED: 'slate',
};
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const ACTION_LABEL: Record<string, string> = {
  ACKNOWLEDGE: 'Acknowledge',
  REQUEST_EXPLANATION: 'Request explanation',
  RECORD_FOLLOW_UP: 'Record follow-up',
  ASSIGN_ACTION: 'Assign corrective action',
  RETURN_FOR_INFORMATION: 'Return for further information',
  RESOLVE: 'Record resolution',
  CLOSE: 'Close escalation',
};

/** Regulation Bureau home: cross-region bottlenecks, overdue work, missing reports and compliance delays. */
export function BureauOverview() {
  const nav = useNavigate();
  const ov = useApi('/api/bureau/overview');
  const q = useApi('/api/bureau/escalations?open=true');
  const d = ov.data;
  const open = q.data?.escalations ?? [];
  const stages = new Map<string, { label: string; n: number; maxDays: number; regions: Record<string, number> }>();
  const regionKey = (s: any): string => s.region_code ?? 'Not configured';
  for (const s of d?.byStage ?? []) {
    const x = stages.get(s.status) ?? { label: s.label as string, n: 0, maxDays: 0, regions: {} as Record<string, number> };
    x.n += s.n;
    x.maxDays = Math.max(x.maxDays, s.max_days ?? 0);
    x.regions[regionKey(s)] = (x.regions[regionKey(s)] ?? 0) + s.n;
    stages.set(s.status, x);
  }
  const regions: string[] = [...(d?.regions ?? []).map((r: any) => r.code), ...((d?.byStage ?? []).some((s: any) => !s.region_code) ? ['Not configured'] : [])];
  const overdueTotal = (d?.overdueDeadlines ?? []).reduce((a: number, x: any) => a + x.n, 0);
  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Overview']}
        title="Regulation Bureau"
        subtitle="Cross-region pendency, EVC escalations and compliance delays."
        action={<Button onClick={() => nav('/official/bureau/escalations')}><ShieldAlert className="h-4 w-4" /> Escalation queue</Button>}
      />
      {(ov.loading && !d) || (q.loading && !q.data) ? <Spinner /> : null}
      {ov.error && <Alert kind="error">{ov.error}</Alert>}
      {d && (
        <>
          <KpiRow>
            <Kpi label="Open escalations" value={open.length} tone={open.length ? 'red' : 'default'} caption="Awaiting Bureau follow-up" />
            <Kpi label="Overdue deadlines" value={overdueTotal} tone={overdueTotal ? 'amber' : 'default'} caption="Corrections, compliance and EVC follow-up" />
            <Kpi label="EVC reports missing" value={d.missingReports.length} tone={d.missingReports.length ? 'red' : 'default'} caption="Past the configured due time" />
            <Kpi label="Compliance delays" value={d.complianceDelays.length} tone={d.complianceDelays.length ? 'amber' : 'default'} caption="Past the due date" />
          </KpiRow>
          <div className="mb-6"><Alert kind="info">{d.note}</Alert></div>
          <Card className="mb-6">
            <CardHeader title="Stage bottlenecks by region" subtitle="Applications at each stage; days measured from the last workflow event" />
            <Table head={['Stage', ...regions, 'Total', 'Longest at stage']} empty={stages.size === 0 && <Empty title="No applications in processing" />}>
              {[...stages.entries()].map(([k, s]) => (
                <tr key={k}>
                  <td className={`${tdCls} font-medium`}>{s.label}</td>
                  {regions.map((r) => (
                    <td key={r} className={`${tdCls} num`}>{s.regions[r] ?? '—'}</td>
                  ))}
                  <td className={`${tdCls} num font-semibold`}>{s.n}</td>
                  <td className={`${tdCls} num text-slate-600`}>{s.maxDays} day(s)</td>
                </tr>
              ))}
            </Table>
          </Card>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title="Open escalations" action={<TextLink to="/official/bureau/escalations">Queue <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {open.length === 0 && <li className="px-5 py-4 text-sm text-slate-500">No open escalations.</li>}
                {open.slice(0, 6).map((e: any) => (
                  <li key={e.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <Badge t={ESC_TONE[e.status]}>{label(e.status)}</Badge>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-[13px] text-brand-600">{e.application_ref}</span> · {label(e.kind)}
                    </span>
                    <TextLink to={`/official/bureau/escalations/${e.id}`}>Open</TextLink>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Missing EVC reports" subtitle="Visit completed; report past its configured due time" />
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {d.missingReports.length === 0 && <li className="px-5 py-4 text-sm text-slate-500">None.</li>}
                {d.missingReports.map((m: any) => (
                  <li key={m.visit_id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <Link to={`/official/visits/${m.visit_id}`} className="font-mono text-[13px] text-brand-600">{m.reference_no}</Link>
                    <span className="min-w-0 flex-1 truncate">{m.institution_name}</span>
                    <span className="text-xs text-rose-600">due {fmtDateTime(m.due_at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <Card className="mt-6">
            <CardHeader title="Compliance delays" subtitle="Open or deficient items past the due date" />
            <Table head={['Item', 'Application', 'Institution', 'Region', 'Due', 'Status']} empty={d.complianceDelays.length === 0 && <Empty title="No compliance delays" />}>
              {d.complianceDelays.map((o: any) => (
                <tr key={o.id}>
                  <td className={tdCls}><div className="max-w-[280px] truncate font-medium">{o.title}</div></td>
                  <td className={`${tdCls} font-mono text-[13px]`}>{o.reference_no ?? '—'}</td>
                  <td className={tdCls}><div className="max-w-[200px] truncate">{o.institution_name}</div></td>
                  <td className={`${tdCls} text-[13px]`}>{o.region_code ?? 'Not configured'}</td>
                  <td className={`${tdCls} text-[13px] whitespace-nowrap text-rose-600`}>{fmtDate(o.due_date)}</td>
                  <td className={tdCls}><Badge t="amber">{label(o.status)}</Badge></td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
      <PageNote>All figures are counted from persisted records.</PageNote>
    </>
  );
}

export function EscalationQueue() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [kind, setKind] = useState('');
  const { data, error, loading } = useApi(`/api/bureau/escalations?${filter === 'open' ? 'open=true&' : ''}${kind ? `kind=${kind}` : ''}`);
  const rows: any[] = data?.escalations ?? [];
  const paged = usePaged(rows, 12);
  const count = (s: string) => (data?.counts ?? []).find((c: any) => c.status === s)?.n ?? 0;
  return (
    <>
      <PageHeader crumbs={['Workspace', 'Escalations']} title="EVC escalation queue" subtitle="Missed visits, overdue reports and scheduling disputes awaiting review." />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Open" value={count('OPEN')} tone={count('OPEN') ? 'red' : 'default'} caption="Not yet taken up" />
            <Kpi label="In follow-up" value={count('ACKNOWLEDGED') + count('EXPLANATION_REQUESTED') + count('ACTION_ASSIGNED') + count('RETURNED_FOR_INFORMATION')} tone="amber" caption="Acknowledged or awaiting response" />
            <Kpi label="Resolved" value={count('RESOLVED')} tone="green" caption="Resolution recorded" />
            <Kpi label="Closed" value={count('CLOSED')} caption="History preserved" />
          </KpiRow>
          <Card>
            <CardHeader
              title="Escalations"
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="Kind" className="rounded-lg border border-slate-300 px-2 py-1.5 text-[13px]" value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="">All reasons</option>
                    {data.kinds.map((k: any) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </select>
                  <FilterTabs value={filter} onChange={setFilter} items={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />
                </div>
              }
            />
            <Table head={['Escalation', 'Application', 'Reason', 'Visit', 'Raised', 'Status', '']} empty={rows.length === 0 && <Empty title="Nothing to show" />}>
              {paged.slice.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50/70">
                  <td className={`${tdCls} font-mono text-xs font-semibold whitespace-nowrap`}>{e.reference_no}</td>
                  <td className={tdCls}>
                    <div className="font-mono text-[13px] text-brand-600">{e.application_ref}</div>
                    <div className="max-w-[180px] truncate text-xs text-slate-500">{e.institution_name} · {e.region_code ?? 'no region'}</div>
                  </td>
                  <td className={tdCls}><div className="max-w-[260px] truncate text-[13px]">{label(e.kind)}</div></td>
                  <td className={`${tdCls} text-xs whitespace-nowrap`}>{e.scheduled_start ? fmtDateTime(e.scheduled_start) : '—'}</td>
                  <td className={`${tdCls} text-xs whitespace-nowrap text-slate-500`}>{fmtDateTime(e.created_at)}<div>{e.raised_role === 'SYSTEM' ? 'Deadline monitor' : label(e.raised_role)}</div></td>
                  <td className={tdCls}><Badge t={ESC_TONE[e.status]}>{label(e.status)}</Badge></td>
                  <td className={`${tdCls} text-right`}><TextLink to={`/official/bureau/escalations/${e.id}`}>Review</TextLink></td>
                </tr>
              ))}
            </Table>
            <Pager {...paged} shown={paged.slice.length} noun="escalations" />
          </Card>
        </>
      )}
      <PageNote>An escalation never penalises an EVC member, rejects an application or alters a decision.</PageNote>
    </>
  );
}

export function EscalationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi(`/api/bureau/escalations/${id}`);
  const [action, setAction] = useState('');
  const [note, setNote] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;
  const e = data.escalation;
  const canAct = user?.activeRole === 'REGULATION_BUREAU';
  const chosen = action || data.allowedActions[0] || '';
  return (
    <>
      <PageHeader
        crumbs={['Escalations', e.reference_no]}
        title={data.label}
        subtitle={`${e.reference_no} · ${e.application_ref} · ${e.institution_name}`}
        action={
          <>
            <Button variant="secondary" onClick={() => nav('/official/bureau/escalations')}><ArrowLeft className="h-4 w-4" /> Queue</Button>
            {e.visit_id && <Button variant="secondary" onClick={() => nav(`/official/visits/${e.visit_id}`)}>Visit record</Button>}
            <Button variant="secondary" onClick={() => nav(`/official/applications/${e.application_id}`)}>Application</Button>
          </>
        }
      />
      <Card className="mb-6">
        <div className="grid grid-cols-2 gap-5 px-5 py-4 lg:grid-cols-5">
          <KV k="Status" v={<Badge t={ESC_TONE[e.status]}>{label(e.status)}</Badge>} />
          <KV k="Owner" v={e.owner_name ?? 'Not yet taken up'} />
          <KV k="Raised" v={`${fmtDateTime(e.created_at)} · ${e.raised_role === 'SYSTEM' ? 'deadline monitor' : label(e.raised_role)}`} />
          <KV k="Deadline" v={e.deadline_at ? fmtDateTime(e.deadline_at) : '—'} />
          <KV k="Application stage" v={label(e.application_status)} />
        </div>
        <div className="border-t border-slate-100 px-5 py-3 text-sm text-slate-700">{e.reason}</div>
        {e.deadline_source && <div className="px-5 pb-3 text-xs text-slate-500">Deadline basis: {e.deadline_source}</div>}
      </Card>
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {data.visit && (
            <Card>
              <CardHeader title="Visit and committee" divided />
              <div className="grid gap-4 p-5 sm:grid-cols-3">
                <KV k="Scheduled" v={`${fmtDate(data.visit.scheduled_start)} · ${istRange(data.visit.scheduled_start, data.visit.scheduled_end)}`} />
                <KV k="Mode" v={data.visit.mode === 'ONLINE' ? 'Online' : 'Physical'} />
                <KV k="Visit status" v={label(data.visit.status)} />
                {data.visit.missed_reason && <KV k="Missed — reason given" v={data.visit.missed_reason} />}
              </div>
              <Table head={['Member', 'Seat', 'Response', 'Attendance']}>
                {data.members.map((m: any) => (
                  <tr key={m.user_id} className={m.active ? '' : 'text-slate-400'}>
                    <td className={tdCls}>{m.full_name}{!m.active && ' (removed)'}</td>
                    <td className={`${tdCls} text-[13px]`}>{SEAT_SHORT[m.seat] ?? '—'}</td>
                    <td className={tdCls}><Badge t={responsePill(m.response_status).tone}>{responsePill(m.response_status).label}</Badge>{(m.rejection_reason || m.conflict_note) && <div className="mt-1 text-xs text-violet-700">{m.rejection_reason ?? m.conflict_note}</div>}</td>
                    <td className={tdCls}><Badge t={m.attendance === 'PRESENT' ? 'green' : m.attendance === 'ABSENT' ? 'red' : 'slate'}>{label(m.attendance)}</Badge></td>
                  </tr>
                ))}
              </Table>
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-[13px] font-semibold">Reports</div>
                  {data.reports.length === 0 ? <p className="text-sm text-slate-500">None submitted.</p> : data.reports.map((r: any) => <div key={r.id} className="text-sm">v{r.version} · {r.receipt_no} · {fmtDateTime(r.submitted_at)}</div>)}
                </div>
                <div>
                  <div className="mb-1 text-[13px] font-semibold">Evidence</div>
                  {data.evidence.length === 0 ? <p className="text-sm text-slate-500">None.</p> : data.evidence.map((x: any) => <a key={x.id} className="block text-sm text-brand-600 hover:underline" href={`/api/evc/evidence/${x.id}/download`}>{x.file_name}</a>)}
                </div>
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title="Follow-up history" subtitle="Append-only" divided />
            <Timeline items={data.actions.map((a: any) => ({ id: a.id, title: ACTION_LABEL[a.action] ?? label(a.action), meta: `${a.actor_name ?? 'System'} · ${fmtDateTime(a.created_at)}${a.assigned_to_name ? ` · assigned to ${a.assigned_to_name}` : ''}`, body: a.note, tone: a.action === 'RAISED' ? 'warn' : 'done' }))} />
          </Card>
          <Card>
            <CardHeader title="Notification and acknowledgement history" divided />
            <Table head={['When', 'Recipient', 'Event', 'Delivery', 'Read']} empty={data.notifications.length === 0 && <Empty title="No notifications" />}>
              {data.notifications.map((n: any, i: number) => (
                <tr key={i}>
                  <td className={`${tdCls} text-xs whitespace-nowrap`}>{fmtDateTime(n.created_at)}</td>
                  <td className={`${tdCls} text-[13px]`}>{n.recipient}</td>
                  <td className={`${tdCls} text-xs`}>{n.title}</td>
                  <td className={tdCls}><Badge t={n.delivery_status === 'FAILED' ? 'red' : 'green'}>{n.delivery_status.toLowerCase()}</Badge></td>
                  <td className={`${tdCls} text-xs`}>{n.read_at ? fmtDateTime(n.read_at) : '—'}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Bureau action" subtitle="Recorded with your name and reason" divided />
            <div className="space-y-3 p-5">
              {!canAct ? (
                <p className="text-sm text-slate-500">Only Regulation Bureau officers act on escalations.</p>
              ) : data.allowedActions.length === 0 ? (
                <p className="text-sm text-slate-500">This escalation is closed.</p>
              ) : (
                <>
                  <div>
                    <Label required>Action</Label>
                    <select aria-label="Action" className={inputCls} value={chosen} onChange={(x) => setAction(x.target.value)}>
                      {data.allowedActions.map((a: string) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
                    </select>
                  </div>
                  {chosen === 'ASSIGN_ACTION' && (
                    <div>
                      <Label required>Assign to</Label>
                      <select aria-label="Assign to" className={inputCls} value={assignTo} onChange={(x) => setAssignTo(x.target.value)}>
                        <option value="">Select…</option>
                        {data.assignable.map((p: any) => <option key={`${p.id}${p.role}`} value={p.id}>{p.full_name} ({label(p.role)})</option>)}
                      </select>
                    </div>
                  )}
                  <div>
                    <Label required>{chosen === 'RESOLVE' ? 'Resolution and reason' : 'Note'}</Label>
                    <textarea aria-label="Note" rows={4} className={inputCls} value={note} onChange={(x) => setNote(x.target.value)} />
                  </div>
                  <Button
                    className="w-full"
                    loading={busy}
                    disabled={note.trim().length < 5 || (chosen === 'ASSIGN_ACTION' && !assignTo)}
                    onClick={async () => {
                      setBusy(true);
                      setMsg(null);
                      try {
                        await api.post(`/api/bureau/escalations/${id}/actions`, { action: chosen, note: note.trim(), assignTo: chosen === 'ASSIGN_ACTION' ? assignTo : undefined });
                        setMsg({ kind: 'success', text: `${ACTION_LABEL[chosen]} — recorded.` });
                        setNote('');
                        setAction('');
                        reload();
                      } catch (x: any) {
                        setMsg({ kind: 'error', text: x.message });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {ACTION_LABEL[chosen] ?? 'Record'}
                  </Button>
                  <p className="text-xs text-slate-500">Requests for explanation notify the committee and the region's Regional Officers.</p>
                </>
              )}
              {e.resolution && <Alert kind="success" title="Resolution">{e.resolution}</Alert>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Follow-up deadlines" divided />
            <ul className="space-y-2 p-5 text-xs">
              {data.deadlines.length === 0 && <li className="text-slate-500">None.</li>}
              {data.deadlines.map((d: any, i: number) => (
                <li key={i}>
                  <span className="font-semibold">{label(d.subject_type)}</span> · {fmtDateTime(d.due_at)} · {label(d.status)}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      <PageNote>Bureau actions are follow-up records only; approval decisions stay with the competent authority.</PageNote>
    </>
  );
}
