/**
 * Deterministic APH rules engine.
 *
 * Same input + same rule versions + same evaluation date ⇒ same findings.
 * The engine identifies missing / invalid requirements. It never grants or
 * rejects a statutory approval — that power stays with authorised officials.
 */
import crypto from 'node:crypto';
import type { Condition } from '../catalogue/types.ts';
import { academicYearStart, addYears, evaluate, isCondition, isPresent, parseDate, toNumber, type EvalContext } from './conditions.ts';
import type { RuleDef } from './ruleset.ts';

export type Outcome = 'PASS' | 'FAIL' | 'WARNING' | 'HUMAN_REVIEW' | 'NOT_APPLICABLE';

/** Officer-facing result status for each check. */
export type FindingStatus = 'PASS' | 'DISCREPANCY_DETECTED' | 'NOT_APPLICABLE' | 'UNABLE_TO_VERIFY' | 'HUMAN_REVIEW_REQUIRED';

/** Technical file facts recorded at upload. None of these prove legal authenticity. */
export interface FileIntegrity {
  kind?: 'pdf' | 'jpg' | 'png';
  readable?: boolean;
  readabilityNote?: string;
  /** PDF contains a signature dictionary (/ByteRange + /Sig). Not cryptographically validated. */
  signatureStructure?: boolean;
}

export interface EngineDocument {
  requirementId: string;
  documentId: string;
  version: number;
  sha256: string;
  metadata: Record<string, unknown>;
  integrity?: FileIntegrity;
}

export interface EngineInput {
  applicationType: string;
  subtype: string | null;
  fields: Record<string, unknown>;
  documents: EngineDocument[];
  evaluationDate: string;
  /** SUBMISSION checks only submission-stage documents; EVC also includes EVC-stage documents. */
  documentStage: 'SUBMISSION' | 'EVC';
  /** Report rules that did not apply (for scrutiny reports). */
  includeNotApplicable?: boolean;
}

export interface Finding {
  ruleId: string;
  ruleVersion: number;
  ruleType: string;
  outcome: Outcome;
  status: FindingStatus;
  humanVerification: boolean;
  blocking: boolean;
  targetType: 'FIELD' | 'DOCUMENT' | 'APPLICATION';
  targetId: string | null;
  targetLabel: string;
  aphReference: string | null;
  explanation: string;
  correctiveAction: string;
  lifecycleStatus: string;
}

