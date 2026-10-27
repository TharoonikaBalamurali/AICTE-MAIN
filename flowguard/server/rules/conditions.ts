/**
 * Safe interpreter for the structured Condition schema.
 * Only the operators below exist; nothing from the database is ever executed as code.
 */
import type { Condition } from '../catalogue/types.ts';

export interface EvalContext {
  fields: Record<string, unknown>;
  subtype: string | null;
  /** ISO date (YYYY-MM-DD) used for all date arithmetic, recorded with every validation run. */
  evaluationDate: string;
}

export function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addYears(d: Date, years: number): Date {
  const r = new Date(d.getTime());
  r.setUTCFullYear(r.getUTCFullYear() + years);
  return r;
}

/** Start year of an academic year string such as "2026-27". */
export function academicYearStart(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-\d{2}$/.exec(v);
  return m ? Number(m[1]) : null;
}

function escapeWord(w: string) {
  return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

export function evaluate(c: Condition, ctx: EvalContext): boolean {
  const val = (f: string) => ctx.fields[f];
  const today = parseDate(ctx.evaluationDate)!;
  switch (c.op) {
    case 'eq':
      return val(c.field) === c.value;
    case 'neq':
      return val(c.field) !== c.value;
    case 'in':
      return c.values.includes(val(c.field) as string | number);
    case 'truthy':
      return val(c.field) === true || val(c.field) === 'true';
    case 'falsy':
      return !(val(c.field) === true || val(c.field) === 'true');
    case 'present':
      return isPresent(val(c.field));
    case 'subtypeIn':
      return ctx.subtype !== null && c.values.includes(ctx.subtype);
    case 'yearsSinceGte': {
      const d = parseDate(val(c.field));
      return d !== null && addYears(d, c.years) <= today;
    }
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const n = toNumber(val(c.field));
      if (n === null) return false;
      return c.op === 'lt' ? n < c.value : c.op === 'gt' ? n > c.value : c.op === 'lte' ? n <= c.value : n >= c.value;
    }
    case 'gtRatioOf':
    case 'ltRatioOf': {
      const a = toNumber(val(c.field));
      const b = toNumber(val(c.ofField));
      if (a === null || b === null) return false;
      return c.op === 'gtRatioOf' ? a > c.ratio * b : a < c.ratio * b;
    }
    case 'lengthLt': {
      const v = val(c.field);
      return (Array.isArray(v) ? v.length : 0) < c.value;
    }
    case 'yearsBetweenLt': {
      const a = parseDate(val(c.from));
      const b = parseDate(val(c.to));
      return a !== null && b !== null && b < addYears(a, c.years);
    }
    case 'yearsUntilLt': {
      const d = parseDate(val(c.field));
      return d !== null && d < addYears(today, c.years);
    }
    case 'yearsUntilLtField': {
      const d = parseDate(val(c.field));
      const y = toNumber(val(c.yearsField));
      return d !== null && y !== null && d < addYears(today, y);
    }
    case 'academicYearsBetweenGte': {
      const a = academicYearStart(val(c.fromField));
      const b = academicYearStart(val(c.toField));
      return a !== null && b !== null && b - a >= c.years;
    }
    case 'containsWord': {
      const v = val(c.field);
      if (typeof v !== 'string') return false;
      return c.words.some((w) => new RegExp(`(^|[^A-Za-z])${escapeWord(w)}([^A-Za-z]|$)`, 'i').test(v));
    }
    case 'and':
      return c.conditions.every((x) => evaluate(x, ctx));
    case 'or':
      return c.conditions.some((x) => evaluate(x, ctx));
    case 'not':
      return !evaluate(c.condition, ctx);
    default: {
      const never: never = c;
      throw new Error(`Unsupported condition operator: ${JSON.stringify(never)}`);
    }
  }
}

/** Validates that an object read from storage is a well-formed Condition (defence against tampered rows). */
export function isCondition(x: unknown): x is Condition {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  const s = (k: string) => typeof o[k] === 'string';
  switch (o.op) {
    case 'eq':
    case 'neq':
      return s('field') && ['string', 'number', 'boolean'].includes(typeof o.value);
    case 'in':
      return s('field') && Array.isArray(o.values);
    case 'truthy':
    case 'falsy':
    case 'present':
      return s('field');
    case 'subtypeIn':
      return Array.isArray(o.values);
    case 'yearsSinceGte':
    case 'yearsUntilLt':
      return s('field') && typeof o.years === 'number';
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte':
    case 'lengthLt':
      return s('field') && typeof o.value === 'number';
    case 'gtRatioOf':
    case 'ltRatioOf':
      return s('field') && s('ofField') && typeof o.ratio === 'number';
    case 'yearsBetweenLt':
      return s('from') && s('to') && typeof o.years === 'number';
    case 'yearsUntilLtField':
      return s('field') && s('yearsField');
    case 'academicYearsBetweenGte':
      return s('fromField') && s('toField') && typeof o.years === 'number';
    case 'containsWord':
      return s('field') && Array.isArray(o.words) && (o.words as unknown[]).every((w) => typeof w === 'string' && w.length < 40);
    case 'and':
    case 'or':
      return Array.isArray(o.conditions) && (o.conditions as unknown[]).every(isCondition);
    case 'not':
      return isCondition(o.condition);
    default:
      return false;
  }
}
