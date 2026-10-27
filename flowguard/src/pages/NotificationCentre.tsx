import { ArrowUpRight, Bell, CheckCheck, Clock, FileText, Repeat, ShieldCheck, UserCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, PageHeader, PageNote, Pager, Spinner, Tabs, usePaged } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, useApi } from '../lib/hooks';
import { WORKSPACE_NAME } from '../lib/roles';

/** One inbox for every role: grouped by kind, with a details panel and workspace switching. */
type Kind = 'REMINDER' | 'ASSIGNMENT' | 'UPDATE';
const kindOf = (eventType: string): Kind =>
  /REMINDER|OVERDUE|DEADLINE|_DUE$|ESCALATION|FOLLOW_UP|EXPLANATION/.test(eventType)
    ? 'REMINDER'
    : /ASSIGNED|STAGE_READY|AWAITING|HANDOFF|RESCRUTINY_EXPECTED|COMMITTEE_SUBMISSION$|VERIFICATION_REQUESTED|APPEAL_SUBMITTED|REOPEN_REQUEST|COMPLIANCE_EVIDENCE$|INSPECTION_UPDATE/.test(eventType)
      ? 'ASSIGNMENT'
      : 'UPDATE';
const KIND: Record<Kind, { label: string; icon: typeof Clock; note: string }> = {
  REMINDER: { label: 'Reminder', icon: Clock, note: 'Operational reminder — it does not change the application or issue a notice.' },
  ASSIGNMENT: { label: 'Assignment', icon: UserCheck, note: 'Work routed to you or your role.' },
  UPDATE: { label: 'Application update', icon: FileText, note: 'A recorded change on an application you can see.' },
};
const COMMITTEE = ['EC_OFFICIAL', 'SHC_MEMBER', 'SAC_MEMBER', 'COUNCIL_OFFICIAL'];

