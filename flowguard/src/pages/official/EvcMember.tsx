import { ArrowLeft, Camera, CheckCircle2, Download, FileText, Film, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, inputCls, KV, Label, PageHeader, PageNote, Spinner, Table, tdCls, TextLink, Timeline, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, useApi } from '../../lib/hooks';
import { fromIST, istDay, istLongDate, istRange, responsePill } from './evcCoord';

export const MEMBER_STATUS: Record<string, [string, Tone]> = {
  INVITED: ['Invitation — please respond', 'amber'],
  ACCEPTED: ['Accepted — awaiting confirmation', 'blue'],
  DECLINED: ['Declined', 'slate'],
  VISIT_SCHEDULED: ['Visit scheduled', 'blue'],
  VISIT_IN_PROGRESS: ['Visit in progress', 'blue'],
  VISIT_COMPLETED: ['Visit completed — report due', 'amber'],
  REPORT_DRAFT: ['Report draft', 'amber'],
  REPORT_SUBMITTED: ['Report submitted', 'green'],
  REPORT_OVERDUE: ['Report overdue', 'red'],
  VISIT_MISSED: ['Visit missed', 'red'],
  HUMAN_REVIEW_REQUIRED: ['Conflict / withdrawal — with Regional Officer', 'violet'],
  REMOVED: ['Removed from committee', 'slate'],
  CANCELLED: ['Visit cancelled', 'slate'],
};
export const SEAT_SHORT: Record<string, string> = {
  ACADEMICIAN: 'Academician',
  EXPERT: 'Expert member',
  ARCHITECT_PLANNING: 'Architect / Planning',
  CO_OPTED: 'Co-opted',
  CHAIRMAN_DEEMED_UNIVERSITY: 'Chairman (Deemed University)',
};
export const DOC_CATS = ['INSPECTION_REPORT', 'SUPPORTING_DOCUMENT', 'ATTENDANCE_SHEET'];
export const EVIDENCE_LABEL: Record<string, string> = { INSPECTION_REPORT: 'Inspection report', SUPPORTING_DOCUMENT: 'Supporting document', VISIT_PHOTO: 'Visit photograph', ATTENDANCE_SHEET: 'Attendance sheet', VIDEO_RECORDING: 'Video recording', OTHER: 'Other evidence' };
const FINDING_LABEL: Record<string, string> = { VERIFIED_AVAILABLE: 'Verified — available', DEFICIENT: 'Deficient', NOT_VERIFIED: 'Not verified', NOT_APPLICABLE: 'Not applicable' };