export interface EngineResult {
  inputHash: string;
  evaluationDate: string;
  rulesEvaluated: number;
  findings: Finding[];
  summary: { pass: number; fail: number; warning: number; humanReview: number; blocking: number };
  /** Requirement IDs of documents applicable in this case (for checklist rendering). */
  applicableDocuments: string[];
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

function cond(x: unknown): Condition | null {
  if (x === null || x === undefined) return null;
  if (!isCondition(x)) throw new Error('Rule contains a malformed condition — refusing to execute.');
  return x;
}

function validateFormat(c: Record<string, unknown>, value: unknown): string | null {
  if (!isPresent(value)) return null;
  const v = (c.validation ?? {}) as { min?: number; max?: number; pattern?: string; patternMessage?: string; maxLength?: number };
  const allowed = c.allowed as string[] | null;
  switch (c.fieldType) {
    case 'number': {
      const n = toNumber(value);
      if (n === null) return 'must be a number';
      if (v.min !== undefined && n < v.min) return `must be at least ${v.min}`;
      if (v.max !== undefined && n > v.max) return `must be at most ${v.max}`;
      return null;
    }
    case 'date':
      return parseDate(value) ? null : 'must be a valid date (YYYY-MM-DD)';
    case 'email':
      return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'must be a valid email address';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be yes or no';
    case 'select':
      return allowed && !allowed.includes(String(value)) ? 'is not one of the permitted options' : null;
    case 'multiselect':
      return Array.isArray(value) && (!allowed || value.every((x) => allowed.includes(String(x)))) ? null : 'contains an option that is not permitted';
    case 'courses': {
      if (!Array.isArray(value)) return 'must be a list of courses';
      for (const [i, row] of value.entries()) {
        const r = row as Record<string, unknown>;
        if (!r || typeof r.course !== 'string' || r.course.trim() === '') return `row ${i + 1}: course name is required`;
        for (const k of ['currentIntake', 'proposedIntake']) {
          if (isPresent(r[k]) && (toNumber(r[k]) === null || toNumber(r[k])! < 0)) return `row ${i + 1}: ${k} must be a non-negative number`;
        }
      }
      return null;
    }
    default: {
      if (typeof value !== 'string') return 'must be text';
      if (v.maxLength && value.length > v.maxLength) return `must be at most ${v.maxLength} characters`;
      if (v.pattern && !new RegExp(v.pattern).test(value)) return v.patternMessage ?? 'has an invalid format';
      return null;
    }
  }
}

export function runEngine(input: EngineInput, rules: RuleDef[]): EngineResult {
  const ctx: EvalContext = { fields: input.fields, subtype: input.subtype, evaluationDate: input.evaluationDate };
  const today = parseDate(input.evaluationDate);
  if (!today) throw new Error('evaluationDate must be YYYY-MM-DD');

  const active = rules
    .filter((r) => r.applicationType === input.applicationType && r.lifecycleStatus !== 'DRAFT' && r.lifecycleStatus !== 'RETIRED')
    .filter((r) => r.actionSubtype === null || r.actionSubtype === input.subtype)
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  const docsByReq = new Map<string, EngineDocument>();
  for (const d of input.documents) docsByReq.set(d.requirementId, d);

  const stages = input.documentStage === 'EVC' ? ['SUBMISSION', 'EVC'] : ['SUBMISSION'];
  const docApplicable = (c: Record<string, unknown>) => {
    if (!stages.includes(c.stage as string)) return false;
    if (c.level === 'MANDATORY') return true;
    const trig = cond(c.trigger);
    if (c.level === 'CONDITIONAL') return trig ? evaluate(trig, ctx) : true;
    return false;
  };

  const findings: Finding[] = [];
  const applicableDocs = new Set<string>();

  for (const r of active) {
    const c = r.condition;
    const approved = r.lifecycleStatus === 'APPROVED_FOR_EXECUTION';
    let outcome: Outcome | null = null;
    let detail = '';
    let unable = false;
    let humanAfterPass = false;
    let notApplicable = false;

    switch (r.ruleType) {
      case 'REQUIRED_FIELD': {
        const when = cond(c.applicableWhen);
        if (when && !evaluate(when, ctx)) {
          notApplicable = true;
          break;
        }
        outcome = isPresent(input.fields[c.field as string]) ? 'PASS' : 'FAIL';
        break;
      }
      case 'FIELD_FORMAT': {
        const err = validateFormat(c, input.fields[c.field as string]);
        if (!isPresent(input.fields[c.field as string])) break;
        outcome = err ? 'FAIL' : 'PASS';
        if (err) detail = ` Value ${err}.`;
        break;
      }
      case 'REQUIRED_DOCUMENT': {
        const oneOf = c.oneOf as string[] | null;
        if (oneOf) {
          if (!stages.includes(c.stage as string)) break;
          oneOf.forEach((id) => applicableDocs.add(id));
          outcome = oneOf.some((id) => docsByReq.has(id)) ? 'PASS' : 'FAIL';
          break;
        }
        if (!docApplicable(c)) {
          notApplicable = c.level !== 'OPTIONAL';
          break;
        }
        applicableDocs.add(c.requirementId as string);
        outcome = docsByReq.has(c.requirementId as string) ? 'PASS' : 'FAIL';
        break;
      }
      case 'DOC_DSC_DECLARED':
      case 'DOC_NOT_EXPIRED':
      case 'DOC_VALID_FROM_ISSUE':
      case 'DOC_PERIOD_COVERED':
      case 'DOC_INTEGRITY':
      case 'DOC_SIGNATURE_TECHNICAL':
      case 'DOC_SIGNATORY_RECORDED':
      case 'DOC_METADATA': {
        const doc = docsByReq.get(c.requirementId as string);
        if (!doc) break; // absence is reported by REQUIRED_DOCUMENT
        const m = doc.metadata ?? {};
        const integ = doc.integrity ?? {};
        if (r.ruleType === 'DOC_INTEGRITY') {
          if (integ.readable === undefined) {
            outcome = 'HUMAN_REVIEW';
            unable = true;
            detail = ' The file was uploaded before technical checks existed; open it to confirm it is readable.';
          } else {
            outcome = integ.readable ? 'PASS' : 'FAIL';
            if (!integ.readable) detail = ` ${integ.readabilityNote ?? 'The file structure appears incomplete or corrupt.'}`;
          }
        } else if (r.ruleType === 'DOC_SIGNATURE_TECHNICAL') {
          if (integ.kind && integ.kind !== 'pdf') {
            outcome = 'HUMAN_REVIEW';
            unable = true;
            detail = ' Image files cannot carry an embedded digital signature; the DSC cannot be technically detected.';
          } else if (integ.signatureStructure) {
            outcome = 'PASS';
            humanAfterPass = true;
          } else {
            outcome = 'HUMAN_REVIEW';
            detail = ' No embedded PDF signature structure was detected. The applicant declared a DSC; an officer must verify the signature.';
          }
        } else if (r.ruleType === 'DOC_SIGNATORY_RECORDED') {
          if (isPresent(m.signatory)) outcome = 'PASS';
          else {
            outcome = 'HUMAN_REVIEW';
            unable = true;
            detail = ' No signatory name was recorded with the upload.';
          }
        } else if (r.ruleType === 'DOC_DSC_DECLARED') {
          outcome = m.dscDeclared === true ? 'PASS' : 'FAIL';
        } else if (r.ruleType === 'DOC_METADATA') {
          outcome = isPresent(m[c.metaKey as string]) ? 'PASS' : 'FAIL';
        } else if (r.ruleType === 'DOC_NOT_EXPIRED') {
          const exp = parseDate(m.expiryDate);
          if (!exp) {
            outcome = 'HUMAN_REVIEW';
            unable = true;
            detail = ' No expiry date was stated, so validity must be confirmed by an authorised reviewer.';
          } else {
            outcome = exp >= today ? 'PASS' : 'FAIL';
            if (outcome === 'FAIL') detail = ` Stated expiry ${m.expiryDate} is before ${input.evaluationDate}.`;
          }
        } else if (r.ruleType === 'DOC_VALID_FROM_ISSUE') {
          const iss = parseDate(m.issueDate);
          if (!iss) break; // DOC_METADATA reports the missing issue date
          const until = addYears(iss, c.years as number);
          outcome = until >= today && iss <= today ? 'PASS' : 'FAIL';
          if (outcome === 'FAIL') detail = iss > today ? ' Issue date is in the future.' : ` Validity ended on ${until.toISOString().slice(0, 10)}.`;
        } else if (r.ruleType === 'DOC_PERIOD_COVERED') {
          const ay = academicYearStart(input.fields.academicYear);
          const fy = (m.financialYear as string) || (input.fields.auditedAccountsFinancialYear as string);
          if (!ay || !fy) break;
          const expected = `${ay - 1}-${String(ay % 100).padStart(2, '0')}`;
          outcome = fy === expected ? 'PASS' : 'HUMAN_REVIEW';
          if (outcome !== 'PASS') detail = ` Stated ${fy}; the year preceding academic year ${input.fields.academicYear} is ${expected}.`;
        }
        break;
      }
      case 'CATEGORY_CHECK': {
        const when = cond(c.applicableWhen);
        if (when && !evaluate(when, ctx)) {
          notApplicable = true;
          break;
        }
        const failed = evaluate(cond(c.failWhen)!, ctx);
        outcome = failed ? (r.severity === 'BLOCKING' ? 'FAIL' : 'WARNING') : 'PASS';
        break;
      }
      case 'HUMAN_REVIEW_NOTICE': {
        const when = cond(c.applicableWhen);
        if (when && !evaluate(when, ctx)) break;
        outcome = 'HUMAN_REVIEW';
        break;
      }
    }

    if (!outcome) {
      if (notApplicable && input.includeNotApplicable) {
        findings.push({
          ruleId: r.ruleId,
          ruleVersion: r.ruleVersion,
          ruleType: r.ruleType,
          outcome: 'NOT_APPLICABLE',
          status: 'NOT_APPLICABLE',
          humanVerification: false,
          blocking: false,
          targetType: r.targetType,
          targetId: r.targetId,
          targetLabel: r.targetLabel,
          aphReference: r.aphReference,
          explanation: 'Not applicable to this application: the triggering condition is not met.',
          correctiveAction: '',
          lifecycleStatus: r.lifecycleStatus,
        });
      }
      continue;
    }
    // Rules not approved for execution can only advise; they never block.
    if (!approved && (outcome === 'FAIL' || outcome === 'WARNING')) {
      outcome = 'HUMAN_REVIEW';
      detail += ' (Rule pending regulatory verification — advisory only.)';
    }
    const status: FindingStatus =
      outcome === 'PASS' ? 'PASS' : outcome === 'FAIL' || outcome === 'WARNING' ? 'DISCREPANCY_DETECTED' : unable ? 'UNABLE_TO_VERIFY' : 'HUMAN_REVIEW_REQUIRED';
    findings.push({
      ruleId: r.ruleId,
      ruleVersion: r.ruleVersion,
      ruleType: r.ruleType,
      outcome,
      status,
      humanVerification: outcome === 'WARNING' || outcome === 'HUMAN_REVIEW' || humanAfterPass,
      blocking: outcome === 'FAIL' && r.severity === 'BLOCKING' && approved,
      targetType: r.targetType,
      targetId: r.targetId,
      targetLabel: r.targetLabel,
      aphReference: r.aphReference,
      explanation: outcome === 'PASS' ? r.expectedResult + (humanAfterPass ? ' (technical check only — not proof of legal authenticity).' : '') : r.explanation + detail,
      correctiveAction: outcome === 'PASS' ? '' : r.correctiveAction,
      lifecycleStatus: r.lifecycleStatus,
    });
  }

  const summary = { pass: 0, fail: 0, warning: 0, humanReview: 0, blocking: 0 };
  for (const f of findings) {
    if (f.outcome === 'NOT_APPLICABLE') continue;
    if (f.outcome === 'PASS') summary.pass++;
    else if (f.outcome === 'FAIL') summary.fail++;
    else if (f.outcome === 'WARNING') summary.warning++;
    else summary.humanReview++;
    if (f.blocking) summary.blocking++;
  }

  const inputHash = crypto
    .createHash('sha256')
    .update(
      canonical({
        t: input.applicationType,
        s: input.subtype,
        f: input.fields,
        d: [...input.documents].sort((a, b) => a.requirementId.localeCompare(b.requirementId)).map((d) => ({ r: d.requirementId, h: d.sha256, m: d.metadata, i: d.integrity ?? {} })),
        e: input.evaluationDate,
        st: input.documentStage,
        rv: active.map((r) => `${r.ruleId}@${r.ruleVersion}:${r.lifecycleStatus}`),
      }),
    )
    .digest('hex');

  return { inputHash, evaluationDate: input.evaluationDate, rulesEvaluated: active.length, findings, summary, applicableDocuments: [...applicableDocs].sort() };
}
