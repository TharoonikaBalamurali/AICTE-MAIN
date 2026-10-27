import { AlertTriangle, ArrowRightCircle, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, cx, inputCls, Label, Modal } from '../../components/ui';
import { FindingPill } from './common';
import type { Finding } from './Reports';

interface Item {
  key: string;
  include: boolean;
  status?: string;
  targetType: 'FIELD' | 'DOCUMENT' | 'APPLICATION';
  targetId: string;
  targetLabel: string;
  category: string;
  explanation: string;
  correctiveAction: string;
  sourceReference: string;
  sourceFindingRuleId?: string;
}

const CATEGORIES = ['MISSING_DOCUMENT', 'INVALID_OR_EXPIRED', 'SIGNATURE_AUTHENTICATION', 'MISMATCH', 'INCOMPLETE_INFORMATION', 'UNREADABLE_FILE', 'OTHER'];
const categoryFor = (f: Finding) =>
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

/** Institution-facing default wording; some rule texts are written for officers. */
function defaultsFor(f: Finding) {
  if (f.ruleType === 'DOC_SIGNATURE_TECHNICAL' || f.ruleType === 'DOC_DSC_DECLARED')
    return { explanation: `${f.targetLabel}: the digital signature (DSC) on the uploaded file could not be verified.`, correctiveAction: 'Upload the document digitally signed (DSC) by the prescribed signatory.' };
  if (f.ruleType === 'DOC_SIGNATORY_RECORDED')
    return { explanation: `${f.targetLabel}: the signatory of the document is not stated.`, correctiveAction: 'Confirm the signatory name and designation, and re-upload the signed document if required.' };
  if (f.ruleType === 'DOC_INTEGRITY') return { explanation: `${f.targetLabel}: the uploaded file is unreadable or incomplete.`, correctiveAction: 'Upload a complete, readable copy of the document.' };
  return { explanation: f.explanation, correctiveAction: f.correctiveAction || 'Provide the corrected document / information.' };
}

/** Collects every non-passing finding in the scrutiny report, once per rule. */
function findingsFrom(report: any): Finding[] {
  const c = report?.content;
  if (!c) return [];
  const all: Finding[] = [
    ...c.documents.expected.flatMap((d: any) => d.findings),
    ...c.fields.flatMap((f: any) => f.findings),
    ...c.validity,
    ...c.signatures,
    ...c.otherDiscrepancies,
  ];
  const seen = new Set<string>();
  return all.filter((f) => {
    if (['PASS', 'NOT_APPLICABLE'].includes(f.status) || f.ruleType === 'HUMAN_REVIEW_NOTICE' || seen.has(f.ruleId)) return false;
    seen.add(f.ruleId);
    return true;
  });
}

/**
 * The Scrutiny officer's two decisions:
 *  1. Send for re-scrutiny — explain each deficiency / discrepancy; the institution receives a notice, and its
 *     corrections go to the Re-Scrutiny Committee.
 *  2. Forward to the EVC Coordinator — scrutiny found in order; hand off to the EVC dashboard
 *     (or to the decision stage when Table 2.3 has no EVC for the category).
 */
