import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Empty, FilterTabs, inputCls, Kpi, KpiRow, Label, Modal, PageHeader, PageNote, Pager, Spinner, Table, tdCls, usePaged } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, useApi } from '../../lib/hooks';

const LIFECYCLE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  NEEDS_VERIFICATION: 'Needs verification',
  VERIFIED: 'Verified',
  APPROVED_FOR_EXECUTION: 'Approved for execution',
  RETIRED: 'Retired',
};

export function RulesGovernance() {
  const { user } = useAuth();
  const [type, setType] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const qs = new URLSearchParams();
  if (type) qs.set('type', type);
  if (lifecycle) qs.set('lifecycle', lifecycle);
  const { data, error, loading, reload } = useApi(`/api/rules?${qs}`);
  const cats = useApi('/api/categories');
  const [msg, setMsg] = useState<string | null>(null);
  const canEdit = user?.activeRole === 'RULES_GOVERNANCE';
  const next: Record<string, string[]> = { DRAFT: ['NEEDS_VERIFICATION', 'VERIFIED'], NEEDS_VERIFICATION: ['VERIFIED', 'RETIRED'], VERIFIED: ['APPROVED_FOR_EXECUTION', 'RETIRED'], APPROVED_FOR_EXECUTION: ['RETIRED'], RETIRED: [] };
  const paged = usePaged(data?.rules, 15);
  const count = (s: string) => (data?.counts ?? []).find((c: any) => c.lifecycle_status === s)?.n ?? 0;
  return (
    <>
      <PageHeader crumbs={['Workspace', 'Regulatory rules']} title="Regulatory rules" subtitle="Versioned rules and their approval status." />
      <div className="mb-6">
        <Alert kind="warn" title="Development seed approval">
          Rules extracted from verified sources were seeded as approved for execution in this development build. In a real deployment an authorised rules-governance official must review and approve each rule.
        </Alert>
      </div>
      <KpiRow>
        <Kpi label="Approved for execution" value={count('APPROVED_FOR_EXECUTION')} tone="green" caption="Can block a submission" />
        <Kpi label="Verified" value={count('VERIFIED')} tone="blue" caption="Awaiting approval" />
        <Kpi label="Needs verification" value={count('NEEDS_VERIFICATION') + count('DRAFT')} tone="amber" caption="Advisory only" />
        <Kpi label="Retired" value={count('RETIRED')} caption="Kept for audit" />
      </KpiRow>
      {msg && <div className="mb-4"><Alert kind="error">{msg}</Alert></div>}
      <Card>
        <CardHeader title="Rule register" subtitle={data ? `${data.rules.length} rule version(s) match` : undefined} />
        <div className="grid gap-3 px-5 pb-4 sm:grid-cols-2">
          <select className={inputCls} value={type} onChange={(e) => { setType(e.target.value); paged.setPage(1); }} aria-label="Application type">
            <option value="">All application types</option>
            {cats.data?.categories.map((c: any) => <option key={c.code} value={c.code}>{c.title}</option>)}
          </select>
          <select className={inputCls} value={lifecycle} onChange={(e) => { setLifecycle(e.target.value); paged.setPage(1); }} aria-label="Lifecycle">
            <option value="">All lifecycle states</option>
            {Object.keys(next).map((l) => <option key={l} value={l}>{LIFECYCLE_LABEL[l]}</option>)}
          </select>
        </div>
        {loading && !data && <Spinner />}
        {error && <div className="p-4"><Alert kind="error">{error}</Alert></div>}
        <Table head={['Rule', 'Severity', 'Lifecycle', 'Approved', ...(canEdit ? [''] : [])]} empty={data?.rules.length === 0 && <Empty title="No rules match" />}>
          {paged.slice.map((r: any) => (
            <tr key={`${r.rule_id}@${r.rule_version}`} className="align-top">
              <td className={tdCls}>
                <div className="max-w-[340px] truncate text-[13px] font-medium text-slate-900">{r.target_label}</div>
                <div className="mt-0.5 max-w-[340px] truncate font-mono text-[11px] text-slate-500">{r.rule_id} v{r.rule_version}</div>
                <div className="text-[11px] text-slate-400">{r.rule_type.replace(/_/g, ' ').toLowerCase()}</div>
              </td>
              <td className={tdCls}><Badge t={r.severity === 'BLOCKING' ? 'red' : 'amber'}>{r.severity === 'BLOCKING' ? 'Blocking' : 'Advisory'}</Badge></td>
              <td className={tdCls}><Badge t={r.lifecycle_status === 'APPROVED_FOR_EXECUTION' ? 'green' : r.lifecycle_status === 'RETIRED' ? 'slate' : 'amber'}>{LIFECYCLE_LABEL[r.lifecycle_status] ?? r.lifecycle_status}</Badge></td>
              <td className={`${tdCls} text-xs text-slate-500`}><div className="max-w-[160px] truncate">{r.approved_by ? `${r.approved_by}` : '—'}</div>{r.approved_at && <div>{fmtDate(r.approved_at)}</div>}</td>
              {canEdit && (
                <td className={tdCls}>
                  {next[r.lifecycle_status].length > 0 && (
                    <select
                      aria-label="Change lifecycle"
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                      value=""
                      onChange={async (e) => {
                        const to = e.target.value;
                        const note = prompt(`Reason for moving ${r.rule_id} to ${LIFECYCLE_LABEL[to]}`);
                        if (!note) return;
                        try {
                          await api.post(`/api/rules/${encodeURIComponent(r.rule_id)}/${r.rule_version}/lifecycle`, { to, note });
                          setMsg(null);
                          reload();
                        } catch (err: any) {
                          setMsg(err.message);
                        }
                      }}
                    >
                      <option value="">Move to…</option>
                      {next[r.lifecycle_status].map((n) => <option key={n} value={n}>{LIFECYCLE_LABEL[n]}</option>)}
                    </select>
                  )}
                </td>
              )}
            </tr>
          ))}
        </Table>
        <Pager {...paged} shown={paged.slice.length} noun="rules" />
      </Card>
      <PageNote>Every lifecycle change is recorded in the audit log with its reason.</PageNote>
    </>
  );
}

