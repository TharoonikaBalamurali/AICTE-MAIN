import { ShieldAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, inputCls, Label, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { fmtDateTime, useApi } from '../lib/hooks';

const FIELDS: Array<{ k: string; label: string; required?: boolean; type?: string; full?: boolean; hint?: string }> = [
  { k: 'name', label: 'Institution name', required: true, full: true },
  { k: 'address', label: 'Institution address', required: true, full: true },
  { k: 'state', label: 'State / UT', required: true },
  { k: 'district', label: 'District', required: true },
  { k: 'pincode', label: 'PIN code', required: true, hint: '6 digits' },
  { k: 'official_email', label: 'Official email', required: true, type: 'email' },
  { k: 'applicant_name', label: 'Applicant / filing official name', required: true },
  { k: 'applicant_designation', label: 'Applicant designation', required: true },
  { k: 'legal_entity_name', label: 'Applicant legal entity (Trust / Society / Company) name' },
  { k: 'legal_entity_reg_no', label: 'Legal entity registration number' },
  { k: 'signatory_name', label: 'Authorised signatory name' },
  { k: 'signatory_designation', label: 'Authorised signatory designation' },
];

export default function Profile() {
  const { data, error, loading, setData } = useApi('/api/institution/profile');
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string; details?: string[] } | null>(null);
  useEffect(() => {
    if (data?.institution) setForm(Object.fromEntries(Object.entries(data.institution).map(([k, v]) => [k, v === null ? '' : String(v)])));
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const body: Record<string, unknown> = {};
    for (const f of FIELDS) body[f.k] = form[f.k]?.trim() || (f.required ? '' : null);
    body.legal_entity_type = form.legal_entity_type || null;
    try {
      const r = await api.put('/api/institution/profile', body);
      setData(r);
      setMsg({ kind: 'success', text: 'Profile saved. New applications will use this information.' });
    } catch (err: any) {
      setMsg({ kind: 'error', text: err.message, details: err.body?.details?.map((d: any) => `${d.path}: ${d.message}`) });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <Alert kind="error">{error}</Alert>;
  const inst = data.institution;
  return (
    <>
      <PageHeader crumbs={["Account", "Profile"]} title="Institution profile" subtitle="Used to pre-populate and snapshot every application at submission." />
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Card className="p-6 sm:p-8">
          <form onSubmit={save} className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>College ID / Institution ID</Label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">{inst.aicte_institution_id}</span>
                <Badge t={inst.id_verification_status === 'VERIFIED' ? 'green' : 'amber'}>{inst.id_verification_status.toLowerCase()}</Badge>
                {inst.is_demo && <Badge>demo institution</Badge>}
              </div>
              <p className="mt-1 text-xs text-slate-500">Assigned to your account by the administrator. This portal has no connection to the official AICTE portal, so it cannot verify this ID and shows it as unverified.</p>
            </div>
            {FIELDS.map((f) => (
              <div key={f.k} className={f.full ? 'sm:col-span-2' : ''}>
                <Label htmlFor={f.k} required={f.required} hint={f.hint}>{f.label}</Label>
                {f.k === 'address' ? (
                  <textarea id={f.k} rows={2} className={inputCls} value={form[f.k] ?? ''} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })} />
                ) : (
                  <input id={f.k} type={f.type ?? 'text'} className={inputCls} value={form[f.k] ?? ''} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })} />
                )}
              </div>
            ))}
            <div>
              <Label htmlFor="let">Legal entity type</Label>
              <select id="let" className={inputCls} value={form.legal_entity_type ?? ''} onChange={(e) => setForm({ ...form, legal_entity_type: e.target.value })}>
                <option value="">Select…</option>
                <option value="TRUST">Trust</option>
                <option value="SOCIETY">Society</option>
                <option value="SECTION_8_COMPANY">Section 8 Company</option>
                <option value="GOVERNMENT">Government</option>
                <option value="PPP_BOT">PPP / BOT</option>
              </select>
            </div>
            {msg && (
              <div className="sm:col-span-2">
                <Alert kind={msg.kind}>
                  {msg.text}
                  {msg.details && <ul className="mt-1 list-disc pl-4">{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </Alert>
              </div>
            )}
            <div className="flex items-center justify-between sm:col-span-2">
              <span className="text-xs text-slate-400">Last updated {fmtDateTime(inst.updated_at)}</span>
              <Button type="submit" loading={busy}>Save profile</Button>
            </div>
          </form>
        </Card>
        <Card className="h-fit p-5">
          <ShieldAlert className="h-5 w-5 text-brand-600" />
          <h3 className="mt-2 font-semibold">How this is used</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-sm text-slate-600">
            <li>Address, official email, applicant name and designation are required before final submission.</li>
            <li>A snapshot is stored with each submitted application, so later edits do not change past submissions.</li>
            <li>Only members of this institution can see its data; every request is checked on the server.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
