import { AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X } from 'lucide-react';
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
export function Button({ variant = 'primary', loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-[0_1px_2px_rgba(37,99,235,0.25)]',
    secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50',
    ghost: 'text-slate-600 hover:bg-slate-100',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    dark: 'bg-navy-900 text-white hover:bg-navy-800',
  };
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className={cx('rounded-xl border border-slate-200 bg-white', className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, action, divided }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; divided?: boolean }) {
  return (
    <div className={cx('flex items-start justify-between gap-4 px-5 pt-4', divided ? 'border-b border-slate-200 pb-4' : 'pb-3')}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Blue text link used for "View all →" and row actions. */
export function TextLink({ to, onClick, children, className }: { to?: string; onClick?: () => void; children: ReactNode; className?: string }) {
  const cls = cx('inline-flex items-center gap-1 text-[13px] font-semibold whitespace-nowrap text-brand-600 hover:text-brand-700', className);
  if (to)
    return (
      <Link to={to} className={cls}>
        {children}
      </Link>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

export function PageHeader({ eyebrow, crumbs, title, subtitle, action }: { eyebrow?: string; crumbs?: string[]; title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  const trail = crumbs ?? (eyebrow ? [eyebrow] : []);
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {trail.length > 0 && (
          <div className="mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
            {trail.map((c, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-1.5 text-slate-300">/</span>}
                <span className={i === trail.length - 1 && trail.length > 1 ? 'text-slate-700' : undefined}>{c}</span>
              </span>
            ))}
          </div>
        )}
        <h1 className="text-[26px] leading-tight font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

// Monotone: figures are navy; a single accent shade marks the ones that need attention.
const valueTone = { default: 'text-slate-900', blue: 'text-brand-700', amber: 'text-brand-700', red: 'text-brand-700', green: 'text-slate-900' };
export function Kpi({ label, value, caption, tone = 'default' }: { label: string; value: ReactNode; caption?: ReactNode; tone?: keyof typeof valueTone }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
      <div className="text-[13px] text-slate-500">{label}</div>
      <div className={cx('num mt-1.5 text-[28px] leading-none font-bold', valueTone[tone])}>{value}</div>
      {caption && <div className="mt-2 text-xs text-slate-500">{caption}</div>}
    </div>
  );
}
export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">{children}</div>;
}

const tone = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-100',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-100',
  violet: 'bg-violet-50 text-violet-700 ring-violet-100',
};
export type Tone = keyof typeof tone;
export function Badge({ t = 'slate', children, className }: { t?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', tone[t], className)}>{children}</span>;
}

export function statusTone(status: string): Tone {
  if (status === 'DRAFT') return 'slate';
  if (['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'].includes(status)) return 'amber';
  if (['DECISION_ISSUED', 'CLOSED'].includes(status)) return 'green';
  if (status.startsWith('APPEAL')) return 'violet';
  if (['SCRUTINY_COMPLETED', 'AWAITING_AUTHORISED_DECISION', 'AWAITING_COMMITTEE_REVIEW', 'EVC_REPORT_SUBMITTED'].includes(status)) return 'slate';
  return 'blue';
}
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const full = label ?? status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  // Pills show the short stage name; the full label (e.g. "Submitted — scrutiny pending") stays in the tooltip.
  return (
    <span title={full}>
      <Badge t={statusTone(status)}>{full.split(' — ')[0]}</Badge>
    </span>
  );
}

export function outcomeTone(o: string): Tone {
  return o === 'PASS' ? 'green' : o === 'FAIL' ? 'red' : o === 'WARNING' ? 'amber' : 'violet';
}

export function Alert({ kind = 'info', title, children, action }: { kind?: 'info' | 'error' | 'success' | 'warn'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const s = {
    info: ['bg-slate-50 border-slate-200 text-slate-700', Info, 'text-slate-500'],
    error: ['bg-rose-50 border-rose-200 text-rose-900', AlertCircle, 'text-rose-600'],
    success: ['bg-emerald-50 border-emerald-200 text-emerald-900', CheckCircle2, 'text-emerald-600'],
    warn: ['bg-amber-50 border-amber-200 text-amber-900', AlertTriangle, 'text-amber-600'],
  } as const;
  const [cls, Icon, iconCls] = s[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', cls)}>
      <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', iconCls)} />
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx(!!title && 'mt-0.5', 'opacity-90')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-400">{icon}</div>}
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('w-full rounded-xl bg-white shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';

export function Label({ children, required, htmlFor, hint }: { children: ReactNode; required?: boolean; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-semibold text-slate-800">
      {children}
      {required && <span className="ml-0.5 text-rose-600">*</span>}
      {hint && <span className="ml-2 font-normal text-slate-400">{hint}</span>}
    </label>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-500">{k}</div>
      <div className="mt-1 text-sm font-medium break-words text-slate-900">{v ?? '—'}</div>
    </div>
  );
}

export const thCls = 'px-4 py-2.5 first:pl-5 last:pr-5 text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-slate-500 uppercase';
export const tdCls = 'px-4 py-3.5 first:pl-5 last:pr-5';
export function Table({ head, children, empty, className }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-y border-slate-200 bg-slate-50">
            {head.map((h, i) => (
              <th key={i} className={thCls}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

/** Underline tabs (page sections). */
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: ReactNode }>; className?: string }) {
  return (
    <div role="tablist" className={cx('flex gap-5 overflow-x-auto overflow-y-hidden border-b border-slate-200 [scrollbar-width:none]', className)}>
      {items.map((i) => (
        <button
          role="tab"
          aria-selected={value === i.value}
          key={i.value}
          onClick={() => onChange(i.value)}
          className={cx(
            '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 py-3 text-sm font-medium whitespace-nowrap transition',
            value === i.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

/** Segmented filter chips with counts (table filters). */
export function FilterTabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: string; count?: number }> }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
      {items.map((i) => (
        <button
          role="tab"
          aria-selected={value === i.value}
          key={i.value}
          onClick={() => onChange(i.value)}
          className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition', value === i.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}
        >
          {i.label}
          {i.count !== undefined && <span className={cx('ml-1.5 text-xs', value === i.value ? 'text-brand-600' : 'text-slate-400')}>{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Client-side pagination for lists already loaded from the API. */
export function usePaged<T>(rows: T[] | undefined, size = 8) {
  const [page, setPage] = useState(1);
  const total = rows?.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, pages);
  const slice = (rows ?? []).slice((p - 1) * size, p * size);
  return { slice, page: p, pages, total, setPage };
}
export function Pager({ page, pages, total, shown, setPage, noun = 'applications' }: { page: number; pages: number; total: number; shown: number; setPage: (n: number) => void; noun?: string }) {
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-[13px] text-slate-500">
      <span>
        Showing {shown} of {total} {noun}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-md border border-slate-200 p-1.5 disabled:opacity-40">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1)
            .map((n) => (
              <button key={n} onClick={() => setPage(n)} className={cx('min-w-7 rounded-md border px-2 py-1 text-xs font-semibold', n === page ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
                {n}
              </button>
            ))}
          <button aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-md border border-slate-200 p-1.5 disabled:opacity-40">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export interface TimelineItem {
  id: string | number;
  title: ReactNode;
  meta?: ReactNode;
  body?: ReactNode;
  tone?: 'done' | 'current' | 'warn' | 'muted';
}
/** Vertical history with circular markers, used for workflow activity. */
export function Timeline({ items, empty = 'No activity recorded yet.' }: { items: TimelineItem[]; empty?: string }) {
  if (items.length === 0) return <p className="px-5 pb-5 text-sm text-slate-500">{empty}</p>;
  const marker = {
    done: 'border-emerald-200 bg-emerald-50 text-emerald-600',
    current: 'border-brand-200 bg-brand-50 text-brand-600',
    warn: 'border-amber-200 bg-amber-50 text-amber-600',
    muted: 'border-slate-200 bg-slate-50 text-slate-400',
  };
  return (
    <ol className="px-5 pb-5">
      {items.map((it, i) => (
        <li key={it.id} className="relative flex gap-3 pb-4 last:pb-0">
          {i < items.length - 1 && <span className="absolute top-7 bottom-0 left-[11px] w-px bg-slate-200" />}
          <span className={cx('z-[1] mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border', marker[it.tone ?? 'done'])}>
            {it.tone === 'warn' ? <AlertTriangle className="h-3 w-3" /> : it.tone === 'muted' ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0 pt-0.5">
            <div className="text-sm font-medium text-slate-900">{it.title}</div>
            {it.meta && <div className="mt-0.5 text-xs text-slate-500">{it.meta}</div>}
            {it.body && <div className="mt-1 text-[13px] text-slate-600">{it.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Horizontal segmented progress (Submitted → … → Decision). */
export function StepBar({ steps, current, attention }: { steps: Array<{ key: string; label: string }>; current: number; attention?: boolean }) {
  return (
    <div>
      <div className="flex gap-1.5">
        {steps.map((s, i) => (
          <div key={s.key} className={cx('h-1.5 flex-1 rounded-full', i < current ? 'bg-brand-600' : i === current ? (attention ? 'bg-amber-500' : 'bg-brand-600') : 'bg-slate-200')} />
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        {steps.map((s, i) => (
          <div key={s.key} className={cx('flex-1 truncate text-xs', i === current ? (attention ? 'font-semibold text-amber-700' : 'font-semibold text-brand-700') : i < current ? 'text-slate-700' : 'text-slate-400')}>
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Footer line under each page. */
export function PageNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 text-xs text-slate-400">
      <span>{children}</span>
      <span>AICTE Approval Portal</span>
    </div>
  );
}
