/**
 * Scrutiny / re-scrutiny reports and deficiency-notice content.
 * Reports are verification assistance for authorised officials. They never approve or reject.
 */
import { getCategory } from './catalogue/categories.ts';
import type { CategoryDef, FieldDef } from './catalogue/types.ts';
import type { Db } from './db/index.ts';
import type { FindingStatus } from './rules/engine.ts';
import { evaluate } from './rules/conditions.ts';
import { checklistFor, todayIST, type AppRow } from './services.ts';
import { routeStages, STATE_LABELS } from './workflow/stateMachine.ts';

export const DISCLAIMER =
  'Automated verification assistance only. This report does not approve or reject the application; all scrutiny outcomes are decided by the authorised official. A successful upload or technical check is not proof of legal authenticity.';

export interface ReportFinding {
  ruleId: string;
  ruleVersion: number;
  ruleType: string;
  status: FindingStatus;
  blocking: boolean;
  humanVerification: boolean;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  explanation: string;
  correctiveAction: string;
  sourceReference: string | null;
}

const SEVERITY: Record<FindingStatus, number> = { DISCREPANCY_DETECTED: 4, UNABLE_TO_VERIFY: 3, HUMAN_REVIEW_REQUIRED: 2, PASS: 1, NOT_APPLICABLE: 0 };
export function worst(fs: Array<{ status: FindingStatus }>): FindingStatus {
  return fs.reduce<FindingStatus>((w, f) => (SEVERITY[f.status] > SEVERITY[w] ? f.status : w), 'NOT_APPLICABLE');
}

async function runFindings(db: Db, runId: string): Promise<ReportFinding[]> {
  const rows = await db.query<Record<string, any>>('SELECT * FROM validation_findings WHERE run_id = $1 ORDER BY id', [runId]);
  return rows.map((r) => ({
    ruleId: r.rule_id,
    ruleVersion: r.rule_version,
    ruleType: r.rule_type,
    status: (r.status ?? (r.outcome === 'PASS' ? 'PASS' : r.outcome === 'FAIL' ? 'DISCREPANCY_DETECTED' : 'HUMAN_REVIEW_REQUIRED')) as FindingStatus,
    blocking: r.blocking,
    humanVerification: r.human_verification,
    targetType: r.target_type,
    targetId: r.target_id,
    targetLabel: r.target_label,
    explanation: r.explanation,
    correctiveAction: r.corrective_action,
    sourceReference: r.aph_reference,
  }));
}

