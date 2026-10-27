import { Clock, Download, FileText, Gavel, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { daysUntil, fmtDate, fmtDateTime } from '../lib/hooks';
import { DocumentUploadModal } from './DocumentUpload';
import { Alert, Badge, Button, cx, inputCls, Label, Modal, type Tone } from './ui';

export const DEF_TONE: Record<string, Tone> = { OPEN: 'red', RESPONDED: 'blue', RESOLVED: 'green', UNRESOLVED: 'amber', PARTIALLY_RESOLVED: 'amber', DRAFT: 'slate', WITHDRAWN: 'slate' };

export function deadlineText(d: { deadline_type?: string; deadline?: string | null; deadline_basis?: string | null }) {
  if (!d.deadline || d.deadline_type === 'NOT_CONFIGURED') return 'No deadline established — requires authorised configuration';
  return d.deadline_type === 'APH' ? `Regulatory deadline: ${fmtDate(d.deadline)}` : `Operational (system-configured): ${fmtDate(d.deadline)}`;
}

/** One deficiency with its explanation, history and (for applicants) the correction controls. */
export function DeficiencyCard({ d, app, categoryDocs, categoryFields, editable, onChanged }: { d: any; app: any; categoryDocs?: any[]; categoryFields?: any[]; editable: boolean; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  const [upload, setUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const canAct = editable && ['OPEN', 'RESPONDED'].includes(d.status);
  const docDef = d.target_type === 'DOCUMENT' ? categoryDocs?.find((x) => x.id === d.target_id) : null;
  const fieldDef = d.target_type === 'FIELD' ? categoryFields?.find((x) => x.id === d.target_id) : null;

  async function respond() {
    setBusy(true);
    setMsg(null);
    try {
      const fieldChanges = fieldDef && fieldValue !== '' ? { [fieldDef.id]: fieldDef.type === 'number' ? Number(fieldValue) : fieldDef.type === 'boolean' ? fieldValue === 'true' : fieldValue } : undefined;
      await api.post(`/api/deficiencies/${d.id}/respond`, { note, fieldChanges });
      setMsg({ kind: 'success', text: 'Response recorded.' });
      setNote('');
      onChanged();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const left = daysUntil(d.deadline);
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-slate-500">{d.reference_no}</span>
        <Badge t={DEF_TONE[d.status]}>{d.status.toLowerCase()}</Badge>
        <Badge>{d.category.replace(/_/g, ' ').toLowerCase()}</Badge>
        <span className="text-xs text-slate-500">Stage: {d.stage_detected.toLowerCase().replace('_', '-')}</span>
        {d.notice_no && <span className="text-xs text-slate-500">Notice {d.notice_no} v{d.notice_version}</span>}
        {d.deadline && d.deadline_type !== 'NOT_CONFIGURED' ? (
          <Badge t={left !== null && left < 0 ? 'red' : 'amber'}>
            <Clock className="h-3 w-3" /> {left !== null && left < 0 ? 'Overdue' : 'Due'} {fmtDate(d.deadline)}
          </Badge>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-slate-500">{deadlineText(d)}</div>
      <div className="mt-2 text-sm font-semibold text-slate-900">{d.target_label}</div>
      <p className="mt-1 text-sm text-slate-700">{d.explanation}</p>
      <div className="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
        <div>Corrective action: <span className="text-slate-700">{d.corrective_action}</span></div>
        {d.required_replacement && <div>Replacement required: <span className="text-slate-700">{d.required_replacement}</span></div>}
        <div>Source: {d.source_reference ?? '—'}</div>
        <div>Raised {fmtDateTime(d.raised_at)} by {d.raised_by_name ?? 'reviewer'}</div>
        {d.deadline_basis && <div>Deadline basis: {d.deadline_basis}</div>}
      </div>
      {d.officer_response && (
        <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <span className="font-semibold">Latest officer response:</span> {d.officer_response}
        </div>
      )}
      {d.events?.length > 0 && (
        <ol className="mt-3 space-y-1 border-l-2 border-slate-100 pl-3 text-xs text-slate-600">
          {d.events.map((e: any) => (
            <li key={e.id}>
              <span className="font-semibold">{e.event.replace(/_/g, ' ').toLowerCase()}</span> · {fmtDateTime(e.created_at)}
              {e.actor_name && ` · ${e.actor_name}`}
              {e.note && <div className="text-slate-500">{e.note}</div>}
              {e.field_changes && <div className="font-mono text-[10px] text-slate-400">{JSON.stringify(e.field_changes.after)}</div>}
            </li>
          ))}
        </ol>
      )}
      {canAct && (
        <div className="mt-4 space-y-3 rounded-lg bg-slate-50 p-3">
          {docDef && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => setUpload(true)}>
                <Upload className="h-4 w-4" /> Upload corrected document
              </Button>
              <span className="text-xs text-slate-500">The previous version is preserved.</span>
            </div>
          )}
          {fieldDef && (
            <div>
              <Label htmlFor={`fv-${d.id}`}>New value for “{fieldDef.label}”</Label>
              <input id={`fv-${d.id}`} type={fieldDef.type === 'date' ? 'date' : fieldDef.type === 'number' ? 'number' : 'text'} className={inputCls} value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} placeholder={`Current: ${String(app.field_values?.[fieldDef.id] ?? '—')}`} />
            </div>
          )}
          <div>
            <Label htmlFor={`n-${d.id}`} required>Response</Label>
            <textarea id={`n-${d.id}`} rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain what was corrected" />
          </div>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          <Button onClick={respond} loading={busy} disabled={note.trim().length < 3}>Record response</Button>
        </div>
      )}
      {docDef && (
        <DocumentUploadModal
          open={upload}
          onClose={() => setUpload(false)}
          appId={app.id}
          doc={docDef}
          deficiencyId={d.id}
          onUploaded={(m) => {
            setMsg({ kind: 'success', text: m });
            onChanged();
          }}
        />
      )}
    </div>
  );
}

export function AppealPanel({ appId, eligibility, appeal, onFiled }: { appId: string; eligibility: any; appeal: any; onFiled: () => void }) {
  const [grounds, setGrounds] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [confirmAppeal, setConfirmAppeal] = useState(false);
  const [declared, setDeclared] = useState(false);
  async function fileAppeal() {
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append('grounds', grounds);
    if (file) fd.append('file', file);
    try {
      await api.upload(`/api/applications/${appId}/appeal`, fd);
      onFiled();
    } catch (e: any) {
      setConfirmAppeal(false);
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (appeal)
    return (
      <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Gavel className="h-4 w-4 text-violet-600" />
          <span className="font-semibold">Appeal {appeal.reference_no}</span>
          <Badge t="violet">{appeal.status.replace(/_/g, ' ').toLowerCase()}</Badge>
        </div>
        <div className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
          <div>Submitted {fmtDateTime(appeal.submitted_at)}</div>
          <div>Deadline was {fmtDateTime(appeal.deadline_at)}</div>
          {appeal.sac_outcome && <div>SAC: {appeal.sac_outcome.replace(/_/g, ' ').toLowerCase()} — {appeal.sac_notes}</div>}
        </div>
        <p className="mt-2 text-slate-700">{appeal.grounds}</p>
      </div>
    );
  if (!eligibility?.decisionId && !eligibility?.eligible) return <Alert kind="info" title="Appeal">{eligibility?.reason}</Alert>;
  const ms = eligibility.deadlineAt ? new Date(eligibility.deadlineAt).getTime() - now : 0;
  const remaining = ms > 0 ? `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h remaining` : 'expired';
  return (
    <div className={cx('rounded-xl border p-4', eligibility.eligible ? 'border-violet-200' : 'border-slate-200')}>
      <div className="flex flex-wrap items-center gap-2">
        <Gavel className="h-4 w-4 text-violet-600" />
        <span className="font-semibold">Appeal to the Council (Standing Appellate Committee)</span>
        <Badge t={eligibility.eligible ? 'violet' : 'slate'}>{eligibility.eligible ? 'Eligible' : 'Not eligible'}</Badge>
      </div>
      <p className="mt-1 text-sm text-slate-600">{eligibility.reason}</p>
      {eligibility.deadlineAt && (
        <div className="mt-2 text-xs text-slate-500">
          Deadline {fmtDateTime(eligibility.deadlineAt)} ({remaining}). Basis: {eligibility.deadlineBasis}
        </div>
      )}
      {eligibility.eligible && (
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="grounds" required>Grounds of appeal</Label>
            <textarea id="grounds" rows={4} className={inputCls} value={grounds} onChange={(e) => setGrounds(e.target.value)} placeholder="State the grounds (minimum 20 characters)" />
          </div>
          <div>
            <Label htmlFor="appealfile">Supporting document (optional)</Label>
            <input id="appealfile" type="file" accept=".pdf,.jpg,.jpeg,.png" className={inputCls} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          {err && <Alert kind="error">{err}</Alert>}
          <Button disabled={grounds.trim().length < 20} onClick={() => setConfirmAppeal(true)}>
            File appeal
          </Button>
        </div>
      )}
      <Modal
        open={confirmAppeal}
        onClose={() => {
          setConfirmAppeal(false);
          setDeclared(false);
        }}
        title="File the appeal"
      >
        <div className="space-y-4 text-sm">
          <Alert kind="warn">Only one appeal is allowed. This cannot be withdrawn or refiled once submitted.</Alert>
          <label className="flex items-start gap-2">
            <input type="checkbox" required className="mt-1" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
            <span>
              <span className="text-rose-600">*</span> I am authorised to file this appeal on behalf of the institution and declare that the grounds stated are true and correct.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { setConfirmAppeal(false); setDeclared(false); }}>Cancel</Button>
            <Button onClick={fileAppeal} disabled={!declared} loading={busy}>File appeal</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function DecisionCard({ d }: { d: any }) {
  const tone: Record<string, Tone> = { LOA: 'green', EOA: 'green', LOD: 'amber', LOR: 'red', CLOSURE_ORDER: 'slate', OTHER: 'slate' };
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge t={tone[d.decision_type]}>{d.decision_type.replace('_', ' ')}</Badge>
        <span className="font-mono text-sm font-semibold">{d.reference_no}</span>
        <Badge>{d.decision_body === 'COUNCIL' ? 'Council (final, on appeal)' : 'Executive Committee'}</Badge>
      </div>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div><div className="text-xs text-slate-500">Issuing authority</div>{d.issuing_authority}</div>
        <div><div className="text-xs text-slate-500">Decision date</div>{fmtDate(d.decision_date)}</div>
        <div><div className="text-xs text-slate-500">Uploaded</div>{fmtDateTime(d.uploaded_at)}</div>
      </div>
      {d.reasons && <div className="mt-3 text-sm"><span className="text-xs font-semibold text-slate-500 uppercase">Reasons</span><p className="text-slate-700">{d.reasons}</p></div>}
      {d.conditions && <div className="mt-2 text-sm"><span className="text-xs font-semibold text-slate-500 uppercase">Conditions</span><p className="text-slate-700">{d.conditions}</p></div>}
      {d.corrective_action && <div className="mt-2 text-sm"><span className="text-xs font-semibold text-slate-500 uppercase">Corrective action</span><p className="text-slate-700">{d.corrective_action}</p></div>}
      {d.next_steps && <div className="mt-2 text-sm"><span className="text-xs font-semibold text-slate-500 uppercase">Next steps</span><p className="text-slate-700">{d.next_steps}</p></div>}
      {d.document_name && (
        <a href={`/api/decisions/${d.id}/document`} className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600">
          <Download className="h-4 w-4" /> {d.document_name}
        </a>
      )}
    </div>
  );
}

export function DocLink({ doc }: { doc: any }) {
  return (
    <a href={`/api/documents/${doc.id}/download`} className="inline-flex items-center gap-1.5 text-brand-600 hover:underline">
      <FileText className="h-3.5 w-3.5" /> {doc.file_name}
    </a>
  );
}