export function Notifications() {
  const { data, error, loading, reload, setData } = useApi<any>('/api/notifications');
  const { user, switchRole } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'all' | 'unread' | Kind>('all');
  const [selId, setSelId] = useState<string | null>(null);
  const role = user?.activeRole ?? '';
  const institution = role === 'INSTITUTION_APPLICANT';
  const all: any[] = useMemo(() => (data?.notifications ?? []).map((n: any) => ({ ...n, kind: kindOf(n.event_type) })), [data]);
  const shown = all.filter((n) => (tab === 'all' ? true : tab === 'unread' ? !n.read_at : n.kind === tab));
  const paged = usePaged(shown, 8);
  const sel = all.find((n) => n.id === selId) ?? paged.slice[0] ?? null;
  useEffect(() => paged.setPage(1), [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = (n: any) => (!n.application_id ? null : institution ? `/applications/${n.application_id}` : COMMITTEE.includes(role) ? `/official/committee/${n.application_id}` : `/official/applications/${n.application_id}`);
  async function markRead(n: any) {
    if (n.read_at) return;
    await api.post(`/api/notifications/${n.id}/read`);
    setData((d: any) => d && { ...d, unread: Math.max(0, d.unread - 1), notifications: d.notifications.map((x: any) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) });
  }
  const count = (k: Kind) => all.filter((n) => n.kind === k).length;

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Notifications']}
        title="Notification centre"
        subtitle="One inbox for application updates, assignments and reminders."
        action={
          <Button variant="secondary" disabled={!data?.unread} onClick={async () => { await api.post('/api/notifications/read-all'); reload(); }}>
            <CheckCheck className="h-4 w-4" /> Mark all as read
          </Button>
        }
      />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'all', label: 'All notifications' },
          { value: 'unread', label: <>Unread <span className="text-slate-400">{data?.unread ?? 0}</span></> },
          { value: 'ASSIGNMENT', label: <>Assignments <span className="text-slate-400">{count('ASSIGNMENT')}</span></> },
          { value: 'UPDATE', label: <>Application updates <span className="text-slate-400">{count('UPDATE')}</span></> },
          { value: 'REMINDER', label: <>Reminders <span className="text-slate-400">{count('REMINDER')}</span></> },
        ]}
      />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Card className="self-start">
            <CardHeader title="Latest notifications" subtitle="Limited to records within your access" divided />
            {shown.length === 0 ? (
              <Empty icon={<Bell className="h-5 w-5" />} title="Nothing here">{tab === 'unread' ? 'You are all caught up.' : 'Notifications appear as work moves.'}</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {paged.slice.map((n) => {
                  const K = KIND[n.kind as Kind];
                  const active = sel?.id === n.id;
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => { setSelId(n.id); markRead(n); }}
                        className={cx('flex w-full gap-4 px-5 py-4 text-left transition', active ? 'bg-brand-50/70' : 'hover:bg-slate-50')}
                      >
                        <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border', active ? 'border-brand-200 bg-white text-brand-700' : 'border-slate-200 bg-slate-50 text-slate-500')}>
                          <K.icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cx('block truncate text-sm', n.read_at ? 'font-medium text-slate-700' : 'font-semibold text-slate-900')}>{n.title}</span>
                          <span className="mt-0.5 block truncate text-[13px] text-slate-500">{[!institution && n.institution_name, n.message].filter(Boolean).join(' · ')}</span>
                          {n.reference_no && <span className="mt-1 block font-mono text-xs text-brand-700">{n.reference_no}</span>}
                        </span>
                        <span className="flex shrink-0 flex-col items-end justify-between gap-2">
                          <span className={cx('h-2 w-2 rounded-full', n.read_at ? 'bg-transparent' : 'bg-brand-600')} aria-label={n.read_at ? undefined : 'Unread'} />
                          <span className="text-xs whitespace-nowrap text-slate-400">{fmtDateTime(n.created_at)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Pager {...paged} shown={paged.slice.length} noun="notifications" />
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader title="Details" subtitle={sel ? KIND[sel.kind as Kind].label : undefined} divided />
              {!sel ? (
                <p className="px-5 py-4 text-sm text-slate-500">Select a notification.</p>
              ) : (
                <div className="space-y-4 p-5">
                  <Badge t={sel.kind === 'REMINDER' ? 'amber' : 'slate'}>{KIND[sel.kind as Kind].label}</Badge>
                  <h2 className="text-lg leading-snug font-semibold text-slate-900">{sel.title}</h2>
                  <p className="text-sm whitespace-pre-wrap text-slate-600">{sel.message}</p>
                  {(sel.reference_no || sel.institution_name) && (
                    <div className="grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-sm">
                      {sel.reference_no && (
                        <div>
                          <div className="text-xs text-slate-500">Application</div>
                          <div className="mt-1 font-mono font-medium text-slate-900">{sel.reference_no}</div>
                        </div>
                      )}
                      {sel.institution_name && !institution && (
                        <div>
                          <div className="text-xs text-slate-500">Institution</div>
                          <div className="mt-1 font-medium text-slate-900">{sel.institution_name}</div>
                        </div>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-slate-500">{KIND[sel.kind as Kind].note}</p>
                  {link(sel) && (
                    <Button onClick={() => nav(link(sel)!)}>
                      <ArrowUpRight className="h-4 w-4" /> Open application
                    </Button>
                  )}
                  <div className="text-xs text-slate-400">Created {fmtDateTime(sel.created_at)}{sel.read_at ? ` · read ${fmtDateTime(sel.read_at)}` : ''}</div>
                </div>
              )}
            </Card>
            {!institution && (
              <Card>
                <CardHeader title="Your authorised workspaces" subtitle="Switch workspace without signing in again" divided />
                <ul className="space-y-2 p-5">
                  {(user?.roles ?? []).map((r) => (
                    <li key={r} className={cx('flex items-center gap-3 rounded-lg border px-4 py-3 text-sm', r === role ? 'border-brand-200 bg-brand-50/60' : 'border-slate-200')}>
                      {r === role ? <ShieldCheck className="h-4 w-4 text-brand-700" /> : <Repeat className="h-4 w-4 text-slate-400" />}
                      <span className="flex-1 font-medium text-slate-900">{WORKSPACE_NAME[r] ?? r}</span>
                      {r === role ? (
                        <span className="text-xs font-semibold text-brand-700">Current</span>
                      ) : (
                        <button className="text-xs font-semibold text-brand-700 hover:underline" onClick={async () => { await switchRole(r); nav('/official'); }}>
                          Switch →
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="px-5 pb-5 text-xs text-slate-500">Only workspaces assigned by an administrator appear here.</p>
              </Card>
            )}
          </div>
        </div>
      )}
      <PageNote>In-app notifications. Each is kept with its delivery record.</PageNote>
    </>
  );
}
