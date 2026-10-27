import { ArrowLeft, ArrowRight, CalendarClock, Download, FileText, Gavel, Inbox, MessageSquare, Scale, Send, Users } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, FilterTabs, inputCls, Kpi, KpiRow, KV, Label, PageHeader, PageNote, Spinner, StatusBadge, Table, tdCls, TextLink, Timeline, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCategories } from '../../lib/categories';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';
import { actionLabel } from '../../lib/roles';

/** What each body is for. */
const DESK: Record<string, { title: string; icon: typeof Gavel; tone: Tone; purpose: string }> = {
  EC: {
    title: 'Executive Committee',
    icon: Gavel,
    tone: 'blue',
    purpose: 'Decides on applications after considering the committee recommendations and the views of the Regulation Bureau. Decisions are uploaded as LoA / LoD / LoR, with a speaking order where required.',
  },
  SHC: {
    title: 'Standing Hearing Committee',
    icon: Users,
    tone: 'violet',
    purpose: 'Verifies the compliance an institution submits for shortcomings found by Scrutiny / Re-Scrutiny / EVC. Its recommendations are placed before the Executive Committee.',
  },
  SAC: {
    title: 'Standing Appellate Committee',
    icon: Scale,
    tone: 'amber',
    purpose: 'Considers appeals against Executive Committee decisions. Recommends / does not recommend to the Council, or recommends a further Scrutiny / EVC whose reports return to the SAC.',
  },
  COUNCIL: {
    title: 'Council',
    icon: Gavel,
    tone: 'green',
    purpose: 'Takes the final decision on appeals after the SAC recommendation. Its decision is uploaded on the portal and is final.',
  },
};
const OUTCOME: Record<string, string> = {
  COMPLIANCE_SATISFACTORY: 'Compliance satisfactory',
  COMPLIANCE_NOT_SATISFACTORY: 'Compliance not satisfactory',
  PARTIAL: 'Partial compliance',
  RECOMMEND: 'Recommend',
  NOT_RECOMMEND: 'Not recommend',
  REFER_SCRUTINY: 'Refer for Scrutiny Committee',
  REFER_EVC: 'Refer for EVC',
};
const KIND: Record<string, { label: string; disclosed: boolean }> = {
  REVIEW_NOTE: { label: 'Review note', disclosed: false },
  CLARIFICATION_REQUEST: { label: 'Clarification request', disclosed: true },
  HEARING_NOTICE: { label: 'Hearing notice', disclosed: true },
  HEARING_RECORD: { label: 'Hearing record', disclosed: false },
};
const human = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');

// ------------------------------------------------------------------ dashboard

