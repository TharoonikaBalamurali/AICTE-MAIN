import { ArrowRight, CalendarDays, ClipboardList, Download, Files, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, CardHeader, Empty, Kpi, KpiRow, KV, PageHeader, PageNote, Spinner, StatusBadge, StepBar, Table, tdCls, TextLink, Timeline } from '../components/ui';
import { BarList, ColumnChart } from '../components/Charts';
import { daysUntil, fmtDate, fmtDateTime, useApi } from '../lib/hooks';
import { actionLabel } from '../lib/roles';
import { workflowSteps } from '../lib/workflow';

export default function Dashboard() {
  const nav = useNavigate();
  const { data, error, loading } = useApi('/api/dashboard');
  const k = data?.kpis;
  const cur = data?.currentApplication;
  const needsCorrection = cur && ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'].includes(cur.status);
  const flow = cur ? workflowSteps(cur.status, cur.stages) : null;
  const left = daysUntil(cur?.next_deadline);

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Overview']}
        title="Your institution, at a glance"
        subtitle="Your applications, required actions and upcoming visits."
        action={
          <>
            <Button variant="secondary" onClick={() => nav('/applications')}>View applications</Button>
            <Button onClick={() => nav('/applications/new')}>
              <Plus className="h-4 w-4" /> New application
            </Button>
          </>
        }
      />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error" title="Could not load the overview">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Active applications" value={k.processing + k.actionRequired} caption={`${k.drafts} draft${k.drafts === 1 ? '' : 's'} saved`} />
            <Kpi label="Action required" value={k.actionRequired} tone={k.actionRequired ? 'amber' : 'default'} caption={`${k.openDeficiencies} open correction item${k.openDeficiencies === 1 ? '' : 's'}`} />
            <Kpi label="Upcoming EVC visits" value={data.upcomingEvc.length} tone="blue" caption={data.upcomingEvc[0] ? `Next ${fmtDate(data.upcomingEvc[0].scheduled_start)}` : 'No visit scheduled yet'} />
            <Kpi label="Decisions issued" value={k.withDecision} tone={k.withDecision ? 'green' : 'default'} caption="Decision issued or closed" />
          </KpiRow>

          {needsCorrection && (
            <div className="mb-6">
              <Alert
                kind="warn"
                title={`A correction notice on ${cur.reference_no} needs your response`}
                action={<Button onClick={() => nav('/deficiencies')}>Respond to notice <ArrowRight className="h-4 w-4" /></Button>}
              >
                {cur.open_items} of {cur.total_items} item{cur.total_items === 1 ? '' : 's'} open
                {cur.next_deadline ? ` · respond by ${fmtDate(cur.next_deadline)}${left !== null ? ` (${left < 0 ? `${-left} days overdue` : `${left} days left`})` : ''}` : ' · no response deadline has been configured'}
              </Alert>
            </div>
          )}

          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <Card>
              <CardHeader title="Current application" subtitle={cur ? 'The application that needs your attention first' : undefined} action={cur && <TextLink to={`/applications/${cur.id}`}>Open application <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
              {!cur ? (
                <Empty icon={<Files className="h-5 w-5" />} title="No application in processing" action={<Button variant="secondary" onClick={() => nav('/applications/new')}>Start an application</Button>}>
                  Submitted applications and their stage appear here.
                </Empty>
              ) : (
                <div className="px-5 pb-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm font-semibold text-brand-600">{cur.reference_no}</span>
                    <StatusBadge status={cur.status} label={cur.statusLabel} />
                  </div>
                  <div className="mt-1 text-[15px] font-semibold text-slate-900">{cur.categoryTitle}</div>
                  <div className="mt-5">{flow && <StepBar steps={flow.steps} current={flow.current} attention={flow.attention} />}</div>
                  <div className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-4">
                    <KV k="Submitted" v={fmtDate(cur.submitted_at)} />
                    <KV k="Last update" v={fmtDate(cur.updated_at)} />
                    <KV k="Open correction items" v={cur.open_items} />
                    <KV k="Response due" v={cur.next_deadline ? fmtDate(cur.next_deadline) : 'Not configured'} />
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {needsCorrection ? (
                      <Button onClick={() => nav('/deficiencies')}>Continue correction</Button>
                    ) : (
                      <Button onClick={() => nav(`/applications/${cur.id}`)}>View progress</Button>
                    )}
                    {cur.latest_notice_id && (
                      <a href={`/api/notices/${cur.latest_notice_id}/pdf`} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">
                        <Download className="h-4 w-4" /> Download notice
                      </a>
                    )}
                  </div>
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title="Latest activity" subtitle="Workflow events on your applications" />
              <Timeline
                items={data.recentActivity.map((e: any, i: number) => ({
                  id: e.id,
                  title: actionLabel(e.action),
                  meta: `${e.reference_no} · ${fmtDateTime(e.created_at)}`,
                  tone: ['ISSUE_DEFICIENCY_NOTICE', 'REQUEST_FURTHER_CORRECTION'].includes(e.action) ? 'warn' : i === 0 ? 'current' : 'done',
                }))}
              />
            </Card>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
            <Card>
              <CardHeader title="My applications" subtitle="Most recently updated" action={<TextLink to="/applications">View all <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
              <Table
                head={['Application ID', 'Application type', 'Stage', '']}
                empty={data.recentApplications.length === 0 && <Empty icon={<Files className="h-5 w-5" />} title="No applications yet">Use “New application” to start one. Drafts are saved on the server.</Empty>}
              >
                {data.recentApplications.map((a: any) => (
                  <tr key={a.id} className="hover:bg-slate-50/70">
                    <td className={`${tdCls} font-mono text-[13px] font-semibold whitespace-nowrap text-brand-600`}>{a.reference_no ?? <span className="font-sans text-slate-400">Draft</span>}</td>
                    <td className={tdCls}><div className="max-w-[200px] truncate text-slate-700">{a.categoryTitle}</div></td>
                    <td className={tdCls}><StatusBadge status={a.status} label={a.statusLabel} /></td>
                    <td className={`${tdCls} text-right`}>
                      <TextLink to={a.status === 'DRAFT' ? `/applications/${a.id}/edit` : `/applications/${a.id}`}>{a.status === 'DRAFT' ? 'Continue' : 'Open'}</TextLink>
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card>
              <CardHeader title="Next steps" action={<TextLink to="/compliance">Compliance <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
              <ul className="space-y-3 px-5 pb-5">
                {needsCorrection && (
                  <Step icon={<ClipboardList className="h-4 w-4" />} tone="amber" title="Respond to the correction notice" meta={`${cur.reference_no} · ${cur.open_items} open item(s)`} />
                )}
                {data.upcomingEvc.map((v: any) => (
                  <Step key={v.id} icon={<CalendarDays className="h-4 w-4" />} title={`EVC visit (${v.mode.toLowerCase()})`} meta={`${v.reference_no} · ${fmtDateTime(v.scheduled_start)}`} />
                ))}
                {data.obligations.map((o: any) => {
                  const d = daysUntil(o.due_date);
                  return <Step key={o.id} icon={<ClipboardList className="h-4 w-4" />} tone={d !== null && d < 0 ? 'red' : 'slate'} title={o.title} meta={o.due_date ? `Due ${fmtDate(o.due_date)}` : 'No fixed date'} />;
                })}
                {!needsCorrection && data.upcomingEvc.length === 0 && data.obligations.length === 0 && <li className="text-sm text-slate-500">Nothing pending from your institution right now.</li>}
              </ul>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Applications by stage" subtitle="Where each of your applications stands" />
              <div className="px-5 pb-5">
                <BarList items={STAGES.map(([key, label]) => ({ label, value: data.stageDistribution[key] ?? 0 }))} empty="No applications yet." />
              </div>
            </Card>
            <Card>
              <CardHeader title="Submissions by month" subtitle="Last six months" />
              <div className="px-5 pb-5">
                <ColumnChart items={lastMonths(6).map(([key, label]) => ({ label, value: data.monthlySubmissions.find((m: any) => m.month === key)?.n ?? 0 }))} />
              </div>
            </Card>
          </div>
        </>
      )}
      <PageNote>Only your institution’s records are shown.</PageNote>
    </>
  );
}

const STAGES: Array<[string, string]> = [
  ['DRAFT', 'Draft'],
  ['SUBMITTED', 'Submitted'],
  ['SELF_DISCLOSURE', 'Self-disclosure check'],
  ['SCRUTINY', 'Scrutiny & correction'],
  ['EVC', 'Expert visit'],
  ['SHC', 'Standing Hearing Committee'],
  ['DECISION', 'Decision'],
  ['APPEAL', 'Appeal'],
  ['CLOSED', 'Closed'],
];

/** [YYYY-MM, short label] for the last n months in IST, oldest first. */
function lastMonths(n: number): Array<[string, string]> {
  const now = new Date(Date.now() + 5.5 * 3600000);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1));
    return [d.toISOString().slice(0, 7), d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })];
  });
}

function Step({ icon, title, meta, tone = 'slate' }: { icon: ReactNode; title: string; meta: string; tone?: 'slate' | 'amber' | 'red' }) {
  const c = { slate: 'bg-slate-100 text-slate-500', amber: 'bg-amber-50 text-amber-600', red: 'bg-rose-50 text-rose-600' }[tone];
  return (
    <li className="flex gap-3">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${c}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900">{title}</div>
        <div className="truncate text-xs text-slate-500">{meta}</div>
      </div>
    </li>
  );
}
