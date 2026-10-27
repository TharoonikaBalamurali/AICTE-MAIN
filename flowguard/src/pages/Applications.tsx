import { Files, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Empty, FilterTabs, inputCls, PageHeader, PageNote, Pager, Spinner, StatusBadge, Table, tdCls, TextLink, usePaged } from '../components/ui';
import { useCategories } from '../lib/categories';
import { fmtDate, useApi } from '../lib/hooks';

export const STATUS_OPTIONS = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_SCRUTINY',
  'DEFICIENCY_RAISED',
  'CORRECTION_IN_PROGRESS',
  'READY_FOR_RE_SCRUTINY',
  'UNDER_RE_SCRUTINY',
  'AWAITING_EVC_SCHEDULING',
  'EVC_SCHEDULED',
  'EVC_IN_PROGRESS',
  'EVC_REPORT_SUBMITTED',
  'AWAITING_COMMITTEE_REVIEW',
  'AWAITING_AUTHORISED_DECISION',
  'DECISION_ISSUED',
  'APPEAL_SUBMITTED',
  'APPEAL_UNDER_REVIEW',
  'CLOSED',
];

export default function Applications() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const cats = useCategories();
  const view = (sp.get('view') as 'all' | 'drafts' | 'submitted') ?? 'all';
  const [q, setQ] = useState(sp.get('q') ?? '');
  useEffect(() => setQ(sp.get('q') ?? ''), [sp]);
  const qs = new URLSearchParams();
  for (const k of ['view', 'q', 'category', 'status', 'from', 'to']) if (sp.get(k)) qs.set(k, sp.get(k)!);
  const { data, error, loading } = useApi(`/api/applications?${qs}`);
  const paged = usePaged(data?.applications, 10);
  const set = (k: string, v: string) =>
    setSp((p) => {
      if (v) p.set(k, v);
      else p.delete(k);
      return p;
    });

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Applications']}
        title="Applications"
        subtitle="Every application with its tracking reference, server timestamps and current workflow stage."
        action={
          <Button onClick={() => nav('/applications/new')}>
            <Plus className="h-4 w-4" /> New application
          </Button>
        }
      />
      <Card>
        <CardHeader
          title="All applications"
          subtitle={data ? `${data.applications.length} matching` : undefined}
          action={<FilterTabs value={view} onChange={(v) => set('view', v === 'all' ? '' : v)} items={[{ value: 'all', label: 'All' }, { value: 'drafts', label: 'Drafts' }, { value: 'submitted', label: 'Submitted' }]} />}
        />
        <form
          className="grid gap-3 px-5 pb-4 md:grid-cols-[1.4fr_1.4fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q.trim());
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input aria-label="Search by application ID" className={`${inputCls} pl-9`} placeholder="Search by application ID (FG-…)" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select aria-label="Filter by category" className={inputCls} value={sp.get('category') ?? ''} onChange={(e) => set('category', e.target.value)}>
            <option value="">All application types</option>
            {cats?.map((c) => (
              <option key={c.code} value={c.code}>
                {c.title}
              </option>
            ))}
          </select>
          <select aria-label="Filter by status" className={inputCls} value={sp.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        {loading && !data && <Spinner />}
        {error && (
          <div className="p-5">
            <Alert kind="error">{error}</Alert>
          </div>
        )}
        {data && (
          <>
            <Table
              head={['Application ID', 'Application type', 'Submitted', 'Stage', 'Pending with', 'Respond by', '']}
              empty={data.applications.length === 0 && <Empty icon={<Files className="h-5 w-5" />} title="No applications match">Adjust the filters or start a new application.</Empty>}
            >
              {paged.slice.map((a: any) => {
                const deadline = a.deficiency_deadline ?? a.appeal_deadline;
                const to = a.status === 'DRAFT' ? `/applications/${a.id}/edit` : `/applications/${a.id}`;
                return (
                  <tr key={a.id} className="hover:bg-slate-50/70">
                    <td className={`${tdCls} font-mono text-[13px] font-semibold whitespace-nowrap text-brand-600`}>{a.reference_no ?? <span className="font-sans font-normal text-slate-400">Draft (no ID yet)</span>}</td>
                    <td className={tdCls}>
                      <div className="max-w-[300px] truncate text-slate-800">{a.categoryTitle}</div>
                      {a.subtypeLabel && <div className="max-w-[300px] truncate text-xs text-slate-500">{a.subtypeLabel}</div>}
                    </td>
                    <td className={`${tdCls} whitespace-nowrap text-slate-600`}>{fmtDate(a.submitted_at)}</td>
                    <td className={tdCls}><StatusBadge status={a.status} label={a.statusLabel} /></td>
                    <td className={tdCls}>{a.pendingAction === 'APPLICANT' ? <Badge t="amber">Your institution</Badge> : a.pendingAction === 'OFFICIAL' ? <Badge t="blue">AICTE officials</Badge> : <Badge>None</Badge>}</td>
                    <td className={`${tdCls} whitespace-nowrap text-slate-600`}>{deadline ? fmtDate(deadline) : '—'}</td>
                    <td className={`${tdCls} text-right`}>
                      <TextLink to={to}>{a.status === 'DRAFT' ? 'Continue' : 'Open'}</TextLink>
                    </td>
                  </tr>
                );
              })}
            </Table>
            <Pager {...paged} shown={paged.slice.length} />
          </>
        )}
      </Card>
      <PageNote>Deadlines are shown only when set from a verified source or recorded with their basis by an official.</PageNote>
    </>
  );
}
