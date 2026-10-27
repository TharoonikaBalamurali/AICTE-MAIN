import { ArrowLeft, ArrowRight, CheckCircle2, Circle, Download, FileText, RefreshCw, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentUploadModal } from '../components/DocumentUpload';
import { FieldInput } from '../components/FieldInput';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, inputCls, Label, Modal, PageHeader, PageNote, Spinner } from '../components/ui';
import { deadlineText } from '../components/Workflow';
import { api } from '../lib/api';
import { daysUntil, fmtDate, fmtDateTime, useApi } from '../lib/hooks';

const itemNo = (i: number) => `C-${String(i + 1).padStart(2, '0')}`;
const CORRECTION_STATES = ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'];

/** Institution: answer each item of the latest correction notice, then submit the correction package. */
export default function RespondNotice() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi(`/api/applications/${id}`);
  const [cat, setCat] = useState<any>(null);
  const [sel, setSel] = useState(0);
  const [note, setNote] = useState('');
  const [fieldValue, setFieldValue] = useState<unknown>(undefined);
  const [upload, setUpload] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string; retry?: () => void } | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [declared, setDeclared] = useState(false);

  useEffect(() => {
    if (data?.application?.category_code) api.get(`/api/categories/${data.application.category_code}`).then((r) => setCat(r.category));
  }, [data?.application?.category_code]);

  const notice = data?.notices?.[0];
  const items: any[] = useMemo(() => (notice ? data.deficiencies.filter((d: any) => d.notice_id === notice.id) : []), [data, notice]);
  const item = items[sel];
  useEffect(() => {
    setNote('');
    setFieldValue(undefined);
    setMsg(null);
  }, [sel, item?.id]);

  if (loading && !data) return <Spinner />;
  if (error) return <Alert kind="error" title="Application not available">{error}</Alert>;
  if (!data) return null;
  const a = data.application;
  const open = CORRECTION_STATES.includes(a.status);
  const answered = items.filter((d) => d.status !== 'OPEN').length;
  const pending = items.length - answered;
  const nextDeadline = items.map((d) => d.deadline).filter(Boolean).sort()[0];
  const left = daysUntil(nextDeadline);

  const docDef = item?.target_type === 'DOCUMENT' ? cat?.documents?.find((x: any) => x.id === item.target_id) : null;
  const fieldDef = item?.target_type === 'FIELD' ? cat?.fields?.find((x: any) => x.id === item.target_id) : null;
  const uploaded = item ? data.documents.find((d: any) => d.deficiency_id === item.id && d.is_current) : null;
  const lastResponse = item?.events?.filter((e: any) => e.event === 'RESPONSE').at(-1);
  const editable = open && item && ['OPEN', 'RESPONDED'].includes(item.status);

  async function save() {
    setBusy('save');
    setMsg(null);
    try {
      const changed = fieldDef && fieldValue !== undefined && JSON.stringify(fieldValue) !== JSON.stringify(a.field_values?.[fieldDef.id]);
      const fieldChanges = changed ? { [fieldDef.id]: fieldValue } : undefined;
      await api.post(`/api/deficiencies/${item.id}/respond`, { note, fieldChanges });
      setMsg({ kind: 'success', text: `Response to ${itemNo(sel)} saved.` });
      setNote('');
      reload();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message, retry: save });
    } finally {
      setBusy(null);
    }
  }
  async function submitPackage() {
    setBusy('submit');
    setMsg(null);
    try {
      await api.post(`/api/applications/${a.id}/corrections/submit`);
      nav(`/applications/${a.id}`);
    } catch (e: any) {
      setConfirmSubmit(false);
      setMsg({ kind: 'error', text: e.message, retry: submitPackage });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        crumbs={['Applications', a.reference_no, 'Correction notice']}
        title="Respond to correction notice"
        subtitle={notice ? `Notice ${notice.notice_no} v${notice.version} · issued ${fmtDateTime(notice.issued_at)} by ${notice.content?.issuedBy?.role ?? notice.issued_by_name}` : undefined}
        action={
          <>
            <Button variant="secondary" onClick={() => nav(`/applications/${a.id}`)}>
              <ArrowLeft className="h-4 w-4" /> Application
            </Button>
            {notice && (
              <a href={`/api/notices/${notice.id}/pdf`} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">
                <Download className="h-4 w-4" /> Download notice
              </a>
            )}
          </>
        }
      />
      {!notice ? (
        <Card>
          <Empty title="No correction notice">There is no correction notice on this application.</Empty>
        </Card>
      ) : (
        <>
          <div className="mb-6">
            {open ? (
              <Alert kind={pending ? 'warn' : 'success'} title={pending ? `${answered} of ${items.length} items have a response` : 'Every item has a response'}>
                {nextDeadline ? `Respond by ${fmtDate(nextDeadline)}${left !== null ? ` (${left < 0 ? `${-left} days overdue` : `${left} days left`})` : ''}.` : 'No response deadline has been configured for this notice.'}{' '}
                Previous file versions are kept; re-scrutiny examines only the items in this notice.
              </Alert>
            ) : (
              <Alert kind="info" title="This notice is closed for responses">
                {['READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'].includes(a.status) ? 'Your correction package has been submitted and is with the Re-Scrutiny Committee.' : `Current stage: ${a.statusLabel}.`}
              </Alert>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
            <Card className="self-start">
              <CardHeader title="Notice items" subtitle={`${items.length} item${items.length === 1 ? '' : 's'} requested`} divided />
              <ul className="p-2">
                {items.map((d, i) => {
                  const done = d.status !== 'OPEN';
                  return (
                    <li key={d.id}>
                      <button
                        onClick={() => setSel(i)}
                        className={cx('flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition', i === sel ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-slate-50')}
                      >
                        {done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />}
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] font-semibold tracking-wide text-slate-500">ITEM {itemNo(i)}</span>
                          <span className="block truncate text-sm font-medium text-slate-900">{d.target_label}</span>
                          <span className="mt-1 inline-block">
                            <ItemStatus status={d.status} />
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>

            {item && (
              <Card>
                <CardHeader
                  title={
                    <span>
                      <span className="text-slate-400">Item {itemNo(sel)} · </span>
                      {item.target_label}
                    </span>
                  }
                  subtitle={`${item.category.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase())} · ${deadlineText(item)}`}
                  action={<ItemStatus status={item.status} />}
                  divided
                />
                <div className="space-y-5 p-5">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Official observation</div>
                    <p className="mt-1.5 text-sm text-slate-800">{item.explanation}</p>
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-xs text-slate-500">Requested correction</dt>
                        <dd className="mt-0.5 text-slate-800">{item.corrective_action}</dd>
                      </div>
                      {item.required_replacement && (
                        <div>
                          <dt className="text-xs text-slate-500">Replacement required</dt>
                          <dd className="mt-0.5 text-slate-800">{item.required_replacement}</dd>
                        </div>
                      )}
                    </dl>
                  </div>

                  {docDef && (
                    <div>
                      <Label>Corrected document</Label>
                      {uploaded ? (
                        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                          <FileText className="h-5 w-5 text-emerald-600" />
                          <div className="min-w-0 flex-1">
                            <a href={`/api/documents/${uploaded.id}/download?inline=1`} target="_blank" rel="noreferrer" className="block truncate text-sm font-semibold text-slate-900 hover:underline">
                              {uploaded.file_name}
                            </a>
                            <div className="text-xs text-slate-500">
                              Version {uploaded.version} · {(uploaded.size_bytes / 1024).toFixed(0)} KB · uploaded {fmtDateTime(uploaded.uploaded_at)}
                            </div>
                          </div>
                          {editable && (
                            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setUpload(true)}>
                              Replace
                            </Button>
                          )}
                        </div>
                      ) : editable ? (
                        <button
                          type="button"
                          onClick={() => setUpload(true)}
                          className="flex w-full flex-col items-center rounded-lg border-2 border-dashed border-slate-300 px-6 py-8 text-center transition hover:border-brand-500 hover:bg-brand-50/40"
                        >
                          <UploadCloud className="h-7 w-7 text-slate-400" />
                          <span className="mt-2 text-sm font-semibold text-slate-800">Upload the corrected file</span>
                          <span className="mt-0.5 text-xs text-slate-500">PDF, JPG or PNG up to 10 MB · {docDef.name}</span>
                        </button>
                      ) : (
                        <p className="text-sm text-slate-500">No corrected file was uploaded for this item.</p>
                      )}
                    </div>
                  )}

                  {fieldDef && editable && (
                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="mb-3 text-[13px] font-semibold text-slate-900">Correct “{fieldDef.label}”</div>
                      <FieldInput f={fieldDef} value={fieldValue === undefined ? a.field_values?.[fieldDef.id] : fieldValue} onChange={setFieldValue} />
                      <p className="mt-2 text-xs text-slate-500">The value is saved with your response; the earlier value is kept for re-scrutiny comparison.</p>
                    </div>
                  )}

                  {lastResponse && (
                    <div className="rounded-lg border border-brand-100 bg-brand-50/60 px-4 py-3 text-sm">
                      <div className="text-[11px] font-semibold tracking-wide text-brand-700 uppercase">Your recorded response</div>
                      <p className="mt-1 text-slate-800">{lastResponse.note}</p>
                      <div className="mt-1 text-xs text-slate-500">{fmtDateTime(lastResponse.created_at)}</div>
                    </div>
                  )}

                  {editable && (
                    <div>
                      <Label htmlFor="resp" required>
                        {lastResponse ? 'Update your response' : 'Your response'}
                      </Label>
                      <textarea id="resp" rows={4} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain what was corrected and where the officer can verify it." />
                      {docDef && !uploaded && <p className="mt-1 text-xs text-slate-500">Upload the corrected document before saving the response.</p>}
                    </div>
                  )}

                  {msg && (
                    <Alert
                      kind={msg.kind}
                      action={
                        msg.retry && (
                          <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={msg.retry}>
                            <RefreshCw className="h-3.5 w-3.5" /> Retry
                          </Button>
                        )
                      }
                    >
                      {msg.text}
                    </Alert>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                    <span className="text-xs text-slate-500">Raised {fmtDate(item.raised_at)} · {item.reference_no}</span>
                    <div className="flex gap-2">
                      {editable && (
                        <Button variant="secondary" loading={busy === 'save'} disabled={note.trim().length < 3 || (!!docDef && !uploaded)} onClick={save}>
                          Save response
                        </Button>
                      )}
                      <Button disabled={sel >= items.length - 1} onClick={() => setSel(sel + 1)}>
                        Next item <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            )}
          </div>

          {open && (
            <Card className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="text-[15px] font-semibold text-slate-900">{pending ? 'Correction package not yet ready' : 'Correction package ready to submit'}</div>
                  <div className="mt-0.5 text-[13px] text-slate-500">
                    {pending ? `${pending} item${pending === 1 ? '' : 's'} still need a response before the package can be submitted.` : 'All items have a response. Submitting sends the package to the Re-Scrutiny Committee.'}
                  </div>
                </div>
                <Button disabled={pending > 0} onClick={() => setConfirmSubmit(true)}>
                  Submit correction package
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
      <PageNote>
        <Link to={`/applications/${a.id}`} className="hover:text-slate-600">
          {a.reference_no}
        </Link>{' '}
        · responses are stored as an immutable correction submission when the package is submitted.
      </PageNote>
      {docDef && (
        <DocumentUploadModal
          open={upload}
          onClose={() => setUpload(false)}
          appId={a.id}
          doc={docDef}
          deficiencyId={item.id}
          onUploaded={(m) => {
            setMsg({ kind: 'success', text: m });
            reload();
          }}
        />
      )}
      <Modal
        open={confirmSubmit}
        onClose={() => {
          setConfirmSubmit(false);
          setDeclared(false);
        }}
        title="Submit correction package"
      >
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3">
            <div><div className="text-xs text-slate-500">Application</div><div className="font-semibold">{a.reference_no}</div></div>
            <div><div className="text-xs text-slate-500">Items responded</div><div className="font-semibold">{answered} of {items.length}</div></div>
          </div>
          <Alert kind="warn">Responses cannot be edited after submission. The package is sent to the Re-Scrutiny Committee, which examines only the items in this notice.</Alert>
          <label className="flex items-start gap-2">
            <input type="checkbox" required className="mt-1" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
            <span>
              <span className="text-rose-600">*</span> I am authorised to respond on behalf of the institution and declare that the corrections and documents submitted are true and correct.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { setConfirmSubmit(false); setDeclared(false); }}>Cancel</Button>
            <Button onClick={submitPackage} disabled={!declared} loading={busy === 'submit'}>Submit correction package</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function ItemStatus({ status }: { status: string }) {
  if (status === 'OPEN') return <Badge t="amber">Needs response</Badge>;
  if (status === 'RESPONDED') return <Badge t="blue">Response saved</Badge>;
  if (status === 'RESOLVED') return <Badge t="green">Resolved</Badge>;
  if (status === 'UNRESOLVED' || status === 'PARTIALLY_RESOLVED') return <Badge t="red">{status === 'UNRESOLVED' ? 'Unresolved' : 'Partially resolved'}</Badge>;
  return <Badge>{status.toLowerCase()}</Badge>;
}
