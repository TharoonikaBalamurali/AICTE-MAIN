import { Download, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Empty, inputCls, Kpi, KpiRow, Label, PageHeader, PageNote, Pager, Spinner, Table, tdCls, usePaged } from '../../components/ui';
import { BarList } from '../../components/Charts';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCategories } from '../../lib/categories';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';

const EVC_STATUSES = ['PROPOSED', 'SCHEDULED', 'RESCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'MISSED'];

/** Consolidated pendency report with filters and CSV export (exports are audited). */
export function PendencyReport() {
  const { user } = useAuth();
  const cats = useCategories();
  const meta = useApi('/api/meta');
  const [f, setF] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<Record<string, string>>({});
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v));
  const { data, error, loading } = useApi(`/api/reports/pendency?${qs}`);
  const paged = usePaged<any>(data?.rows, 15);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const rows: any[] = data?.rows ?? [];
  const overdue = rows.filter((r) => r.overdueDeadlines > 0).length;
  const avg = rows.length ? Math.round((rows.reduce((a, r) => a + r.daysAtStage, 0) / rows.length) * 10) / 10 : 0;

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Reports']}
        title="Pendency report"
        subtitle={`${data?.scope ?? ''} · stage-wise pendency, deadlines, EVC and compliance status. Contact details are excluded.`}
        action={
          <a href={`/api/reports/pendency?${new URLSearchParams({ ...Object.fromEntries(qs), format: 'csv' })}`} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700">
            <Download className="h-4 w-4" /> Export CSV
          </a>
        }
      />
      <Card className="mb-6">
        <CardHeader title="Filters" />
        <form
          className="grid gap-3 px-5 pb-5 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(f);
          }}
        >
          <div><Label>Submitted from</Label><input type="date" className={inputCls} value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} /></div>
          <div><Label>Submitted to</Label><input type="date" className={inputCls} value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} /></div>
          <div>
            <Label>Region</Label>
            <select className={inputCls} value={f.region ?? ''} onChange={(e) => set('region', e.target.value)}>
              <option value="">All {user?.activeRole === 'REGIONAL_OFFICER' ? 'of my regions' : 'regions'}</option>
              {data?.regions.map((r: any) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <Label>Application type</Label>
            <select className={inputCls} value={f.category ?? ''} onChange={(e) => set('category', e.target.value)}>
              <option value="">All</option>
              {cats?.map((c) => <option key={c.code} value={c.code}>{c.title}</option>)}
            </select>
          </div>
          <div>
            <Label>Workflow stage</Label>
            <select className={inputCls} value={f.stage ?? ''} onChange={(e) => set('stage', e.target.value)}>
              <option value="">All</option>
              {meta.data && Object.entries(meta.data.states as Record<string, string>).filter(([k]) => k !== 'DRAFT').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <Label>EVC status</Label>
            <select className={inputCls} value={f.evcStatus ?? ''} onChange={(e) => set('evcStatus', e.target.value)}>
              <option value="">Any</option>
              {EVC_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
            </select>
          </div>
          <div>
            <Label>Compliance</Label>
            <select className={inputCls} value={f.complianceStatus ?? ''} onChange={(e) => set('complianceStatus', e.target.value)}>
              <option value="">Any</option>
              <option value="ANY_OPEN">Has open items</option>
              <option value="OVERDUE">Has overdue items</option>
              <option value="NONE">No open items</option>
            </select>
          </div>
          <div>
            <Label>Overdue deadlines</Label>
            <select className={inputCls} value={f.overdue ?? ''} onChange={(e) => set('overdue', e.target.value)}>
              <option value="">Any</option>
              <option value="true">Overdue only</option>
              <option value="false">None overdue</option>
            </select>
          </div>
          <div className="flex items-end gap-2 md:col-span-4">
            <Button type="submit"><Search className="h-4 w-4" /> Apply filters</Button>
            <Button type="button" variant="secondary" onClick={() => { setF({}); setApplied({}); }}>Reset</Button>
          </div>
        </form>
      </Card>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Applications" value={rows.length} caption="Matching the filters" />
            <Kpi label="With overdue deadlines" value={overdue} tone={overdue ? 'red' : 'default'} caption="Corrections, compliance or EVC follow-up" />
            <Kpi label="Average days at stage" value={avg} tone="blue" caption="Since the last workflow event" />
            <Kpi label="Stages represented" value={data.summary.length} caption="Distinct workflow stages" />
          </KpiRow>
          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Pending by stage" subtitle="Applications matching the filters" />
              <div className="px-5 pb-5">
                <BarList items={[...data.summary].sort((a: any, b: any) => b.count - a.count).map((s: any) => ({ label: s.stage, value: s.count }))} empty="No applications match." />
              </div>
            </Card>
            <Card>
              <CardHeader title="Average days at stage" subtitle="Since each application's last workflow event" />
              <div className="px-5 pb-5">
                <BarList items={[...data.summary].sort((a: any, b: any) => b.avgDays - a.avgDays).map((s: any) => ({ label: s.stage, value: s.avgDays, hint: `longest ${s.maxDays} days` }))} unit=" d" empty="No applications match." />
              </div>
            </Card>
          </div>
          <Card className="mb-6">
            <CardHeader title="Stage summary" />
            <Table head={['Stage', 'Applications', 'Average days', 'Longest', 'With overdue items']} empty={data.summary.length === 0 && <Empty title="No data" />}>
              {data.summary.map((s: any) => (
                <tr key={s.stage}>
                  <td className={`${tdCls} font-medium`}>{s.stage}</td>
                  <td className={`${tdCls} num`}>{s.count}</td>
                  <td className={`${tdCls} num`}>{s.avgDays}</td>
                  <td className={`${tdCls} num`}>{s.maxDays}</td>
                  <td className={`${tdCls} num`}>{s.overdue ? <span className="font-semibold text-brand-700">{s.overdue}</span> : 0}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="Applications" />
            <Table head={['Application', 'Stage', 'Days', 'Assigned', 'EVC', 'Open items', 'Next due', 'Compliance']} empty={rows.length === 0 && <Empty title="No applications match" />}>
              {paged.slice.map((r) => (
                <tr key={r.applicationId}>
                  <td className={tdCls}>
                    <Link to={`/official/applications/${r.applicationId}`} className="font-mono text-[13px] font-semibold text-brand-600">{r.applicationRef}</Link>
                    <div className="max-w-[180px] truncate text-xs text-slate-500">{r.institution}</div>
                    <div className="text-xs text-slate-400">{r.region}</div>
                  </td>
                  <td className={tdCls}><div className="max-w-[150px] truncate text-[13px]">{r.stage}</div></td>
                  <td className={`${tdCls} num`}>{r.daysAtStage}</td>
                  <td className={tdCls}><div className="max-w-[160px] truncate text-xs">{r.assigned || '—'}</div></td>
                  <td className={`${tdCls} text-xs`}>{r.evcStatus ? r.evcStatus.toLowerCase() : '—'}{r.evcReportVersion ? ` · report v${r.evcReportVersion}` : ''}</td>
                  <td className={`${tdCls} num`}>{r.openCorrectionItems || '—'}</td>
                  <td className={`${tdCls} text-xs whitespace-nowrap`}>{r.nextDueAt ? <span className={r.overdueDeadlines ? 'font-semibold text-rose-600' : ''}>{fmtDate(r.nextDueAt)}</span> : '—'}</td>
                  <td className={tdCls}>{r.complianceOverdue ? <Badge t="red">{r.complianceOverdue} overdue</Badge> : r.complianceOpen ? <Badge t="amber">{r.complianceOpen} open</Badge> : <span className="text-xs text-slate-400">—</span>}</td>
                </tr>
              ))}
            </Table>
            <Pager {...paged} shown={paged.slice.length} />
          </Card>
        </>
      )}
      <PageNote>CSV exports are recorded in the audit log with the filters used.</PageNote>
    </>
  );
}

/** Operational configuration: administrators propose, supervisors authorise. */
export function OperationalPolicies() {
  const { user } = useAuth();
  const role = user?.activeRole ?? '';
  const { data, error, loading, reload } = useApi('/api/official/admin/policies');
  const [edit, setEdit] = useState<Record<string, { value: string; reason: string }>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
      setEdit({});
      reload();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    }
  };
  return (
    <>
      <PageHeader crumbs={['Workspace', 'Operational settings']} title="Operational settings" subtitle="Follow-up periods (reminders only)." />
      {data && <div className="mb-6"><Alert kind="warn" title="Operational setting">{data.note} Values marked “demonstration” have not been authorised.</Alert></div>}
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <Card className="mb-6">
            <CardHeader title="Settings" subtitle="An administrator proposes a value; a supervisor (a different person) authorises it" />
            <Table head={['Setting', 'Value', 'Version', 'Status', ...(role === 'SYSTEM_ADMIN' || role === 'SUPERVISOR' ? ['Action'] : [])]}>
              {data.policies.map((p: any) => (
                <tr key={p.key} className="align-top">
                  <td className={tdCls}><div className="font-mono text-xs font-semibold">{p.key}</div><div className="mt-0.5 max-w-[420px] text-xs text-slate-500">{p.description}</div></td>
                  <td className={`${tdCls} num font-semibold`}>{String(p.value)}</td>
                  <td className={`${tdCls} num`}>v{p.version}</td>
                  <td className={tdCls}><Badge t={p.status === 'AUTHORISED' ? 'green' : 'amber'}>{p.status === 'AUTHORISED' ? 'Authorised' : 'Demonstration'}</Badge>{p.authorised_by && <div className="mt-0.5 text-[11px] text-slate-500">{p.authorised_by}</div>}</td>
                  {role === 'SYSTEM_ADMIN' && (
                    <td className={tdCls}>
                      <div className="flex flex-wrap gap-2">
                        <input aria-label="New value" type="number" className="w-20 rounded-md border border-slate-300 px-2 py-1 text-xs" value={edit[p.key]?.value ?? ''} onChange={(e) => setEdit({ ...edit, [p.key]: { reason: edit[p.key]?.reason ?? '', value: e.target.value } })} />
                        <input aria-label="Reason" className="w-44 rounded-md border border-slate-300 px-2 py-1 text-xs" placeholder="Reason" value={edit[p.key]?.reason ?? ''} onChange={(e) => setEdit({ ...edit, [p.key]: { value: edit[p.key]?.value ?? '', reason: e.target.value } })} />
                        <Button variant="secondary" className="px-2.5 py-1 text-xs" disabled={!edit[p.key]?.value || (edit[p.key]?.reason ?? '').length < 5} onClick={() => act(() => api.put(`/api/official/admin/policies/${p.key}`, { value: Number(edit[p.key].value), reason: edit[p.key].reason }), `${p.key} changed; it now awaits authorisation.`)}>
                          Propose
                        </Button>
                      </div>
                    </td>
                  )}
                  {role === 'SUPERVISOR' && (
                    <td className={tdCls}>
                      {p.status !== 'AUTHORISED' && (
                        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => { const reason = prompt(`Reason for authorising ${p.key} = ${p.value}`); if (reason) act(() => api.post(`/api/official/admin/policies/${p.key}/authorise`, { reason }), `${p.key} authorised.`); }}>
                          Authorise
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="Change history" subtitle="Append-only" />
            <Table head={['When', 'Setting', 'Version', 'Value', 'Status', 'By', 'Reason']}>
              {data.history.map((h: any) => (
                <tr key={h.id}>
                  <td className={`${tdCls} text-xs whitespace-nowrap`}>{fmtDateTime(h.created_at)}</td>
                  <td className={`${tdCls} font-mono text-xs`}>{h.key}</td>
                  <td className={`${tdCls} num`}>v{h.version}</td>
                  <td className={`${tdCls} num`}>{String(h.value)}</td>
                  <td className={`${tdCls} text-xs`}>{h.status.toLowerCase().replace('_', ' ')}</td>
                  <td className={`${tdCls} text-xs`}>{h.changed_by_name ?? 'Seed'}</td>
                  <td className={`${tdCls} text-xs`}>{h.reason}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
