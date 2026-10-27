import { ArrowLeft, ArrowRight, CalendarCheck, Download, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Findings } from '../components/Findings';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, inputCls, KV, Label, Modal, PageHeader, PageNote, Spinner, StatusBadge, StepBar, Table, Tabs, tdCls, TextLink, Timeline } from '../components/ui';
import { AppealPanel, DecisionCard, DEF_TONE, DocLink } from '../components/Workflow';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, useApi } from '../lib/hooks';
import { actionLabel } from '../lib/roles';
import { workflowSteps } from '../lib/workflow';

/** Compact stage bar used by the official workspace header. */
export function StageProgress({ stages, status }: { stages: Array<{ key: string; label: string }>; current?: string; status: string }) {
  const flow = workflowSteps(status, stages);
  return <StepBar steps={flow.steps} current={flow.current} attention={flow.attention} />;
}

type Tab = 'overview' | 'documents' | 'validation' | 'deficiencies' | 'evc' | 'decision' | 'compliance';

const RESPONSE_LABEL: Record<string, string> = { OPEN: 'Needs response', RESPONDED: 'Response submitted', RESOLVED: 'Resolved', UNRESOLVED: 'Unresolved', PARTIALLY_RESOLVED: 'Partially resolved' };

export default function ApplicationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi(`/api/applications/${id}`);
  const [tab, setTab] = useState<Tab>('overview');
  const [cat, setCat] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [reopen, setReopen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenFile, setReopenFile] = useState<File | null>(null);

  useEffect(() => {
    if (data?.application?.category_code) api.get(`/api/categories/${data.application.category_code}`).then((r) => setCat(r.category));
  }, [data?.application?.category_code]);
  useEffect(() => {
    if (data && data.notices.length > 0 && ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS', 'READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'].includes(data.application.status)) setTab('deficiencies');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.application?.status]);

  if (loading && !data) return <Spinner />;
  if (error) return <Alert kind="error" title="Application not available">{error}</Alert>;
  if (!data) return null;
  const a = data.application;
  const inCorrection = ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'].includes(a.status);
  const openDefs = data.deficiencies.filter((d: any) => ['OPEN', 'UNRESOLVED'].includes(d.status)).length;
  const fieldsDef: any[] = cat?.fields ?? [];
  const flow = workflowSteps(a.status, data.category.stages);
  const lastEvent = data.timeline.at(-1);
  const nextDeadline = data.deficiencies.filter((d: any) => d.status === 'OPEN' && d.deadline).map((d: any) => d.deadline).sort()[0];
  const latestNotice = data.notices[0];
  const noticeItems = latestNotice ? data.deficiencies.filter((d: any) => d.notice_id === latestNotice.id) : [];
  const respond = () => nav(`/applications/${a.id}/respond`);

  return (
    <>
      <PageHeader
        crumbs={['Applications', a.reference_no]}
        title={<span className="font-mono">{a.reference_no}</span>}
        subtitle={
          <>
            {data.category.title}
            {a.subtype && ` — ${data.category.subtypes.find((s: any) => s.value === a.subtype)?.label}`}
          </>
        }
        action={
          <>
            <Button variant="secondary" onClick={() => nav('/applications')}>
              <ArrowLeft className="h-4 w-4" /> All applications
            </Button>
            {a.status === 'SUBMITTED' && a.reopen_count === 0 && (
              <Button variant="secondary" onClick={() => setReopen(true)} disabled={!!a.reopen_requested_at}>
                <RotateCcw className="h-4 w-4" /> {a.reopen_requested_at ? 'Reopen requested' : 'Request reopening'}
              </Button>
            )}
            {inCorrection && (
              <Button onClick={respond}>
                Respond to notice <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </>
        }
      />
      <Card className="mb-6">
        <div className="grid grid-cols-2 gap-5 px-5 py-4 lg:grid-cols-5">
          <KV k="Current stage" v={<StatusBadge status={a.status} label={a.statusLabel} />} />
          <KV k="Pending with" v={a.pendingAction === 'APPLICANT' ? 'Your institution' : a.pendingAction === 'OFFICIAL' ? 'AICTE officials' : 'No one'} />
          <KV
            k="Last workflow event"
            v={
              lastEvent ? (
                <>
                  {actionLabel(lastEvent.action)}
                  <div className="text-xs font-normal text-slate-500">{fmtDateTime(lastEvent.created_at)}</div>
                </>
              ) : (
                '—'
              )
            }
          />
          <KV k="Response due" v={nextDeadline ? fmtDate(nextDeadline) : inCorrection ? 'Not configured' : '—'} />
          <KV k="Submitted" v={fmtDateTime(a.submitted_at)} />
        </div>
        <div className="border-t border-slate-100 px-5 py-4">
          <StepBar steps={flow.steps} current={flow.current} attention={flow.attention} />
        </div>
      </Card>
      {inCorrection && (
        <div className="mb-6">
          <Alert kind="warn" title={`${openDefs} correction item${openDefs === 1 ? ' needs' : 's need'} your response`} action={<Button onClick={respond}>Respond</Button>}>
            {data.nextAction}
          </Alert>
        </div>
      )}
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card className="self-start">
          <div className="px-5">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'overview', label: 'Overview' },
                { value: 'documents', label: `Documents (${data.documents.filter((d: any) => d.is_current).length})` },
                { value: 'deficiencies', label: <>Corrections {openDefs > 0 && <Badge t="amber">{openDefs}</Badge>}</> },
                { value: 'validation', label: 'Checks' },
                ...(data.category.route.evc === 'YES' ? [{ value: 'evc' as Tab, label: 'EVC' }] : []),
                { value: 'decision', label: 'Decision & appeal' },
                { value: 'compliance', label: 'Compliance' },
              ]}
            />
          </div>
          <div className="p-5">
            {tab === 'overview' && (
              <div className="space-y-6">
                <div>
                  <h4 className="mb-3 text-[13px] font-semibold text-slate-900">Institution</h4>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <KV k="Institution name" v={a.institution_snapshot?.name} />
                    <KV k="AICTE institution ID" v={<>{a.institution_snapshot?.aicteInstitutionId} <span className="text-xs font-normal text-slate-500">({a.institution_snapshot?.idVerification?.toLowerCase()})</span></>} />
                    <KV k="Applicant" v={`${a.applicant_name ?? '—'}${a.applicant_designation ? `, ${a.applicant_designation}` : ''}`} />
                    <KV k="Official email" v={a.institution_snapshot?.officialEmail} />
                  </div>
                </div>
                <div className="border-t border-slate-100 pt-5">
                  <h4 className="mb-3 text-[13px] font-semibold text-slate-900">Application</h4>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <KV k="Application type" v={data.category.title} />
                    <KV k="Rule set" v={<span className="font-mono text-xs">{a.ruleset_version}</span>} />
                    {fieldsDef
                      .filter((f) => a.field_values[f.id] !== undefined && a.field_values[f.id] !== null && a.field_values[f.id] !== '')
                      .map((f) => {
                        const v = a.field_values[f.id];
                        const shown = Array.isArray(v)
                          ? v.map((r: any) => `${r.course}${r.proposedIntake !== undefined ? ` (${r.proposedIntake})` : ''}`).join(', ')
                          : typeof v === 'boolean'
                            ? v
                              ? 'Yes'
                              : 'No'
                            : (f.options?.find((o: any) => o.value === v)?.label ?? String(v));
                        return <KV key={f.id} k={f.label} v={shown} />;
                      })}
                  </div>
                </div>
              </div>
            )}
            {tab === 'documents' && (
              <Table className="-mx-5" head={['Requirement', 'File', 'Version', 'Uploaded', 'Status']} empty={data.documents.length === 0 && <Empty title="No documents" />}>
                {data.documents.map((d: any) => (
                  <tr key={d.id} className={cx(!d.is_current && 'text-slate-400')}>
                    <td className={`${tdCls} max-w-[260px] text-[13px]`}>{cat?.documents?.find((x: any) => x.id === d.requirement_id)?.name ?? d.requirement_id}</td>
                    <td className={`${tdCls} text-[13px]`}><DocLink doc={d} /></td>
                    <td className={tdCls}>v{d.version}</td>
                    <td className={`${tdCls} text-xs whitespace-nowrap`}>{fmtDateTime(d.uploaded_at)}</td>
                    <td className={tdCls}>{d.is_current ? <Badge t="green">Current</Badge> : <Badge>Superseded</Badge>}</td>
                  </tr>
                ))}
              </Table>
            )}
            {tab === 'validation' &&
              (data.validation ? (
                <>
                  <p className="mb-4 text-xs text-slate-500">
                    Latest run {fmtDateTime(data.validation.run.run_at)} · {data.validation.run.rules_evaluated} rules · rule set {data.validation.run.ruleset_version}. These automated checks assist reviewers; they are not a decision.
                  </p>
                  <Findings findings={data.validation.findings} />
                </>
              ) : (
                <Empty title="No checks run yet" />
              ))}
            {tab === 'deficiencies' && (
              <div className="space-y-5">
                {!latestNotice && <Empty title="No correction notice">Correction notices issued by reviewers appear here.</Empty>}
                {latestNotice && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[15px] font-semibold text-slate-900">Correction notice summary</div>
                        <div className="text-[13px] text-slate-500">
                          {latestNotice.notice_no} v{latestNotice.version} · issued {fmtDateTime(latestNotice.issued_at)}
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <a href={`/api/notices/${latestNotice.id}/pdf`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand-600">
                          <Download className="h-3.5 w-3.5" /> PDF
                        </a>
                        <TextLink onClick={respond}>{inCorrection ? 'Respond to notice' : 'Read notice'} <ArrowRight className="h-3.5 w-3.5" /></TextLink>
                      </div>
                    </div>
                    <Table className="-mx-5" head={['Item', 'Requested clarification', 'Response']}>
                      {noticeItems.map((d: any, i: number) => (
                        <tr key={d.id} className="align-top">
                          <td className={`${tdCls} font-mono text-xs font-semibold whitespace-nowrap text-slate-500`}>C-{String(i + 1).padStart(2, '0')}</td>
                          <td className={tdCls}>
                            <div className="font-medium text-slate-900">{d.target_label}</div>
                            <div className="mt-0.5 line-clamp-2 text-[13px] text-slate-500">{d.explanation}</div>
                          </td>
                          <td className={tdCls}><Badge t={DEF_TONE[d.status]}>{RESPONSE_LABEL[d.status] ?? d.status.toLowerCase()}</Badge></td>
                        </tr>
                      ))}
                    </Table>
                  </>
                )}
                {['READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'].includes(a.status) && (
                  <Alert kind="info" title="Re-scrutiny">
                    {a.status === 'READY_FOR_RE_SCRUTINY' ? 'Your corrections are waiting for re-scrutiny.' : 'Re-scrutiny is in progress. Only the items in the notice are verified.'}
                  </Alert>
                )}
                {data.notices.length > 1 && (
                  <div className="text-xs text-slate-500">
                    Earlier notices:{' '}
                    {data.notices.slice(1).map((n: any) => (
                      <a key={n.id} href={`/api/notices/${n.id}/pdf`} className="mr-2 font-semibold text-brand-600">
                        {n.notice_no} v{n.version}
                      </a>
                    ))}
                  </div>
                )}
                {data.corrections.length > 0 && (
                  <div className="border-t border-slate-100 pt-4">
                    <h4 className="mb-2 text-[13px] font-semibold text-slate-900">Submitted correction packages</h4>
                    {data.corrections.map((c: any) => (
                      <div key={c.id} className="mb-1 text-[13px] text-slate-600">
                        Package v{c.version} · {fmtDateTime(c.submitted_at)} · {c.items.length} response(s) · changed {[...c.changed_docs, ...c.changed_fields].join(', ') || 'no files or fields'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {tab === 'evc' && (
              <div className="space-y-4">
                {data.evcVisits.length === 0 && <Empty icon={<CalendarCheck className="h-5 w-5" />} title="No EVC scheduled yet">The Regional Officer schedules the EVC after scrutiny.</Empty>}
                {data.evcVisits.map((v: any) => (
                  <div key={v.id} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge t="blue">{v.mode.toLowerCase()} EVC</Badge>
                      <Badge t={v.status === 'CANCELLED' ? 'red' : v.status === 'COMPLETED' ? 'green' : 'amber'}>{v.status.toLowerCase()}</Badge>
                      <span className="text-sm font-semibold">{fmtDateTime(v.scheduled_start)}</span>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {v.location && <KV k="Location" v={v.location} />}
                      {v.meeting_link && <KV k="Online meeting" v={<a className="text-brand-600 underline" href={v.meeting_link} target="_blank" rel="noreferrer noopener">{v.meeting_link}</a>} />}
                      {v.agenda && <KV k="Agenda" v={v.agenda} />}
                      {v.prepare_items && <KV k="Prepare" v={v.prepare_items} />}
                      {v.instructions && <KV k="Instructions" v={v.instructions} />}
                      {v.committee_disclosure && <KV k="Committee (as disclosed)" v={v.committee_disclosure} />}
                      {v.status_note && <KV k="Status note" v={v.status_note} />}
                    </div>
                  </div>
                ))}
                {data.evcReports.map((r: any) => (
                  <div key={r.id} className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 text-sm">
                    <div className="font-semibold">EVC report v{r.version} · {fmtDateTime(r.submitted_at)}</div>
                    <div className="mt-2"><span className="text-xs text-slate-500">Recommendation</span><p>{r.recommendation}</p></div>
                    <div className="mt-2"><span className="text-xs text-slate-500">Observations</span><p className="whitespace-pre-wrap">{r.observations}</p></div>
                    <p className="mt-2 text-xs text-slate-500">Reports are made available to institutions; internal evidence references are not disclosed.</p>
                  </div>
                ))}
              </div>
            )}
            {tab === 'decision' && (
              <div className="space-y-4">
                {data.decisions.length === 0 && <Empty title="No decision yet">Only authorised officials record LoA / EoA / LoD / LoR. The portal never grants or rejects approval automatically.</Empty>}
                {data.decisions.map((d: any) => <DecisionCard key={d.id} d={d} />)}
                {data.committeeReviews.map((c: any) => (
                  <div key={c.id} className="text-sm text-slate-600">
                    <Badge t="violet">{c.committee}</Badge> {c.committee === 'SHC' ? 'Standing Hearing Committee' : 'Standing Appellate Committee'} recommendation recorded · {fmtDateTime(c.recorded_at)}
                    <span className="block text-xs text-slate-500">A recommendation is not a decision; the {c.committee === 'SHC' ? 'Executive Committee' : 'Council'} decides.</span>
                  </div>
                ))}
                {data.decisions.length > 0 && <AppealPanel appId={a.id} eligibility={data.appealEligibility} appeal={data.appeal} onFiled={reload} />}
              </div>
            )}
            {tab === 'compliance' && (
              <div className="space-y-2">
                {data.obligations.length === 0 && <Empty title="No compliance obligations">Obligations are created only where a regulatory provision establishes them.</Empty>}
                {data.obligations.map((o: any) => (
                  <div key={o.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{o.title}</div>
                      <div className="text-xs text-slate-500">{o.trigger_event}</div>
                    </div>
                    <span className="text-xs">{o.due_date ? `Due ${fmtDate(o.due_date)}` : 'No fixed date'}</span>
                    <Badge t={o.status === 'ACCEPTED_BY_AUTHORISED_REVIEWER' ? 'green' : ['SUBMITTED', 'UNDER_REVIEW'].includes(o.status) ? 'blue' : o.status === 'DEFICIENT' ? 'red' : 'amber'}>{o.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                  </div>
                ))}
                {data.obligations.length > 0 && <Link to="/compliance" className="text-sm font-semibold text-brand-600">Open compliance</Link>}
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <CommitteePanel data={data} onDone={(kind, text) => { setMsg({ kind, text }); reload(); }} />
          <Card>
            <CardHeader title="Shared workflow history" subtitle="Events visible to your institution" />
            <Timeline
              items={[
                ...data.timeline.map((e: any) => ({ at: e.created_at, id: `w${e.id}`, title: actionLabel(e.action), warn: ['ISSUE_DEFICIENCY_NOTICE', 'REQUEST_FURTHER_CORRECTION'].includes(e.action) })),
                ...data.committeeProceedings.map((p: any) => ({ at: p.created_at, id: `p${p.id}`, title: `${COMMITTEE_NAME[p.committee]}: ${p.kind === 'HEARING_NOTICE' ? 'hearing notice' : 'clarification requested'}`, warn: true })),
                ...data.committeeSubmissions.map((s: any) => ({ at: s.submitted_at, id: `s${s.id}`, title: `Submission to the ${COMMITTEE_NAME[s.committee]}`, warn: false })),
              ]
                .sort((x, y) => y.at.localeCompare(x.at))
                .map((e, i) => ({ id: e.id, title: e.title, meta: fmtDateTime(e.at), tone: e.warn ? 'warn' : i === 0 ? 'current' : 'done' }))}
            />
          </Card>
          <Card>
            <CardHeader title="Next workflow step" />
            <div className="px-5 pb-5">
              <p className="text-sm text-slate-700">{data.nextAction}</p>
              {inCorrection ? (
                <Button className="mt-4 w-full" onClick={respond}>Respond to notice</Button>
              ) : (
                <>
                  <Button className="mt-4 w-full" disabled>
                    {a.pendingAction === 'OFFICIAL' ? 'Awaiting AICTE officials' : 'No action pending'}
                  </Button>
                  <p className="mt-2 text-xs text-slate-500">You will be notified in the portal when the next step needs your institution.</p>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
      <PageNote>Automated checks assist reviewers; every outcome is recorded by an authorised official.</PageNote>

      <Modal open={reopen} onClose={() => setReopen(false)} title="Request one-time reopening">
        <div className="space-y-3 text-sm">
          <Alert kind="info">If an application was wrongly submitted, it may be reopened ONE time with competent authority approval. Attach the Format 3 resolution.</Alert>
          <div>
            <Label htmlFor="rr" required>Reason</Label>
            <textarea id="rr" rows={3} className={inputCls} value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rf" required>Format 3 resolution</Label>
            <input id="rf" type="file" accept=".pdf,.jpg,.jpeg,.png" className={inputCls} onChange={(e) => setReopenFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReopen(false)}>Cancel</Button>
            <Button
              disabled={reopenReason.trim().length < 10 || !reopenFile}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const fd = new FormData();
                fd.append('reason', reopenReason);
                fd.append('file', reopenFile!);
                try {
                  await api.upload(`/api/applications/${a.id}/reopen-request`, fd);
                  setReopen(false);
                  setMsg({ kind: 'success', text: 'Reopen request sent to the competent authority.' });
                  reload();
                } catch (e: any) {
                  setMsg({ kind: 'error', text: e.message });
                  setReopen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send request
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

const COMMITTEE_NAME: Record<string, string> = { EC: 'Executive Committee', SHC: 'Standing Hearing Committee', SAC: 'Standing Appellate Committee', COUNCIL: 'Council' };

/** The committee currently holding the case, as the institution sees it (the server re-checks every submission). */
function committeeFor(data: any): string | null {
  const s = data.application.status;
  if (s === 'AWAITING_COMMITTEE_REVIEW') return 'SHC';
  if (s === 'APPEAL_SUBMITTED' || s === 'APPEAL_UNDER_REVIEW') return 'SAC';
  if (s === 'AWAITING_AUTHORISED_DECISION' && data.committeeProceedings.some((p: any) => p.committee === 'EC' && p.kind === 'CLARIFICATION_REQUEST') && (!data.appeal || data.appeal.status === 'DECIDED')) return 'EC';
  return null;
}

/** Hearing notices and clarification requests from a committee, and the institution's replies. */
function CommitteePanel({ data, onDone }: { data: any; onDone: (kind: 'success' | 'error', text: string) => void }) {
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const holder = committeeFor(data);
  const notices = [...data.committeeProceedings].reverse();
  if (!holder && notices.length === 0 && data.committeeSubmissions.length === 0) return null;
  async function send() {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('note', note);
      if (file) fd.append('file', file);
      await api.upload(`/api/applications/${data.application.id}/committee-submissions`, fd);
      setNote('');
      setFile(null);
      onDone('success', `Submission recorded by the ${COMMITTEE_NAME[holder!]}.`);
    } catch (e: any) {
      onDone('error', e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title="Committee notices" subtitle={holder ? `Your case is before the ${COMMITTEE_NAME[holder]}` : 'Hearings and requests from AICTE committees'} divided />
      {notices.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {notices.map((p: any) => (
            <li key={p.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge t={p.kind === 'HEARING_NOTICE' ? 'green' : 'amber'}>{p.kind === 'HEARING_NOTICE' ? 'Hearing notice' : 'Clarification requested'}</Badge>
                <span className="text-xs text-slate-500">{COMMITTEE_NAME[p.committee]} · {fmtDateTime(p.created_at)}</span>
              </div>
              {p.hearing_at && (
                <div className="mt-1 inline-flex items-center gap-1.5 font-medium text-slate-900">
                  <CalendarCheck className="h-4 w-4 text-emerald-600" /> {fmtDateTime(p.hearing_at)} · {p.hearing_mode === 'ONLINE' ? 'Online' : 'Physical'}
                  {p.hearing_venue && ` · ${p.hearing_venue}`}
                </div>
              )}
              <p className="mt-1 whitespace-pre-wrap text-slate-700">{p.body}</p>
            </li>
          ))}
        </ul>
      )}
      {data.committeeSubmissions.length > 0 && (
        <div className="border-t border-slate-100 px-5 py-3">
          <div className="mb-1 text-xs font-semibold text-slate-500 uppercase">Your submissions</div>
          <ul className="space-y-1 text-[13px]">
            {data.committeeSubmissions.map((s: any) => (
              <li key={s.id}>
                {fmtDateTime(s.submitted_at)} · to the {COMMITTEE_NAME[s.committee]}
                {s.file_name && (
                  <a className="ml-1 text-brand-600 hover:underline" href={`/api/committee/submissions/${s.id}/download?inline=1`} target="_blank" rel="noreferrer">
                    {s.file_name}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {holder && (
        <div className="space-y-3 border-t border-slate-100 p-5">
          <Label htmlFor="cs" required hint={holder === 'SHC' ? 'Compliance for the shortcomings' : holder === 'SAC' ? 'Supporting documents for the appeal' : 'Your clarification'}>
            Submit to the {COMMITTEE_NAME[holder]}
          </Label>
          <textarea id="cs" rows={3} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Describe what you are submitting" />
          <input type="file" accept=".pdf,.jpg,.jpeg,.png" className={inputCls} aria-label="Supporting document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button className="w-full" loading={busy} disabled={note.trim().length < 5} onClick={send}>
            Submit
          </Button>
          <p className="text-xs text-slate-500">Submissions are kept with a timestamp and cannot be replaced; send a new one to add material.</p>
        </div>
      )}
    </Card>
  );
}