export function CommitteeDashboard() {
  const nav = useNavigate();
  const cats = useCategories();
  const { data, error, loading } = useApi<any>('/api/committee/queue');
  const [tab, setTab] = useState<'pending' | 'waiting' | 'handled' | 'all'>('pending');
  const [q, setQ] = useState('');
  const c: string = data?.committee ?? 'EC';
  const desk = DESK[c];
  const rows: any[] = data?.cases ?? [];
  const filtered = rows
    .filter((x) => (tab === 'pending' ? x.pending : tab === 'waiting' ? x.pending && x.awaitingInstitution : tab === 'handled' ? !x.pending : true))
    .filter((x) => !q || `${x.reference_no} ${x.institution_name} ${x.appeal_ref ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const Icon = desk?.icon ?? Gavel;

  return (
    <>
      <PageHeader crumbs={['Workspace', 'Committee desk']} title={desk ? desk.title : 'Committee desk'} subtitle={desk?.purpose} />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge t={desk.tone}>
              <Icon className="h-3 w-3" /> {desk.title}
            </Badge>
            <span>The portal records proceedings; it never decides on its own.</span>
          </div>
          <KpiRow>
            <Kpi label="Before the committee" value={data.kpis.pending} tone="blue" caption="Cases formally referred and pending" />
            <Kpi label="Awaiting institution" value={data.kpis.awaitingInstitution} tone="amber" caption="Clarification requested, no reply yet" />
            <Kpi label="Upcoming hearings" value={data.kpis.hearingsUpcoming} tone="green" caption="Hearing notices issued" />
            <Kpi label="Handled" value={data.kpis.handled} caption="Recorded and moved on" />
          </KpiRow>
          <Card>
            <div className="flex flex-col gap-3 px-5 pt-4 pb-3 md:flex-row md:items-center md:justify-between">
              <FilterTabs
                value={tab}
                onChange={setTab}
                items={[
                  { value: 'pending', label: 'Pending', count: rows.filter((x) => x.pending).length },
                  { value: 'waiting', label: 'Awaiting institution', count: rows.filter((x) => x.pending && x.awaitingInstitution).length },
                  { value: 'handled', label: 'Handled', count: rows.filter((x) => !x.pending).length },
                  { value: 'all', label: 'All', count: rows.length },
                ]}
              />
              <input className={cx(inputCls, 'md:w-72')} placeholder="Search application, institution or appeal" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Table
              head={['Application', 'Institution', 'Stage', 'Before the committee', 'Last activity', '']}
              empty={filtered.length === 0 && <Empty icon={<Inbox className="h-5 w-5" />} title="No cases here">Cases appear when the workflow refers them to the {desk.title}.</Empty>}
            >
              {filtered.map((x) => (
                <tr key={x.id} className="hover:bg-slate-50/70">
                  <td className={tdCls}>
                    <div className="font-mono text-[13px] font-semibold whitespace-nowrap text-brand-600">{x.reference_no}</div>
                    <div className="max-w-[200px] truncate text-xs text-slate-500">{cats?.find((k) => k.code === x.category_code)?.shortTitle}</div>
                  </td>
                  <td className={tdCls}>
                    <div className="max-w-[220px] truncate">{x.institution_name}</div>
                    <div className="text-xs text-slate-500">{[x.district, x.state].filter(Boolean).join(', ')}</div>
                  </td>
                  <td className={tdCls}>
                    <StatusBadge status={x.status} label={x.statusLabel} />
                  </td>
                  <td className={`${tdCls} text-xs`}>
                    <CaseContext c={c} x={x} />
                  </td>
                  <td className={`${tdCls} text-[13px] whitespace-nowrap text-slate-500`}>{x.since ? fmtDate(x.since) : '—'}</td>
                  <td className={`${tdCls} text-right`}>
                    <TextLink onClick={() => nav(`/official/committee/${x.id}`)}>{x.pending ? 'Open case' : 'View'} →</TextLink>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
      <PageNote>Recommendations (SHC, SAC) and decisions (EC, Council) are recorded separately and never overwrite each other.</PageNote>
    </>
  );
}

function CaseContext({ c, x }: { c: string; x: any }) {
  const chips: ReactNode[] = [];
  if (!x.pending) chips.push(<Badge key="h" t="slate">With {x.holder ? DESK[x.holder]?.title : 'the next stage'}</Badge>);
  if (x.pending && x.awaitingInstitution) chips.push(<Badge key="w" t="amber">Awaiting institution</Badge>);
  if (x.hearing_at && new Date(x.hearing_at) > new Date()) chips.push(<Badge key="hr" t="green">Hearing {fmtDateTime(x.hearing_at)}</Badge>);
  if (c === 'EC' && x.shc_outcome) chips.push(<Badge key="s" t="violet">SHC recommendation on file</Badge>);
  if ((c === 'SAC' || c === 'COUNCIL') && x.appeal_ref) chips.push(<Badge key="a" t="amber">Appeal {x.appeal_ref}</Badge>);
  if (c === 'COUNCIL' && x.sac_outcome) chips.push(<Badge key="r" t="blue">SAC: {OUTCOME[x.sac_outcome] ?? x.sac_outcome}</Badge>);
  if (x.open_deficiencies) chips.push(<Badge key="d" t="red">{x.open_deficiencies} open deficienc{x.open_deficiencies === 1 ? 'y' : 'ies'}</Badge>);
  if (x.evc_reports) chips.push(<Badge key="e" t="slate">{x.evc_reports} EVC report(s)</Badge>);
  return <div className="flex max-w-[320px] flex-wrap gap-1">{chips.length ? chips : <span className="text-slate-400">—</span>}</div>;
}

// ------------------------------------------------------------------ case file

export function CommitteeCase() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<any>(`/api/committee/applications/${id}`);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const done = (kind: 'success' | 'error', text: string) => {
    setMsg({ kind, text });
    if (kind === 'success') reload();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const role = user?.activeRole ?? '';

  if (loading && !data) return <Spinner />;
  if (error && !data) return <Alert kind="error" title="Case not available">{error}</Alert>;
  if (!data) return null;
  const a = data.application;
  const desk = DESK[data.committee];
  const issues = data.deficiencies.filter((d: any) => !['DRAFT', 'WITHDRAWN', 'RESOLVED'].includes(d.status));
  const evcFindings = data.evcReports.flatMap((r: any) =>
    Object.entries(r.sections ?? {})
      .filter(([, s]: any) => ['DEFICIENT', 'NOT_VERIFIED'].includes(s.finding))
      .map(([k, s]: any) => ({ key: `${r.id}${k}`, section: human(k), finding: s.finding, observation: s.observation, version: r.version })),
  );

  return (
    <>
      <PageHeader
        crumbs={[desk.title, a.reference_no]}
        title={data.institution?.name ?? a.reference_no}
        subtitle={
          <>
            <span className="font-mono font-semibold text-brand-600">{a.reference_no}</span> · {data.category.title}
            {a.academic_year && ` · ${a.academic_year}`}
          </>
        }
        action={
          <Button variant="secondary" onClick={() => nav('/official')}>
            <ArrowLeft className="h-4 w-4" /> {desk.title}
          </Button>
        }
      />
      <Card className="mb-6">
        <div className="grid grid-cols-2 gap-5 px-5 py-4 lg:grid-cols-4">
          <KV k="Status" v={<StatusBadge status={a.status} label={a.statusLabel} />} />
          <KV k="Now before" v={data.holderName ? <Badge t={data.canAct ? 'blue' : 'slate'}>{data.holderName}</Badge> : 'No committee'} />
          <KV k="Submitted" v={a.submitted_at ? fmtDate(a.submitted_at) : '—'} />
          <KV k="Institution" v={<span className="text-[13px]">{[data.institution?.district, data.institution?.state].filter(Boolean).join(', ') || '—'}</span>} />
        </div>
        <div className="border-t border-slate-100 px-5 py-3">
          <StagePath stages={data.category.stages} stage={a.stage} />
        </div>
      </Card>
      {msg && <div className="mb-5"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {!data.canAct && <div className="mb-5"><Alert kind="info">This case is {data.holderName ? `before the ${data.holderName}` : 'not before a committee'} now. You can read the record; recording is closed for the {desk.title}.</Alert></div>}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          {data.appeal && (
            <Card>
              <CardHeader title={`Appeal ${data.appeal.reference_no}`} subtitle={`Filed ${fmtDateTime(data.appeal.submitted_at)} · ${data.appeal.deadline_basis}`} action={<Badge t="amber">{human(data.appeal.status)}</Badge>} divided />
              <div className="space-y-3 p-5 text-sm">
                <p className="whitespace-pre-wrap text-slate-800">{data.appeal.grounds}</p>
                {data.appeal.supporting_name && (
                  <a className="inline-flex items-center gap-1.5 font-medium text-brand-600 hover:underline" href={`/api/committee/applications/${a.id}/appeal-document?inline=1`} target="_blank" rel="noreferrer">
                    <FileText className="h-4 w-4" /> {data.appeal.supporting_name}
                  </a>
                )}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Issues before the committee" subtitle="Open deficiencies and EVC findings, with their sources" divided />
            {issues.length === 0 && evcFindings.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">No open deficiencies or adverse EVC findings on record.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {issues.map((d: any) => (
                  <li key={d.id} className="px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-500">{d.reference_no}</span>
                      <Badge t="red">{human(d.status)}</Badge>
                      <span className="font-medium text-slate-900">{d.target_label}</span>
                    </div>
                    <p className="mt-1 text-slate-700">{d.explanation}</p>
                    <div className="mt-0.5 text-xs text-slate-500">{human(d.category)}</div>
                  </li>
                ))}
                {evcFindings.map((f: any) => (
                  <li key={f.key} className="px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge t="amber">EVC report v{f.version}</Badge>
                      <span className="font-medium text-slate-900">{f.section}</span>
                      <Badge t={f.finding === 'DEFICIENT' ? 'red' : 'violet'}>{human(f.finding)}</Badge>
                    </div>
                    {f.observation && <p className="mt-1 text-slate-700">{f.observation}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Reports, recommendations and decisions" subtitle="Each kept as recorded — later records never overwrite earlier ones" divided />
            <div className="space-y-3 p-5">
              {data.evcReports.length === 0 && data.committeeReviews.length === 0 && data.decisions.length === 0 && <p className="text-sm text-slate-500">Nothing recorded yet.</p>}
              {data.evcReports.map((r: any) => (
                <Record key={r.id} tone="slate" label="EVC report" title={`Version ${r.version} · receipt ${r.receipt_no ?? '—'}`} meta={`${r.submitted_by_name} · ${fmtDateTime(r.submitted_at)}`}>
                  <p className="font-medium">{r.recommendation}</p>
                  <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-slate-600">{r.observations}</p>
                  {data.evcEvidence.filter((x: any) => x.report_id === r.id).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {data.evcEvidence
                        .filter((x: any) => x.report_id === r.id)
                        .map((x: any) => (
                          <a key={x.id} href={`/api/evc/evidence/${x.id}/download?inline=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-brand-600 hover:bg-slate-50">
                            <FileText className="h-3 w-3" /> {x.file_name}
                          </a>
                        ))}
                    </div>
                  )}
                </Record>
              ))}
              {data.committeeReviews.map((r: any) => (
                <Record key={r.id} tone={r.committee === 'SHC' ? 'violet' : 'amber'} label={`${r.committee} recommendation`} title={OUTCOME[r.outcome] ?? r.outcome} meta={`${r.recorded_by_name} · ${fmtDateTime(r.recorded_at)} · recommendation, not a decision`}>
                  <p className="whitespace-pre-wrap text-slate-700">{r.notes}</p>
                </Record>
              ))}
              {data.decisions.map((d: any) => (
                <Record key={d.id} tone={d.decision_body === 'COUNCIL' ? 'green' : 'blue'} label={d.decision_body === 'COUNCIL' ? 'Council decision (final)' : 'Executive Committee decision'} title={`${d.decision_type} · ${d.reference_no}`} meta={`${d.issuing_authority} · decided ${fmtDate(d.decision_date)} · uploaded ${fmtDateTime(d.uploaded_at)}`}>
                  {d.reasons && <p className="whitespace-pre-wrap text-slate-700"><span className="font-medium">Reasons: </span>{d.reasons}</p>}
                  {d.document_name && (
                    <a href={`/api/decisions/${d.id}/document`} className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-600 hover:underline">
                      <Download className="h-3.5 w-3.5" /> {d.document_name}
                    </a>
                  )}
                </Record>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Institution submissions" subtitle="Compliance and supporting material placed before a committee" divided />
            {data.committeeSubmissions.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">No submissions.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.committeeSubmissions.map((s: any) => (
                  <li key={s.id} className="px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge t="slate">To {DESK[s.committee]?.title ?? s.committee}</Badge>
                      <span className="text-xs text-slate-500">{s.submitted_by_name} · {fmtDateTime(s.submitted_at)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-slate-800">{s.note}</p>
                    {s.file_name && (
                      <a href={`/api/committee/submissions/${s.id}/download?inline=1`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-600 hover:underline">
                        <FileText className="h-3.5 w-3.5" /> {s.file_name}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Proceedings" subtitle="Notes, clarification requests, hearing notices and hearing records" divided />
            {data.committeeProceedings.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">No proceedings recorded.</p>
            ) : (
              <ol className="space-y-4 px-5 py-4">
                {[...data.committeeProceedings].reverse().map((p: any) => (
                  <li key={p.id} className="border-l-2 border-slate-200 pl-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge t={DESK[p.committee]?.tone ?? 'slate'}>{p.committee}</Badge>
                      <span className="font-medium text-slate-900">{KIND[p.kind]?.label ?? p.kind}</span>
                      <Badge t={p.disclosed ? 'green' : 'slate'}>{p.disclosed ? 'Sent to institution' : 'Internal'}</Badge>
                    </div>
                    {p.hearing_at && (
                      <div className="mt-1 inline-flex items-center gap-1.5 text-[13px] text-slate-700">
                        <CalendarClock className="h-3.5 w-3.5 text-slate-400" /> {fmtDateTime(p.hearing_at)} · {p.hearing_mode === 'ONLINE' ? 'Online' : 'Physical'}
                        {p.hearing_venue && ` · ${p.hearing_venue}`}
                      </div>
                    )}
                    <p className="mt-1 whitespace-pre-wrap text-slate-700">{p.body}</p>
                    <div className="mt-0.5 text-xs text-slate-500">{p.created_by_name} · {fmtDateTime(p.created_at)}</div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card>
            <CardHeader title="Workflow history" divided />
            <div className="pt-4">
              <Timeline
                items={[...data.timeline].reverse().slice(0, 25).map((e: any) => ({
                  id: e.id,
                  title: actionLabel(e.action),
                  meta: `${e.actor_name ?? 'System'} · ${fmtDateTime(e.created_at)}`,
                  body: e.note,
                }))}
              />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          {data.canAct && <ActionPanel data={data} role={role} onDone={done} />}
          {data.canAct && data.allowedKinds.length > 0 && <ProceedingForm appId={a.id} kinds={data.allowedKinds} onDone={done} />}
          <Card>
            <CardHeader title="Application documents" divided />
            <ul className="space-y-2 p-5 text-sm">
              {data.documents.filter((d: any) => d.is_current).length === 0 && <li className="text-slate-500">None.</li>}
              {data.documents
                .filter((d: any) => d.is_current)
                .map((d: any) => (
                  <li key={d.id}>
                    <a className="inline-flex items-center gap-1.5 text-slate-700 hover:underline" href={`/api/documents/${d.id}/download?inline=1`} target="_blank" rel="noreferrer">
                      <FileText className="h-3.5 w-3.5" /> {d.requirement_id}: {d.file_name}
                    </a>
                  </li>
                ))}
            </ul>
          </Card>
        </div>
      </div>
      <PageNote>{desk.title}. Automated findings are inputs to the committee; they are not decisions.</PageNote>
    </>
  );
}

function Record({ tone, label, title, meta, children }: { tone: Tone; label: string; title: string; meta: string; children?: ReactNode }) {
  const bar: Record<string, string> = { slate: 'border-slate-300', violet: 'border-violet-400', amber: 'border-amber-400', blue: 'border-brand-500', green: 'border-emerald-500', red: 'border-rose-400' };
  return (
    <div className={cx('rounded-lg border border-slate-200 border-l-4 p-4 text-sm', bar[tone])}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge t={tone}>{label}</Badge>
        <span className="font-semibold text-slate-900">{title}</span>
      </div>
      <div className="mt-0.5 text-xs text-slate-500">{meta}</div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

function StagePath({ stages, stage }: { stages: Array<{ key: string; label: string }>; stage: string }) {
  const idx = stages.findIndex((s) => s.key === stage || (stage === 'APPEAL' && s.key === 'DECISION'));
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {stages.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className={cx('rounded-full px-2.5 py-1 font-medium', i < idx ? 'bg-emerald-50 text-emerald-700' : i === idx ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>{s.label}</span>
          {i < stages.length - 1 && <ArrowRight className="h-3 w-3 text-slate-300" />}
        </li>
      ))}
      {stage === 'APPEAL' && (
        <>
          <ArrowRight className="h-3 w-3 text-slate-300" />
          <span className="rounded-full bg-amber-500 px-2.5 py-1 font-medium text-white">Appeal (SAC → Council)</span>
        </>
      )}
    </ol>
  );
}

/** Recommendation / decision for the body that holds the case. All go through the workflow action endpoint. */
function ActionPanel({ data, role, onDone }: { data: any; role: string; onDone: (k: 'success' | 'error', t: string) => void }) {
  const a = data.application;
  const [f, setF] = useState<Record<string, any>>({ decisionType: data.committee === 'COUNCIL' ? 'LOA' : 'LOA' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const act = async (action: string, body?: object | FormData, ok?: string) => {
    setBusy(true);
    try {
      if (body instanceof FormData) await api.upload(`/api/official/applications/${a.id}/actions/${action}`, body);
      else await api.post(`/api/official/applications/${a.id}/actions/${action}`, body ?? {});
      onDone('success', ok ?? 'Recorded.');
    } catch (e: any) {
      onDone('error', e.body?.details?.map?.((d: any) => d.message).join('; ') || e.message);
    } finally {
      setBusy(false);
    }
  };
  const types = useMemo(() => (data.committee === 'COUNCIL' ? ['LOA', 'LOR', 'OTHER'] : ['LOA', 'EOA', 'LOD', 'LOR', 'CLOSURE_ORDER', 'OTHER']), [data.committee]);
  const needsReasons = ['LOD', 'LOR'].includes(f.decisionType);

  if (role === 'SHC_MEMBER')
    return (
      <Card>
        <CardHeader title="SHC recommendation" subtitle="Placed before the Executive Committee. Not a decision." divided />
        <div className="space-y-3 p-5">
          <div>
            <Label htmlFor="o" required>Recommendation</Label>
            <select id="o" className={inputCls} value={f.outcome ?? ''} onChange={(e) => set('outcome', e.target.value)}>
              <option value="">Select…</option>
              {['COMPLIANCE_SATISFACTORY', 'PARTIAL', 'COMPLIANCE_NOT_SATISFACTORY'].map((o) => <option key={o} value={o}>{OUTCOME[o]}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="n" required>Observations and evidence considered</Label>
            <textarea id="n" rows={4} className={inputCls} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </div>
          <Button className="w-full" loading={busy} disabled={!f.outcome || (f.notes ?? '').trim().length < 3} onClick={() => act('RECORD_SHC_OUTCOME', { outcome: f.outcome, notes: f.notes }, 'Recommendation recorded and placed before the Executive Committee.')}>
            <Send className="h-4 w-4" /> Record and forward to EC
          </Button>
        </div>
      </Card>
    );

  if (role === 'SAC_MEMBER') {
    if (a.status === 'APPEAL_SUBMITTED')
      return (
        <Card>
          <CardHeader title="Appeal received" divided />
          <div className="p-5">
            <Button className="w-full" loading={busy} onClick={() => act('START_APPEAL_REVIEW', {}, 'Appeal taken up by the SAC.')}>Take up appeal</Button>
          </div>
        </Card>
      );
    if (a.status === 'AWAITING_AUTHORISED_DECISION')
      return (
        <Card>
          <CardHeader title="Further committee reports received" subtitle="Reports of the Scrutiny / EVC you ordered return to the SAC" divided />
          <div className="p-5">
            <Button className="w-full" loading={busy} onClick={() => act('RETURN_TO_SAC', {}, 'Placed before the SAC again.')}>Place before the SAC</Button>
          </div>
        </Card>
      );
    return (
      <Card>
        <CardHeader title="SAC recommendation" subtitle="To the Council, or for a further Scrutiny / EVC. Not a decision." divided />
        <div className="space-y-3 p-5">
          <div>
            <Label htmlFor="o" required>Recommendation</Label>
            <select id="o" className={inputCls} value={f.outcome ?? ''} onChange={(e) => set('outcome', e.target.value)}>
              <option value="">Select…</option>
              {['RECOMMEND', 'NOT_RECOMMEND', 'REFER_SCRUTINY', 'REFER_EVC'].map((o) => <option key={o} value={o}>{OUTCOME[o]}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="n" required>Observations</Label>
            <textarea id="n" rows={4} className={inputCls} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </div>
          <Button className="w-full" loading={busy} disabled={!f.outcome || (f.notes ?? '').trim().length < 3} onClick={() => act('RECORD_SAC_RECOMMENDATION', { outcome: f.outcome, notes: f.notes }, 'SAC recommendation recorded.')}>
            <Send className="h-4 w-4" /> Record recommendation
          </Button>
        </div>
      </Card>
    );
  }

  // EC or Council decision.
  return (
    <Card>
      <CardHeader
        title={data.committee === 'COUNCIL' ? 'Record the Council decision (final)' : 'Record the Executive Committee decision'}
        divided
      />
      <div className="space-y-3 p-5">
        <Alert kind="info">Record the decision taken by the competent body and upload the signed letter. Automated findings are inputs only.</Alert>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="dt" required>Decision</Label>
            <select id="dt" className={inputCls} value={f.decisionType} onChange={(e) => set('decisionType', e.target.value)}>
              {types.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="dd" required>Decision date</Label>
            <input id="dd" type="date" className={inputCls} value={f.decisionDate ?? ''} onChange={(e) => set('decisionDate', e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="rn" required>Letter / order reference</Label>
          <input id="rn" className={inputCls} value={f.referenceNo ?? ''} onChange={(e) => set('referenceNo', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="ia" required>Issuing authority</Label>
          <input id="ia" className={inputCls} value={f.issuingAuthority ?? (data.committee === 'COUNCIL' ? 'Council, AICTE' : 'Executive Committee, AICTE')} onChange={(e) => set('issuingAuthority', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="rs" required={needsReasons} hint={needsReasons ? 'Speaking order' : undefined}>Reasons</Label>
          <textarea id="rs" rows={3} className={inputCls} value={f.reasons ?? ''} onChange={(e) => set('reasons', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cd">Conditions / corrective action</Label>
          <textarea id="cd" rows={2} className={inputCls} value={f.conditions ?? ''} onChange={(e) => set('conditions', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="df" required>Signed decision document</Label>
          <input id="df" type="file" accept=".pdf,.jpg,.jpeg,.png" className={inputCls} onChange={(e) => set('file', e.target.files?.[0])} />
        </div>
        <Button
          className="w-full"
          loading={busy}
          disabled={!f.decisionDate || !f.referenceNo || !f.file || (needsReasons && !(f.reasons ?? '').trim())}
          onClick={() => {
            const fd = new FormData();
            fd.append('decisionType', f.decisionType);
            fd.append('referenceNo', f.referenceNo);
            fd.append('issuingAuthority', f.issuingAuthority ?? (data.committee === 'COUNCIL' ? 'Council, AICTE' : 'Executive Committee, AICTE'));
            fd.append('decisionDate', f.decisionDate);
            if (f.reasons) fd.append('reasons', f.reasons);
            if (f.conditions) fd.append('conditions', f.conditions);
            fd.append('file', f.file);
            act('ISSUE_DECISION', fd, 'Decision recorded and published to the institution.');
          }}
        >
          <Gavel className="h-4 w-4" /> Record decision
        </Button>
      </div>
    </Card>
  );
}

function ProceedingForm({ appId, kinds, onDone }: { appId: string; kinds: string[]; onDone: (k: 'success' | 'error', t: string) => void }) {
  const [kind, setKind] = useState(kinds[0]);
  const [body, setBody] = useState('');
  const [when, setWhen] = useState('');
  const [mode, setMode] = useState('ONLINE');
  const [venue, setVenue] = useState('');
  const [busy, setBusy] = useState(false);
  const hearing = kind === 'HEARING_NOTICE';
  async function save() {
    setBusy(true);
    try {
      await api.post(`/api/committee/applications/${appId}/proceedings`, { kind, body, ...(hearing ? { hearingAt: new Date(`${when}:00+05:30`).toISOString(), hearingMode: mode, hearingVenue: venue || undefined } : {}) });
      setBody('');
      setWhen('');
      setVenue('');
      onDone('success', KIND[kind].disclosed ? `${KIND[kind].label} sent to the institution.` : `${KIND[kind].label} recorded (internal).`);
    } catch (e: any) {
      onDone('error', e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title="Record proceedings" subtitle="Internal notes stay internal; requests and notices go to the institution" divided />
      <div className="space-y-3 p-5">
        <div>
          <Label htmlFor="pk">Type</Label>
          <select id="pk" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => <option key={k} value={k}>{KIND[k].label}{KIND[k].disclosed ? ' — sent to institution' : ' — internal'}</option>)}
          </select>
        </div>
        {hearing && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="hw" required>Date & time (IST)</Label>
              <input id="hw" type="datetime-local" className={inputCls} value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="hm" required>Mode</Label>
              <select id="hm" className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="ONLINE">Online</option>
                <option value="PHYSICAL">Physical</option>
              </select>
            </div>
            <div className="col-span-2">
              <Label htmlFor="hv">{mode === 'ONLINE' ? 'Meeting link' : 'Venue'}</Label>
              <input id="hv" className={inputCls} value={venue} onChange={(e) => setVenue(e.target.value)} />
            </div>
          </div>
        )}
        <div>
          <Label htmlFor="pb" required>{hearing ? 'Notice text' : kind === 'CLARIFICATION_REQUEST' ? 'What the institution must clarify' : 'Text'}</Label>
          <textarea id="pb" rows={3} className={inputCls} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <Button variant="secondary" className="w-full" loading={busy} disabled={body.trim().length < 5 || (hearing && !when)} onClick={save}>
          <MessageSquare className="h-4 w-4" /> {KIND[kind].disclosed ? 'Send to institution' : 'Record'}
        </Button>
      </div>
    </Card>
  );
}
