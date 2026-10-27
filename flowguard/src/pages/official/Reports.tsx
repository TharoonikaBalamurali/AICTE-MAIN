import { ArrowRight, Download, FilePlus2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert, Badge, Button, cx, inputCls, KV } from '../../components/ui';
import { fmtDateTime } from '../../lib/hooks';
import { ASSESSMENT_TONE, DocViewer, FindingPill } from './common';

export interface Finding {
  ruleId: string;
  ruleVersion: number;
  ruleType: string;
  status: string;
  blocking: boolean;
  humanVerification: boolean;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  explanation: string;
  correctiveAction: string;
  sourceReference: string | null;
}

export function FindingRow({ f, onDraft }: { f: Finding; onDraft?: (f: Finding) => void }) {
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="shrink-0 sm:w-44">
        <FindingPill status={f.status} />
        {f.blocking && <Badge t="red" className="ml-1">blocking</Badge>}
      </div>
      <div className="min-w-[200px] flex-1 text-sm">
        <div className="font-medium text-slate-900">{f.targetLabel}</div>
        <div className="mt-0.5 text-slate-600">{f.explanation}</div>
        {f.correctiveAction && f.status !== 'PASS' && <div className="mt-0.5 text-xs text-slate-500">Suggested correction: {f.correctiveAction}</div>}
        <div className="mt-0.5 font-mono text-[10px] text-slate-400">
          {f.ruleId} v{f.ruleVersion}
          {f.sourceReference && ` · ${f.sourceReference}`}
          {f.humanVerification && ' · human verification required'}
        </div>
      </div>
      {onDraft && f.status !== 'PASS' && f.status !== 'NOT_APPLICABLE' && (
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => onDraft(f)}>
          <FilePlus2 className="h-3.5 w-3.5" /> Draft item
        </Button>
      )}
    </li>
  );
}

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="mt-6 border-t border-slate-100 pt-5">
      <h4 className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-slate-900">
        {title} {count !== undefined && <span className="text-xs font-normal text-slate-400">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

function SummaryTile({ tone, title, detail }: { tone: 'red' | 'green' | 'violet' | 'slate' | 'blue'; title: string; detail: string }) {
  const c = { red: 'border-rose-200 bg-rose-50 text-rose-900', green: 'border-emerald-200 bg-emerald-50 text-emerald-900', violet: 'border-violet-200 bg-violet-50 text-violet-900', slate: 'border-slate-200 bg-slate-50 text-slate-800', blue: 'border-brand-100 bg-brand-50 text-brand-900' }[tone];
  return (
    <div className={cx('rounded-lg border px-4 py-3 text-sm', c)}>
      <div className="font-semibold">{title}</div>
      <div className="mt-0.5 text-xs opacity-80">{detail}</div>
    </div>
  );
}

export function ScrutinyReportView({ report, onDraft }: { report: any; onDraft?: (f: Finding) => void }) {
  const c = report.content;
  const [showAll, setShowAll] = useState(false);
  const s = c.summary;
  const list = (fs: Finding[]) => (
    <ul className="divide-y divide-slate-100">
      {fs.length === 0 && <li className="py-2 text-sm text-slate-500">None.</li>}
      {fs.map((f, i) => (
        <FindingRow key={i} f={f} onDraft={onDraft} />
      ))}
    </ul>
  );
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-slate-900">Automated scrutiny report v{c.version}</div>
          <div className="text-[13px] text-slate-500">
            Generated {fmtDateTime(c.generatedAt)} · submission v{c.application.submissionVersion} · {c.run.rulesEvaluated} rules · {c.run.rulesetVersion}
          </div>
        </div>
        <a href={`/api/reports/${report.id}/pdf`} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-600">
          <Download className="h-4 w-4" /> PDF
        </a>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <SummaryTile tone={s.discrepanciesDetected ? 'red' : 'green'} title={s.discrepanciesDetected ? 'Discrepancies detected' : 'No discrepancies detected'} detail={`${s.counts.DISCREPANCY_DETECTED} finding(s), ${s.blocking} blocking`} />
        <SummaryTile tone={s.verificationRequired ? 'violet' : 'slate'} title={s.verificationRequired ? 'Human verification required' : 'No extra verification flagged'} detail={`${s.counts.HUMAN_REVIEW_REQUIRED} for review · ${s.counts.UNABLE_TO_VERIFY} unable to verify`} />
        <SummaryTile tone="blue" title="Ready for officer review" detail={`${s.counts.PASS} passed · ${s.counts.NOT_APPLICABLE ?? 0} not applicable`} />
      </div>
      <p className="mt-3 text-xs text-slate-500">{c.disclaimer}</p>

      <Section title="Application & institution">
        <div className="grid gap-4 sm:grid-cols-3">
          <KV k="Application" v={`${c.application.referenceNo} · ${c.application.categoryTitle}${c.application.subtypeLabel ? ` — ${c.application.subtypeLabel}` : ''}`} />
          <KV k="Institution" v={`${c.institution.name} (${c.institution.aicteInstitutionId}, ${String(c.institution.idVerification).toLowerCase()})`} />
          <KV k="Route" v={`${c.application.route} (${c.application.routeReference})`} />
        </div>
      </Section>

      <Section title="Outstanding findings" count={s.outstanding.length}>
        {list(s.outstanding.map((o: any) => ({ ...o, ruleVersion: 1, ruleType: '', blocking: false, humanVerification: false, targetType: '', targetId: null, correctiveAction: '' })))}
      </Section>

      <Section title="Documents — expected vs submitted" count={c.documents.expected.length}>
        {c.documents.missing.length > 0 && (
          <div className="my-2">
            <Alert kind="error" title="Missing">{c.documents.missing.join('; ')}</Alert>
          </div>
        )}
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {c.documents.expected.map((d: any) => {
            const issues = d.findings.filter((f: Finding) => f.status !== 'PASS' && f.status !== 'NOT_APPLICABLE');
            return (
              <li key={d.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
                  <div className="min-w-[200px] flex-1">
                    <div className="font-medium text-slate-900">{d.name}</div>
                    <div className="text-xs text-slate-500">{d.requirement.toLowerCase().replace('_', ' ')} · {d.sourceReference}</div>
                  </div>
                  <div className="text-xs">
                    {d.submitted ? (
                      <>
                        <DocViewer doc={d.submitted} />
                        <div className="text-slate-500">{d.submitted.integrity?.readable === false ? 'unreadable / truncated' : 'readable'}{d.submitted.integrity?.signatureStructure ? ' · signature structure present' : ''}</div>
                      </>
                    ) : (
                      <span className="text-slate-400">Not submitted</span>
                    )}
                  </div>
                  <FindingPill status={d.status} />
                </div>
                {issues.length > 0 && (
                  <ul className="mt-1 border-l-2 border-slate-100 pl-3">
                    {issues.map((f: Finding, i: number) => <FindingRow key={i} f={f} onDraft={onDraft} />)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Validity & expiry" count={c.validity.length}>{list(c.validity)}</Section>
      <Section title="Signatures & signatories" count={c.signatures.length}>{list(c.signatures)}</Section>
      <Section title="Other discrepancies" count={c.otherDiscrepancies.length}>{list(c.otherDiscrepancies)}</Section>
      <Section title="Items requiring human verification" count={c.humanVerification.length}>{list(c.humanVerification)}</Section>

      <Section title="Fields checked" count={c.fields.length}>
        <button className="mb-2 text-xs font-semibold text-brand-600" onClick={() => setShowAll((x) => !x)}>
          {showAll ? 'Show only fields with findings' : 'Show all fields'}
        </button>
        <table className="w-full text-sm">
          <tbody>
            {c.fields
              .filter((f: any) => showAll || !['PASS', 'NOT_APPLICABLE'].includes(f.status))
              .map((f: any) => (
                <tr key={f.id} className="border-t border-slate-100 align-top">
                  <td className="w-1/3 py-2.5 pr-3">
                    <div className="font-medium">{f.label}</div>
                    <div className="text-[11px] text-slate-400">{f.sourceReference ?? f.classification.toLowerCase()}</div>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-700">{f.value}</td>
                  <td className="py-2.5"><FindingPill status={f.status} /></td>
                </tr>
              ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = { RESOLVED: 'Resolved', PARTIALLY_RESOLVED: 'Partially resolved', UNRESOLVED: 'Unresolved' };

/**
 * Re-scrutiny: one notice item at a time — the original notice next to the institution's response,
 * the re-evaluated checks, and the official's item review.
 */
export function ReScrutinyReportView({
  report,
  deficiencies,
  canReview,
  onReview,
  busy,
  onDraft,
}: {
  report: any;
  deficiencies: any[];
  canReview: boolean;
  onReview: (id: string, outcome: string, note: string) => void;
  busy: string | null;
  onDraft?: (f: Finding) => void;
}) {
  const c = report.content;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sel, setSel] = useState(0);
  const items: any[] = c.deficiencies;
  const e = items[Math.min(sel, items.length - 1)];
  const live = e && deficiencies.find((d) => d.id === e.deficiencyId);
  const reviewed = (x: any) => ['RESOLVED', 'UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(deficiencies.find((d) => d.id === x.deficiencyId)?.status);
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-slate-900">Correction package v{c.correctionSubmission.version}</div>
          <div className="text-[13px] text-slate-500">
            Received {fmtDateTime(c.correctionSubmission.submittedAt)} · {c.run.rulesEvaluated} checks re-evaluated · re-scrutiny report v{c.version}
          </div>
        </div>
        <a href={`/api/reports/${report.id}/pdf`} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-600">
          <Download className="h-4 w-4" /> Report PDF
        </a>
      </div>
      <div className="mt-4">
        <Alert kind="info">{c.scopeNote}</Alert>
      </div>
      {!e ? (
        <p className="mt-4 text-sm text-slate-500">This correction package has no notice items.</p>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            {items.map((x, i) => (
              <button
                key={x.deficiencyId}
                onClick={() => setSel(i)}
                className={cx('inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition', i === sel ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:border-slate-300')}
              >
                {reviewed(x) && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}C-{String(i + 1).padStart(2, '0')}
              </button>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-slate-200">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
              <span className="font-semibold text-slate-900">{e.target.label}</span>
              <Badge>{e.category.replace(/_/g, ' ').toLowerCase()}</Badge>
              <span className="ml-auto text-xs text-slate-500">Automated assessment</span>
              <Badge t={ASSESSMENT_TONE[e.automatedAssessment]}>{e.automatedAssessment.replace(/_/g, ' ').toLowerCase()}</Badge>
            </div>
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Original notice</div>
                <p className="mt-1.5 text-slate-800">{e.original.explanation}</p>
                <p className="mt-2 text-[13px] text-slate-600">
                  <span className="text-slate-500">Requested: </span>
                  {e.original.correctiveAction}
                </p>
                {e.original.requiredReplacement && (
                  <p className="mt-1 text-[13px] text-slate-600">
                    <span className="text-slate-500">Replacement: </span>
                    {e.original.requiredReplacement}
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-400">
                  {e.original.noticeNo} · {e.sourceReference ?? 'no source cited'}
                </p>
                {e.correction.documents?.map((x: any) =>
                  x.before ? (
                    <div key={x.before.documentId} className="mt-2 text-xs">
                      Earlier file: <DocViewer doc={x.before} />
                    </div>
                  ) : null,
                )}
                {Object.keys(e.correction.fieldChanges?.before ?? {}).map((k) => (
                  <div key={k} className="mt-2 text-xs">
                    Earlier value ({k}): <span className="font-mono">{JSON.stringify(e.correction.fieldChanges.before[k])}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-brand-100 bg-brand-50/60 p-4 text-sm">
                <div className="text-[11px] font-semibold tracking-wide text-brand-700 uppercase">Institution response</div>
                <p className="mt-1.5 text-slate-800">{e.correction.response ?? <span className="text-slate-400">No response note</span>}</p>
                {e.correction.documents?.map((x: any) => (
                  <div key={x.after.documentId} className="mt-2 text-xs">
                    New file: <DocViewer doc={x.after} /> {x.after.integrity?.readable === false && <Badge t="red">unreadable</Badge>}
                  </div>
                ))}
                {Object.keys(e.correction.fieldChanges?.after ?? {}).map((k) => (
                  <div key={k} className="mt-2 text-xs">
                    New value ({k}): <span className="font-mono">{JSON.stringify(e.correction.fieldChanges.after[k])}</span>
                  </div>
                ))}
                {(e.correction.documents?.length ?? 0) === 0 && Object.keys(e.correction.fieldChanges?.after ?? {}).length === 0 && <p className="mt-2 text-xs text-amber-700">No document or field was changed.</p>}
              </div>
            </div>
            <div className="border-t border-slate-200 px-4 py-3">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Checks re-evaluated for this item</div>
              <ul className="divide-y divide-slate-100">
                {e.newResults.length === 0 && <li className="py-1.5 text-sm text-slate-500">No automated rule covers this item — verify it against the document.</li>}
                {e.newResults.map((f: Finding, i: number) => (
                  <FindingRow key={i} f={f} onDraft={onDraft} />
                ))}
              </ul>
              {e.humanVerificationRequired && <p className="mt-1 text-xs text-violet-700">Human verification still required.</p>}
            </div>
            {live?.officer_response && (
              <div className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
                <Badge t={live.status === 'RESOLVED' ? 'green' : live.status === 'RESPONDED' ? 'blue' : 'amber'}>{OUTCOME_LABEL[live.status] ?? live.status.toLowerCase()}</Badge>
                <span className="ml-2">{live.officer_response}</span>
              </div>
            )}
            {canReview && live && ['RESPONDED', 'RESOLVED', 'UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(live.status) && (
              <div className="space-y-3 border-t border-slate-200 bg-slate-50 px-4 py-4">
                <div className="text-sm font-semibold text-slate-900">Record item review</div>
                <textarea
                  aria-label="Item review note"
                  rows={2}
                  className={inputCls}
                  placeholder="What you verified for this item (required)"
                  value={notes[e.deficiencyId] ?? ''}
                  onChange={(ev) => setNotes({ ...notes, [e.deficiencyId]: ev.target.value })}
                />
                <div className="flex flex-wrap gap-2">
                  {(['RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED'] as const).map((o) => (
                    <Button
                      key={o}
                      variant={o === 'RESOLVED' ? 'primary' : 'secondary'}
                      className="px-3 py-1.5 text-xs"
                      disabled={(notes[e.deficiencyId] ?? '').trim().length < 3}
                      loading={busy === `${e.deficiencyId}${o}`}
                      onClick={() => onReview(e.deficiencyId, o, notes[e.deficiencyId])}
                    >
                      {OUTCOME_LABEL[o]}
                    </Button>
                  ))}
                  {sel < items.length - 1 && (
                    <Button variant="ghost" className="ml-auto px-3 py-1.5 text-xs" onClick={() => setSel(sel + 1)}>
                      Next item <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {c.dependentChecks.length > 0 && (
        <div className="mt-5">
          <div className="mb-1 text-[13px] font-semibold text-slate-900">Dependent checks re-evaluated</div>
          <ul className="divide-y divide-slate-100">
            {c.dependentChecks.map((f: Finding, i: number) => (
              <FindingRow key={i} f={f} />
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">{c.disclaimer}</p>
    </div>
  );
}
