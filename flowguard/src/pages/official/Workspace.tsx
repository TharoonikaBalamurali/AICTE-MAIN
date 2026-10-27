import { AlertTriangle, ArrowLeft, CheckCircle2, Download, ExternalLink, FileText, ShieldAlert, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, inputCls, KV, Label, PageHeader, PageNote, Spinner, StatusBadge, Table, Tabs, tdCls, TextLink, Timeline } from '../../components/ui';
import { DecisionCard, DEF_TONE } from '../../components/Workflow';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';
import { actionLabel, WORKSPACE_NAME } from '../../lib/roles';
import { StageProgress } from '../ApplicationDetail';
import { FindingPill, ReasonAction } from './common';
import { ReScrutinyReportView, ScrutinyReportView, type Finding } from './Reports';
import { ScrutinyActions } from './ScrutinyActions';
import { istLongDate, istRange, responsePill } from './evcCoord';
import { SEAT_SHORT } from './EvcMember';

type Tab = 'overview' | 'report' | 'documents' | 'rescrutiny' | 'deficiencies' | 'evc' | 'decision' | 'audit';

/** A titled block inside the actions card. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="mb-3 text-sm font-semibold text-slate-900">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function F({ label, children, required }: { label: string; children: ReactNode; required?: boolean }) {
  // Wrapping in a <label> associates the caption with its control for assistive technology.
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold text-slate-800">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      {children}
    </label>
  );
}

const CATEGORIES = ['MISSING_DOCUMENT', 'INVALID_OR_EXPIRED', 'SIGNATURE_AUTHENTICATION', 'MISMATCH', 'INCOMPLETE_INFORMATION', 'UNREADABLE_FILE', 'OTHER'];
const guessCategory = (f: Finding) =>
  f.ruleType === 'REQUIRED_DOCUMENT'
    ? 'MISSING_DOCUMENT'
    : f.ruleType === 'DOC_INTEGRITY'
      ? 'UNREADABLE_FILE'
      : ['DOC_NOT_EXPIRED', 'DOC_VALID_FROM_ISSUE', 'DOC_PERIOD_COVERED'].includes(f.ruleType)
        ? 'INVALID_OR_EXPIRED'
        : ['DOC_DSC_DECLARED', 'DOC_SIGNATURE_TECHNICAL', 'DOC_SIGNATORY_RECORDED'].includes(f.ruleType)
          ? 'SIGNATURE_AUTHENTICATION'
          : f.targetType === 'FIELD'
            ? 'INCOMPLETE_INFORMATION'
            : 'OTHER';

const REVIEW_LABEL: Record<string, string> = {
  EXAMINED_NO_OBSERVATION: 'Examined — no observation',
  OBSERVATION_RECORDED: 'Observation recorded',
  CLARIFICATION_NEEDED: 'Clarification needed',
};
const REVIEW_TONE: Record<string, 'green' | 'amber' | 'red'> = { EXAMINED_NO_OBSERVATION: 'green', OBSERVATION_RECORDED: 'amber', CLARIFICATION_NEEDED: 'red' };

export function OfficialApplication() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const role = user?.activeRole ?? '';
  const { data, error, loading, reload } = useApi(`/api/official/applications/${id}`);
  const [tab, setTab] = useState<Tab>((sp.get('tab') as Tab) || 'overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [f, setF] = useState<Record<string, any>>({ targetType: 'DOCUMENT', category: 'MISSING_DOCUMENT', deadlineType: 'NOT_CONFIGURED', mode: 'ONLINE', decisionType: 'EOA', outcome: '' });
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const [docSel, setDocSel] = useState<string | null>(null);
  const [rev, setRev] = useState({ status: 'EXAMINED_NO_OBSERVATION', observation: '' });
  const assignees = useApi(role === 'SUPERVISOR' ? `/api/official/users?role=${f.assignRole ?? 'SCRUTINY_OFFICIAL'}` : null, [f.assignRole]);

  useEffect(() => {
    if (!data || sp.get('tab')) return;
    const s = data.application.status;
    if (['READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'].includes(s) && data.reports.some((r: any) => r.kind === 'RE_SCRUTINY')) setTab('rescrutiny');
    else if (['SUBMITTED', 'UNDER_SCRUTINY'].includes(s) && ['SCRUTINY_OFFICIAL'].includes(role)) setTab('report');
    else if (['SCRUTINY_COMPLETED', 'AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED', 'EVC_IN_PROGRESS', 'EVC_REPORT_SUBMITTED'].includes(s) && data.category.route.evc === 'YES') setTab('evc');
    else if (['AWAITING_AUTHORISED_DECISION', 'DECISION_ISSUED', 'APPEAL_SUBMITTED', 'APPEAL_UNDER_REVIEW', 'AWAITING_COMMITTEE_REVIEW'].includes(s)) setTab('decision');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.application?.status]);

  async function call(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
      reload();
      return true;
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.body?.details?.map((d: any) => `${d.path}: ${d.message}`).join('; ') || e.message });
      return false;
    } finally {
      setBusy(null);
    }
  }
  const act = (action: string, body: Record<string, unknown> | FormData = {}, ok = `${action.replace(/_/g, ' ').toLowerCase()} — recorded.`) =>
    call(action, () => (body instanceof FormData ? api.upload(`/api/official/applications/${id}/actions/${action}`, body) : api.post(`/api/official/applications/${id}/actions/${action}`, body)), ok);
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null));

  if (loading && !data) return <Spinner />;
  if (error) return <Alert kind="error" title="Not available">{error}</Alert>;
  if (!data) return null;
  const a = data.application;
  const s = a.status;
  const route = data.category.route;
  const scrutinyReports = data.reports.filter((r: any) => r.kind === 'SCRUTINY');
  const reReports = data.reports.filter((r: any) => r.kind === 'RE_SCRUTINY');
  const latestScrutiny = scrutinyReports[0];
  const latestRe = reReports[0];
  const drafts = data.deficiencies.filter((d: any) => d.status === 'DRAFT');
  const myAssignment = data.assignments.find((x: any) => x.role === role);
  const stageAssignment = myAssignment ?? data.assignments[0];
  const canDraft = role === 'RE_SCRUTINY_OFFICIAL' && s === 'UNDER_RE_SCRUTINY';
  const canExamine = (role === 'SCRUTINY_OFFICIAL' && ['SUBMITTED', 'UNDER_SCRUTINY'].includes(s)) || (role === 'RE_SCRUTINY_OFFICIAL' && ['READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'].includes(s));
  const lastEvent = data.timeline.at(-1);
  const nextDeadline = data.deficiencies.filter((d: any) => d.status === 'OPEN' && d.deadline).map((d: any) => d.deadline).sort()[0];
  const latestNotice = data.notices[0];
  const noticeItems = latestNotice ? data.deficiencies.filter((d: any) => d.notice_id === latestNotice.id) : [];
  const issues = latestScrutiny ? latestScrutiny.content.summary.counts.DISCREPANCY_DETECTED + latestScrutiny.content.summary.counts.UNABLE_TO_VERIFY : 0;

  // Document verification state
  const currentDocs: any[] = data.documents.filter((d: any) => d.is_current);
  const doc = currentDocs.find((d) => d.id === docSel) ?? currentDocs[0];
  const docDef = doc && data.documentsDef.find((x: any) => x.id === doc.requirement_id);
  const latestReview = (docId: string) => data.documentReviews.find((r: any) => r.document_id === docId);
  const docFindings: Finding[] = doc
    ? (latestScrutiny?.content.documents.expected.find((e: any) => e.id === doc.requirement_id)?.findings ?? []).filter((x: Finding) => !['PASS', 'NOT_APPLICABLE'].includes(x.status))
    : [];
  const examined = currentDocs.filter((d) => latestReview(d.id)).length;

  const onDraft = canDraft
    ? (fd: Finding) => {
        setF((x) => ({
          ...x,
          targetType: fd.targetType === 'APPLICATION' ? 'APPLICATION' : fd.targetType,
          targetId: fd.targetId ?? '',
          category: guessCategory(fd),
          explanation: fd.explanation,
          correctiveAction: fd.correctiveAction || '',
          sourceReference: fd.sourceReference ?? '',
          sourceFindingRuleId: fd.ruleId,
        }));
        setMsg({ kind: 'success', text: 'Finding copied into the draft form — review and edit before saving.' });
        document.getElementById('draft-form')?.scrollIntoView({ behavior: 'smooth' });
      }
    : undefined;

  // ------------------------------------------------------------------ action panel
  const actions: ReactNode[] = [];
  if (role === 'SCRUTINY_OFFICIAL' && (['SUBMITTED', 'UNDER_SCRUTINY'].includes(s) || (s === 'SCRUTINY_COMPLETED' && route.evc === 'YES'))) {
    actions.push(
      <ScrutinyActions
        key="scrutiny"
        report={latestScrutiny}
        route={route}
        fieldsDef={data.fieldsDef}
        documentsDef={data.documentsDef.filter((d: any) => d.stage === 'SUBMISSION')}
        busy={busy}
        onSend={(reason, deficiencies) => act('SEND_FOR_RESCRUTINY', { reason, deficiencies }, 'Correction notice issued to the institution. Its response will go to the re-scrutiny workspace.')}
        onForward={(reason) => act('FORWARD_TO_EVC', { reason }, route.evc === 'YES' ? 'Forwarded to the EVC coordinator.' : 'Forwarded to the decision stage.')}
      />,
    );
  }
  if (role === 'RE_SCRUTINY_OFFICIAL') {
    if (s === 'READY_FOR_RE_SCRUTINY')
      actions.push(
        <Button key="rs" className="w-full" loading={busy === 'START_RE_SCRUTINY'} onClick={() => act('START_RE_SCRUTINY')}>
          Take up for re-scrutiny
        </Button>,
      );
    if (s === 'UNDER_RE_SCRUTINY') {
      const items = latestRe?.content.deficiencies ?? [];
      const reviewed = items.filter((e: any) => ['RESOLVED', 'UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(data.deficiencies.find((d: any) => d.id === e.deficiencyId)?.status)).length;
      const responded = data.deficiencies.filter((d: any) => d.status === 'RESPONDED').length;
      const unresolved = data.deficiencies.filter((d: any) => ['UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(d.status)).length;
      const notResolved = data.deficiencies.filter((d: any) => !['RESOLVED', 'WITHDRAWN'].includes(d.status)).length;
      const options = [
        { v: 'COMPLETE_RE_SCRUTINY', label: 'All items addressed — complete re-scrutiny', ok: notResolved === 0, why: 'Every item must be marked resolved.' },
        { v: 'REQUEST_FURTHER_CORRECTION', label: 'Request further correction (updated notice)', ok: responded === 0 && (unresolved > 0 || drafts.length > 0), why: responded > 0 ? `Review all ${responded} response(s) first.` : 'Mark an item unresolved or partially resolved first.' },
        { v: 'REFER_UNRESOLVED', label: `Refer unresolved items to ${route.shc === 'AS_APPLICABLE' ? 'SHC' : 'the decision stage'}`, ok: true, why: '' },
      ];
      const chosen = options.find((o) => o.v === f.nextAction) ?? options[0];
      actions.push(
        <div key="rec" className="space-y-3">
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5 text-sm">
            <span className="text-slate-600">Items examined</span>
            <span className="num font-semibold text-slate-900">
              {reviewed} of {items.length}
            </span>
          </div>
          <F label="Recommended next action" required>
            <select className={inputCls} value={chosen.v} onChange={(e) => set('nextAction', e.target.value)}>
              {options.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </F>
          <F label="Review note" required>
            <textarea rows={3} className={inputCls} value={f.reviewNote ?? ''} onChange={(e) => set('reviewNote', e.target.value)} placeholder="Summarise your re-scrutiny (kept in the audit trail)" />
          </F>
          {!chosen.ok && <p className="text-xs text-amber-700">{chosen.why}</p>}
          <Button className="w-full" disabled={!chosen.ok || (f.reviewNote ?? '').trim().length < 5} loading={busy === chosen.v} onClick={() => act(chosen.v, { reason: f.reviewNote.trim() }, `Review submitted: ${chosen.label.toLowerCase()}.`).then((ok) => ok && set('reviewNote', ''))}>
            Submit review
          </Button>
        </div>,
      );
    }
  }
  if (['RE_SCRUTINY_OFFICIAL', 'SUPERVISOR'].includes(role) && s === 'SCRUTINY_COMPLETED' && route.evc === 'YES') {
    actions.push(
      <ReasonAction key="ho" variant="primary" label="Approve EVC handoff" hint="Creates an auditable handoff record and notifies the EVC scheduling queue." disabled={!data.evcEligibility?.eligible} disabledReason="Eligibility prerequisites are unresolved (see EVC tab)." busy={busy === 'APPROVE_EVC_HANDOFF'} onSubmit={(reason) => act('APPROVE_EVC_HANDOFF', { reason })} />,
    );
  }
  if (['RE_SCRUTINY_OFFICIAL', 'REGIONAL_OFFICER'].includes(role) && !['DECISION_ISSUED', 'CLOSED'].includes(s)) {
    actions.push(<ReasonAction key="vr" variant="secondary" label="Request further verification (supervisor)" hint="Use when findings are inconclusive. Open requests block EVC handoff." busy={busy === 'vr'} onSubmit={(reason) => call('vr', () => api.post(`/api/official/applications/${id}/verification-requests`, { reason }), 'Verification request sent to the supervisor.')} />);
  }
  if (role === 'EVC_MEMBER') {
    if (s === 'EVC_SCHEDULED')
      actions.push(
        <Button key="se" className="w-full" loading={busy === 'START_EVC'} onClick={() => act('START_EVC')}>
          Start visit
        </Button>,
      );
    if (s === 'EVC_IN_PROGRESS')
      actions.push(
        <Panel key="rep" title="Submit EVC report">
          <F label="Observations" required><textarea rows={4} className={inputCls} value={f.observations ?? ''} onChange={(e) => set('observations', e.target.value)} /></F>
          <F label="Recommendation" required><input className={inputCls} value={f.recommendation ?? ''} onChange={(e) => set('recommendation', e.target.value)} /></F>
          <F label="Summary disclosed to institution"><textarea rows={2} className={inputCls} value={f.disclosedSummary ?? ''} onChange={(e) => set('disclosedSummary', e.target.value)} /></F>
          <F label="Evidence references (one per line, internal)"><textarea rows={2} className={inputCls} value={f.evidence ?? ''} onChange={(e) => set('evidence', e.target.value)} /></F>
          <Button loading={busy === 'SUBMIT_EVC_REPORT'} onClick={() => act('SUBMIT_EVC_REPORT', clean({ observations: f.observations, recommendation: f.recommendation, disclosedSummary: f.disclosedSummary, evidenceRefs: (f.evidence ?? '').split('\n').map((x: string) => x.trim()).filter(Boolean) }))}>Submit report</Button>
        </Panel>,
      );
  }
  if (role === 'REGIONAL_OFFICER' && s === 'EVC_REPORT_SUBMITTED') {
    actions.push(<Button key="fd" className="w-full" loading={busy === 'FORWARD_AFTER_EVC'} onClick={() => act('FORWARD_AFTER_EVC', { toShc: false })}>Forward for authorised decision</Button>);
    if (route.shc === 'AS_APPLICABLE') actions.push(<Button key="fs" variant="secondary" className="w-full" loading={busy === 'FORWARD_AFTER_EVC'} onClick={() => act('FORWARD_AFTER_EVC', { toShc: true })}>Forward to SHC (compliance hearing)</Button>);
  }
  if (role === 'REGIONAL_OFFICER' && ['AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED'].includes(s) && tab !== 'evc')
    actions.push(
      <Button key="goevc" className="w-full" onClick={() => setTab('evc')}>
        {s === 'EVC_SCHEDULED' ? 'Manage scheduled visit' : 'Schedule the visit'}
      </Button>,
    );
  if (['EC_OFFICIAL', 'SHC_MEMBER', 'SAC_MEMBER', 'COUNCIL_OFFICIAL'].includes(role))
    actions.push(
      <Button key="case" className="w-full" onClick={() => nav(`/official/committee/${a.id}`)}>
        Open committee case file
      </Button>,
    );
  if (role === 'SHC_MEMBER' && s === 'AWAITING_COMMITTEE_REVIEW')
    actions.push(
      <Panel key="shc" title="Record SHC outcome">
        <F label="Outcome" required><select className={inputCls} value={f.outcome} onChange={(e) => set('outcome', e.target.value)}><option value="">Select…</option><option value="COMPLIANCE_SATISFACTORY">Compliance satisfactory</option><option value="PARTIAL">Partial</option><option value="COMPLIANCE_NOT_SATISFACTORY">Compliance not satisfactory</option></select></F>
        <F label="Notes" required><textarea rows={3} className={inputCls} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></F>
        <Button loading={busy === 'RECORD_SHC_OUTCOME'} onClick={() => act('RECORD_SHC_OUTCOME', { outcome: f.outcome, notes: f.notes })}>Record and forward to EC</Button>
      </Panel>,
    );
  if (role === 'DECISION_AUTHORITY') {
    if (s === 'SUBMITTED' && a.reopen_requested_at)
      actions.push(
        <Panel key="ro" title="Reopen request">
          <p className="text-sm">{a.reopen_request_reason}</p>
          <ReasonAction label="Approve one-time reopening" busy={busy === 'APPROVE_REOPEN'} onSubmit={(reason) => act('APPROVE_REOPEN', { reason })} />
          <ReasonAction variant="secondary" label="Decline reopening" busy={busy === 'DECLINE_REOPEN'} onSubmit={(reason) => act('DECLINE_REOPEN', { reason })} />
        </Panel>,
      );
    if (s === 'DECISION_ISSUED') actions.push(<ReasonAction key="cl" variant="secondary" label="Close application (after appeal window)" busy={busy === 'CLOSE'} onSubmit={(reason) => act('CLOSE', { reason })} />);
  }
  if (role === 'SAC_MEMBER') {
    if (s === 'APPEAL_SUBMITTED') actions.push(<Button key="sa" className="w-full" loading={busy === 'START_APPEAL_REVIEW'} onClick={() => act('START_APPEAL_REVIEW')}>Take up appeal</Button>);
    if (s === 'APPEAL_UNDER_REVIEW')
      actions.push(
        <Panel key="sac" title="SAC recommendation">
          <F label="Outcome" required><select className={inputCls} value={f.outcome} onChange={(e) => set('outcome', e.target.value)}><option value="">Select…</option><option value="RECOMMEND">Recommend</option><option value="NOT_RECOMMEND">Not recommend</option><option value="REFER_SCRUTINY">Refer for Scrutiny Committee</option><option value="REFER_EVC">Refer for EVC</option></select></F>
          <F label="Notes" required><textarea rows={3} className={inputCls} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></F>
          <Button loading={busy === 'RECORD_SAC_RECOMMENDATION'} onClick={() => act('RECORD_SAC_RECOMMENDATION', { outcome: f.outcome, notes: f.notes })}>Record recommendation</Button>
        </Panel>,
      );
  }

  const draftForm = canDraft && (
    <Card id="draft-form">
      <CardHeader title="Draft follow-up item" subtitle="Within re-scrutiny scope. Not visible to the institution until a notice is issued." divided />
      <div className="space-y-3 p-5">
        <F label="Original item" required>
          <select className={inputCls} value={f.parentDeficiencyId ?? ''} onChange={(e) => set('parentDeficiencyId', e.target.value)}>
            <option value="">Select…</option>
            {data.deficiencies.filter((d: any) => !['DRAFT', 'WITHDRAWN'].includes(d.status)).map((d: any) => <option key={d.id} value={d.id}>{d.reference_no} — {d.target_label}</option>)}
          </select>
        </F>
        <F label="Affected item" required>
          <select className={inputCls} value={f.targetType} onChange={(e) => { set('targetType', e.target.value); set('targetId', ''); }}>
            <option value="DOCUMENT">Document</option><option value="FIELD">Field</option><option value="APPLICATION">Application (general)</option>
          </select>
        </F>
        {f.targetType !== 'APPLICATION' && (
          <F label={f.targetType === 'DOCUMENT' ? 'Document' : 'Field'} required>
            <select className={inputCls} value={f.targetId ?? ''} onChange={(e) => set('targetId', e.target.value)}>
              <option value="">Select…</option>
              {(f.targetType === 'DOCUMENT' ? data.documentsDef : data.fieldsDef).map((x: any) => <option key={x.id} value={x.id}>{x.name ?? x.label}</option>)}
            </select>
          </F>
        )}
        <F label="Category" required>
          <select className={inputCls} value={f.category} onChange={(e) => set('category', e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
        </F>
        <F label="Observation" required><textarea rows={2} className={inputCls} value={f.explanation ?? ''} onChange={(e) => set('explanation', e.target.value)} /></F>
        <F label="Required correction" required><input className={inputCls} value={f.correctiveAction ?? ''} onChange={(e) => set('correctiveAction', e.target.value)} /></F>
        <F label="Source reference"><input className={inputCls} value={f.sourceReference ?? ''} onChange={(e) => set('sourceReference', e.target.value)} placeholder="e.g. clause or policy reference" /></F>
        <F label="Deadline">
          <select className={inputCls} value={f.deadlineType} onChange={(e) => set('deadlineType', e.target.value)}>
            <option value="NOT_CONFIGURED">No deadline — requires authorised configuration</option>
            <option value="OPERATIONAL">Operational deadline (system-configured)</option>
            <option value="APH">Regulatory deadline (cite the clause)</option>
          </select>
        </F>
        {f.deadlineType !== 'NOT_CONFIGURED' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <F label="Date" required><input type="date" className={inputCls} value={f.deadline ?? ''} onChange={(e) => set('deadline', e.target.value)} /></F>
            <F label="Basis" required><input className={inputCls} value={f.deadlineBasis ?? ''} onChange={(e) => set('deadlineBasis', e.target.value)} placeholder={f.deadlineType === 'APH' ? 'Regulatory clause' : 'Who configured it and why'} /></F>
          </div>
        )}
        <Button
          variant="secondary"
          className="w-full"
          loading={busy === 'draft'}
          onClick={() =>
            call(
              'draft',
              () =>
                api.post(
                  `/api/official/applications/${id}/deficiency-drafts`,
                  clean({
                    targetType: f.targetType,
                    targetId: f.targetType === 'APPLICATION' ? null : f.targetId,
                    category: f.category,
                    explanation: f.explanation,
                    sourceReference: f.sourceReference,
                    correctiveAction: f.correctiveAction,
                    deadlineType: f.deadlineType,
                    deadline: f.deadlineType === 'NOT_CONFIGURED' ? '' : f.deadline,
                    deadlineBasis: f.deadlineType === 'NOT_CONFIGURED' ? '' : f.deadlineBasis,
                    sourceFindingRuleId: f.sourceFindingRuleId,
                    parentDeficiencyId: f.parentDeficiencyId,
                  }),
                ),
              'Draft item saved.',
            ).then(() => setF((x) => ({ ...x, explanation: '', correctiveAction: '', sourceFindingRuleId: '' })))
          }
        >
          Save draft item
        </Button>
      </div>
    </Card>
  );

  const docReviewPanel = tab === 'documents' && doc && (
    <Card>
      <CardHeader title="Document review" subtitle={docDef?.name ?? doc.requirement_id} divided />
      <div className="space-y-4 p-5">
        {latestReview(doc.id) && (
          <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
            Last recorded: <Badge t={REVIEW_TONE[latestReview(doc.id).status]}>{REVIEW_LABEL[latestReview(doc.id).status]}</Badge>
            <div className="mt-1">
              {latestReview(doc.id).reviewed_by_name} · {fmtDateTime(latestReview(doc.id).created_at)}
            </div>
          </div>
        )}
        {canExamine ? (
          <>
            <F label="Examination status" required>
              <select className={inputCls} value={rev.status} onChange={(e) => setRev({ ...rev, status: e.target.value })}>
                {Object.entries(REVIEW_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </F>
            <F label="Official observation" required={rev.status !== 'EXAMINED_NO_OBSERVATION'}>
              <textarea rows={4} className={inputCls} value={rev.observation} onChange={(e) => setRev({ ...rev, observation: e.target.value })} placeholder="What you checked and what you found" />
            </F>
            <Button
              className="w-full"
              loading={busy === 'docrev'}
              disabled={rev.status !== 'EXAMINED_NO_OBSERVATION' && rev.observation.trim().length < 5}
              onClick={() =>
                call('docrev', () => api.post(`/api/official/applications/${id}/documents/${doc.id}/review`, { status: rev.status, observation: rev.observation.trim() || undefined, sourceReference: docDef?.aphReference }), 'Document review recorded.').then(
                  (ok) => ok && setRev({ status: 'EXAMINED_NO_OBSERVATION', observation: '' }),
                )
              }
            >
              Record document review
            </Button>
            <p className="text-xs text-slate-500">Recorded in the audit trail. An examination record is not a statutory outcome; raise items to the institution through “Send for re-scrutiny”.</p>
          </>
        ) : (
          <p className="text-sm text-slate-500">Document examination is recorded by the scrutiny or re-scrutiny official while the application is at their stage.</p>
        )}
      </div>
    </Card>
  );

  const el = data.evcEligibility;
  const visit = data.evcVisits.find((v: any) => ['PROPOSED', 'SCHEDULED', 'RESCHEDULED', 'IN_PROGRESS'].includes(v.status));

  return (
    <>
      <PageHeader
        crumbs={['Review queue', a.reference_no]}
        title={<span className="font-mono">{a.reference_no}</span>}
        subtitle={`${data.category.title} · ${data.institution.name} (${data.institution.aicte_institution_id})`}
        action={
          <>
            <Button variant="secondary" onClick={() => nav('/official/queue')}>
              <ArrowLeft className="h-4 w-4" /> Queue
            </Button>
            {['SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL', 'REGIONAL_OFFICER'].includes(role) && !myAssignment && (
              <Button variant="secondary" loading={busy === 'claim'} onClick={() => call('claim', () => api.post(`/api/official/applications/${id}/claim`), 'Assigned to you.')}>
                Assign to me
              </Button>
            )}
            {latestScrutiny && (
              <a href={`/api/reports/${latestScrutiny.id}/pdf`} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700">
                <Download className="h-4 w-4" /> Report PDF
              </a>
            )}
          </>
        }
      />

      <Card className="mb-6">
        <div className="grid grid-cols-2 gap-5 px-5 py-4 lg:grid-cols-5">
          <KV k="Current stage" v={<StatusBadge status={s} label={a.statusLabel} />} />
          <KV k="Assigned officer" v={stageAssignment ? <>{stageAssignment.full_name}<div className="text-xs font-normal text-slate-500">{WORKSPACE_NAME[stageAssignment.role] ?? stageAssignment.role}</div></> : <span className="text-slate-400">Unassigned</span>} />
          <KV k="Last workflow event" v={lastEvent ? <>{actionLabel(lastEvent.action)}<div className="text-xs font-normal text-slate-500">{fmtDateTime(lastEvent.created_at)}</div></> : '—'} />
          <KV k="Internal response target" v={nextDeadline ? fmtDate(nextDeadline) : 'Not configured'} />
          <KV k="Response package" v={data.corrections[0] ? <>Version {data.corrections[0].version}<div className="text-xs font-normal text-slate-500">{fmtDateTime(data.corrections[0].submitted_at)}</div></> : 'None received'} />
        </div>
        <div className="border-t border-slate-100 px-5 py-4">
          <StageProgress stages={data.category.stages} status={s} />
        </div>
        {role === 'SUPERVISOR' && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3 text-sm">
            <span className="text-slate-500">Reassign:</span>
            <select aria-label="Role" className="rounded-md border border-slate-300 px-2 py-1.5 text-xs" value={f.assignRole ?? 'SCRUTINY_OFFICIAL'} onChange={(e) => set('assignRole', e.target.value)}>
              <option value="SCRUTINY_OFFICIAL">Scrutiny</option><option value="RE_SCRUTINY_OFFICIAL">Re-scrutiny</option><option value="REGIONAL_OFFICER">EVC scheduling</option>
            </select>
            <select aria-label="Official" className="rounded-md border border-slate-300 px-2 py-1.5 text-xs" value={f.assignUser ?? ''} onChange={(e) => set('assignUser', e.target.value)}>
              <option value="">Select official…</option>
              {assignees.data?.users.map((x: any) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
            </select>
            <input aria-label="Reason" className="min-w-[200px] flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs" placeholder="Reason for (re)assignment" value={f.assignReason ?? ''} onChange={(e) => set('assignReason', e.target.value)} />
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-xs"
              disabled={!f.assignUser || (f.assignReason ?? '').trim().length < 3}
              loading={busy === 'assign'}
              onClick={() => call('assign', () => api.post(`/api/official/applications/${id}/assign`, { role: f.assignRole ?? 'SCRUTINY_OFFICIAL', userId: f.assignUser, reason: f.assignReason.trim() }), 'Assignment updated.')}
            >
              Assign
            </Button>
          </div>
        )}
      </Card>
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card className="self-start">
          <div className="px-5">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'overview', label: 'Overview' },
                { value: 'report', label: <>Checks report {issues > 0 && <Badge t="amber">{issues}</Badge>}</> },
                { value: 'documents', label: `Documents (${currentDocs.length})` },
                ...(reReports.length ? [{ value: 'rescrutiny' as Tab, label: 'Re-scrutiny' }] : []),
                { value: 'deficiencies', label: <>Notices {drafts.length > 0 && <Badge t="amber">{drafts.length} draft</Badge>}</> },
                ...(route.evc === 'YES' ? [{ value: 'evc' as Tab, label: 'EVC' }] : []),
                { value: 'decision', label: 'Decision' },
                { value: 'audit', label: 'Audit' },
              ]}
            />
          </div>
          <div className="p-5">
            {tab === 'overview' && (
              <div className="space-y-6">
                <div>
                  <h4 className="mb-3 text-[13px] font-semibold text-slate-900">Institution & application</h4>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <KV k="Institution" v={data.institution.name} />
                    <KV k="AICTE institution ID" v={<>{data.institution.aicte_institution_id} <span className="text-xs font-normal text-slate-500">({String(data.institution.id_verification_status).toLowerCase()})</span></>} />
                    <KV k="Applicant" v={`${a.applicant_name ?? '—'}${a.applicant_designation ? `, ${a.applicant_designation}` : ''}`} />
                    <KV k="Official email" v={a.institution_snapshot?.officialEmail} />
                    <KV k="Application type" v={data.category.title} />
                    <KV k="Submitted" v={`${fmtDateTime(a.submitted_at)} · submission v${a.submission_version}`} />
                    <KV k="Processing route" v={route.evc === 'YES' ? 'Scrutiny → EVC → decision' : route.scrutiny ? 'Scrutiny → decision' : 'Self-disclosure → decision'} />
                    <KV k="Documents examined" v={`${examined} of ${currentDocs.length}`} />
                  </div>
                </div>
                <div className="border-t border-slate-100 pt-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h4 className="text-[13px] font-semibold text-slate-900">Correction notice summary</h4>
                    {latestNotice && <TextLink onClick={() => setTab('deficiencies')}>Read notice →</TextLink>}
                  </div>
                  {!latestNotice ? (
                    <p className="text-sm text-slate-500">No correction notice has been issued.</p>
                  ) : (
                    <Table className="-mx-5" head={['Item', 'Requested clarification', 'Response']}>
                      {noticeItems.map((d: any, i: number) => (
                        <tr key={d.id} className="align-top">
                          <td className={`${tdCls} font-mono text-xs font-semibold whitespace-nowrap text-slate-500`}>C-{String(i + 1).padStart(2, '0')}</td>
                          <td className={tdCls}>
                            <div className="font-medium text-slate-900">{d.target_label}</div>
                            <div className="mt-0.5 line-clamp-2 text-[13px] text-slate-500">{d.explanation}</div>
                          </td>
                          <td className={tdCls}><Badge t={DEF_TONE[d.status]}>{d.status === 'OPEN' ? 'Awaiting response' : d.status.replace(/_/g, ' ').toLowerCase()}</Badge></td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </div>
              </div>
            )}
            {tab === 'report' &&
              (latestScrutiny ? (
                <>
                  {issues > 0 && (
                    <div className="mb-4">
                      <Alert kind="warn" title={`Assisted checks · ${issues} potential issue${issues === 1 ? '' : 's'}`}>
                        Automated checks flagged these for your examination. Confirm each against the document before raising it with the institution.
                      </Alert>
                    </div>
                  )}
                  {scrutinyReports.length > 1 && <p className="mb-2 text-xs text-slate-500">Earlier versions preserved: {scrutinyReports.slice(1).map((r: any) => `v${r.version}`).join(', ')}</p>}
                  {role === 'SCRUTINY_OFFICIAL' && ['SUBMITTED', 'UNDER_SCRUTINY'].includes(s) && (
                    <Button variant="secondary" className="mb-3 px-3 py-1.5 text-xs" loading={busy === 'rerun'} onClick={() => call('rerun', () => api.post(`/api/official/applications/${id}/rerun-checks`), 'Checks re-run; a new report version was saved.')}>
                      Re-run checks
                    </Button>
                  )}
                  <ScrutinyReportView report={latestScrutiny} onDraft={onDraft} />
                </>
              ) : (
                <Empty title="No scrutiny report yet" />
              ))}
            {tab === 'documents' &&
              (currentDocs.length === 0 ? (
                <Empty title="No documents uploaded" />
              ) : (
                <div>
                  <div className="-mx-5 -mt-5 flex gap-2 overflow-x-auto border-b border-slate-200 bg-slate-50/60 px-5 py-3 [scrollbar-width:thin]">
                    {currentDocs.map((d) => {
                      const r = latestReview(d.id);
                      const name = data.documentsDef.find((x: any) => x.id === d.requirement_id)?.name ?? d.requirement_id;
                      return (
                        <button
                          key={d.id}
                          onClick={() => setDocSel(d.id)}
                          className={cx('flex max-w-[220px] shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition', doc?.id === d.id ? 'border-brand-500 bg-white ring-1 ring-brand-200' : 'border-slate-200 bg-white hover:border-slate-300')}
                        >
                          {r ? (r.status === 'EXAMINED_NO_OBSERVATION' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />) : <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                          <span className="truncate font-medium text-slate-800">{name}</span>
                        </button>
                      );
                    })}
                  </div>
                  {doc && (
                    <div className="pt-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <FileText className="h-5 w-5 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-900">{doc.file_name}</div>
                          <div className="text-xs text-slate-500">
                            Version {doc.version} · {(doc.size_bytes / 1024).toFixed(0)} KB · uploaded {fmtDateTime(doc.uploaded_at)} by {doc.uploaded_by_name}
                            {doc.deficiency_id && ' · correction upload'}
                          </div>
                        </div>
                        {doc.integrity?.readable === false ? <Badge t="red">Unreadable / incomplete</Badge> : doc.integrity?.readable ? <Badge t="green">Readable</Badge> : null}
                        {doc.integrity?.signatureStructure && <Badge t="blue">Signature structure present</Badge>}
                        {latestReview(doc.id) ? <Badge t={REVIEW_TONE[latestReview(doc.id).status]}>{REVIEW_LABEL[latestReview(doc.id).status]}</Badge> : <Badge>Not examined</Badge>}
                      </div>
                      {docFindings.length > 0 && (
                        <div className="mt-4">
                          <Alert kind="warn" title={`Assisted checks · ${docFindings.length} potential issue${docFindings.length === 1 ? '' : 's'}`}>
                            <ul className="mt-1 space-y-1">
                              {docFindings.map((x, i) => (
                                <li key={i} className="flex items-start gap-2">
                                  <FindingPill status={x.status} />
                                  <span>{x.explanation}</span>
                                </li>
                              ))}
                            </ul>
                          </Alert>
                        </div>
                      )}
                      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                          <span className="truncate">{docDef?.name}</span>
                          <span className="flex shrink-0 gap-3">
                            <a href={`/api/documents/${doc.id}/download?inline=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-brand-600">
                              <ExternalLink className="h-3.5 w-3.5" /> Full screen
                            </a>
                            <a href={`/api/documents/${doc.id}/download`} className="inline-flex items-center gap-1 font-semibold text-brand-600">
                              <Download className="h-3.5 w-3.5" /> Download
                            </a>
                          </span>
                        </div>
                        {/^image\//.test(doc.mime_type) ? (
                          <img src={`/api/documents/${doc.id}/download?inline=1`} alt={doc.file_name} className="max-h-[560px] w-full bg-slate-100 object-contain" />
                        ) : (
                          <iframe title={doc.file_name} src={`/api/documents/${doc.id}/download?inline=1`} className="h-[560px] w-full bg-slate-100" />
                        )}
                      </div>
                      <p className="mt-2 text-xs text-slate-500">Viewing a file does not establish its authenticity. Verify signatures and issuers against the source.</p>
                      {data.documentReviews.filter((r: any) => r.document_id === doc.id).length > 0 && (
                        <div className="mt-5 border-t border-slate-100 pt-4">
                          <h4 className="mb-2 text-[13px] font-semibold text-slate-900">Examination history</h4>
                          <ul className="space-y-2 text-[13px]">
                            {data.documentReviews
                              .filter((r: any) => r.document_id === doc.id)
                              .map((r: any) => (
                                <li key={r.id}>
                                  <Badge t={REVIEW_TONE[r.status]}>{REVIEW_LABEL[r.status]}</Badge> <span className="text-slate-500">{r.reviewed_by_name} · {fmtDateTime(r.created_at)}</span>
                                  {r.observation && <div className="mt-0.5 text-slate-700">{r.observation}</div>}
                                </li>
                              ))}
                          </ul>
                        </div>
                      )}
                      {data.documents.some((d: any) => !d.is_current && d.requirement_id === doc.requirement_id) && (
                        <div className="mt-4 text-xs text-slate-500">
                          Earlier versions:{' '}
                          {data.documents
                            .filter((d: any) => !d.is_current && d.requirement_id === doc.requirement_id)
                            .map((d: any) => (
                              <a key={d.id} href={`/api/documents/${d.id}/download?inline=1`} target="_blank" rel="noreferrer" className="mr-2 font-semibold text-brand-600">
                                v{d.version}
                              </a>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            {tab === 'rescrutiny' && latestRe && (
              <>
                {reReports.length > 1 && <p className="mb-2 text-xs text-slate-500">Earlier re-scrutiny reports preserved: {reReports.slice(1).map((r: any) => `v${r.version}`).join(', ')}</p>}
                {s === 'READY_FOR_RE_SCRUTINY' && role === 'RE_SCRUTINY_OFFICIAL' && <div className="mb-4"><Alert kind="info">Take up the application for re-scrutiny to record item reviews.</Alert></div>}
                <ReScrutinyReportView
                  report={latestRe}
                  deficiencies={data.deficiencies}
                  canReview={role === 'RE_SCRUTINY_OFFICIAL' && s === 'UNDER_RE_SCRUTINY'}
                  busy={busy}
                  onReview={(defId, outcome, note) => call(`${defId}${outcome}`, () => api.post(`/api/official/deficiencies/${defId}/review`, { outcome, note }), `Item review recorded: ${outcome.toLowerCase().replace('_', ' ')}.`)}
                  onDraft={onDraft}
                />
              </>
            )}
            {tab === 'deficiencies' && (
              <div className="space-y-5">
                <div>
                  <h4 className="mb-2 text-[13px] font-semibold text-slate-900">Notices</h4>
                  {data.notices.length === 0 && <p className="text-sm text-slate-500">No notice issued.</p>}
                  {data.notices.map((n: any, i: number) => (
                    <div key={n.id} className={cx('mb-2 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm', i === 0 ? 'border-slate-200' : 'border-slate-100 text-slate-500')}>
                      <span className="font-mono font-semibold">{n.notice_no} v{n.version}</span>
                      <Badge>{n.kind === 'FURTHER_CORRECTION' ? 'Further correction' : 'Initial notice'}</Badge>
                      <span className="text-xs text-slate-500">{fmtDateTime(n.issued_at)} · {n.issued_by_name} · {n.content.deficiencies.length} item(s)</span>
                      <a className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-600" href={`/api/notices/${n.id}/pdf`}><Download className="h-3.5 w-3.5" /> PDF</a>
                    </div>
                  ))}
                </div>
                <div>
                  <h4 className="mb-2 text-[13px] font-semibold text-slate-900">Items</h4>
                  {data.deficiencies.length === 0 && <p className="text-sm text-slate-500">None recorded.</p>}
                  {data.deficiencies.map((d: any) => (
                    <div key={d.id} className="mb-2 rounded-lg border border-slate-200 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-500">{d.reference_no}</span>
                        <Badge t={d.status === 'DRAFT' ? 'slate' : (DEF_TONE[d.status] ?? 'amber')}>{d.status.toLowerCase().replace('_', ' ')}</Badge>
                        <span className="font-semibold">{d.target_label}</span>
                        {d.automated_assessment && <Badge t="violet">auto: {d.automated_assessment.toLowerCase().replace(/_/g, ' ')}</Badge>}
                        {d.status === 'DRAFT' && canDraft && (
                          <button className="ml-auto text-xs font-semibold text-rose-600" onClick={() => call('wd', () => api.post(`/api/official/deficiencies/${d.id}/withdraw`), 'Draft withdrawn.')}>Withdraw draft</button>
                        )}
                      </div>
                      <p className="mt-1 text-slate-600">{d.explanation}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Correction: {d.corrective_action} · Deadline: {d.deadline_type === 'NOT_CONFIGURED' ? 'not configured' : `${fmtDate(d.deadline)} (${d.deadline_type.toLowerCase()}: ${d.deadline_basis})`}
                      </p>
                      {d.officer_response && <p className="mt-0.5 text-xs text-slate-600">Officer: {d.officer_response}</p>}
                    </div>
                  ))}
                </div>
                <div>
                  <h4 className="mb-2 text-[13px] font-semibold text-slate-900">Correction packages</h4>
                  {data.corrections.length === 0 && <p className="text-sm text-slate-500">None.</p>}
                  {data.corrections.map((c: any) => (
                    <div key={c.id} className="mb-1 text-[13px] text-slate-600">
                      v{c.version} · {fmtDateTime(c.submitted_at)} · submission v{c.submission_version} · changed: {[...c.changed_docs, ...c.changed_fields].join(', ') || 'nothing'}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {tab === 'evc' && (
              <div className="space-y-5">
                {el && (
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <h4 className="text-[13px] font-semibold text-slate-900">EVC eligibility</h4>
                      <Badge t={el.eligible ? 'green' : 'amber'}>{el.eligible ? 'Prerequisites met' : 'Prerequisites unresolved'}</Badge>
                    </div>
                    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {el.conditions.map((c: any) => (
                        <li key={c.id} className="flex gap-3 px-3 py-2.5 text-sm">
                          {c.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />}
                          <div>
                            <div className="font-medium">{c.label}</div>
                            <div className="text-xs text-slate-500">{c.detail}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-slate-500">{el.note}</p>
                  </div>
                )}
                {data.handoffs.map((h: any) => (
                  <Alert key={h.id} kind="success" title={`EVC handoff approved by ${h.approved_by_name}`}>{fmtDateTime(h.created_at)} — {h.note}</Alert>
                ))}
                {['AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED', 'EVC_IN_PROGRESS'].includes(s) && ['REGIONAL_OFFICER', 'SUPERVISOR', 'REGULATION_BUREAU'].includes(role) && (
                  <Alert
                    kind="info"
                    title="EVC scheduling"
                    action={<Button onClick={() => nav(`/official/evc/schedule/${a.id}`)}>{role === 'REGIONAL_OFFICER' ? 'Open scheduling' : 'View scheduling'} →</Button>}
                  >
                    Propose the slot, check each official's availability, invite the committee and confirm once everyone accepts — on the scheduling page.
                  </Alert>
                )}
                {data.evcVisits.length === 0 && <Empty title="No visit yet" />}
                {data.evcVisits.map((v: any) => (
                  <div key={v.id} className="rounded-lg border border-slate-200 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge t="blue">{v.mode.toLowerCase()}</Badge>
                      <Badge t={v.status === 'PROPOSED' ? 'amber' : v.status === 'CANCELLED' ? 'red' : 'green'}>{v.status === 'SCHEDULED' ? 'confirmed' : v.status.toLowerCase()}</Badge>
                      <span className="font-semibold">{istLongDate(v.scheduled_start)}, {istRange(v.scheduled_start, v.scheduled_end)}</span>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <KV
                        k="Committee"
                        v={
                          v.members.filter((m: any) => m.active).length === 0
                            ? 'None assigned'
                            : v.members
                                .filter((m: any) => m.active)
                                .map((m: any) => (
                                  <div key={m.user_id} className="flex flex-wrap items-center gap-1.5">
                                    {m.full_name} <span className="text-xs text-slate-500">· {SEAT_SHORT[m.seat] ?? 'no seat'}</span>
                                    <Badge t={responsePill(m.response_status).tone}>{responsePill(m.response_status).label}</Badge>
                                    {m.attendance !== 'NOT_RECORDED' && <Badge t={m.attendance === 'PRESENT' ? 'green' : 'red'}>{m.attendance.toLowerCase()}</Badge>}
                                  </div>
                                ))
                        }
                      />
                      {v.meeting_link && <KV k="Meeting link" v={<span className="break-all">{v.meeting_link}</span>} />}
                      {v.location && <KV k="Location" v={v.location} />}
                      {v.agenda && <KV k="Agenda" v={v.agenda} />}
                      {v.offline_justification && <KV k="Offline justification" v={v.offline_justification} />}
                      {v.missed_reason && <KV k="Reported missed" v={v.missed_reason} />}
                    </div>
                    {v.status !== 'CANCELLED' && (
                      <div className="mt-3 flex flex-wrap gap-3">
                        <TextLink to={`/official/visits/${v.id}`}>Open visit record</TextLink>
                        {role === 'REGIONAL_OFFICER' && <TextLink onClick={() => { const reason = prompt('Reason for escalating to the Regulation Bureau (scheduling dispute or other EVC blocker)'); if (reason && reason.trim().length >= 10) call('esc', () => api.post(`/api/evc/visits/${v.id}/escalate`, { kind: 'SCHEDULING_DISPUTE', reason: reason.trim() }), 'Escalated to the Regulation Bureau.'); }}>Escalate to Regulation Bureau</TextLink>}
                      </div>
                    )}
                    <ol className="mt-3 space-y-0.5 border-l-2 border-slate-100 pl-3 text-xs text-slate-600">
                      {v.events.map((e: any) => <li key={e.id}>{e.event.toLowerCase().replace(/_/g, ' ')} · {fmtDateTime(e.created_at)} · {e.actor_name ?? 'system'}</li>)}
                    </ol>
                  </div>
                ))}
                {data.evcReports.map((r: any) => (
                  <div key={r.id} className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 text-sm">
                    <div className="font-semibold">EVC report v{r.version} · {r.submitted_by_name} · {fmtDateTime(r.submitted_at)}</div>
                    <p className="whitespace-pre-wrap">{r.observations}</p>
                    <p className="text-slate-600">Recommendation: {r.recommendation}</p>
                  </div>
                ))}
              </div>
            )}
            {tab === 'decision' && (
              <div className="space-y-3">
                {data.decisions.length === 0 && <Empty title="No decision yet" />}
                {data.decisions.map((d: any) => <DecisionCard key={d.id} d={d} />)}
                {data.committeeReviews.map((c: any) => (
                  <div key={c.id} className="text-sm"><Badge t="violet">{c.committee}</Badge> {c.outcome.toLowerCase()} · {fmtDateTime(c.recorded_at)} — {c.notes}</div>
                ))}
                {data.appeal && <Alert kind="info" title={`Appeal ${data.appeal.reference_no} (${data.appeal.status.toLowerCase()})`}>{data.appeal.grounds}</Alert>}
              </div>
            )}
            {tab === 'audit' && (
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-[13px] font-semibold text-slate-900">Officer actions</h4>
                  <ol className="space-y-2 text-xs">
                    {data.officerActions.map((o: any) => (
                      <li key={o.id}>
                        <span className="font-semibold">{o.action.toLowerCase().replace(/_/g, ' ')}</span> · {o.actor_name} ({WORKSPACE_NAME[o.actor_role] ?? o.actor_role}) · {fmtDateTime(o.created_at)}
                        {o.reason && <div className="text-slate-600">“{o.reason}”</div>}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h4 className="mb-2 text-[13px] font-semibold text-slate-900">Deadline events</h4>
                  {data.deadlineEvents.length === 0 && <p className="text-xs text-slate-500">None.</p>}
                  {data.deadlineEvents.map((e: any) => <div key={e.id} className="text-xs">{e.event_type.toLowerCase()} · {fmtDateTime(e.created_at)} · {e.dedupe_key}</div>)}
                  <h4 className="mt-4 mb-2 text-[13px] font-semibold text-slate-900">Verification requests</h4>
                  {data.verificationRequests.length === 0 && <p className="text-xs text-slate-500">None.</p>}
                  {data.verificationRequests.map((v: any) => <div key={v.id} className="text-xs">{v.status.toLowerCase()} · {v.requested_by_name}: {v.reason}{v.resolution && ` → ${v.resolution}`}</div>)}
                </div>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          {docReviewPanel}
          <Card>
            <CardHeader title={role === 'RE_SCRUTINY_OFFICIAL' && s === 'UNDER_RE_SCRUTINY' ? 'Official review record' : 'Application next action'} subtitle={WORKSPACE_NAME[role]} divided />
            <div className="p-5">
              {actions.length === 0 ? (
                <>
                  <Button className="w-full" disabled>No action for your role</Button>
                  <p className="mt-2 text-xs text-slate-500">This application is not at a stage your role acts on. It is pending with {a.pendingAction === 'APPLICANT' ? 'the institution' : 'another official'}.</p>
                </>
              ) : (
                <div className="flex flex-col gap-3">{actions}</div>
              )}
              <p className="mt-4 flex gap-1.5 text-[11px] text-slate-500">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> Automated findings assist your review. You decide every outcome; your reason is recorded in the audit trail.
              </p>
            </div>
          </Card>
          {draftForm}
          <Card>
            <CardHeader title="Shared workflow history" action={<TextLink onClick={() => setTab('audit')}>Audit trail</TextLink>} />
            <Timeline
              items={[...data.timeline]
                .reverse()
                .slice(0, 8)
                .map((e: any, i: number) => ({
                  id: e.id,
                  title: actionLabel(e.action),
                  meta: `${e.actor_name ?? WORKSPACE_NAME[e.actor_role] ?? e.actor_role} · ${fmtDateTime(e.created_at)}`,
                  tone: ['ISSUE_DEFICIENCY_NOTICE', 'REQUEST_FURTHER_CORRECTION'].includes(e.action) ? 'warn' : i === 0 ? 'current' : 'done',
                }))}
            />
          </Card>
        </div>
      </div>
      <PageNote>
        <Link to="/official" className="hover:text-slate-600">Workspace</Link> · every officer action on this application is stored with its reason.
      </PageNote>
    </>
  );
}