export function displayValue(f: FieldDef | undefined, v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.map((r: any) => (typeof r === 'string' ? r : `${r.course}${r.proposedIntake !== undefined && r.proposedIntake !== '' ? ` (intake ${r.proposedIntake})` : ''}`)).join('; ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return f?.options?.find((o) => o.value === v)?.label ?? String(v);
}

async function header(db: Db, app: AppRow, cat: CategoryDef) {
  const inst = app.institution_snapshot ?? {};
  const sv = (await db.one<{ submission_version: number }>('SELECT submission_version FROM applications WHERE id = $1', [app.id]))!.submission_version;
  return {
    application: {
      id: app.id,
      referenceNo: app.reference_no,
      submissionVersion: sv,
      submittedAt: app.submitted_at,
      status: app.status,
      statusLabel: STATE_LABELS[app.status],
      categoryCode: cat.code,
      categoryTitle: cat.title,
      subtype: app.subtype,
      subtypeLabel: cat.subtypes?.find((s) => s.value === app.subtype)?.label ?? null,
      academicYear: app.academic_year,
      rulesetVersion: app.ruleset_version,
      route: routeStages(cat.route).map((s) => s.label).join(' → '),
      routeReference: cat.route.aphReference,
    },
    institution: {
      name: inst.name ?? null,
      aicteInstitutionId: inst.aicteInstitutionId ?? null,
      idVerification: inst.idVerification ?? 'UNVERIFIED',
      address: inst.address ?? null,
      officialEmail: inst.officialEmail ?? null,
      applicant: `${app.applicant_name ?? '—'}${app.applicant_designation ? `, ${app.applicant_designation}` : ''}`,
    },
  };
}

function summarise(findings: ReportFinding[]) {
  const counts: Record<FindingStatus, number> = { PASS: 0, DISCREPANCY_DETECTED: 0, NOT_APPLICABLE: 0, UNABLE_TO_VERIFY: 0, HUMAN_REVIEW_REQUIRED: 0 };
  for (const f of findings) counts[f.status]++;
  const outstanding = findings.filter((f) => f.status === 'DISCREPANCY_DETECTED' || f.status === 'UNABLE_TO_VERIFY');
  return {
    counts,
    blocking: findings.filter((f) => f.blocking).length,
    discrepanciesDetected: counts.DISCREPANCY_DETECTED > 0,
    verificationRequired: findings.some((f) => f.humanVerification),
    readyForOfficerReview: true,
    outstanding: outstanding.map((f) => ({ ruleId: f.ruleId, status: f.status, targetLabel: f.targetLabel, explanation: f.explanation, sourceReference: f.sourceReference })),
  };
}

/** Builds and persists a scrutiny report for the given validation run. */
export async function createScrutinyReport(db: Db, app: AppRow, runId: string, createdBy: string) {
  const cat = getCategory(app.category_code)!;
  const findings = await runFindings(db, runId);
  const run = await db.one<Record<string, any>>('SELECT * FROM validation_runs WHERE id = $1', [runId]);
  const docs = await db.query<Record<string, any>>('SELECT * FROM documents WHERE application_id = $1 AND is_current', [app.id]);
  const ctx = { fields: { ...app.field_values, academicYear: app.academic_year }, subtype: app.subtype, evaluationDate: todayIST() };
  const forTarget = (id: string) => findings.filter((f) => f.targetId === id);

  const fields = cat.fields
    .filter((f) => !f.showWhen || evaluate(f.showWhen, ctx))
    .map((f) => {
      const fs = forTarget(f.id);
      return { id: f.id, label: f.label, value: displayValue(f, app.field_values[f.id]), required: f.required, classification: f.classification, sourceReference: f.aphReference ?? null, status: fs.length ? worst(fs) : 'NOT_APPLICABLE', findings: fs };
    });
  const expected = checklistFor(cat, app)
    .filter((d) => d.stage === 'SUBMISSION')
    .map((d) => {
      const up = docs.find((x) => x.requirement_id === d.id);
      const fs = findings.filter((f) => f.targetId === d.id || f.ruleId.includes(`.DOC.${d.oneOfGroup ?? d.id}.`));
      return {
        id: d.id,
        name: d.name,
        requirement: d.state,
        sourceReference: d.aphReference,
        issuer: d.issuer ?? null,
        validity: d.validity.description,
        submitted: up
          ? { documentId: up.id, fileName: up.file_name, version: up.version, uploadedAt: up.uploaded_at, sha256: up.sha256, metadata: up.metadata, integrity: up.integrity }
          : null,
        status: fs.length ? worst(fs) : up ? 'PASS' : 'NOT_APPLICABLE',
        findings: fs,
      };
    });
  const byType = (...types: string[]) => findings.filter((f) => types.includes(f.ruleType) && f.status !== 'NOT_APPLICABLE');
  const content = {
    kind: 'SCRUTINY',
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
    ...(await header(db, app, cat)),
    run: { id: runId, stage: run!.stage, evaluationDate: run!.evaluation_date, rulesEvaluated: run!.rules_evaluated, inputHash: run!.input_hash, rulesetVersion: run!.ruleset_version },
    fields,
    documents: {
      expected,
      missing: expected.filter((d) => !d.submitted && (d.requirement === 'REQUIRED' || d.requirement === 'ONE_OF')).map((d) => d.name),
      potentiallyIncorrect: expected.filter((d) => d.submitted && (d.status === 'DISCREPANCY_DETECTED' || d.status === 'UNABLE_TO_VERIFY')).map((d) => d.name),
    },
    validity: byType('DOC_NOT_EXPIRED', 'DOC_VALID_FROM_ISSUE', 'DOC_PERIOD_COVERED'),
    signatures: byType('DOC_DSC_DECLARED', 'DOC_SIGNATURE_TECHNICAL', 'DOC_SIGNATORY_RECORDED'),
    otherDiscrepancies: findings.filter((f) => f.ruleType === 'CATEGORY_CHECK' && f.status !== 'PASS' && f.status !== 'NOT_APPLICABLE'),
    humanVerification: findings.filter((f) => f.humanVerification),
    summary: summarise(findings),
  };
  const v = await db.one<{ n: number }>("SELECT coalesce(max(version),0)::int AS n FROM workflow_reports WHERE application_id = $1 AND kind = 'SCRUTINY'", [app.id]);
  const row = await db.one<{ id: string; version: number }>(
    `INSERT INTO workflow_reports(application_id, kind, version, submission_version, run_id, content, created_by) VALUES ($1,'SCRUTINY',$2,$3,$4,$5,$6) RETURNING id, version`,
    [app.id, (v?.n ?? 0) + 1, content.application.submissionVersion, runId, JSON.stringify({ ...content, version: (v?.n ?? 0) + 1 }), createdBy],
  );
  return { id: row!.id, version: row!.version, content };
}

export type DeficiencyAssessment = 'RESOLVED' | 'UNRESOLVED' | 'PARTIALLY_RESOLVED' | 'HUMAN_REVIEW_REQUIRED';

/** Suggests an assessment; the re-scrutiny officer decides. A file upload alone never yields RESOLVED. */
export function assessDeficiency(category: string, hasCorrection: boolean, related: ReportFinding[]): DeficiencyAssessment {
  if (!hasCorrection) return 'UNRESOLVED';
  const effective = related.filter((f) => f.status !== 'NOT_APPLICABLE' && f.ruleType !== 'HUMAN_REVIEW_NOTICE');
  if (effective.some((f) => f.blocking)) return 'UNRESOLVED';
  if (effective.length === 0) return 'HUMAN_REVIEW_REQUIRED';
  if (effective.some((f) => f.status === 'DISCREPANCY_DETECTED')) return 'PARTIALLY_RESOLVED';
  if (['SIGNATURE_AUTHENTICATION', 'MISMATCH', 'OTHER'].includes(category)) return 'HUMAN_REVIEW_REQUIRED';
  if (effective.some((f) => f.status !== 'PASS')) return 'HUMAN_REVIEW_REQUIRED';
  return 'RESOLVED';
}

/** Builds and persists the re-scrutiny report for a correction submission. */
export async function createReScrutinyReport(db: Db, app: AppRow, correctionId: string, runId: string, createdBy: string) {
  const cat = getCategory(app.category_code)!;
  const findings = await runFindings(db, runId);
  const cs = await db.one<Record<string, any>>('SELECT * FROM correction_submissions WHERE id = $1', [correctionId]);
  const run = await db.one<Record<string, any>>('SELECT * FROM validation_runs WHERE id = $1', [runId]);
  const items = cs!.items as Array<Record<string, any>>;
  const defs = await db.query<Record<string, any>>(
    `SELECT d.*, n.notice_no, n.version AS notice_version FROM deficiencies d LEFT JOIN deficiency_notices n ON n.id = d.notice_id WHERE d.id = ANY($1)`,
    [items.map((i) => i.deficiencyId)],
  );
  const linked = new Set<string>();
  const entries = [];
  for (const d of defs) {
    const item = items.find((i) => i.deficiencyId === d.id)!;
    const related = findings.filter((f) => {
      const hit = d.target_type === 'DOCUMENT' ? f.targetId === d.target_id || f.ruleId.includes(`.DOC.${d.target_id}.`) : d.target_type === 'FIELD' ? f.targetId === d.target_id : false;
      if (hit) linked.add(`${f.ruleId}`);
      return hit;
    });
    const hasCorrection = (item.documents?.length ?? 0) > 0 || Object.keys(item.fieldChanges?.after ?? {}).length > 0 || (d.target_type === 'APPLICATION' && !!item.response);
    const assessment = assessDeficiency(d.category, hasCorrection, related);
    await db.query('UPDATE deficiencies SET automated_assessment = $2 WHERE id = $1', [d.id, assessment]);
    entries.push({
      deficiencyId: d.id,
      referenceNo: d.reference_no,
      target: { type: d.target_type, id: d.target_id, label: d.target_label },
      category: d.category,
      original: {
        explanation: d.explanation,
        correctiveAction: d.corrective_action,
        requiredReplacement: d.required_replacement,
        sourceReference: d.source_reference,
        noticeNo: d.notice_no ? `${d.notice_no} v${d.notice_version}` : null,
        raisedAt: d.raised_at,
      },
      correction: item,
      newResults: related,
      automatedAssessment: assessment,
      remainingDiscrepancies: related.filter((f) => f.status === 'DISCREPANCY_DETECTED' || f.status === 'UNABLE_TO_VERIFY'),
      humanVerificationRequired: assessment === 'HUMAN_REVIEW_REQUIRED' || related.some((f) => f.humanVerification),
      sourceReference: d.source_reference,
    });
  }
  const dependent = findings.filter((f) => !linked.has(f.ruleId) && f.status !== 'NOT_APPLICABLE' && f.ruleType !== 'HUMAN_REVIEW_NOTICE');
  const content = {
    kind: 'RE_SCRUTINY',
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
    ...(await header(db, app, cat)),
    scopeNote: 'Re-scrutiny verifies only the deficiencies pointed out by the Scrutiny Committee. Only rules affected by the corrected fields/documents, and rules that depend on them, were re-evaluated.',
    correctionSubmission: { id: correctionId, version: cs!.version, submittedAt: cs!.submitted_at, changedFields: cs!.changed_fields, changedDocs: cs!.changed_docs },
    run: { id: runId, evaluationDate: run!.evaluation_date, rulesEvaluated: run!.rules_evaluated, inputHash: run!.input_hash, scope: run!.scope },
    deficiencies: entries,
    dependentChecks: dependent,
    summary: {
      deficiencies: entries.length,
      byAssessment: entries.reduce<Record<string, number>>((m, e) => ({ ...m, [e.automatedAssessment]: (m[e.automatedAssessment] ?? 0) + 1 }), {}),
      dependentDiscrepancies: dependent.filter((f) => f.status === 'DISCREPANCY_DETECTED').length,
      readyForOfficerReview: true,
    },
  };
  const v = await db.one<{ n: number }>("SELECT coalesce(max(version),0)::int AS n FROM workflow_reports WHERE application_id = $1 AND kind = 'RE_SCRUTINY'", [app.id]);
  const row = await db.one<{ id: string; version: number }>(
    `INSERT INTO workflow_reports(application_id, kind, version, submission_version, run_id, correction_submission_id, content, created_by) VALUES ($1,'RE_SCRUTINY',$2,$3,$4,$5,$6,$7) RETURNING id, version`,
    [app.id, (v?.n ?? 0) + 1, content.application.submissionVersion, runId, correctionId, JSON.stringify({ ...content, version: (v?.n ?? 0) + 1 }), createdBy],
  );
  return { id: row!.id, version: row!.version, content };
}

export function deadlineLabel(type: string, date: string | null, basis: string | null) {
  if (type === 'APH') return `APH-prescribed deadline ${date} (${basis})`;
  if (type === 'OPERATIONAL') return `System-configured operational deadline ${date} — not an APH-prescribed deadline (${basis})`;
  return 'No deadline established — requires authorised configuration or verification';
}
