import { Plus, Trash2 } from 'lucide-react';
import type { FieldDef } from '../../server/catalogue/types';
import { cx, inputCls, Label } from './ui';

export interface CourseRow {
  programme?: string;
  level?: string;
  course: string;
  currentIntake?: number | string;
  proposedIntake?: number | string;
}

export function FieldInput({ f, value, onChange, error }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const id = `f-${f.id}`;
  const err = error ? `${id}-err` : undefined;
  const common = { id, 'aria-invalid': !!error, 'aria-describedby': err } as const;
  let control;
  switch (f.type) {
    case 'textarea':
      control = <textarea {...common} rows={3} className={cx(inputCls, error && 'border-rose-400')} value={(value as string) ?? ''} placeholder={f.placeholder} maxLength={f.validation?.maxLength} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'number':
      control = (
        <input
          {...common}
          type="number"
          inputMode="decimal"
          className={cx(inputCls, error && 'border-rose-400')}
          value={value === undefined || value === null ? '' : String(value)}
          min={f.validation?.min}
          max={f.validation?.max}
          placeholder={f.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
      break;
    case 'date':
      control = <input {...common} type="date" className={cx(inputCls, error && 'border-rose-400')} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case 'select':
      control = (
        <select {...common} className={cx(inputCls, error && 'border-rose-400')} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Select…</option>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'boolean':
      control = (
        <div role="radiogroup" aria-labelledby={`${id}-l`} className="flex gap-2">
          {[
            [true, 'Yes'],
            [false, 'No'],
          ].map(([v, l]) => (
            <button
              type="button"
              role="radio"
              aria-checked={value === v}
              key={String(v)}
              onClick={() => onChange(v)}
              className={cx('rounded-lg border px-4 py-2 text-sm font-medium', value === v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50')}
            >
              {l as string}
            </button>
          ))}
        </div>
      );
      break;
    case 'courses': {
      const rows = (Array.isArray(value) ? value : []) as CourseRow[];
      const set = (i: number, k: keyof CourseRow, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: k.endsWith('Intake') ? (v === '' ? undefined : Number(v)) : v } : r)));
      control = (
        <div className={cx('rounded-lg border', error ? 'border-rose-400' : 'border-slate-200')}>
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[11px] text-slate-500 uppercase">
                  <tr>
                    {['Programme', 'Level', 'Course', 'Current intake', 'Proposed intake', ''].map((h) => (
                      <th key={h} className="px-2 py-2 text-left font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="p-1.5"><input aria-label={`Row ${i + 1} programme`} className={inputCls} value={r.programme ?? ''} onChange={(e) => set(i, 'programme', e.target.value)} placeholder="e.g. Engineering & Technology" /></td>
                      <td className="w-32 p-1.5"><input aria-label={`Row ${i + 1} level`} className={inputCls} value={r.level ?? ''} onChange={(e) => set(i, 'level', e.target.value)} placeholder="UG / PG / Diploma" /></td>
                      <td className="p-1.5"><input aria-label={`Row ${i + 1} course`} className={inputCls} value={r.course ?? ''} onChange={(e) => set(i, 'course', e.target.value)} placeholder="Course name" /></td>
                      <td className="w-28 p-1.5"><input aria-label={`Row ${i + 1} current intake`} type="number" min={0} className={inputCls} value={r.currentIntake ?? ''} onChange={(e) => set(i, 'currentIntake', e.target.value)} /></td>
                      <td className="w-28 p-1.5"><input aria-label={`Row ${i + 1} proposed intake`} type="number" min={0} className={inputCls} value={r.proposedIntake ?? ''} onChange={(e) => set(i, 'proposedIntake', e.target.value)} /></td>
                      <td className="p-1.5">
                        <button type="button" aria-label={`Remove row ${i + 1}`} className="rounded p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium text-brand-600 hover:bg-brand-50" onClick={() => onChange([...rows, { course: '' }])}>
            <Plus className="h-4 w-4" /> Add course
          </button>
        </div>
      );
      break;
    }
    default:
      control = (
        <input
          {...common}
          type={f.type === 'email' ? 'email' : 'text'}
          className={cx(inputCls, error && 'border-rose-400')}
          value={(value as string) ?? ''}
          placeholder={f.placeholder}
          maxLength={f.validation?.maxLength}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <div className={f.type === 'textarea' || f.type === 'courses' ? 'sm:col-span-2' : ''}>
      <span id={`${id}-l`}>
        <Label htmlFor={id} required={f.required}>
          {f.label}
        </Label>
      </span>
      {control}
      {error && (
        <p id={err} className="mt-1 text-xs text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
