import { ArrowRight, Check, FileText, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, inputCls, Kpi, KpiRow, Label, PageHeader, PageNote, Pager, Spinner, StatusBadge, Table, Tabs, tdCls, TextLink, Timeline, usePaged } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';
import { actionLabel } from '../../lib/roles';

/**
 * Re-scrutiny workspace: resubmission queue, side-by-side comparison of each notice item with the institution's
 * response, and the official review record. Every action goes through the existing workflow endpoints.
 */
const REVIEWED = ['RESOLVED', 'UNRESOLVED', 'PARTIALLY_RESOLVED'];
const OUTCOME_LABEL: Record<string, string> = { RESOLVED: 'Resolved', PARTIALLY_RESOLVED: 'Partially resolved', UNRESOLVED: 'Unresolved', RESPONDED: 'Official review pending', OPEN: 'No response' };

export function ReScrutinyWorkspace() {
  const { user } = useAuth();
  const queue = useApi<any>('/api/official/queue?scope=mine');
  const waiting = useApi<any>('/api/official/queue?scope=all');
  const [q, setQ] = useState('');
  const [resp, setResp] = useState<'all' | 'READY_FOR_RE_SCRUTINY' | 'UNDER_RE_SCRUTINY'>('all');
  const [who, setWho] = useState<'any' | 'me'>('any');
  const [selId, setSelId] = useState<string | null>(null);
  const rows: any[] = queue.data?.applications ?? [];
  const filtered = rows.filter(
    (a) => (resp === 'all' || a.status === resp) && (who === 'any' || a.assignment?.userId === user?.id) && (!q || `${a.reference_no} ${a.institution_name}`.toLowerCase().includes(q.toLowerCase())),
  );
  const paged = usePaged(filtered, 6);
  const mine = rows.filter((a) => a.assignment?.userId === user?.id);
  const awaiting = (waiting.data?.applications ?? []).filter((a: any) => ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'].includes(a.status)).length;
  useEffect(() => {
    if (!selId && rows.length) setSelId((mine.find((a) => a.status === 'UNDER_RE_SCRUTINY') ?? rows[0]).id);
  }, [rows, mine, selId]);

  return (
    <>
      <PageHeader crumbs={['Workspace', 'Overview']} title="Re-scrutiny workspace" subtitle="Compare resubmitted evidence with the original notice, then record your recommendation." />
      {queue.loading && !queue.data && <Spinner />}
      {queue.error && <Alert kind="error">{queue.error}</Alert>}
      {queue.data && (
        <>
          <KpiRow>
            <Kpi label="Assigned re-reviews" value={mine.length} caption="Your authorised review queue" />
            <Kpi label="Resubmissions ready" value={rows.filter((a) => a.status === 'READY_FOR_RE_SCRUTINY').length} tone="blue" caption="Responses received from institutions" />
            <Kpi label="Under examination" value={rows.filter((a) => a.status === 'UNDER_RE_SCRUTINY').length} caption="Reviews in progress" />
            <Kpi label="Awaiting clarification" value={awaiting} tone="amber" caption="Institution preparing its response" />
          </KpiRow>

          <Card>
            <CardHeader title="Resubmission queue" action={<TextLink to="/official/queue">View all {rows.length} <ArrowRight className="h-3.5 w-3.5" /></TextLink>} />
            <div className="grid gap-3 px-5 pb-4 md:grid-cols-[1fr_200px_180px]">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input aria-label="Search" className={`${inputCls} pl-9`} placeholder="Search application ID or institution" value={q} onChange={(e) => { setQ(e.target.value); paged.setPage(1); }} />
              </div>
              <select aria-label="Response status" className={inputCls} value={resp} onChange={(e) => { setResp(e.target.value as typeof resp); paged.setPage(1); }}>
                <option value="all">All responses</option>
                <option value="READY_FOR_RE_SCRUTINY">Resubmitted</option>
                <option value="UNDER_RE_SCRUTINY">Under examination</option>
              </select>
              <select aria-label="Assignment" className={inputCls} value={who} onChange={(e) => { setWho(e.target.value as typeof who); paged.setPage(1); }}>
                <option value="any">Any assignment</option>
                <option value="me">Assigned to me</option>
              </select>
            </div>
            <Table head={['Application', 'Institution', 'Response', 'Received', 'Status', '']} empty={filtered.length === 0 && <Empty title="No resubmissions">Correction packages appear here when institutions submit them.</Empty>}>
              {paged.slice.map((a) => (
                <tr key={a.id} className={cx('hover:bg-slate-50/70', selId === a.id && 'bg-brand-50/50')}>
                  <td className={`${tdCls} font-mono text-[13px] font-semibold whitespace-nowrap text-brand-700`}>{a.reference_no}</td>
                  <td className={tdCls}><div className="max-w-[260px] truncate">{a.institution_name}</div></td>
                  <td className={`${tdCls} text-[13px] text-slate-700`}>{a.responded_items} item{a.responded_items === 1 ? '' : 's'} responded</td>
                  <td className={`${tdCls} text-[13px] whitespace-nowrap text-slate-600`}>{fmtDate(a.last_correction_at ?? a.updated_at)}</td>
                  <td className={tdCls}><Badge t={a.status === 'READY_FOR_RE_SCRUTINY' ? 'blue' : 'slate'}>{a.status === 'READY_FOR_RE_SCRUTINY' ? 'Resubmitted' : 'Under examination'}</Badge></td>
                  <td className={`${tdCls} text-right`}>
                    <TextLink onClick={() => { setSelId(a.id); document.getElementById('compare')?.scrollIntoView({ behavior: 'smooth' }); }}>{a.status === 'READY_FOR_RE_SCRUTINY' ? 'Review' : 'Open'}</TextLink>
                  </td>
                </tr>
              ))}
            </Table>
            <Pager {...paged} shown={paged.slice.length} noun="resubmissions" />
          </Card>

          {selId && <ComparePanel key={selId} id={selId} onChanged={() => { queue.reload(); waiting.reload(); }} />}
        </>
      )}
      <PageNote>Your recommendation is recorded in the audit trail; it is not a statutory decision.</PageNote>
    </>
  );
}

function ComparePanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<any>(`/api/official/applications/${id}`);
  const [tab, setTab] = useState<'compare' | 'documents' | 'history'>('compare');
  const [idx, setIdx] = useState(0);
  const [itemNote, setItemNote] = useState('');
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const items: any[] = useMemo(() => {
    if (!data) return [];
    const notice = data.notices?.[0];
    return data.deficiencies.filter((d: any) => !['DRAFT', 'WITHDRAWN'].includes(d.status) && (!notice || d.notice_id === notice.id));
  }, [data]);
  const item = items[Math.min(idx, Math.max(0, items.length - 1))];
  useEffect(() => setItemNote(''), [idx]);

  if (loading && !data) return <Spinner />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;
  const a = data.application;
  const under = a.status === 'UNDER_RE_SCRUTINY';
  const reviewed = items.filter((d) => REVIEWED.includes(d.status)).length;
  const responded = items.filter((d) => d.status === 'RESPONDED').length;
  const notResolved = items.filter((d) => d.status !== 'RESOLVED').length;
  const unresolved = items.filter((d) => ['UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(d.status)).length;
  const options = [
    { v: 'COMPLETE_RE_SCRUTINY', label: 'All items resolved — complete re-scrutiny', ok: items.length > 0 && notResolved === 0 },
    { v: 'REQUEST_FURTHER_CORRECTION', label: 'Request further correction', ok: responded === 0 && unresolved > 0 },
    { v: 'REFER_UNRESOLVED', label: 'Refer unresolved items onward', ok: responded === 0 && unresolved > 0 },
  ];
  const chosen = options.find((o) => o.v === next);
  const response = item?.events?.filter((e: any) => e.event === 'RESPONSE').at(-1);
  const newDoc = item && data.documents.find((d: any) => d.deficiency_id === item.id && d.is_current);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
      await reload();
      onChanged();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div id="compare" className="mt-6 grid gap-6 xl:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader
          title="Compare correction response"
          subtitle={`${a.reference_no} · ${data.institution?.name ?? a.institution_snapshot?.name ?? ''}`}
          action={<TextLink onClick={() => nav(`/official/applications/${a.id}`)}>Full workspace <ArrowRight className="h-3.5 w-3.5" /></TextLink>}
        />
        <div className="px-5">
          <Tabs value={tab} onChange={setTab} items={[{ value: 'compare', label: 'Response comparison' }, { value: 'documents', label: 'Documents' }, { value: 'history', label: 'Workflow history' }]} />
        </div>
        <div className="p-5">
          {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
          {tab === 'compare' &&
            (items.length === 0 ? (
              <p className="text-sm text-slate-500">This application has no notice items.</p>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {items.map((d, i) => (
                    <button key={d.id} onClick={() => setIdx(i)} className={cx('inline-flex items-center gap-1 rounded-md border px-2.5 py-1 font-mono text-xs font-semibold', i === idx ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
                      {REVIEWED.includes(d.status) && <Check className="h-3 w-3" />}
                      {d.reference_no}
                    </button>
                  ))}
                </div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[15px] font-semibold text-slate-900">{item.reference_no} · {item.target_label}</div>
                  <Badge t={REVIEWED.includes(item.status) ? 'slate' : 'amber'}>{OUTCOME_LABEL[item.status] ?? item.status}</Badge>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg bg-slate-50 p-4">
                    <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Original notice · {fmtDate(item.raised_at)}</div>
                    <p className="mt-2 text-sm text-slate-800">{item.explanation}</p>
                    {item.corrective_action && <p className="mt-2 text-[13px] text-slate-600">Required: {item.corrective_action}</p>}
                    <div className="mt-3 text-xs text-slate-500">Issued by {item.raised_by_name}{item.notice_no ? ` · ${item.notice_no}` : ''}</div>
                  </div>
                  <div className="rounded-lg bg-brand-50/70 p-4">
                    <div className="text-[11px] font-semibold tracking-wide text-brand-700 uppercase">Institution response{response ? ` · ${fmtDate(response.created_at)}` : ''}</div>
                    <p className="mt-2 text-sm text-slate-800">{response?.note ?? 'No written response.'}</p>
                    {newDoc && (
                      <a href={`/api/documents/${newDoc.id}/download?inline=1`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-700 hover:underline">
                        <FileText className="h-3.5 w-3.5" /> {newDoc.file_name} (v{newDoc.version})
                      </a>
                    )}
                  </div>
                </div>
                {item.officer_response && REVIEWED.includes(item.status) && <p className="mt-3 text-[13px] text-slate-600">Your review: {item.officer_response}</p>}
                {under ? (
                  <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                    <Label htmlFor="in" hint="Kept in the audit trail">Item review note</Label>
                    <textarea id="in" rows={2} className={inputCls} value={itemNote} onChange={(e) => setItemNote(e.target.value)} placeholder="What you checked and found" />
                    <div className="flex flex-wrap gap-2">
                      {(['RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED'] as const).map((o) => (
                        <Button
                          key={o}
                          variant={o === 'RESOLVED' ? 'primary' : 'secondary'}
                          disabled={itemNote.trim().length < 3}
                          loading={busy === o}
                          onClick={() => run(o, () => api.post(`/api/official/deficiencies/${item.id}/review`, { outcome: o, note: itemNote.trim() }), `${item.reference_no} recorded as ${OUTCOME_LABEL[o].toLowerCase()}.`).then(() => idx < items.length - 1 && setIdx(idx + 1))}
                        >
                          {o === 'RESOLVED' && <Check className="h-4 w-4" />} Record: {OUTCOME_LABEL[o].toLowerCase()}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  a.status === 'READY_FOR_RE_SCRUTINY' && (
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3 text-sm">
                      <span className="text-slate-600">Take up this resubmission to record item reviews.</span>
                      <Button loading={busy === 'start'} onClick={() => run('start', () => api.post(`/api/official/applications/${a.id}/actions/START_RE_SCRUTINY`, {}), 'Taken up for re-scrutiny.')}>Take up</Button>
                    </div>
                  )
                )}
              </>
            ))}
          {tab === 'documents' && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {data.documents.filter((d: any) => d.is_current).map((d: any) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <FileText className="h-4 w-4 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate">{d.requirement_id} · {d.file_name}</span>
                  <span className="text-xs text-slate-500">v{d.version}{d.deficiency_id ? ' · correction' : ''}</span>
                  <a href={`/api/documents/${d.id}/download?inline=1`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand-700">Open</a>
                </li>
              ))}
            </ul>
          )}
          {tab === 'history' && (
            <Timeline items={[...data.timeline].reverse().slice(0, 12).map((e: any) => ({ id: e.id, title: actionLabel(e.action), meta: `${e.actor_name ?? 'System'} · ${fmtDateTime(e.created_at)}`, body: e.note }))} />
          )}
        </div>
      </Card>

      <Card className="self-start">
        <CardHeader title="Official review record" subtitle="Your recommendation is not a statutory decision." divided />
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-500">Items examined</div>
              <div className="num mt-1 text-lg font-semibold text-slate-900">{reviewed} of {items.length}</div>
            </div>
            <StatusBadge status={a.status} label={a.statusLabel} />
          </div>
          <div className="h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-brand-700" style={{ width: `${items.length ? (reviewed / items.length) * 100 : 0}%` }} /></div>
          <div>
            <Label htmlFor="rn" required>Review note</Label>
            <textarea id="rn" rows={4} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} disabled={!under} placeholder="Summary of your re-scrutiny" />
          </div>
          <div>
            <Label htmlFor="na" required>Recommended next action</Label>
            <select id="na" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} disabled={!under}>
              <option value="">Select after reviewing all items</option>
              {options.map((o) => <option key={o.v} value={o.v} disabled={!o.ok}>{o.label}</option>)}
            </select>
          </div>
          <Button className="w-full" disabled={!under || !chosen?.ok || note.trim().length < 5} loading={busy === 'submit'} onClick={() => run('submit', () => api.post(`/api/official/applications/${a.id}/actions/${chosen!.v}`, { reason: note.trim() }), 'Review submitted.')}>
            Submit review
          </Button>
          <p className="text-xs text-slate-500">
            {!under ? 'Take up the resubmission first.' : responded ? `Review all ${responded} remaining response(s) to enable every option.` : 'Only an authorised official can forward the application.'}
          </p>
          <Link to={`/official/applications/${a.id}`} className="block text-center text-[13px] font-semibold text-brand-700 hover:underline">Draft a follow-up item in the full workspace</Link>
        </div>
      </Card>
    </div>
  );
}
