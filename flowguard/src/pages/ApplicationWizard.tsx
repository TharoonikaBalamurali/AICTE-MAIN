import { CheckCircle2, ChevronDown, FileText, Lock, Search, ShieldCheck, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { evaluate } from '../../server/rules/conditions';
import type { CategoryDef, DocumentRequirement, FieldDef } from '../../server/catalogue/types';
import { DocumentUploadModal } from '../components/DocumentUpload';
import { FieldInput } from '../components/FieldInput';
import { Findings } from '../components/Findings';
import { Alert, Badge, Button, Card, cx, inputCls, Label, Modal, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useCategories, type CategorySummary } from '../lib/categories';
import { fmtDateTime } from '../lib/hooks';

const today = () => new Date().toISOString().slice(0, 10);

function Steps({ step, onStep, canGo }: { step: number; onStep?: (n: number) => void; canGo: (n: number) => boolean }) {
  const items = ['Application type', 'Required information', 'Documents & review'];
  return (
    <ol className="mb-6 grid overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-3" aria-label="Progress">
      {items.map((t, i) => {
        const n = i + 1;
        const active = step === n;
        const done = step > n;
        return (
          <li key={t}>
            <button
              type="button"
              disabled={!canGo(n)}
              onClick={() => onStep?.(n)}
              aria-current={active ? 'step' : undefined}
              className={cx('flex w-full items-center gap-3 px-5 py-4 text-left text-sm font-semibold transition sm:border-r sm:border-slate-200', active ? 'bg-navy-900 text-white' : 'text-slate-600 hover:bg-slate-50 disabled:hover:bg-white')}
            >
              <span className={cx('flex h-7 w-7 items-center justify-center rounded-full text-xs', active ? 'bg-white text-navy-900' : done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                {done ? <CheckCircle2 className="h-4 w-4" /> : n}
              </span>
              {t}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function CategoryPicker({ cats, value, onChange, disabled }: { cats: CategorySummary[]; value: string | null; onChange: (c: string) => void; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const sel = cats.find((c) => c.code === value);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cats;
    return cats.filter((c) => [c.title, c.summary, c.aphReferences, ...c.keywords].join(' ').toLowerCase().includes(s));
  }, [q, cats]);
  useEffect(() => {
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, []);
  const pick = (c: CategorySummary) => {
    onChange(c.code);
    setQ('');
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls="cat-list"
          aria-label="Search application types"
          disabled={disabled}
          className={cx(inputCls, 'py-3.5 pr-10 pl-11 text-[15px]')}
          placeholder={sel ? sel.title : 'Search or choose one of 22 application types…'}
          value={open ? q : sel?.title ?? ''}
          onFocus={() => {
            setQ('');
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, list.length - 1));
            else if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0));
            else if (e.key === 'Enter' && list[hi]) {
              e.preventDefault();
              pick(list[hi]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
        <ChevronDown className="pointer-events-none absolute top-1/2 right-4 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </div>
      {open && !disabled && (
        <ul id="cat-list" role="listbox" className="absolute z-20 mt-1 max-h-[420px] w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {list.length === 0 && <li className="px-4 py-3 text-sm text-slate-500">No application type matches “{q}”.</li>}
          {list.map((c, i) => (
            <li
              key={c.code}
              role="option"
              aria-selected={c.code === value}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              className={cx('flex cursor-pointer items-start gap-3 px-4 py-2.5', i === hi && 'bg-brand-50')}
            >
              <span className="num mt-0.5 w-6 shrink-0 text-xs font-semibold text-slate-400">{c.menuNumber}.</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-900">{c.title}</span>
              </span>
              {!c.submissionEnabled && <Badge t="amber">Draft only</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupBy<T>(xs: T[], k: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
  return [...m.entries()];
}

export default function ApplicationWizard() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const cats = useCategories();
  const [code, setCode] = useState<string | null>(sp.get('category'));
  const [subtype, setSubtype] = useState<string | null>(null);
  const [app, setApp] = useState<any>(null);
  const [cat, setCat] = useState<CategoryDef | null>(null);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);
  const [checklist, setChecklist] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info' | 'warn'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<any>(null);
  const [uploadDoc, setUploadDoc] = useState<DocumentRequirement | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [declared, setDeclared] = useState(false);
  const [submitted, setSubmitted] = useState<any>(null);
  const step = id ? Math.min(3, Math.max(1, Number(sp.get('step') ?? 2))) : 1;
  const setStep = (n: number) => setSp((p) => {
    p.set('step', String(n));
    return p;
  });

  // Load draft
  useEffect(() => {
    if (!id) return;
    api
      .get(`/api/applications/${id}`)
      .then(async (d) => {
        if (d.application.status !== 'DRAFT') {
          nav(`/applications/${id}`, { replace: true });
          return;
        }
        setApp(d.application);
        setCode(d.application.category_code);
        setSubtype(d.application.subtype);
        setFields(d.application.field_values ?? {});
        const c = await api.get(`/api/categories/${d.application.category_code}`);
        setCat(c.category);
      })
      .catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [id, nav]);

  const loadChecklist = () => id && api.get(`/api/applications/${id}/checklist`).then((r) => setChecklist(r.checklist));
  useEffect(() => {
    if (id && step === 3) loadChecklist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, step, app?.row_version]);

  const summary = cats?.find((c) => c.code === code);
  const ctx = { fields: { ...fields }, subtype, evaluationDate: today() };
  const visibleFields = (cat?.fields ?? []).filter((f) => !f.showWhen || evaluate(f.showWhen, ctx));

  function clientValidate(): Record<string, string> {
    const e: Record<string, string> = {};
    for (const f of visibleFields) {
      const v = fields[f.id];
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
      if (f.required && empty) e[f.id] = 'This field is required.';
      else if (!empty && f.type === 'number') {
        const n = Number(v);
        if (f.validation?.min !== undefined && n < f.validation.min) e[f.id] = `Must be at least ${f.validation.min}.`;
        if (f.validation?.max !== undefined && n > f.validation.max) e[f.id] = `Must be at most ${f.validation.max}.`;
      } else if (!empty && f.validation?.pattern && typeof v === 'string' && !new RegExp(f.validation.pattern).test(v)) e[f.id] = f.validation.patternMessage ?? 'Invalid format.';
      if (f.type === 'courses' && Array.isArray(v) && v.some((r: any) => !r.course?.trim())) e[f.id] = 'Each row needs a course name.';
    }
    if (cat?.subtypes?.length && !subtype) e.__subtype = `Select the ${cat.subtypeLabel?.toLowerCase() ?? 'subtype'}.`;
    return e;
  }

  async function save(quiet = false) {
    if (!app) return null;
    setBusy('save');
    try {
      const r = await api.patch(`/api/applications/${app.id}`, { rowVersion: app.row_version, subtype, fields });
      setApp(r.application);
      setDirty(false);
      if (!quiet) setMsg({ kind: 'success', text: `Draft saved at ${new Date().toLocaleTimeString('en-IN')}. It stays available after refresh or a new login.` });
      return r.application;
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.body?.details?.map((d: any) => d.message).join('; ') || e.message });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createDraft() {
    if (!summary) return setMsg({ kind: 'error', text: 'Choose an application type first.' });
    if (summary.subtypes.length && !subtype) return setMsg({ kind: 'error', text: `Select the ${summary.subtypeLabel?.toLowerCase() ?? 'subtype'} to load the correct requirements.` });
    setBusy('create');
    try {
      const r = await api.post('/api/applications', { categoryCode: summary.code, subtype });
      nav(`/applications/${r.application.id}/edit?step=2`);
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function toDocuments() {
    const e = clientValidate();
    setErrors(e);
    const saved = await save(true);
    if (!saved) return;
    if (Object.keys(e).length) {
      setMsg({ kind: 'warn', text: `Draft saved. ${Object.keys(e).length} field(s) still need attention — they must be completed before final submission.` });
    } else setMsg(null);
    setStep(3);
  }

  async function runChecks() {
    if (!app) return;
    setBusy('check');
    try {
      if (dirty) await save(true);
      setValidation(await api.post(`/api/applications/${app.id}/validate`));
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setBusy('submit');
    try {
      const r = await api.post(`/api/applications/${app.id}/submit`, { declaration: true });
      setSubmitted(r.application);
      setConfirm(false);
    } catch (e: any) {
      setConfirm(false);
      if (e.body?.validation) {
        setValidation(e.body.validation);
        setMsg({ kind: 'error', text: e.message });
      } else setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  if (submitted)
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
          <h1 className="mt-4 text-2xl font-semibold">Application submitted</h1>
          <p className="mt-2 text-sm text-slate-500">The application is now locked for editing while it is processed.</p>
          <div className="mx-auto mt-6 grid max-w-md gap-3 rounded-xl bg-slate-50 p-4 text-left text-sm sm:grid-cols-2">
            <div>
              <div className="text-xs text-slate-500">Tracking reference</div>
              <div className="font-mono font-semibold">{submitted.reference_no}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Server timestamp</div>
              <div className="font-semibold">{fmtDateTime(submitted.submitted_at)}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-xs text-slate-500">Rule set</div>
              <div className="font-mono text-xs">{submitted.ruleset_version}</div>
            </div>
          </div>
          <p className="mt-4 text-xs text-slate-500">This is a portal tracking reference. It is not an official AICTE portal application number.</p>
          <div className="mt-6 flex justify-center gap-2">
            <Button variant="secondary" onClick={() => nav('/applications')}>
              My applications
            </Button>
            <Button onClick={() => nav(`/applications/${submitted.id}`)}>Track this application</Button>
          </div>
        </Card>
      </div>
    );

  if (!cats || (id && (!app || !cat))) return msg ? <Alert kind="error">{msg.text}</Alert> : <Spinner />;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
            Applications <span className="mx-1.5 text-slate-300">/</span> <span className="text-slate-700">{app?.reference_no ?? (app ? 'Draft' : 'New application')}</span>
          </div>
          <h1 className="text-[26px] leading-tight font-bold tracking-tight text-slate-900">Application requirements</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">Choose an application type to load its fields, document checklist, validity rules and review controls.</p>
        </div>
        {app && (
          <Button variant="secondary" onClick={() => save()} loading={busy === 'save'}>
            Save draft
          </Button>
        )}
      </div>
      <Steps step={step} canGo={(n) => !!app && n !== 1 ? true : n === 1} onStep={(n) => (app ? (n === 1 ? setStep(1) : n === 2 ? setStep(2) : toDocuments()) : undefined)} />
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}

      {step === 1 && (
        <Card className="p-6 sm:p-8">
          <Label>Type of application</Label>
          <CategoryPicker cats={cats} value={code} onChange={(c) => { setCode(c); setSubtype(null); setMsg(null); }} disabled={!!app} />
          {app && <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><Lock className="h-3.5 w-3.5" /> The type of a draft cannot be changed. Start a new application for a different type.</p>}
          {summary && (
            <>
              {summary.subtypes.length > 0 && (
                <div className="mt-5 max-w-md">
                  <Label required htmlFor="subtype">{summary.subtypeLabel ?? 'Subtype'}</Label>
                  <select
                    id="subtype"
                    className={inputCls}
                    value={subtype ?? ''}
                    onChange={(e) => {
                      setSubtype(e.target.value || null);
                      setDirty(true);
                    }}
                  >
                    <option value="">Select…</option>
                    {summary.subtypes.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">Different actions load different requirements.</p>
                </div>
              )}
              {!summary.submissionEnabled && (
                <div className="mt-4">
                  <Alert kind="warn" title="Draft only — checklist pending regulatory verification">{summary.verificationNotes.join(' ')}</Alert>
                </div>
              )}
            </>
          )}
          <div className="mt-8 flex justify-end">
            {app ? (
              <Button onClick={async () => { await save(true); setStep(2); }}>Continue to required information</Button>
            ) : (
              <Button onClick={createDraft} loading={busy === 'create'} disabled={!summary}>
                Continue to required information
              </Button>
            )}
          </div>
        </Card>
      )}

      {step === 2 && cat && (
        <div>
          <Card className="p-6 sm:p-8">
            <h2 className="text-lg font-semibold">{cat.title}</h2>
            <p className="mt-1 text-sm text-slate-500">Only fields applicable to this application are shown. Required fields are marked <span className="text-rose-600">*</span>.</p>
            {errors.__subtype && <div className="mt-3"><Alert kind="error">{errors.__subtype}</Alert></div>}
            {groupBy(visibleFields, (f: FieldDef) => f.group).map(([group, fs]) => (
              <fieldset key={group} className="mt-7">
                <legend className="mb-3 text-xs font-semibold tracking-[0.1em] text-slate-500 uppercase">{group}</legend>
                <div className="grid gap-5 sm:grid-cols-2">
                  {fs.map((f) => (
                    <FieldInput
                      key={f.id}
                      f={f}
                      value={fields[f.id]}
                      error={errors[f.id]}
                      onChange={(v) => {
                        setFields((x) => ({ ...x, [f.id]: v }));
                        setDirty(true);
                        if (errors[f.id]) setErrors(({ [f.id]: _, ...rest }) => rest);
                      }}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
            <div className="mt-8 flex justify-between border-t border-slate-100 pt-6">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={toDocuments} loading={busy === 'save'}>Continue to documents</Button>
            </div>
          </Card>
        </div>
      )}

      {step === 3 && cat && (
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            {(['SUBMISSION', 'EVC', 'POST_APPROVAL'] as const).map((stage) => {
              const rows = checklist.filter((d) => d.stage === stage);
              if (!rows.length) return null;
              return (
                <Card key={stage}>
                  <div className="border-b border-slate-100 px-6 py-5">
                    <h2 className="text-lg font-semibold">{stage === 'SUBMISSION' ? 'Document checklist' : stage === 'EVC' ? 'EVC-stage evidence' : 'After approval'}</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      {stage === 'SUBMISSION'
                        ? 'PDF, JPG or PNG only. Issuer, dates and DSC declaration are checked at submission.'
                        : stage === 'EVC'
                          ? 'Not required for submission. Prepare these for the Expert Visit Committee (you can upload them once an EVC is pending).'
                          : 'Uploaded after the decision through Compliance.'}
                    </p>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {rows.map((d) => (
                      <li key={d.id} className={cx('flex flex-wrap items-start gap-4 px-6 py-4', d.state === 'NOT_REQUIRED' && 'opacity-60')}>
                        <div className={cx('mt-0.5 rounded-lg p-2', d.uploaded ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500')}>
                          {d.uploaded ? <CheckCircle2 className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[15px] font-semibold text-slate-900">{d.name}</span>
                            {d.state === 'REQUIRED' && <span className="text-[11px] font-semibold text-rose-600 uppercase">Required</span>}
                            {d.state === 'ONE_OF' && <span className="text-[11px] font-semibold text-rose-600 uppercase">Required — one of the alternatives</span>}
                            {d.state === 'NOT_REQUIRED' && <Badge>Not required in your case</Badge>}
                            {d.state === 'OPTIONAL' && <Badge>Optional</Badge>}
                            {d.verificationStatus === 'NEEDS_VERIFICATION' && <Badge t="amber">Needs verification</Badge>}
                          </div>
                          {d.issuer && <div className="mt-0.5 text-[13px] text-slate-500">Authority: {d.issuer}</div>}
                          {d.triggerDescription && <div className="text-[13px] text-slate-500">Condition: {d.triggerDescription}</div>}
                          {d.validity?.kind !== 'NONE_STATED' && <div className="text-[13px] text-amber-700">Validity: {d.validity.description}</div>}
                          {d.uploaded && (
                            <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                              <FileText className="h-3.5 w-3.5" /> {d.uploaded.file_name} · v{d.uploaded.version}
                              {d.uploaded.metadata?.expiryDate && ` · expires ${d.uploaded.metadata.expiryDate}`}
                              {d.uploaded.metadata?.dscDeclared ? ' · DSC declared' : ' · DSC not declared'}
                            </div>
                          )}
                        </div>
                        {stage === 'SUBMISSION' && (
                          <Button variant="secondary" className="shrink-0" onClick={() => setUploadDoc(d)}>
                            {d.uploaded ? 'Replace' : 'Choose file'}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              );
            })}
            {checklist.length === 0 && (
              <Card className="p-6">
                <Alert kind="warn" title="No verified checklist yet">{cat.verificationNotes.join(' ')}</Alert>
              </Card>
            )}
            {validation && (
              <Card className="p-6">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">Validation findings</h3>
                  <div className="flex gap-2 text-xs">
                    <Badge t={validation.summary.blocking ? 'red' : 'green'}>{validation.summary.blocking} blocking</Badge>
                    <Badge t="amber">{validation.summary.warning} warnings</Badge>
                    <Badge t="violet">{validation.summary.humanReview} for human review</Badge>
                    <Badge t="green">{validation.summary.pass} passed</Badge>
                  </div>
                </div>
                <p className="mb-2 text-xs text-slate-500">
                  {validation.rulesEvaluated} rules evaluated on {validation.evaluationDate}. Input hash <span className="font-mono">{validation.inputHash.slice(0, 12)}…</span>
                </p>
                <Findings findings={validation.findings} />
              </Card>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={runChecks} loading={busy === 'check'}>
                  Run validation
                </Button>
                <Button
                  variant="dark"
                  disabled={!cat.submissionEnabled}
                  onClick={() => {
                    const e = clientValidate();
                    setErrors(e);
                    if (Object.keys(e).length) {
                      setMsg({ kind: 'error', text: 'Some required information is missing. Go back to Required information.' });
                      return;
                    }
                    setDeclared(false);
                    setConfirm(true);
                  }}
                >
                  Complete application
                </Button>
              </div>
            </div>
          </div>
          <aside>
            <Card className="p-5">
              <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4 text-brand-600" /> Submission safeguards</h3>
              <ul className="mt-3 space-y-2.5 text-[13px] text-slate-600">
                {[
                  'Mandatory fields and files enforced server-side',
                  'Application locked after final submission',
                  'Reopening (once) requires authority approval',
                  'Only explicit, verified validity periods are enforced',
                  'File SHA-256 and version history retained',
                  'Human-review items are never auto-approved',
                ].map((t) => (
                  <li key={t} className="flex gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />{t}</li>
                ))}
              </ul>
            </Card>
          </aside>
        </div>
      )}

      {app && (
        <DocumentUploadModal
          open={!!uploadDoc}
          onClose={() => setUploadDoc(null)}
          appId={app.id}
          doc={uploadDoc}
          onUploaded={(m) => {
            setMsg({ kind: 'success', text: m });
            loadChecklist();
            setValidation(null);
          }}
        />
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Confirm final submission">
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3">
            <div><div className="text-xs text-slate-500">Application type</div><div className="font-semibold">{cat?.title}</div></div>
            <div><div className="text-xs text-slate-500">Academic year</div><div className="font-semibold">{String(fields.academicYear ?? '—')}</div></div>
            <div><div className="text-xs text-slate-500">Documents uploaded</div><div className="font-semibold">{checklist.filter((d) => d.uploaded).length}</div></div>
            <div><div className="text-xs text-slate-500">Subtype</div><div className="font-semibold">{cat?.subtypes?.find((s) => s.value === subtype)?.label ?? '—'}</div></div>
          </div>
          <Alert kind="warn">After final submission the data cannot be edited while processing is ongoing. Reopening is possible only once, with competent authority approval.</Alert>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
            <span>I am authorised to submit on behalf of the institution and declare that the information and documents are true and correct.</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!declared} loading={busy === 'submit'}>Submit application</Button>
          </div>
        </div>
      </Modal>
      {id && (
        <p className="mt-6 text-center text-xs text-slate-400">
          Draft {app?.id.slice(0, 8)} · last saved {fmtDateTime(app?.updated_at)} · <Link className="underline" to="/applications?view=drafts">All drafts</Link>
        </p>
      )}
    </>
  );
}