export function ComplianceReview() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi('/api/official/compliance');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [target, setTarget] = useState<any>(null);
  const [outcome, setOutcome] = useState('ACCEPTED_BY_AUTHORISED_REVIEWER');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<'review' | 'all'>('review');
  const canReview = user?.activeRole === 'DECISION_AUTHORITY';
  const all: any[] = data?.obligations ?? [];
  const rows = all.filter((o) => filter === 'all' || ['SUBMITTED', 'UNDER_REVIEW', 'HUMAN_REVIEW_REQUIRED'].includes(o.status));
  const paged = usePaged(rows, 15);
  const LABEL: Record<string, [string, 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'slate']> = {
    NOT_YET_DUE: ['Not yet due', 'green'],
    DUE_SOON: ['Due soon', 'amber'],
    OVERDUE: ['Overdue', 'red'],
    NO_FIXED_DATE: ['Open — no fixed date', 'slate'],
    SUBMITTED: ['Submitted', 'blue'],
    UNDER_REVIEW: ['Under review', 'blue'],
    ACCEPTED_BY_AUTHORISED_REVIEWER: ['Accepted', 'green'],
    DEFICIENT: ['Deficient', 'red'],
    HUMAN_REVIEW_REQUIRED: ['Further review', 'violet'],
  };
  return (
    <>
      <PageHeader crumbs={['Workspace', 'Compliance review']} title="Compliance review" subtitle="Evidence submitted by institutions against their obligations." />
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Awaiting review" value={all.filter((o) => ['SUBMITTED', 'UNDER_REVIEW'].includes(o.status)).length} tone="blue" caption="Submitted evidence" />
            <Kpi label="Overdue" value={all.filter((o) => o.displayStatus === 'OVERDUE').length} tone="red" caption="Past the due date" />
            <Kpi label="Deficient" value={all.filter((o) => o.status === 'DEFICIENT').length} tone="amber" caption="Returned to the institution" />
            <Kpi label="Accepted" value={all.filter((o) => o.status === 'ACCEPTED_BY_AUTHORISED_REVIEWER').length} tone="green" caption="By an authorised reviewer" />
          </KpiRow>
          <Card>
            <CardHeader title="Obligations and undertakings" action={<FilterTabs value={filter} onChange={setFilter} items={[{ value: 'review', label: 'Needs review' }, { value: 'all', label: 'All' }]} />} />
            <Table head={['Item', 'Institution', 'Due', 'Status', 'Evidence', '']} empty={rows.length === 0 && <Empty title="Nothing to review" />}>
              {paged.slice.map((o) => {
                const [label, t] = LABEL[o.displayStatus] ?? [o.displayStatus, 'slate'];
                return (
                  <tr key={o.id} className="align-top">
                    <td className={tdCls}>
                      <div className="flex items-center gap-2"><span className="font-semibold">{o.title}</span>{o.kind === 'UNDERTAKING' && <Badge t="violet">Undertaking</Badge>}</div>
                      <div className="text-xs text-slate-500">{o.reference_no ?? '—'}</div>
                    </td>
                    <td className={tdCls}><div className="max-w-[200px] truncate text-sm">{o.institution_name}</div><div className="text-xs text-slate-500">{o.region_code ?? 'no region'}</div></td>
                    <td className={`${tdCls} text-xs whitespace-nowrap`}>{o.due_date ? fmtDate(o.due_date) : '—'}</td>
                    <td className={tdCls}><Badge t={t}>{label}</Badge></td>
                    <td className={`${tdCls} text-xs`}>
                      {o.evidence_name ? <a className="text-brand-600 underline" href={`/api/official/compliance/${o.id}/evidence`}>{o.evidence_name}</a> : '—'}
                      {o.submissions?.length > 1 && <div className="text-slate-400">{o.submissions.length} versions</div>}
                    </td>
                    <td className={tdCls}>
                      {canReview && ['SUBMITTED', 'UNDER_REVIEW', 'HUMAN_REVIEW_REQUIRED'].includes(o.status) && (
                        <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => { setTarget(o); setOutcome('ACCEPTED_BY_AUTHORISED_REVIEWER'); setNote(''); }}>Review</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
            <Pager {...paged} shown={paged.slice.length} noun="items" />
          </Card>
        </>
      )}
      <Modal open={!!target} onClose={() => setTarget(null)} title="Record compliance review">
        {target && (
          <div className="space-y-3 text-sm">
            <div className="font-semibold">{target.title}</div>
            <div className="text-xs text-slate-500">{target.description}</div>
            <div>
              <Label required>Outcome</Label>
              <select className={inputCls} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="UNDER_REVIEW">Mark under review</option>
                <option value="ACCEPTED_BY_AUTHORISED_REVIEWER">Accept (authorised reviewer)</option>
                <option value="DEFICIENT">Return as deficient</option>
                <option value="HUMAN_REVIEW_REQUIRED">Refer for further review</option>
              </select>
            </div>
            <div>
              <Label required>Note to the institution</Label>
              <textarea rows={3} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button>
              <Button
                disabled={note.trim().length < 3}
                onClick={async () => {
                  try {
                    await api.post(`/api/official/compliance/${target.id}/review`, { outcome, note: note.trim() });
                    setMsg({ kind: 'success', text: 'Review recorded and the institution notified.' });
                    setTarget(null);
                    reload();
                  } catch (e: any) {
                    setMsg({ kind: 'error', text: e.message });
                    setTarget(null);
                  }
                }}
              >
                Record review
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
