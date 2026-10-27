import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Empty, FilterTabs, inputCls, Kpi, KpiRow, Label, Modal, PageHeader, PageNote, Pager, Spinner, Table, tdCls, TextLink, usePaged, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, useApi } from '../../lib/hooks';

const LEVELS = ['VICE_CHANCELLOR', 'DIRECTOR_IIT_NIT', 'PROFESSOR', 'ASSOCIATE_PROFESSOR', 'ASSISTANT_PROFESSOR', 'INDUSTRY_EXPERT', 'ARCHITECT', 'GOVT_TECHNICAL_OFFICER', 'OTHER'];
const DISCIPLINES = ['ENGINEERING_TECHNOLOGY', 'MANAGEMENT', 'PHARMACY', 'ARCHITECTURE', 'PLANNING', 'CIVIL_STRUCTURAL', 'COMPUTER_APPLICATIONS', 'HOTEL_MANAGEMENT', 'APPLIED_ARTS', 'OTHER'];
const ORGS = ['IIT', 'IIM', 'NIT', 'GOVERNMENT', 'GOVERNMENT_AIDED', 'UNIVERSITY', 'PRIVATE', 'INDUSTRY', 'CPWD', 'NBCC', 'DRDO', 'CSIR', 'OTHER'];
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const OUT_TONE: Record<string, Tone> = { PASS: 'green', FAIL: 'red', HUMAN_REVIEW_REQUIRED: 'violet', WARNING: 'amber' };
const SEAT_COLS = [
  ['ACADEMICIAN', 'Academician'],
  ['EXPERT', 'Expert'],
  ['ARCHITECT_PLANNING', 'Architect / Planning'],
] as const;

type Form = Record<string, any>;
const empty: Form = { fullName: '', officialEmail: '', designationLevel: 'PROFESSOR', discipline: 'ENGINEERING_TECHNOLOGY', organisation: '', organisationType: 'GOVERNMENT', panelStatus: 'NEEDS_VERIFICATION' };