/** One visit: acknowledgement, attendance, outcome, report draft with evidence, submission. */
export function VisitWorkspace() {
  const { visitId } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi(`/api/evc/visits/${visitId}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [note, setNote] = useState('');
  const [why, setWhy] = useState('');
  const [sections, setSections] = useState<Record<string, { finding?: string; observation?: string }>>({});
  const [rec, setRec] = useState('');
  const [summary, setSummary] = useState('');
  const [obs, setObs] = useState('');
  const [update, setUpdate] = useState('');
  const [declared, setDeclared] = useState(false);
  const [response, setResponse] = useState('');

  useEffect(() => {
    if (data?.draft) {
      setSections(data.draft.sections ?? {});
      setRec(data.draft.recommendation ?? '');
      setSummary(data.draft.disclosed_summary ?? '');
    }
  }, [data?.draft]);

  async function call(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
      setNote('');
      reload();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.body?.details?.map?.((d: any) => d.message ?? d.path).join('; ') || e.message });
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <Spinner />;
  if (error) return <Alert kind="error" title="Visit not available">{error}</Alert>;
  if (!data) return null;
  const v = data.visit;
  const me = data.members.find((m: any) => m.user_id === user?.id && m.active);
  const isMember = data.role.isMember;
  const isRO = data.role.isRegionalOfficer;
  const started = ['IN_PROGRESS', 'COMPLETED'].includes(v.status);
  const beforeVisit = ['PROPOSED', 'SCHEDULED', 'RESCHEDULED'].includes(v.status);
  const submitted = data.reports.length > 0;
  const [statusLabel, statusTone] = MEMBER_STATUS[data.myStatus] ?? [v.status.toLowerCase(), 'slate'];
  const compiled = () =>
    data.reportSections
      .filter((s: any) => sections[s.key]?.finding || sections[s.key]?.observation)
      .map((s: any) => `${s.label}: ${FINDING_LABEL[sections[s.key]?.finding ?? ''] ?? 'Not recorded'}${sections[s.key]?.observation ? ` — ${sections[s.key].observation}` : ''}`)
      .join('\n');
  const draftBody = () => ({ sections, recommendation: rec || undefined, disclosedSummary: summary || undefined });
  const accepted = me?.response_status === 'ACCEPTED';
  const updates = data.events.filter((e: any) => e.event === 'INSPECTION_UPDATE');
  const pendingEvidence = data.evidence.filter((x: any) => !x.report_id);

  return (
    <>
      <PageHeader
        crumbs={['EVC', data.application.reference_no, 'Visit']}
        title={data.institution.name}
        subtitle={`${data.application.reference_no} · ${v.mode === 'ONLINE' ? 'Virtual' : 'Physical'} visit · ${istLongDate(v.scheduled_start)}, ${istRange(v.scheduled_start, v.scheduled_end)}`}
        action={
          <>
            <Button variant="secondary" onClick={() => nav(-1)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {isRO && <Button variant="secondary" onClick={() => nav(`/official/evc/schedule/${data.application.id}`)}>Scheduling</Button>}
          </>
        }
      />
      <Card className="mb-6">
        <div className="grid grid-cols-2 gap-5 px-5 py-4 lg:grid-cols-5">
          <KV k="Visit status" v={<Badge t={v.status === 'MISSED' ? 'red' : v.status === 'COMPLETED' ? 'green' : v.status === 'PROPOSED' ? 'amber' : 'blue'}>{v.status.replace(/_/g, ' ').toLowerCase()}</Badge>} />
          <KV k="Your status" v={me ? <Badge t={statusTone}>{statusLabel}</Badge> : 'Not a member'} />
          <KV k="Your seat" v={me ? SEAT_SHORT[me.seat] ?? '—' : '—'} />
          <KV k={v.mode === 'ONLINE' ? 'Meeting link' : 'Location'} v={<span className="break-all">{(v.mode === 'ONLINE' ? v.meeting_link : v.location) || 'Shared by the Regional Officer'}</span>} />
          <KV k="Institution video link" v={v.institution_video_link ? <a className="break-all text-brand-600 underline" href={v.institution_video_link} target="_blank" rel="noreferrer noopener">Open</a> : 'Not shared yet'} />
        </div>
        {v.offline_justification && <div className="border-t border-slate-100 px-5 py-3 text-[13px] text-slate-600">Offline visit justification: {v.offline_justification}</div>}
        {isMember && (v.instructions || beforeVisit) && (
          <div className="border-t border-slate-100 px-5 py-3 text-[13px] text-slate-600">
            {v.instructions && <div className="mb-1">Note from the Regional Officer: “{v.instructions}”</div>}
            {beforeVisit && <div className="text-xs text-slate-500">The date and time are set by the Regional Officer. To ask for a change, decline with a reason or report a conflict.</div>}
          </div>
        )}
      </Card>
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {isMember && beforeVisit && me && (
            <Card>
              <CardHeader title="Your invitation" subtitle={`${istLongDate(v.scheduled_start)}, ${istRange(v.scheduled_start, v.scheduled_end)} · ${SEAT_SHORT[me.seat] ?? ''}`} divided />
              <div className="space-y-3 p-5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  Your response: <Badge t={responsePill(me.response_status).tone}>{responsePill(me.response_status).label}</Badge>
                  {me.responded_at && <span className="text-xs text-slate-500">{fmtDateTime(me.responded_at)}</span>}
                </div>
                {me.response_status === 'ACCEPTED' && <Alert kind="success">You accepted this visit. {v.status === 'SCHEDULED' ? 'The Regional Officer has confirmed it.' : 'It is confirmed once every member accepts.'}</Alert>}
                {me.response_status === 'REJECTED' && <Alert kind="info">You declined{me.rejection_reason ? `: “${me.rejection_reason}”` : ''}. Your time is released; the Regional Officer arranges any replacement.</Alert>}
                {['CONFLICT_REPORTED', 'WITHDRAWAL_REQUESTED'].includes(me.response_status) && (
                  <Alert kind="warn">
                    {me.response_status === 'CONFLICT_REPORTED' ? 'Conflict reported' : 'Withdrawal requested'}: “{me.conflict_note}”. Your time stays reserved until the Regional Officer decides.
                  </Alert>
                )}
                {['INVITED', 'CONFLICT_REPORTED'].includes(me.response_status) && (
                  <Button loading={busy === 'accept'} onClick={() => call('accept', () => api.post(`/api/evc/visits/${visitId}/respond`, { response: 'ACCEPTED' }), 'Invitation accepted.')}>
                    <CheckCircle2 className="h-4 w-4" /> Accept invitation
                  </Button>
                )}
                {['INVITED', 'CONFLICT_REPORTED', 'ACCEPTED'].includes(me.response_status) && (
                  <div>
                    <Label htmlFor="why" hint="At least 5 characters">{me.response_status === 'ACCEPTED' ? 'Request withdrawal' : 'Decline or report a conflict'}</Label>
                    <textarea id="why" rows={2} className={inputCls} value={why} onChange={(e) => setWhy(e.target.value)} placeholder={me.response_status === 'ACCEPTED' ? 'Why you can no longer attend' : 'e.g. on examination duty that day — available the following week'} />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {me.response_status === 'ACCEPTED' ? (
                        <Button variant="secondary" disabled={why.trim().length < 5} loading={busy === 'withdraw'} onClick={() => call('withdraw', () => api.post(`/api/evc/visits/${visitId}/respond`, { response: 'WITHDRAWAL_REQUESTED', reason: why }), 'Withdrawal request sent to the Regional Officer.').then(() => setWhy(''))}>
                          Request withdrawal
                        </Button>
                      ) : (
                        <>
                          <Button variant="danger" disabled={why.trim().length < 5} loading={busy === 'reject'} onClick={() => call('reject', () => api.post(`/api/evc/visits/${visitId}/respond`, { response: 'REJECTED', reason: why }), 'Invitation declined; your time has been released.').then(() => setWhy(''))}>
                            Decline
                          </Button>
                          {me.response_status === 'INVITED' && (
                            <Button variant="secondary" disabled={why.trim().length < 5} loading={busy === 'conflict'} onClick={() => call('conflict', () => api.post(`/api/evc/visits/${visitId}/respond`, { response: 'CONFLICT_REPORTED', reason: why }), 'Conflict reported to the Regional Officer.').then(() => setWhy(''))}>
                              Report conflict
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          {(isMember || isRO) && (started || beforeVisit) && !submitted && (
            <Card>
              <CardHeader title="Visit progress" subtitle="Record what happened. Nothing is assumed from the scheduled time." divided />
              <div className="space-y-4 p-5">
                {isMember && v.status === 'SCHEDULED' && me?.response_status === 'ACCEPTED' && (
                  <Button loading={busy === 'start'} onClick={() => call('start', () => api.post(`/api/official/applications/${data.application.id}/actions/START_EVC`, {}), 'Visit started.')}>
                    Start visit
                  </Button>
                )}
                {started && (
                  <div>
                    <div className="mb-2 text-[13px] font-semibold text-slate-900">Attendance</div>
                    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {data.members
                        .filter((m: any) => m.active)
                        .map((m: any) => (
                          <li key={m.user_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                            <span className="w-full min-w-0 sm:w-auto sm:flex-1">{m.full_name} <span className="text-xs text-slate-500">· {SEAT_SHORT[m.seat] ?? ''}</span></span>
                            <Badge t={m.attendance === 'PRESENT' ? 'green' : m.attendance === 'ABSENT' ? 'red' : 'slate'}>{m.attendance.replace('_', ' ').toLowerCase()}</Badge>
                            {(m.user_id === user?.id || isRO) &&
                              (['PRESENT', 'ABSENT'] as const).map((a) => (
                                <Button key={a} variant="secondary" className="px-2.5 py-1 text-xs" loading={busy === `att${m.user_id}${a}`} onClick={() => call(`att${m.user_id}${a}`, () => api.post(`/api/evc/visits/${visitId}/attendance`, { userId: m.user_id, attendance: a }), 'Attendance recorded.')}>
                                  {a === 'PRESENT' ? 'Present' : 'Absent'}
                                </Button>
                              ))}
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                <div>
                  <Label>Outcome note</Label>
                  <textarea rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened (kept in the visit history)" />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {v.status === 'IN_PROGRESS' && (
                      <Button disabled={note.trim().length < 5} loading={busy === 'complete'} onClick={() => call('complete', () => api.post(`/api/evc/visits/${visitId}/complete`, { note }), 'Visit recorded as completed. The report is now due.')}>
                        Record visit completed
                      </Button>
                    )}
                    {['SCHEDULED', 'RESCHEDULED'].includes(v.status) && new Date(v.scheduled_start) < new Date() && (
                      <Button variant="danger" disabled={note.trim().length < 5} loading={busy === 'missed'} onClick={() => call('missed', () => api.post(`/api/evc/visits/${visitId}/missed`, { reason: note }), 'Visit reported as missed and escalated for review.')}>
                        Report visit missed
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {((isMember && accepted && started) || updates.length > 0) && (
            <Card>
              <CardHeader title="Inspection updates" subtitle="Progress notes, sent to the Regional Officer." divided />
              <div className="space-y-4 p-5">
                {isMember && accepted && started && !submitted && (
                  <div>
                    <textarea aria-label="Inspection update" rows={2} className={inputCls} value={update} onChange={(e) => setUpdate(e.target.value)} placeholder="e.g. Instructional block and laboratories inspected; library pending" />
                    <div className="mt-2 flex justify-end">
                      <Button variant="secondary" className="w-full sm:w-auto" disabled={update.trim().length < 5} loading={busy === 'update'} onClick={() => call('update', () => api.post(`/api/evc/visits/${visitId}/updates`, { note: update }), 'Update posted and sent to the Regional Officer.').then(() => setUpdate(''))}>
                        Post update
                      </Button>
                    </div>
                  </div>
                )}
                {updates.length === 0 ? (
                  <p className="text-sm text-slate-500">No updates yet.</p>
                ) : (
                  <ol className="space-y-3 border-l-2 border-slate-100 pl-4">
                    {updates.map((e: any, i: number) => (
                      <li key={`${e.created_at}${i}`} className="text-sm">
                        <div className="text-slate-800">{e.details?.note}</div>
                        <div className="text-xs text-slate-500">{e.actor_name} · {fmtDateTime(e.created_at)}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </Card>
          )}

          {isMember && me && !started && !submitted && !['MISSED', 'CANCELLED'].includes(v.status) && (
            <Card>
              <CardHeader title="Inspection report & evidence" subtitle="Opens once the visit has started" divided />
              <div className="grid gap-3 p-5 sm:grid-cols-3">
                {[
                  { icon: FileText, label: 'Report documents' },
                  { icon: Camera, label: 'Photos & videos' },
                  { icon: CheckCircle2, label: 'Final report' },
                ].map((x) => (
                  <div key={x.label} className="flex items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    <x.icon className="h-4 w-4" /> {x.label}
                  </div>
                ))}
              </div>
              <ol className="space-y-1.5 border-t border-slate-100 px-5 py-4 text-[13px]">
                {[
                  { done: me.response_status === 'ACCEPTED', text: 'You accept the invitation' },
                  { done: v.status === 'SCHEDULED', text: 'The Regional Officer confirms the visit (every member has accepted)' },
                  { done: false, text: 'An accepted member starts the visit on the day' },
                ].map((s) => (
                  <li key={s.text} className={cx('flex items-center gap-2', s.done ? 'text-emerald-700' : 'text-slate-600')}>
                    {s.done ? <CheckCircle2 className="h-4 w-4" /> : <span className="h-4 w-4 rounded-full border border-slate-300" />} {s.text}
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {(started || data.evidence.length > 0) && (
            <>
              <UploadSection
                kind="docs"
                visitId={visitId!}
                canUpload={isMember && accepted && started && !submitted}
                items={data.evidence.filter((x: any) => DOC_CATS.includes(x.category))}
                onDone={(kind, text) => {
                  setMsg({ kind, text });
                  reload();
                }}
              />
              <UploadSection
                kind="media"
                visitId={visitId!}
                canUpload={isMember && accepted && started && !submitted}
                items={data.evidence.filter((x: any) => !DOC_CATS.includes(x.category))}
                onDone={(kind, text) => {
                  setMsg({ kind, text });
                  reload();
                }}
              />
            </>
          )}

          {isMember && started && !submitted && (
            <Card>
              <CardHeader
                title="Final EVC report"
                subtitle="On submission the report goes to the Regional Officer and the Regulation Bureau; the Executive Committee decides after the committee's recommendation and the Bureau's views."
                divided
              />
              <div className="space-y-4 p-5">
                {data.reportSections.map((s: any) => (
                  <div key={s.key} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{s.label}</div>
                      </div>
                      <select aria-label={`${s.label} finding`} className="rounded-md border border-slate-300 px-2 py-1.5 text-xs" value={sections[s.key]?.finding ?? ''} onChange={(e) => setSections({ ...sections, [s.key]: { ...sections[s.key], finding: e.target.value || undefined } })}>
                        <option value="">Not recorded</option>
                        {data.sectionFindings.map((f: string) => (
                          <option key={f} value={f}>{FINDING_LABEL[f]}</option>
                        ))}
                      </select>
                    </div>
                    <textarea aria-label={`${s.label} observation`} rows={2} className={`${inputCls} mt-2`} value={sections[s.key]?.observation ?? ''} onChange={(e) => setSections({ ...sections, [s.key]: { ...sections[s.key], observation: e.target.value } })} placeholder="Observation" />
                  </div>
                ))}
                <div>
                  <Label required>Committee recommendation</Label>
                  <input className={inputCls} value={rec} onChange={(e) => setRec(e.target.value)} />
                </div>
                <div>
                  <Label>Summary disclosed to the institution</Label>
                  <textarea rows={2} className={inputCls} value={summary} onChange={(e) => setSummary(e.target.value)} />
                </div>
                <div>
                  <Label>Overall observations</Label>
                  <textarea rows={3} className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Leave empty to compile from the sections above" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { title: 'Report documents', icon: <FileText className="h-4 w-4" />, items: pendingEvidence.filter((x: any) => DOC_CATS.includes(x.category)), empty: 'None yet — add the inspection report under “Inspection report documents”.' },
                    { title: 'Visit evidence', icon: <Camera className="h-4 w-4" />, items: pendingEvidence.filter((x: any) => !DOC_CATS.includes(x.category)), empty: 'No photos or videos yet.' },
                  ].map((g) => (
                    <div key={g.title} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[13px] text-slate-700">
                      <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                        {g.icon} {g.title} <span className="font-normal text-slate-500">({g.items.length})</span>
                      </div>
                      {g.items.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-500">{g.empty}</p>
                      ) : (
                        <ul className="mt-1 space-y-0.5">
                          {g.items.map((x: any) => (
                            <li key={x.id} className="truncate text-xs">
                              {EVIDENCE_LABEL[x.category] ?? 'Other'} · {x.file_name}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
                {!pendingEvidence.some((x: any) => x.category === 'INSPECTION_REPORT') && (
                  <p className="text-xs text-amber-700">Tip: attach the committee’s inspection report as a PDF under “Inspection report documents” before submitting.</p>
                )}
                <label className="flex items-start gap-2.5 text-[13px] text-slate-700">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
                  <span>I confirm this report records what the committee verified during the visit, and the attached evidence was collected for this visit. Submitted versions cannot be edited.</span>
                </label>
                <div className="flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row">
                  <Button variant="secondary" loading={busy === 'draft'} onClick={() => call('draft', () => api.put(`/api/evc/visits/${visitId}/draft`, draftBody()), 'Draft saved.')}>
                    Save draft
                  </Button>
                  <Button
                    disabled={!declared || rec.trim().length < 3 || (obs.trim() || compiled()).length < 10}
                    loading={busy === 'submit'}
                    onClick={() =>
                      call(
                        'submit',
                        async () => {
                          await api.put(`/api/evc/visits/${visitId}/draft`, draftBody());
                          const clean = Object.fromEntries(Object.entries(sections).filter(([, x]) => x.finding).map(([k, x]) => [k, { finding: x.finding, observation: x.observation?.trim() || undefined }]));
                          await api.post(`/api/official/applications/${data.application.id}/actions/SUBMIT_EVC_REPORT`, { declaration: true, observations: obs.trim() || compiled(), recommendation: rec.trim(), disclosedSummary: summary.trim() || undefined, sections: clean });
                        },
                        'Final report submitted to the Regional Officer and the Regulation Bureau. A receipt was sent to your notifications.',
                      )
                    }
                  >
                    Submit final report
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {data.reports.length > 0 && (
            <Card>
              <CardHeader title="Final report submitted" subtitle="Sent to the Regional Officer and the Regulation Bureau, for the Executive Committee" divided />
              <div className="space-y-4 p-5">
                {data.reports.map((r: any) => (
                  <div key={r.id} className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 text-sm">
                    <div className="font-semibold">Version {r.version} · receipt {r.receipt_no ?? '—'}</div>
                    <div className="text-xs text-slate-500">
                      {r.submitted_by_name} · {fmtDateTime(r.submitted_at)}
                      {r.declaration_at && ' · declaration confirmed'}
                      {` · ${data.evidence.filter((x: any) => x.report_id === r.id).length} attachment(s)`}
                    </div>
                    <p className="mt-2">{r.recommendation}</p>
                    <p className="mt-1 whitespace-pre-wrap text-slate-600">{r.observations}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {data.escalations.length > 0 && (
            <Card>
              <CardHeader title="Escalations on this visit" subtitle="Requests from the Regulation Bureau" divided />
              <div className="space-y-3 p-5">
                {data.escalations.map((e: any) => (
                  <div key={e.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{e.reference_no}</span>
                      <Badge t={['RESOLVED', 'CLOSED'].includes(e.status) ? 'green' : 'amber'}>{e.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </div>
                    <p className="mt-1 text-slate-700">{e.reason}</p>
                    {!['RESOLVED', 'CLOSED'].includes(e.status) && (
                      <div className="mt-2 flex gap-2">
                        <input aria-label="Response" className={inputCls} value={response} onChange={(x) => setResponse(x.target.value)} placeholder="Your response" />
                        <Button variant="secondary" disabled={response.trim().length < 5} loading={busy === `r${e.id}`} onClick={() => call(`r${e.id}`, () => api.post(`/api/evc/escalations/${e.id}/respond`, { note: response }), 'Response recorded.').then(() => setResponse(''))}>
                          Respond
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Committee" divided />
            <ul className="divide-y divide-slate-100">
              {data.members.map((m: any) => (
                <li key={m.user_id} className={cx('px-5 py-3 text-sm', !m.active && 'text-slate-400')}>
                  <div className="font-medium">{m.full_name}</div>
                  <div className="text-xs text-slate-500">{SEAT_SHORT[m.seat] ?? 'No seat'}{m.organisation ? ` · ${m.organisation}` : ''}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.active ? (
                      <>
                        <Badge t={responsePill(m.response_status).tone}>{responsePill(m.response_status).label}</Badge>
                        {m.attendance !== 'NOT_RECORDED' && <Badge t={m.attendance === 'PRESENT' ? 'green' : 'red'}>{m.attendance.toLowerCase()}</Badge>}
                      </>
                    ) : (
                      <Badge>removed — {m.removed_reason}</Badge>
                    )}
                  </div>
                  {(m.rejection_reason || m.conflict_note) && <div className="mt-1 text-xs text-violet-700">“{m.rejection_reason ?? m.conflict_note}”</div>}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Institution's documents" subtitle="Submitted with the application" divided />
            <ul className="space-y-2 p-5 text-sm">
              {data.documents.length === 0 && <li className="text-slate-500">None.</li>}
              {data.documents.map((d: any) => (
                <li key={d.id}>
                  <a className="inline-flex items-center gap-1.5 text-slate-700 hover:underline" href={`/api/documents/${d.id}/download?inline=1`} target="_blank" rel="noreferrer">
                    <FileText className="h-3.5 w-3.5" /> {d.requirement_id}: {d.file_name}
                  </a>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Deadlines" subtitle="Operational follow-up" divided />
            <ul className="space-y-2 p-5 text-xs">
              {data.deadlines.length === 0 && <li className="text-slate-500">None.</li>}
              {data.deadlines.map((d: any) => (
                <li key={d.subject_type + d.subject_id}>
                  <span className="font-semibold">{d.subject_type.replace(/_/g, ' ').toLowerCase()}</span> · {fmtDateTime(d.due_at)} · <Badge t={d.status === 'MET' ? 'green' : d.status === 'OPEN' ? 'blue' : d.status === 'CANCELLED' ? 'slate' : 'red'}>{d.status.toLowerCase()}</Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Visit history" divided />
            <Timeline items={data.events.slice(0, 12).map((e: any, i: number) => ({ id: `${e.created_at}${i}`, title: e.event.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase()), meta: `${e.actor_name ?? 'System'} · ${fmtDateTime(e.created_at)}`, tone: /MISSED|CONFLICT|CANCEL/.test(e.event) ? 'warn' : 'done' }))} />
          </Card>
        </div>
      </div>
      <PageNote>
        <Link to="/official" className="hover:text-slate-600">Workspace</Link> · Completing a visit or submitting a report never grants approval.
      </PageNote>
    </>
  );
}

const SECTION = {
  docs: {
    title: 'Inspection report documents',
    subtitle: 'The committee’s signed inspection report and supporting papers. They go with the final report to the Regional Officer and the Regulation Bureau, for the Executive Committee.',
    icon: FileText,
    types: [
      { cat: 'INSPECTION_REPORT', label: 'Inspection report (PDF)', accept: '.pdf', hint: 'PDF up to 10 MB' },
      { cat: 'SUPPORTING_DOCUMENT', label: 'Supporting document', accept: '.pdf,.jpg,.jpeg,.png', hint: 'PDF, JPG or PNG up to 10 MB' },
      { cat: 'ATTENDANCE_SHEET', label: 'Attendance sheet', accept: '.pdf,.jpg,.jpeg,.png', hint: 'PDF, JPG or PNG up to 10 MB' },
    ],
  },
  media: {
    title: 'Visit evidence — photos & videos',
    subtitle: 'Photographs and video recordings taken during the inspection.',
    icon: Camera,
    types: [
      { cat: 'VISIT_PHOTO', label: 'Photograph', accept: '.jpg,.jpeg,.png', hint: 'JPG or PNG up to 10 MB' },
      { cat: 'VIDEO_RECORDING', label: 'Video', accept: '.mp4,.mov,.webm', hint: 'MP4, MOV or WebM up to 50 MB' },
      { cat: 'OTHER', label: 'Other evidence', accept: '.pdf,.jpg,.jpeg,.png', hint: 'PDF, JPG or PNG up to 10 MB' },
    ],
  },
} as const;

/** One upload area: report documents, or visit evidence (photos and videos shown in a gallery). */
function UploadSection({ kind, visitId, canUpload, items, onDone }: { kind: 'docs' | 'media'; visitId: string; canUpload: boolean; items: any[]; onDone: (kind: 'success' | 'error', text: string) => void }) {
  const s = SECTION[kind];
  const [cat, setCat] = useState<string>(s.types[0].cat);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const type = s.types.find((t) => t.cat === cat) ?? s.types[0];
  const Icon = s.icon;
  const url = (x: any, inline = false) => `/api/evc/evidence/${x.id}/download${inline ? '?inline=1' : ''}`;
  async function upload() {
    const f = file.current?.files?.[0];
    if (!f) return onDone('error', 'Choose a file first.');
    const fd = new FormData();
    fd.append('category', cat);
    if (note.trim()) fd.append('note', note.trim());
    fd.append('file', f);
    setBusy(true);
    try {
      await api.upload(`/api/evc/visits/${visitId}/evidence`, fd);
      setNote('');
      if (file.current) file.current.value = '';
      onDone('success', `${EVIDENCE_LABEL[cat]} uploaded.`);
    } catch (e: any) {
      onDone('error', e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <span className={cx('rounded-md p-1.5', kind === 'docs' ? 'bg-brand-50 text-brand-600' : 'bg-violet-50 text-violet-600')}>
              <Icon className="h-4 w-4" />
            </span>
            {s.title}
          </span>
        }
        subtitle={s.subtitle}
        action={<Badge t={kind === 'docs' ? 'blue' : 'violet'}>{items.length} file(s)</Badge>}
        divided
      />
      {canUpload && (
        <div className="grid gap-3 border-b border-slate-100 p-5 md:grid-cols-[200px_1fr]">
          <div>
            <Label htmlFor={`cat-${kind}`}>Type</Label>
            <select id={`cat-${kind}`} className={inputCls} value={cat} onChange={(e) => setCat(e.target.value)}>
              {s.types.map((t) => (
                <option key={t.cat} value={t.cat}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor={`file-${kind}`} hint={type.hint}>File</Label>
            <input id={`file-${kind}`} ref={file} key={cat} type="file" accept={type.accept} className={inputCls} />
          </div>
          <input aria-label="Note" className={cx(inputCls, 'md:col-span-2')} placeholder={kind === 'docs' ? 'Note (optional), e.g. signed by all three members' : 'Caption (optional), e.g. Computer lab, block B'} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="md:col-span-2 md:flex md:justify-end">
            <Button className="w-full md:w-auto" loading={busy} onClick={upload}>
              <UploadCloud className="h-4 w-4" /> Upload {type.label.replace(' (PDF)', '').toLowerCase()}
            </Button>
          </div>
        </div>
      )}
      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">{kind === 'docs' ? 'No report documents uploaded yet.' : 'No photos or videos uploaded yet.'}</p>
      ) : kind === 'docs' ? (
        <ul className="divide-y divide-slate-100">
          {items.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="rounded-md bg-slate-100 p-2 text-slate-500"><FileText className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <a className="block truncate font-medium text-brand-600 hover:underline" href={url(x, true)} target="_blank" rel="noreferrer">{x.file_name}</a>
                <div className="text-xs text-slate-500">
                  {EVIDENCE_LABEL[x.category]} · {x.uploaded_by_name} · {fmtDateTime(x.uploaded_at)}
                  {x.note && ` · ${x.note}`}
                </div>
              </div>
              {x.report_id ? <Badge t="green">In final report</Badge> : <Badge t="slate">Not yet submitted</Badge>}
              <a href={url(x)} aria-label={`Download ${x.file_name}`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><Download className="h-4 w-4" /></a>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((x) => (
            <figure key={x.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex aspect-video items-center justify-center bg-slate-900/5">
                {x.mime_type?.startsWith('image/') ? (
                  <a href={url(x, true)} target="_blank" rel="noreferrer" className="block h-full w-full">
                    <img src={url(x, true)} alt={x.note || x.file_name} loading="lazy" className="h-full w-full object-cover" />
                  </a>
                ) : x.mime_type?.startsWith('video/') ? (
                  <video src={url(x, true)} controls preload="metadata" className="h-full w-full bg-black" />
                ) : (
                  <a href={url(x, true)} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-1 text-xs text-slate-500"><FileText className="h-6 w-6" /> Open file</a>
                )}
              </div>
              <figcaption className="px-3 py-2 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-slate-800">
                  {x.mime_type?.startsWith('video/') ? <Film className="h-3.5 w-3.5 text-violet-500" /> : <Camera className="h-3.5 w-3.5 text-violet-500" />}
                  <span className="truncate">{x.note || x.file_name}</span>
                </div>
                <div className="mt-0.5 text-slate-500">{x.uploaded_by_name} · {fmtDateTime(x.uploaded_at)}{x.report_id ? ' · in final report' : ''}</div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Card>
  );
}

/** The member's own recorded unavailability. It blocks new invitations for that period; existing ones stay with the Regional Officer. */
export function Unavailability() {
  const list = useApi<{ unavailability: Array<{ id: string; starts_at: string; ends_at: string; reason: string }> }>('/api/evc/scheduler/unavailability');
  const [day, setDay] = useState('');
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('18:00');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/evc/scheduler/unavailability', { startsAt: fromIST(day, from), endsAt: fromIST(day, to), reason });
      setMsg({ kind: 'success', text: 'Unavailability recorded. You will not be offered for visits in that period.' });
      setReason('');
      list.reload();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  }
  async function withdraw(id: string) {
    setMsg(null);
    try {
      await api.del(`/api/evc/scheduler/unavailability/${id}`);
      list.reload();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    }
  }
  const rows = list.data?.unavailability ?? [];
  return (
    <Card className="mt-6">
      <CardHeader title="My unavailability" subtitle="Periods you cannot take visits (IST)." divided />
      <div className="grid gap-3 p-5 sm:grid-cols-[160px_120px_120px_1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="ud" required>Date</Label>
          <input id="ud" type="date" min={istDay(new Date())} className={inputCls} value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="uf">From</Label>
          <input id="uf" type="time" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="ut">To</Label>
          <input id="ut" type="time" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="ur" required>Reason</Label>
          <input id="ur" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. University examination duty" />
        </div>
        <Button loading={busy} disabled={!day || reason.trim().length < 3 || !(to > from)} onClick={add}>
          Record
        </Button>
      </div>
      {msg && <div className="px-5 pb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      <Table head={['Period (IST)', 'Reason', '']} empty={rows.length === 0 && <p className="px-5 py-4 text-sm text-slate-500">No unavailability recorded.</p>}>
        {rows.map((x) => (
          <tr key={x.id}>
            <td className={`${tdCls} text-[13px] whitespace-nowrap`}>{istLongDate(x.starts_at)}, {istRange(x.starts_at, x.ends_at)}</td>
            <td className={`${tdCls} text-[13px]`}>{x.reason}</td>
            <td className={`${tdCls} text-right`}><TextLink onClick={() => withdraw(x.id)}>Withdraw</TextLink></td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