export function ScrutinyActions({
  report,
  route,
  fieldsDef,
  documentsDef,
  busy,
  onSend,
  onForward,
}: {
  report: any;
  route: { evc: 'YES' | 'NO'; scrutiny: boolean; aphReference: string };
  fieldsDef: Array<{ id: string; label: string }>;
  documentsDef: Array<{ id: string; name: string }>;
  busy: string | null;
  onSend: (reason: string, deficiencies: Array<Record<string, unknown>>) => void;
  onForward: (reason: string) => void;
}) {
  const findings = useMemo(() => findingsFrom(report), [report]);
  const discrepancies = findings.filter((f) => f.status === 'DISCREPANCY_DETECTED' || f.status === 'UNABLE_TO_VERIFY');
  const [mode, setMode] = useState<'rescrutiny' | 'forward' | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [reason, setReason] = useState('');
  const [deadline, setDeadline] = useState({ type: 'NOT_CONFIGURED', date: '', basis: '' });

  const openRescrutiny = () => {
    setItems(
      findings.map((f) => ({
        key: f.ruleId,
        include: f.status === 'DISCREPANCY_DETECTED' || f.status === 'UNABLE_TO_VERIFY',
        status: f.status,
        targetType: (f.targetType === 'FIELD' || f.targetType === 'DOCUMENT' ? f.targetType : 'APPLICATION') as Item['targetType'],
        targetId: f.targetId ?? '',
        targetLabel: f.targetLabel,
        category: categoryFor(f),
        ...defaultsFor(f),
        sourceReference: f.sourceReference ?? '',
        sourceFindingRuleId: f.ruleId,
      })),
    );
    setReason('');
    setMode('rescrutiny');
  };
  const setItem = (k: string, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const selected = items.filter((i) => i.include);
  const valid = selected.length > 0 && selected.every((i) => i.explanation.trim().length >= 5 && i.correctiveAction.trim().length >= 3 && (i.targetType === 'APPLICATION' || i.targetId)) && reason.trim().length >= 5 && (deadline.type === 'NOT_CONFIGURED' || (deadline.date && deadline.basis.trim()));

  return (
    <div className="space-y-3">
      <div className={cx('rounded-lg px-3 py-2 text-xs', discrepancies.length ? 'bg-brand-50 text-brand-900' : 'bg-slate-50 text-slate-700')}>
        {discrepancies.length
          ? `Automated report: ${discrepancies.length} discrepancy / unable-to-verify finding(s). Review them before deciding.`
          : 'Automated report: no discrepancies detected. Items for human review may still need your check.'}
      </div>
      <button
        onClick={openRescrutiny}
        className="flex w-full items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-left transition hover:border-brand-400 hover:bg-brand-50/50"
      >
        <RotateCcw className="h-5 w-5 shrink-0 text-brand-700" />
        <span>
          <span className="block font-semibold text-slate-900">Send for re-scrutiny</span>
          <span className="block text-xs text-slate-500">Deficiency found — explain it to the institution; corrections go to re-scrutiny.</span>
        </span>
      </button>
      <button
        onClick={() => {
          setReason('');
          setMode('forward');
        }}
        className="flex w-full items-center gap-3 rounded-xl border-2 border-brand-500 bg-brand-600 px-4 py-3 text-left text-white transition hover:bg-brand-700"
      >
        <ArrowRightCircle className="h-5 w-5 shrink-0" />
        <span>
          <span className="block font-semibold">{route.evc === 'YES' ? 'Forward to EVC Coordinator' : 'Forward to decision stage'}</span>
          <span className="block text-xs text-brand-100">
            {route.evc === 'YES' ? 'No deficiency — move to the EVC Committee dashboard.' : 'No EVC for this category.'}
          </span>
        </span>
      </button>

      <Modal open={mode === 'rescrutiny'} onClose={() => setMode(null)} title="Send for re-scrutiny — explain the deficiencies" wide>
        <div className="space-y-4 text-sm">
          <Alert kind="info">
            Items detected by the automated checks are listed below; ticked items will be sent. Edit the explanation and the required correction in plain language. The institution receives a
            PDF deficiency notice; when it submits corrections the application moves to the Re-Scrutiny Dashboard, where only these items are re-checked.
          </Alert>
          {items.length === 0 && <p className="text-slate-500">The automated report found nothing to flag. Add the deficiency you observed below.</p>}
          {items.map((i) => (
            <div key={i.key} className={cx('rounded-lg border p-3', i.include ? 'border-brand-200 bg-brand-50/40' : 'border-slate-200 opacity-70')}>
              <label className="flex flex-wrap items-center gap-2">
                <input type="checkbox" checked={i.include} onChange={(e) => setItem(i.key, { include: e.target.checked })} />
                <span className="font-semibold">{i.targetLabel}</span>
                {i.status && <FindingPill status={i.status} />}
                {!i.sourceFindingRuleId && (
                  <button className="ml-auto text-rose-600" aria-label="Remove" onClick={() => setItems((xs) => xs.filter((x) => x.key !== i.key))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </label>
              {i.include && (
                <div className="mt-2 grid gap-2">
                  {!i.sourceFindingRuleId && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <select aria-label="Affected item type" className={inputCls} value={i.targetType} onChange={(e) => setItem(i.key, { targetType: e.target.value as Item['targetType'], targetId: '', targetLabel: e.target.value === 'APPLICATION' ? 'Application (general)' : 'New deficiency' })}>
                        <option value="DOCUMENT">Document</option>
                        <option value="FIELD">Field</option>
                        <option value="APPLICATION">Application (general)</option>
                      </select>
                      {i.targetType !== 'APPLICATION' && (
                        <select
                          aria-label="Affected item"
                          className={inputCls}
                          value={i.targetId}
                          onChange={(e) => {
                            const opts: Array<{ id: string; name?: string; label?: string }> = i.targetType === 'DOCUMENT' ? documentsDef : fieldsDef;
                            const o = opts.find((x) => x.id === e.target.value);
                            setItem(i.key, { targetId: e.target.value, targetLabel: o?.name ?? o?.label ?? 'New deficiency' });
                          }}
                        >
                          <option value="">Select…</option>
                          {(i.targetType === 'DOCUMENT' ? documentsDef.map((d) => ({ id: d.id, t: d.name })) : fieldsDef.map((f) => ({ id: f.id, t: f.label }))).map((o) => (
                            <option key={o.id} value={o.id}>{o.t}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                  <div>
                    <Label required>Explanation of the deficiency / discrepancy</Label>
                    <textarea rows={2} className={inputCls} value={i.explanation} onChange={(e) => setItem(i.key, { explanation: e.target.value })} />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_200px]">
                    <div>
                      <Label required>Required correction</Label>
                      <input className={inputCls} value={i.correctiveAction} onChange={(e) => setItem(i.key, { correctiveAction: e.target.value })} />
                    </div>
                    <div>
                      <Label>Category</Label>
                      <select className={inputCls} value={i.category} onChange={(e) => setItem(i.key, { category: e.target.value })}>
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>)}
                      </select>
                    </div>
                  </div>
                  <p className="font-mono text-[10px] text-slate-400">{i.sourceReference || 'No source cited'}{i.sourceFindingRuleId && ` · ${i.sourceFindingRuleId}`}</p>
                </div>
              )}
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              setItems((xs) => [
                ...xs,
                { key: `manual-${Date.now()}`, include: true, targetType: 'DOCUMENT', targetId: '', targetLabel: 'New deficiency', category: 'OTHER', explanation: '', correctiveAction: '', sourceReference: '' },
              ])
            }
          >
            <Plus className="h-4 w-4" /> Add a deficiency you observed
          </Button>
          <div className="grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-3">
            <div>
              <Label>Correction deadline</Label>
              <select className={inputCls} value={deadline.type} onChange={(e) => setDeadline({ ...deadline, type: e.target.value })}>
                <option value="NOT_CONFIGURED">None — requires authorised configuration</option>
                <option value="OPERATIONAL">Operational (system-configured)</option>
                <option value="APH">Regulatory (cite clause)</option>
              </select>
            </div>
            {deadline.type !== 'NOT_CONFIGURED' && (
              <>
                <div>
                  <Label required>Date</Label>
                  <input type="date" className={inputCls} value={deadline.date} onChange={(e) => setDeadline({ ...deadline, date: e.target.value })} />
                </div>
                <div>
                  <Label required>Basis</Label>
                  <input className={inputCls} value={deadline.basis} onChange={(e) => setDeadline({ ...deadline, basis: e.target.value })} />
                </div>
              </>
            )}
          </div>
          <div>
            <Label required>Summary note for the notice (recorded in the audit trail)</Label>
            <textarea rows={2} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. NOC signature could not be verified; intake details incomplete." />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">{selected.length} item(s) will be sent</span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
              <Button
                loading={busy === 'SEND_FOR_RESCRUTINY'}
                disabled={!valid}
                onClick={() =>
                  onSend(
                    reason.trim(),
                    selected.map((i) => ({
                      targetType: i.targetType,
                      targetId: i.targetType === 'APPLICATION' ? null : i.targetId,
                      category: i.category,
                      explanation: i.explanation.trim(),
                      correctiveAction: i.correctiveAction.trim(),
                      ...(i.sourceReference ? { sourceReference: i.sourceReference } : {}),
                      ...(i.sourceFindingRuleId ? { sourceFindingRuleId: i.sourceFindingRuleId } : {}),
                      deadlineType: deadline.type,
                      ...(deadline.type !== 'NOT_CONFIGURED' ? { deadline: deadline.date, deadlineBasis: deadline.basis.trim() } : {}),
                    })),
                  )
                }
              >
                Send for re-scrutiny
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={mode === 'forward'} onClose={() => setMode(null)} title={route.evc === 'YES' ? 'Forward to EVC Coordinator' : 'Forward to decision stage'}>
        <div className="space-y-3 text-sm">
          {discrepancies.length > 0 && (
            <Alert kind="warn" title={`${discrepancies.length} automated finding(s) still flagged`}>
              <ul className="list-disc pl-4">
                {discrepancies.slice(0, 6).map((f) => <li key={f.ruleId}>{f.targetLabel}: {f.explanation}</li>)}
              </ul>
              If any of these is a real deficiency, cancel and use “Send for re-scrutiny”.
            </Alert>
          )}
          <p>
            {route.evc === 'YES'
              ? 'Scrutiny will be recorded as in order and the application handed to the EVC Coordinator (EVC scheduling dashboard). The server re-checks EVC eligibility and records the handoff.'
              : 'Scrutiny will be recorded as in order. Table 2.3 has no EVC for this category, so the application goes to the authorised decision stage.'}
          </p>
          <div>
            <Label required>Reason / supporting note</Label>
            <textarea rows={3} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. All documents verified; no deficiency observed." />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
            <Button loading={busy === 'FORWARD_TO_EVC'} disabled={reason.trim().length < 5} onClick={() => onForward(reason.trim())}>
              {route.evc === 'YES' ? 'Forward to EVC Coordinator' : 'Forward to decision stage'}
            </Button>
          </div>
        </div>
      </Modal>
      {discrepancies.length > 0 && (
        <p className="flex gap-1.5 text-[11px] text-slate-500">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> <Badge t="red">{discrepancies.length}</Badge> flagged item(s) will be pre-selected in the re-scrutiny explanation.
        </p>
      )}
    </div>
  );
}