export function ExpertRegistry() {
  const { user } = useAuth();
  const role = user?.activeRole ?? '';
  const [filter, setFilter] = useState<'all' | 'NEEDS_VERIFICATION' | 'VERIFIED'>('all');
  const { data, error, loading, reload } = useApi(`/api/evc/experts${filter === 'all' ? '' : `?verification=${filter}`}`);
  const [form, setForm] = useState<Form | null>(null);
  const [verify, setVerify] = useState<any>(null);
  const [vf, setVf] = useState({ status: 'VERIFIED', source: '', panelStatus: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const rows: any[] = data?.experts ?? [];
  const paged = usePaged(rows, 12);
  const canEdit = ['REGIONAL_OFFICER', 'SYSTEM_ADMIN'].includes(role);
  const canVerify = role === 'REGULATION_BUREAU';
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f!, [k]: v }));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const body = { ...form, experienceYears: form!.experienceYears === '' || form!.experienceYears === undefined ? null : Number(form!.experienceYears) };
      delete (body as Form).id;
      if (form!.id) await api.patch(`/api/evc/experts/${form!.id}`, body);
      else await api.post('/api/evc/experts', body);
      setMsg({ kind: 'success', text: form!.id ? 'Record updated — it now needs verification again.' : 'Expert added. A Regulation Bureau officer must verify the qualifications.' });
      setForm(null);
      reload();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.body?.details?.map?.((d: any) => `${d.path}: ${d.message}`).join('; ') || e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'EVC registry']}
        title="EVC expert registry"
        subtitle="Experts available for committee constitution."
        action={canEdit && <Button onClick={() => setForm({ ...empty })}><Plus className="h-4 w-4" /> Add expert</Button>}
      />
      {data && <div className="mb-6"><Alert kind="info" title="Operational procedure">{data.note}</Alert></div>}
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <KpiRow>
            <Kpi label="Active experts" value={rows.filter((r) => r.active).length} caption="In this view" />
            <Kpi label="Verified" value={rows.filter((r) => r.verification_status === 'VERIFIED').length} tone="green" caption="Qualifications verified" />
            <Kpi label="Needs verification" value={rows.filter((r) => r.verification_status === 'NEEDS_VERIFICATION').length} tone="amber" caption="Cannot fill a seat yet" />
            <Kpi label="Demonstration records" value={rows.filter((r) => r.is_demo).length} caption="Sample data, not a real panel" />
          </KpiRow>
          <Card>
            <CardHeader title="Experts" action={<FilterTabs value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All' }, { value: 'NEEDS_VERIFICATION', label: 'Needs verification' }, { value: 'VERIFIED', label: 'Verified' }]} />} />
            <Table head={['Expert', 'Qualification', 'Panel & verification', ...SEAT_COLS.map(([, l]) => l), '']} empty={rows.length === 0 && <Empty title="No experts" />}>
              {paged.slice.map((e) => (
                <tr key={e.id} className={e.active ? '' : 'text-slate-400'}>
                  <td className={tdCls}>
                    <div className="min-w-[180px] font-medium text-slate-900">{e.full_name}</div>
                    <div className="text-xs text-slate-500">{e.member_code}{e.is_demo ? ' · demo' : ''} · {e.login_id ?? 'no login linked'}</div>
                    <div className="text-xs text-slate-400">{e.assignments} visit(s) · {e.reports} report(s)</div>
                  </td>
                  <td className={tdCls}>
                    <div className="text-[13px]">{human(e.designation_level)} · {human(e.discipline)}</div>
                    <div className="max-w-[200px] truncate text-xs text-slate-500">{e.organisation} ({e.organisation_type}){e.experience_years !== null ? ` · ${e.experience_years} yrs` : ''}</div>
                  </td>
                  <td className={tdCls}>
                    <div className="flex flex-col items-start gap-1">
                      <Badge t={e.panel_status === 'ON_APPROVED_PANEL' ? 'green' : e.panel_status === 'NOT_ON_PANEL' ? 'slate' : 'amber'}>{human(e.panel_status)}</Badge>
                      <Badge t={e.verification_status === 'VERIFIED' ? 'green' : e.verification_status === 'REJECTED' ? 'red' : 'amber'}>{human(e.verification_status)}</Badge>
                    </div>
                    {e.verified_by_name && <div className="mt-0.5 text-[11px] text-slate-500">{e.verified_by_name}</div>}
                  </td>
                  {SEAT_COLS.map(([s]) => {
                    const el = e.seatEligibility[s];
                    return (
                      <td key={s} className={tdCls} title={el.reasons.join(' ')}>
                        <Badge t={OUT_TONE[el.outcome] ?? 'slate'}>{el.outcome === 'PASS' ? 'Eligible' : el.outcome === 'FAIL' ? 'Not eligible' : 'Review'}</Badge>
                      </td>
                    );
                  })}
                  <td className={`${tdCls} text-right whitespace-nowrap`}>
                    {canEdit && (
                      <TextLink
                        onClick={() =>
                          setForm({
                            id: e.id,
                            fullName: e.full_name,
                            officialEmail: e.official_email,
                            phone: e.phone ?? '',
                            designationLevel: e.designation_level,
                            discipline: e.discipline,
                            specialisation: e.specialisation ?? '',
                            organisation: e.organisation,
                            organisationType: e.organisation_type,
                            experienceYears: e.experience_years ?? '',
                            coaRegistrationNo: e.coa_registration_no ?? '',
                            panelStatus: e.panel_status,
                            panelReference: e.panel_reference ?? '',
                            loginId: e.login_id ?? '',
                          })
                        }
                      >
                        Edit
                      </TextLink>
                    )}
                    {canVerify && (
                      <TextLink className="ml-3" onClick={() => { setVerify(e); setVf({ status: 'VERIFIED', source: '', panelStatus: '' }); }}>
                        Verify
                      </TextLink>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            <Pager {...paged} shown={paged.slice.length} noun="experts" />
          </Card>
        </>
      )}
      <PageNote>Hover an eligibility badge for the reason. Editing a record always returns it to “needs verification”.</PageNote>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit expert' : 'Add expert'} wide>
        {form && (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label required>Full name</Label><input className={inputCls} value={form.fullName} onChange={(e) => set('fullName', e.target.value)} /></div>
              <div><Label required>Official email</Label><input className={inputCls} value={form.officialEmail} onChange={(e) => set('officialEmail', e.target.value)} /></div>
              <div><Label required>Designation level</Label><select className={inputCls} value={form.designationLevel} onChange={(e) => set('designationLevel', e.target.value)}>{LEVELS.map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></div>
              <div><Label required>Discipline</Label><select className={inputCls} value={form.discipline} onChange={(e) => set('discipline', e.target.value)}>{DISCIPLINES.map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></div>
              <div><Label required>Organisation</Label><input className={inputCls} value={form.organisation} onChange={(e) => set('organisation', e.target.value)} /></div>
              <div><Label required>Organisation type</Label><select className={inputCls} value={form.organisationType} onChange={(e) => set('organisationType', e.target.value)}>{ORGS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
              <div><Label>Specialisation</Label><input className={inputCls} value={form.specialisation ?? ''} onChange={(e) => set('specialisation', e.target.value)} /></div>
              <div><Label>Experience (years)</Label><input type="number" className={inputCls} value={form.experienceYears ?? ''} onChange={(e) => set('experienceYears', e.target.value)} /></div>
              <div><Label>Council of Architecture registration no.</Label><input className={inputCls} value={form.coaRegistrationNo ?? ''} onChange={(e) => set('coaRegistrationNo', e.target.value)} /></div>
              <div><Label>Panel status (as claimed)</Label><select className={inputCls} value={form.panelStatus} onChange={(e) => set('panelStatus', e.target.value)}>{['NEEDS_VERIFICATION', 'ON_APPROVED_PANEL', 'NOT_ON_PANEL'].map((x) => <option key={x} value={x}>{human(x)}</option>)}</select></div>
              <div><Label>Panel reference</Label><input className={inputCls} value={form.panelReference ?? ''} onChange={(e) => set('panelReference', e.target.value)} /></div>
              <div><Label>EVC member login ID (to link an account)</Label><input className={inputCls} value={form.loginId ?? ''} onChange={(e) => set('loginId', e.target.value)} /></div>
            </div>
            <Alert kind="info">Saving sends the record for verification by a Regulation Bureau officer. Unverified records cannot fill a committee seat.</Alert>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button loading={busy} onClick={save}>Save</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!verify} onClose={() => setVerify(null)} title="Record verification">
        {verify && (
          <div className="space-y-3 text-sm">
            <div className="font-semibold">{verify.full_name} <span className="font-normal text-slate-500">· {verify.member_code}</span></div>
            <div><Label required>Outcome</Label><select className={inputCls} value={vf.status} onChange={(e) => setVf({ ...vf, status: e.target.value })}><option value="VERIFIED">Verified</option><option value="REJECTED">Rejected</option></select></div>
            <div><Label>Panel status confirmed</Label><select className={inputCls} value={vf.panelStatus} onChange={(e) => setVf({ ...vf, panelStatus: e.target.value })}><option value="">Unchanged ({human(verify.panel_status)})</option><option value="ON_APPROVED_PANEL">On approved panel</option><option value="NOT_ON_PANEL">Not on panel</option></select></div>
            <div><Label required>Verification source</Label><textarea rows={3} className={inputCls} value={vf.source} onChange={(e) => setVf({ ...vf, source: e.target.value })} placeholder="What was checked and where (e.g. EC panel list reference, institution records)" /></div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setVerify(null)}>Cancel</Button>
              <Button
                loading={busy}
                disabled={vf.source.trim().length < 5}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.post(`/api/evc/experts/${verify.id}/verify`, { status: vf.status, source: vf.source.trim(), panelStatus: vf.panelStatus || undefined });
                    setMsg({ kind: 'success', text: `Verification recorded for ${verify.full_name}.` });
                    setVerify(null);
                    reload();
                  } catch (e: any) {
                    setMsg({ kind: 'error', text: e.message });
                    setVerify(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Record
              </Button>
            </div>
            {verify.verified_at && <p className="text-xs text-slate-500">Last verified {fmtDateTime(verify.verified_at)}.</p>}
          </div>
        )}
      </Modal>
    </>
  );
}
