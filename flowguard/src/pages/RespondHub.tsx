import { ArrowRight, CheckCircle2, ClipboardList } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Empty, PageHeader, PageNote, Spinner } from '../components/ui';
import { fmtDate, useApi } from '../lib/hooks';

/** "Respond to notice": opens the guided response for the open notice, or lets the institution pick one. */
export default function RespondHub() {
  const nav = useNavigate();
  const { data, error, loading } = useApi<any>('/api/deficiencies');
  if (loading && !data) return <Spinner />;
  if (error) return <Alert kind="error">{error}</Alert>;
  const items: any[] = (data?.deficiencies ?? []).filter((d: any) => ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'].includes(d.application_status) && !['DRAFT', 'WITHDRAWN'].includes(d.status));
  const apps = Object.values(
    items.reduce<Record<string, any>>((m, d) => {
      const a = (m[d.application_id] ??= { id: d.application_id, ref: d.application_ref, total: 0, prepared: 0, due: null as string | null });
      a.total += 1;
      if (d.status !== 'OPEN') a.prepared += 1;
      if (d.deadline && (!a.due || d.deadline < a.due)) a.due = d.deadline;
      return m;
    }, {}),
  );
  if (apps.length === 1) return <Navigate to={`/applications/${apps[0].id}/respond`} replace />;
  return (
    <>
      <PageHeader crumbs={['Actions', 'Respond to notice']} title="Respond to deficiency notice" subtitle="Choose the notice you are responding to." />
      <Card>
        <CardHeader title="Open notices" divided />
        {apps.length === 0 ? (
          <Empty icon={<CheckCircle2 className="h-5 w-5" />} title="No notice needs a response">When an official issues a deficiency notice, you respond to it here.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {apps.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><ClipboardList className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-semibold text-brand-700">{a.ref}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-slate-600">
                    <span>{a.prepared} of {a.total} responses prepared</span>
                    {a.due && <span>Respond by {fmtDate(a.due)}</span>}
                  </div>
                  <div className="mt-2 h-1.5 w-48 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-brand-700" style={{ width: `${(a.prepared / a.total) * 100}%` }} /></div>
                </div>
                <Badge t={a.prepared === a.total ? 'slate' : 'amber'}>{a.prepared === a.total ? 'Ready to submit' : 'In progress'}</Badge>
                <Button onClick={() => nav(`/applications/${a.id}/respond`)}>Continue <ArrowRight className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <PageNote>Responding does not approve the application; it sends your corrections for re-scrutiny.</PageNote>
    </>
  );
}
