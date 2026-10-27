import { AlertTriangle, CalendarCheck, ClipboardCheck, Gavel, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Empty, FilterTabs, inputCls, Kpi, KpiRow, KV, Label, Modal, PageHeader, Pager, Spinner, Table, Tabs, tdCls, TextLink, usePaged, type Tone } from '../components/ui';
import { AppealPanel, DEF_TONE, DecisionCard } from '../components/Workflow';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCategories } from '../lib/categories';
import { daysUntil, fmtDate, fmtDateTime, useApi } from '../lib/hooks';

// ------------------------------------------------------------------ Deficiencies
export function Deficiencies() {
  const { data, error, loading } = useApi('/api/deficiencies');
  const cats = useCategories();
  const nav = useNavigate();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const all = data?.deficiencies ?? [];
  const attention = (d: any) => ['OPEN', 'UNRESOLVED', 'RESPONDED'].includes(d.status);
  const rows = all.filter((d: any) => filter === 'all' || attention(d));
  const n = (s: string) => all.filter((d: any) => d.status === s).length;
  const paged = usePaged(rows, 10);
  const inCorrection = (d: any) => ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'].includes(d.application_status);
  return (
    <>
      <PageHeader crumbs={['Workspace', 'Corrections']} title="Correction notices" subtitle="Respond to each item, then submit the correction package." />
      {loading && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Needs response" value={n('OPEN')} tone={n('OPEN') ? 'amber' : 'default'} caption="Open notice items" />
            <Kpi label="Response saved" value={n('RESPONDED')} tone="blue" caption="Awaiting package submission or re-scrutiny" />
            <Kpi label="Unresolved after re-scrutiny" value={n('UNRESOLVED') + n('PARTIALLY_RESOLVED')} tone={n('UNRESOLVED') ? 'red' : 'default'} caption="Further correction may follow" />
            <Kpi label="Resolved" value={n('RESOLVED')} tone="green" caption="Accepted by re-scrutiny" />
          </KpiRow>
          <Card>
            <CardHeader
              title="Notice items"
              subtitle="Across all of your applications"
              action={<FilterTabs value={filter} onChange={(v) => { setFilter(v); paged.setPage(1); }} items={[{ value: 'open', label: 'Needs attention', count: all.filter(attention).length }, { value: 'all', label: 'All', count: all.length }]} />}
            />
            <Table head={['Application', 'Item', 'Category', 'Raised', 'Respond by', 'Status', '']} empty={rows.length === 0 && <Empty icon={<AlertTriangle className="h-5 w-5" />} title="Nothing to correct">No notice item needs your attention right now.</Empty>}>
              {paged.slice.map((d: any) => (
                <tr key={d.id} className="hover:bg-slate-50/70">
                  <td className={tdCls}>
                    <div className="font-mono text-[13px] font-semibold text-brand-600">{d.application_ref}</div>
                    <div className="max-w-[180px] truncate text-xs text-slate-500">{cats?.find((c) => c.code === d.category_code)?.shortTitle}</div>
                  </td>
                  <td className={tdCls}>
                    <div className="max-w-[280px] truncate font-medium">{d.target_label}</div>
                    <div className="max-w-[280px] truncate text-xs text-slate-500">{d.explanation}</div>
                  </td>
                  <td className={`${tdCls} text-[13px] text-slate-600`}>{d.category.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase())}</td>
                  <td className={`${tdCls} text-[13px] whitespace-nowrap text-slate-600`}>{fmtDate(d.raised_at)}</td>
                  <td className={`${tdCls} text-[13px] whitespace-nowrap text-slate-600`}>{d.deadline ? fmtDate(d.deadline) : 'Not configured'}</td>
                  <td className={tdCls}><Badge t={DEF_TONE[d.status]}>{({ OPEN: 'Needs response', RESPONDED: 'Response saved', RESOLVED: 'Resolved', UNRESOLVED: 'Unresolved', PARTIALLY_RESOLVED: 'Partially resolved' } as Record<string, string>)[d.status] ?? d.status}</Badge></td>
                  <td className={`${tdCls} text-right`}>
                    <TextLink onClick={() => nav(inCorrection(d) ? `/applications/${d.application_id}/respond` : `/applications/${d.application_id}`)}>{inCorrection(d) ? 'Respond' : 'Open'}</TextLink>
                  </td>
                </tr>
              ))}
            </Table>
            <Pager {...paged} shown={paged.slice.length} noun="items" />
          </Card>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ EVC
export function EvcVisits() {
  const { data, error, loading, reload } = useApi('/api/evc-visits');
  const cats = useCategories();
  const [links, setLinks] = useState<Record<string, string>>({});
  const [vmsg, setVmsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  return (
    <>
      <PageHeader crumbs={["Workspace", "EVC schedule"]} title="EVC visits" subtitle="Expert Visit Committee schedules and reports for your applications." />
      {vmsg && <div className="mb-4"><Alert kind={vmsg.kind}>{vmsg.text}</Alert></div>}
      {loading && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && data.visits.length === 0 && (
        <Card>
          <Empty icon={<CalendarCheck className="h-5 w-5" />} title="No EVC visits">Visits appear once a Regional Officer schedules an EVC for an application whose route includes one.</Empty>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.visits.map((v: any) => {
          const d = new Date(v.scheduled_start);
          const left = daysUntil(v.scheduled_start);
          return (
            <Card key={v.id} className="p-5">
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                  <span className="text-[10px] font-semibold uppercase">{d.toLocaleString('en-IN', { month: 'short' })}</span>
                  <span className="text-xl leading-none font-semibold">{d.getDate()}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/applications/${v.application_id}`} className="font-mono text-sm font-semibold text-brand-700">{v.reference_no}</Link>
                    <Badge t="blue">{v.mode.toLowerCase()}</Badge>
                    <Badge t={v.status === 'CANCELLED' ? 'red' : v.status === 'COMPLETED' ? 'green' : 'amber'}>{v.status.toLowerCase()}</Badge>
                    {left !== null && left >= 0 && ['SCHEDULED', 'RESCHEDULED'].includes(v.status) && <span className="text-xs text-slate-500">in {left} day(s)</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">{cats?.find((c) => c.code === v.category_code)?.title}</div>
                  <div className="mt-1 text-sm font-semibold">{fmtDateTime(v.scheduled_start)}</div>
                </div>
              </div>
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                {v.location && <KV k="Location" v={v.location} />}
                {v.meeting_link && <KV k="Online meeting" v={<a className="break-all text-brand-600 underline" href={v.meeting_link} target="_blank" rel="noreferrer noopener">{v.meeting_link}</a>} />}
                {v.agenda && <KV k="Agenda" v={v.agenda} />}
                {v.prepare_items && <KV k="Documents & evidence to prepare" v={v.prepare_items} />}
                {v.instructions && <KV k="Instructions" v={v.instructions} />}
                {v.committee_disclosure && <KV k="Committee information" v={v.committee_disclosure} />}
                {v.status_note && <KV k="Rescheduling / cancellation note" v={v.status_note} />}
                <KV k="Scheduled on" v={fmtDateTime(v.scheduled_at)} />
              </div>
              {!['CANCELLED'].includes(v.status) && (
                <div className="mt-4 rounded-lg border border-slate-200 p-3">
                  <div className="text-[13px] font-semibold text-slate-900">Video link of the facilities / visit proceedings</div>
                  <p className="mt-0.5 text-xs text-slate-500">Upload the video (not less than 30 minutes) on the Trust / Society website and share the link here.</p>
                  {v.institution_video_link && <p className="mt-1 text-xs break-all text-emerald-700">Shared: {v.institution_video_link}</p>}
                  <div className="mt-2 flex gap-2">
                    <input aria-label="Video link" className={inputCls} placeholder="https://" value={links[v.id] ?? ''} onChange={(e) => setLinks({ ...links, [v.id]: e.target.value })} />
                    <Button
                      variant="secondary"
                      disabled={!(links[v.id] ?? '').startsWith('https://')}
                      onClick={async () => {
                        try {
                          await api.post(`/api/evc-visits/${v.id}/video-link`, { url: links[v.id] });
                          setVmsg({ kind: 'success', text: 'Video link shared with the committee.' });
                          setLinks({ ...links, [v.id]: '' });
                          reload();
                        } catch (e: any) {
                          setVmsg({ kind: 'error', text: e.message });
                        }
                      }}
                    >
                      Share link
                    </Button>
                  </div>
                </div>
              )}
              {v.reports.map((r: any) => (
                <div key={r.id} className="mt-4 rounded-lg bg-emerald-50/60 p-3 text-sm">
                  <div className="font-semibold">Report v{r.version} · {fmtDateTime(r.submitted_at)}</div>
                  <div className="text-slate-700">{r.recommendation}</div>
                </div>
              ))}
            </Card>
          );
        })}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Decisions & appeals
export function Decisions() {
  const { data, error, loading, reload } = useApi('/api/decisions');
  const appeals = useApi('/api/appeals');
  const [tab, setTab] = useState<'decisions' | 'appeals'>('decisions');
  return (
    <>
      <PageHeader crumbs={["Workspace", "Decisions"]} title="Decisions & appeals" subtitle="Decisions on your applications and their appeal status." />
      <Card>
        <div className="px-5 pt-2">
          <Tabs value={tab} onChange={setTab} items={[{ value: 'decisions', label: 'Decisions' }, { value: 'appeals', label: `Appeals${appeals.data?.appeals.length ? ` (${appeals.data.appeals.length})` : ''}` }]} />
        </div>
        <div className="p-5">
          {tab === 'decisions' && (
            <>
              {loading && <Spinner />}
              {error && <Alert kind="error">{error}</Alert>}
              {data?.decisions.length === 0 && <Empty icon={<Gavel className="h-5 w-5" />} title="No decisions yet">Decisions (LoA / EoA / LoD / LoR) appear here once issued.</Empty>}
              <div className="space-y-6">
                {data?.decisions.map((d: any) => (
                  <div key={d.id}>
                    <Link to={`/applications/${d.application_id}`} className="mb-2 inline-block font-mono text-sm font-semibold text-brand-700">{d.application_ref}</Link>
                    <DecisionCard d={d} />
                    {!d.is_appeal_outcome && (
                      <div className="mt-3">
                        <AppealPanel
                          appId={d.application_id}
                          eligibility={d.appealEligibility}
                          appeal={appeals.data?.appeals.find((p: any) => p.decision_id === d.id)}
                          onFiled={() => {
                            reload();
                            appeals.reload();
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {tab === 'appeals' && (
            <Table head={['Appeal', 'Application', 'Decision', 'Decision uploaded', 'Submitted', 'Deadline', 'SAC outcome', 'Status']} empty={appeals.data?.appeals.length === 0 && <Empty title="No appeals filed" />}>
              {appeals.data?.appeals.map((p: any) => (
                <tr key={p.id}>
                  <td className="px-5 py-3 font-mono text-xs font-semibold">{p.reference_no}</td>
                  <td className="px-5 py-3"><Link className="font-mono text-xs text-brand-700" to={`/applications/${p.application_id}`}>{p.application_ref}</Link></td>
                  <td className="px-5 py-3 text-xs">{p.decision_type} {p.decision_ref}</td>
                  <td className="px-5 py-3 text-xs whitespace-nowrap">{fmtDateTime(p.decision_uploaded_at)}</td>
                  <td className="px-5 py-3 text-xs whitespace-nowrap">{fmtDateTime(p.submitted_at)}</td>
                  <td className="px-5 py-3 text-xs whitespace-nowrap">{fmtDateTime(p.deadline_at)}</td>
                  <td className="px-5 py-3 text-xs">{p.sac_outcome?.replace(/_/g, ' ').toLowerCase() ?? '—'}</td>
                  <td className="px-5 py-3"><Badge t="violet">{p.status.replace(/_/g, ' ').toLowerCase()}</Badge></td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ Compliance
export function Compliance() {
  const { data, error, loading, reload } = useApi('/api/compliance');
  const validity = useApi('/api/document-validity');
  const [tab, setTab] = useState<'obligations' | 'validity'>('obligations');
  const [target, setTarget] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const STATE: Record<string, [string, Tone]> = {
    NOT_YET_DUE: ['Not yet due', 'green'],
    DUE_SOON: ['Due soon', 'amber'],
    OVERDUE: ['Overdue', 'red'],
    NO_FIXED_DATE: ['Open — no fixed date', 'slate'],
    SUBMITTED: ['Submitted — awaiting review', 'blue'],
    UNDER_REVIEW: ['Under review', 'blue'],
    ACCEPTED_BY_AUTHORISED_REVIEWER: ['Accepted by authorised reviewer', 'green'],
    DEFICIENT: ['Deficient — resubmit', 'red'],
    HUMAN_REVIEW_REQUIRED: ['Further review', 'violet'],
  };
  const VALIDITY: Record<string, [string, Tone]> = {
    VALID: ['Valid', 'green'],
    EXPIRING_SOON: ['Expiring soon', 'amber'],
    EXPIRED: ['Expired', 'red'],
    UNABLE_TO_VERIFY: ['Unable to verify', 'violet'],
    NEEDS_VERIFICATION: ['No validity rule established', 'slate'],
    NOT_APPLICABLE: ['Not an expiry requirement', 'slate'],
  };
  const obls: any[] = data?.obligations ?? [];
  const docs: any[] = validity.data?.documents ?? [];
  const cnt = (s: string[]) => obls.filter((o) => s.includes(o.displayStatus)).length;
  return (
    <>
      <PageHeader crumbs={['Workspace', 'Compliance']} title="Compliance & undertakings" subtitle="Your obligations, undertakings and document validity." />
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Overdue" value={cnt(['OVERDUE'])} tone={cnt(['OVERDUE']) ? 'red' : 'default'} caption="Past the due date" />
            <Kpi label="Due soon" value={cnt(['DUE_SOON'])} tone="amber" caption={`Within ${data.dueSoonDays} days`} />
            <Kpi label="Awaiting review" value={cnt(['SUBMITTED', 'UNDER_REVIEW', 'HUMAN_REVIEW_REQUIRED'])} tone="blue" caption="Submitted evidence" />
            <Kpi label="Document alerts" value={docs.filter((d) => ['EXPIRED', 'EXPIRING_SOON'].includes(d.status)).length} tone={docs.some((d) => d.status === 'EXPIRED') ? 'red' : 'default'} caption={`Expired or expiring within ${validity.data?.alertDays ?? '—'} days`} />
          </KpiRow>
          <Card>
            <div className="px-5">
              <Tabs value={tab} onChange={setTab} items={[{ value: 'obligations', label: `Obligations & undertakings (${obls.length})` }, { value: 'validity', label: `Document validity (${docs.length})` }]} />
            </div>
            {tab === 'obligations' && (
              <Table head={['Item', 'Application', 'Due date', 'Status', '']} empty={obls.length === 0 && <Empty icon={<ClipboardCheck className="h-5 w-5" />} title="No compliance obligations">Obligations appear when a regulatory provision creates one (e.g. Security Deposit within 15 days, enrolment upload before 30 November).</Empty>}>
                {obls.map((o) => {
                  const [label, t] = STATE[o.displayStatus] ?? [o.displayStatus, 'slate'];
                  const lastReview = o.reviews?.[0];
                  return (
                    <tr key={o.id} className="align-top">
                      <td className={tdCls}>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{o.title}</span>
                          {o.kind === 'UNDERTAKING' && <Badge t="violet">Undertaking</Badge>}
                        </div>
                        <div className="mt-0.5 max-w-xl text-xs text-slate-500">{o.description}</div>
                        {o.submissions?.length > 0 && <div className="mt-1 text-xs text-slate-600">Latest evidence: v{o.submissions[0].version} · {o.submissions[0].fileName} · {fmtDateTime(o.submissions[0].submittedAt)}</div>}
                        {lastReview && <div className="mt-0.5 text-xs text-slate-600">Reviewer: {lastReview.note}</div>}
                      </td>
                      <td className={`${tdCls} font-mono text-xs`}>{o.reference_no ?? '—'}</td>
                      <td className={`${tdCls} text-xs whitespace-nowrap`}>{o.due_date ? fmtDate(o.due_date) : 'No date stated'}</td>
                      <td className={tdCls}><Badge t={t}>{label}</Badge></td>
                      <td className={tdCls}>
                        {!['ACCEPTED_BY_AUTHORISED_REVIEWER', 'UNDER_REVIEW'].includes(o.status) && (
                          <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => { setTarget(o); setFile(null); setNote(''); }}>
                            <Upload className="h-3.5 w-3.5" /> {o.status === 'OPEN' ? 'Submit evidence' : 'Submit new version'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
            {tab === 'validity' && (
              <>
                <div className="px-5 pt-4"><Alert kind="info">Validity is calculated only where a verified rule establishes it. Alerts are sent {validity.data?.alertDays ?? '—'} days before a recorded expiry ({validity.data?.policy?.status === 'AUTHORISED' ? 'authorised' : 'demonstration'} operational setting).</Alert></div>
                <Table className="mt-4" head={['Document', 'Application', 'Expires on', 'Days left', 'Status', 'Basis']} empty={docs.length === 0 && <Empty title="No documents uploaded" />}>
                  {docs.map((d) => {
                    const [label, t] = VALIDITY[d.status] ?? [d.status, 'slate'];
                    return (
                      <tr key={d.documentId} className="align-top">
                        <td className={tdCls}><div className="max-w-[280px] font-medium">{d.name}</div><div className="text-xs text-slate-500">{d.fileName} · v{d.version}</div></td>
                        <td className={`${tdCls} font-mono text-xs`}>{d.referenceNo ?? 'Draft'}</td>
                        <td className={`${tdCls} text-xs whitespace-nowrap`}>{d.expiresOn ? fmtDate(d.expiresOn) : '—'}</td>
                        <td className={`${tdCls} num text-xs`}>{d.daysRemaining ?? '—'}</td>
                        <td className={tdCls}><Badge t={t}>{label}</Badge></td>
                        <td className={`${tdCls} max-w-[320px] text-xs text-slate-500`}>{d.basis}</td>
                      </tr>
                    );
                  })}
                </Table>
              </>
            )}
          </Card>
        </>
      )}
      <Modal open={!!target} onClose={() => setTarget(null)} title="Submit compliance evidence">
        <div className="space-y-3 text-sm">
          <div className="font-semibold">{target?.title}</div>
          <div>
            <Label htmlFor="cf" required>Evidence file</Label>
            <input id="cf" type="file" accept=".pdf,.jpg,.jpeg,.png" className={inputCls} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <div>
            <Label htmlFor="cn">Note</Label>
            <textarea id="cn" rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button>
            <Button
              disabled={!file}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const fd = new FormData();
                fd.append('file', file!);
                if (note) fd.append('note', note);
                try {
                  await api.upload(`/api/compliance/${target.id}/evidence`, fd);
                  setMsg({ kind: 'success', text: 'Evidence submitted for review.' });
                  setTarget(null);
                  reload();
                } catch (e: any) {
                  setMsg({ kind: 'error', text: e.message });
                  setTarget(null);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Submit
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ Notifications
export { Notifications } from './NotificationCentre';
