import { BookOpen, ChevronDown, Scale, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Badge, Card, CardHeader, inputCls, PageHeader, Spinner } from '../components/ui';
import { useCategories } from '../lib/categories';
import { useApi } from '../lib/hooks';

export default function Help() {
  const cats = useCategories();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi(open ? `/api/categories/${open}` : null);
  const list = (cats ?? []).filter((c) => !q || [c.title, ...c.keywords, c.aphReferences].join(' ').toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHeader crumbs={["Workspace", "Help & support"]} title="Help centre" subtitle="How the portal works, where each requirement comes from, and what still needs verification." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-5">
          <BookOpen className="h-5 w-5 text-brand-600" />
          <h3 className="mt-2 font-semibold">Regulatory sources</h3>
          <p className="mt-1 text-sm text-slate-600">
            Requirements are taken only from verified regulatory sources supplied with this project. No other source and no AI model is used to decide requirements at runtime.
          </p>
        </Card>
        <Card className="p-5">
          <Workflow className="h-5 w-5 text-brand-600" />
          <h3 className="mt-2 font-semibold">How an application moves</h3>
          <p className="mt-1 text-sm text-slate-600">
            Draft → Submitted → Scrutiny / Re-scrutiny (deficiency → correction) → EVC (where Table 2.3 requires) → SHC (as applicable) → authorised decision → appeal to the Council via SAC within 7 days (where eligible).
          </p>
        </Card>
        <Card className="p-5">
          <Scale className="h-5 w-5 text-brand-600" />
          <h3 className="mt-2 font-semibold">What automation does — and does not</h3>
          <p className="mt-1 text-sm text-slate-600">
            The deterministic rules engine checks presence, file type, explicit validity dates and stated limits. It never grants or rejects approval; authenticity and substantive adequacy are always reviewed by authorised officials.
          </p>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Application types and their requirements" subtitle="All 22 menu categories and their verification status" action={<input className={`${inputCls} max-w-xs`} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search categories" />} />
        {!cats && <Spinner />}
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {list.map((c) => (
            <li key={c.code}>
              <button className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50" onClick={() => setOpen(open === c.code ? null : c.code)} aria-expanded={open === c.code}>
                <span className="num w-6 text-xs text-slate-400">{c.menuNumber}.</span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{c.title}</span>
                </span>
                <Badge t={c.verificationStatus === 'VERIFIED' ? 'green' : 'amber'}>{c.submissionEnabled ? 'verified' : 'draft only'}</Badge>
                <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open === c.code ? 'rotate-180' : ''}`} />
              </button>
              {open === c.code && (
                <div className="bg-slate-50/60 px-5 pt-1 pb-5 text-sm">
                  {!detail.data && <Spinner />}
                  {detail.data && (
                    <>
                      <p className="text-slate-600">{detail.data.category.summary}</p>
                      <p className="mt-1 text-xs text-slate-500">Route: {detail.data.category.stages.map((s: any) => s.label).join(' → ')}</p>
                      <table className="mt-3 w-full text-xs">
                        <thead className="text-left text-slate-500 uppercase">
                          <tr><th className="py-1">Document</th><th>Status</th><th>Stage</th></tr>
                        </thead>
                        <tbody>
                          {detail.data.category.documents.map((d: any) => (
                            <tr key={d.id} className="border-t border-slate-200 align-top">
                              <td className="py-1.5 pr-3">{d.name}{d.triggerDescription && <div className="text-slate-500">If: {d.triggerDescription}</div>}</td>
                              <td className="pr-3">{d.level.toLowerCase()}{d.verificationStatus !== 'VERIFIED' && ' · needs verification'}</td>
                              <td className="pr-3">{d.stage.toLowerCase()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <p className="mt-6 text-center text-xs text-slate-400">This is a prototype. It is not integrated with the official AICTE portal; references it generates are portal tracking IDs.</p>
    </>
  );
}
