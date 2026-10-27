import { Link } from 'react-router-dom';
import { cx } from './ui';

/**
 * Small presentation-only charts. They draw counts the API already returns; they never compute workflow
 * outcomes. Single-series charts use one blue; status mixes use the status colours, always with a text label.
 */

export interface BarDatum {
  label: string;
  value: number;
  to?: string;
  hint?: string;
}

/** Horizontal bars, sorted as given. Each row shows its label and value, so identity never depends on colour. */
export function BarList({ items, empty = 'No data yet.', unit, max }: { items: BarDatum[]; empty?: string; unit?: string; max?: number }) {
  const shown = items.filter((i) => i.value > 0);
  if (shown.length === 0) return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>;
  const top = max ?? Math.max(...shown.map((i) => i.value));
  return (
    <ul className="space-y-3" role="list">
      {shown.map((i) => {
        const row = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate text-slate-700">{i.label}</span>
              <span className="num shrink-0 font-semibold text-slate-900">
                {i.value}
                {unit && <span className="ml-0.5 font-normal text-slate-500">{unit}</span>}
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-100">
              <div className="h-2.5 rounded-full bg-brand-600 transition-[width]" style={{ width: `${Math.max(2, (i.value / top) * 100)}%` }} />
            </div>
          </>
        );
        return (
          <li key={i.label} title={`${i.label}: ${i.value}${unit ?? ''}${i.hint ? ` — ${i.hint}` : ''}`}>
            {i.to ? (
              <Link to={i.to} className="block rounded-md outline-offset-4 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-brand-500">
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Vertical columns along a short axis (e.g. weekdays). Zero columns stay visible as a baseline tick. */
export function ColumnChart({ items, height = 140, highlight }: { items: BarDatum[]; height?: number; highlight?: string }) {
  const top = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      <div className="flex items-end gap-2 border-b border-slate-200" style={{ height }}>
        {items.map((i) => (
          <div key={i.label} className="group flex h-full flex-1 flex-col items-center justify-end" title={`${i.label}: ${i.value}${i.hint ? ` — ${i.hint}` : ''}`}>
            <span className={cx('num mb-1 text-xs font-semibold', i.value ? 'text-slate-900' : 'text-slate-300')}>{i.value}</span>
            <div
              className={cx('w-full max-w-[44px] rounded-t-[4px]', i.label === highlight ? 'bg-brand-700' : 'bg-brand-500', 'group-hover:bg-brand-700')}
              style={{ height: i.value ? `${(i.value / top) * (height - 26)}px` : '2px', opacity: i.value ? 1 : 0.35 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2">
        {items.map((i) => (
          <div key={i.label} className={cx('flex-1 text-center text-[11px]', i.label === highlight ? 'font-semibold text-brand-700' : 'text-slate-500')}>
            {i.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Two series side by side per period (e.g. submitted vs decided). The legend names both; hover gives exact values. */
export function PairedColumns({ items, a, b, height = 220 }: { items: Array<{ label: string; a: number; b: number }>; a: string; b: string; height?: number }) {
  const top = Math.max(1, ...items.flatMap((i) => [i.a, i.b]));
  const ticks = [top, Math.round(top / 2), 0];
  const empty = items.every((i) => !i.a && !i.b);
  return (
    <div>
      <div className="mb-3 flex justify-end gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-600" /> {a}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-200" /> {b}</span>
      </div>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between pb-5 text-right text-[10px] text-slate-400" style={{ height }}>
          {ticks.map((t, i) => <span key={i} className="num">{t}</span>)}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="absolute inset-x-0 top-0 flex flex-col justify-between" style={{ height: height - 20 }} aria-hidden>
            {ticks.map((_, i) => <div key={i} className="border-t border-dashed border-slate-100" />)}
          </div>
          <div className="relative flex items-end gap-1 border-b border-slate-200" style={{ height: height - 20 }}>
            {items.map((i) => (
              <div key={i.label} className="flex h-full flex-1 items-end justify-center gap-[3px]" title={`${i.label} — ${a}: ${i.a}, ${b}: ${i.b}`}>
                <div className="w-full max-w-[12px] rounded-t-[3px] bg-brand-600" style={{ height: `${(i.a / top) * 100}%`, minHeight: i.a ? 3 : 0 }} />
                <div className="w-full max-w-[12px] rounded-t-[3px] bg-brand-200" style={{ height: `${(i.b / top) * 100}%`, minHeight: i.b ? 3 : 0 }} />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1">
            {items.map((i) => <div key={i.label} className="flex-1 text-center text-[10px] text-slate-500">{i.label}</div>)}
          </div>
          {empty && <div className="absolute inset-0 flex items-center justify-center pb-6 text-sm text-slate-400">No submissions or decisions in this period.</div>}
        </div>
      </div>
    </div>
  );
}

// Segments use one hue in descending shades by position; the legend carries the meaning, not the colour.
const SHADES = ['bg-brand-800', 'bg-brand-600', 'bg-brand-400', 'bg-brand-200', 'bg-slate-300', 'bg-slate-200'];
const SEG: Record<string, unknown> = { blue: 1, green: 1, amber: 1, red: 1, violet: 1, slate: 1 };

/** One proportion bar with a labelled legend underneath (label + count + share). */
export function SegmentBar({ segments, empty = 'No data yet.', columns = 2 }: { segments: Array<{ label: string; value: number; tone: keyof typeof SEG }>; empty?: string; columns?: 1 | 2 }) {
  const shade = (s: { label: string }) => SHADES[segments.findIndex((x) => x.label === s.label) % SHADES.length];
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((a, s) => a + s.value, 0);
  if (!total) return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <div>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={shown.map((s) => `${s.label} ${s.value}`).join(', ')}>
        {shown.map((s) => (
          <div key={s.label} className={cx('h-full first:rounded-l-full last:rounded-r-full', shade(s))} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>
      <ul className={cx('mt-3 grid gap-x-4 gap-y-1.5 text-[13px]', columns === 2 && 'sm:grid-cols-2')}>
        {segments.map((s) => (
          <li key={s.label} className={cx('flex items-center gap-2', !s.value && 'text-slate-400')}>
            <span className={cx('h-2.5 w-2.5 shrink-0 rounded-sm', s.value ? shade(s) : 'bg-slate-200')} />
            <span className="flex-1 truncate">{s.label}</span>
            <span className="num font-semibold text-slate-900">{s.value}</span>
            <span className="w-10 text-right text-xs text-slate-500">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A labelled progress meter (done of total). */
export function Meter({ label, done, total, tone = 'blue' }: { label: string; done: number; total: number; tone?: 'blue' | 'green' | 'amber' }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = tone === 'blue' ? 'bg-brand-600' : 'bg-brand-700';
  return (
    <div title={`${label}: ${done} of ${total}`}>
      <div className="mb-1 flex items-baseline justify-between text-[13px]">
        <span className="text-slate-700">{label}</span>
        <span className="num font-semibold text-slate-900">
          {done}
          <span className="font-normal text-slate-500"> / {total}</span>
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-100">
        <div className={cx('h-2 rounded-full', bar)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
