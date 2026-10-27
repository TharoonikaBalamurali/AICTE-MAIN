/**
 * Derives the versioned, structured rule set from the source-referenced catalogue.
 * Rules are stored in the `regulatory_rules` table; the engine executes stored rules,
 * not the catalogue, so governance (approval / retirement) controls execution.
 */
import { CATEGORIES } from '../catalogue/categories.ts';
import type { CategoryDef, Condition, DocMetaKey, FieldDef } from '../catalogue/types.ts';

export const RULESET_VERSION = 'APH-2024-27/r1';

export type RuleType =
  | 'REQUIRED_FIELD'
  | 'FIELD_FORMAT'
  | 'REQUIRED_DOCUMENT'
  | 'DOC_METADATA'
  | 'DOC_DSC_DECLARED'
  | 'DOC_NOT_EXPIRED'
  | 'DOC_VALID_FROM_ISSUE'
  | 'DOC_PERIOD_COVERED'
  | 'DOC_INTEGRITY'
  | 'DOC_SIGNATURE_TECHNICAL'
  | 'DOC_SIGNATORY_RECORDED'
  | 'CATEGORY_CHECK'
  | 'HUMAN_REVIEW_NOTICE';

export type Lifecycle = 'DRAFT' | 'NEEDS_VERIFICATION' | 'VERIFIED' | 'APPROVED_FOR_EXECUTION' | 'RETIRED';

export interface RuleDef {
  ruleId: string;
  ruleVersion: number;
  applicationType: string;
  actionSubtype: string | null;
  ruleType: RuleType;
  condition: Record<string, unknown>;
  expectedResult: string;
  severity: 'BLOCKING' | 'ADVISORY';
  aphReference: string | null;
  sourceEvidence: string;
  verificationStatus: 'VERIFIED' | 'NEEDS_VERIFICATION';
  lifecycleStatus: Lifecycle;
  targetType: 'FIELD' | 'DOCUMENT' | 'APPLICATION';
  targetId: string | null;
  targetLabel: string;
  explanation: string;
  correctiveAction: string;
}

const metaLabels: Record<DocMetaKey, string> = {
  issueDate: 'issue / execution date',
  expiryDate: 'expiry date',
  issuer: 'issuing authority',
  signatory: 'signatory',
  referenceNumber: 'reference number',
  financialYear: 'financial year covered',
  dscDeclared: 'DSC declaration',
};

function fieldRules(cat: CategoryDef, fd: FieldDef): RuleDef[] {
  const out: RuleDef[] = [];
  const common = {
    ruleVersion: 1,
    applicationType: cat.code,
    actionSubtype: null,
    targetType: 'FIELD' as const,
    targetId: fd.id,
    targetLabel: fd.label,
    aphReference: fd.aphReference ?? null,
    sourceEvidence: fd.classification === 'APH_REQUIREMENT' ? `APH: ${fd.aphReference}` : `Portal ${fd.classification}`,
    verificationStatus: 'VERIFIED' as const,
    lifecycleStatus: 'APPROVED_FOR_EXECUTION' as const,
  };
  if (fd.required) {
    out.push({
      ...common,
      ruleId: `${cat.code}.FIELD.${fd.id}.REQUIRED`,
      ruleType: 'REQUIRED_FIELD',
      condition: { field: fd.id, fieldType: fd.type, applicableWhen: fd.showWhen ?? null },
      expectedResult: 'Field has a value',
      severity: 'BLOCKING',
      explanation: `"${fd.label}" is required for this application.`,
      correctiveAction: `Enter "${fd.label}" in Step 2.`,
    });
  }
  out.push({
    ...common,
    ruleId: `${cat.code}.FIELD.${fd.id}.FORMAT`,
    ruleType: 'FIELD_FORMAT',
    condition: {
      field: fd.id,
      fieldType: fd.type,
      validation: fd.validation ?? {},
      allowed: fd.options?.map((o) => o.value) ?? null,
    },
    expectedResult: 'Value matches the field type and validation',
    severity: 'BLOCKING',
    sourceEvidence: 'Portal SYSTEM_POLICY (input validation)',
    explanation: `"${fd.label}" must be a valid ${fd.type} value.`,
    correctiveAction: `Correct "${fd.label}".`,
  });
  return out;
}

function documentRules(cat: CategoryDef): RuleDef[] {
  const out: RuleDef[] = [];
  const groups = new Map<string, string[]>();
  for (const d of cat.documents) if (d.oneOfGroup) groups.set(d.oneOfGroup, [...(groups.get(d.oneOfGroup) ?? []), d.id]);

  for (const d of cat.documents) {
    const lifecycle = d.verificationStatus === 'VERIFIED' ? 'APPROVED_FOR_EXECUTION' : 'NEEDS_VERIFICATION';
    const common = {
      ruleVersion: 1,
      applicationType: cat.code,
      actionSubtype: null,
      targetType: 'DOCUMENT' as const,
      targetId: d.id,
      targetLabel: d.name,
      aphReference: d.aphReference,
      sourceEvidence: `APH: ${d.aphReference}`,
      verificationStatus: d.verificationStatus,
      lifecycleStatus: lifecycle as Lifecycle,
    };
    const trigger: Condition | null = d.trigger ?? null;
    if (d.level !== 'OPTIONAL' && (!d.oneOfGroup || groups.get(d.oneOfGroup)![0] === d.id)) {
      out.push({
        ...common,
        ruleId: `${cat.code}.DOC.${d.oneOfGroup ?? d.id}.PRESENT`,
        ruleType: 'REQUIRED_DOCUMENT',
        condition: {
          requirementId: d.id,
          stage: d.stage,
          level: d.level,
          trigger: d.oneOfGroup ? null : trigger,
          oneOf: d.oneOfGroup ? groups.get(d.oneOfGroup) : null,
        },
        expectedResult: d.oneOfGroup ? 'One of the alternative documents is uploaded' : 'Document is uploaded',
        severity: 'BLOCKING',
        explanation: d.oneOfGroup
          ? `One of the alternatives must be uploaded: ${cat.documents.filter((x) => x.oneOfGroup === d.oneOfGroup).map((x) => x.name).join(' OR ')}.`
          : `${d.name} is ${d.level === 'MANDATORY' ? 'mandatory' : 'required in your case'}${d.triggerDescription ? ` — ${d.triggerDescription}` : ''}.`,
        correctiveAction: 'Upload the document in Step 3.',
        targetLabel: d.oneOfGroup ? cat.documents.filter((x) => x.oneOfGroup === d.oneOfGroup).map((x) => x.name).join(' / ') : d.name,
      });
    }
    const docScope = { requirementId: d.id, stage: d.stage, level: d.level, trigger };
    out.push({
      ...common,
      ruleId: `${cat.code}.DOC.${d.id}.DSC`,
      ruleType: 'DOC_DSC_DECLARED',
      condition: docScope,
      expectedResult: 'Applicant declares the file is digitally signed with a valid DSC',
      severity: 'BLOCKING',
      aphReference: 'Ch. I §1.4.3, §1.4.6; Ch. II §2.3.4(a)',
      sourceEvidence: 'APH: Ch. I §1.4.6 ("Any document uploaded … without Digital Signature shall not be considered as valid")',
      explanation: 'Documents must be digitally signed (DSC). The portal cannot verify signatures cryptographically; it records your declaration and flags authenticity for human review.',
      correctiveAction: 'Re-upload the digitally signed file and tick the DSC declaration.',
    });
    out.push({
      ...common,
      ruleId: `${cat.code}.DOC.${d.id}.INTEGRITY`,
      ruleType: 'DOC_INTEGRITY',
      condition: docScope,
      expectedResult: 'The file is structurally complete and readable',
      severity: 'BLOCKING',
      aphReference: null,
      sourceEvidence: 'Portal SYSTEM_POLICY (technical file check — an unreadable file cannot satisfy a document requirement)',
      verificationStatus: 'VERIFIED',
      lifecycleStatus: 'APPROVED_FOR_EXECUTION',
      explanation: `${d.name}: the uploaded file could not be confirmed as readable.`,
      correctiveAction: 'Upload a complete, readable copy of the document.',
    });
    out.push({
      ...common,
      ruleId: `${cat.code}.DOC.${d.id}.SIGNATURE_TECH`,
      ruleType: 'DOC_SIGNATURE_TECHNICAL',
      condition: docScope,
      expectedResult: 'An embedded PDF digital-signature structure is present',
      severity: 'ADVISORY',
      aphReference: 'Ch. I §1.4.3, §1.4.6; Ch. II §2.3.4(a)',
      sourceEvidence: 'APH requires DSC-signed uploads; the structural check is a Portal SYSTEM_POLICY aid and does not validate the certificate.',
      verificationStatus: 'VERIFIED',
      lifecycleStatus: 'APPROVED_FOR_EXECUTION',
      explanation: `${d.name}: digital signature could not be technically confirmed.`,
      correctiveAction: 'No action unless the officer asks — the officer verifies the DSC.',
    });
    if (d.metadata.includes('signatory')) {
      out.push({
        ...common,
        ruleId: `${cat.code}.DOC.${d.id}.SIGNATORY`,
        ruleType: 'DOC_SIGNATORY_RECORDED',
        condition: docScope,
        expectedResult: 'Signatory name recorded for the document',
        severity: 'ADVISORY',
        aphReference: d.aphReference,
        sourceEvidence: `APH: ${d.aphReference} (${d.authentication ?? 'prescribed signatory'})`,
        explanation: `${d.name} must be signed by ${d.authentication ?? 'the prescribed signatory'}.`,
        correctiveAction: 'Record the signatory when uploading so the officer can compare it with the prescribed signatory.',
      });
    }
    if (d.validity.kind === 'MUST_BE_VALID' && d.metadata.includes('expiryDate')) {
      out.push({
        ...common,
        ruleId: `${cat.code}.DOC.${d.id}.NOT_EXPIRED`,
        ruleType: 'DOC_NOT_EXPIRED',
        condition: docScope,
        expectedResult: 'Expiry date stated on the certificate is on or after the evaluation date',
        severity: 'BLOCKING',
        aphReference: d.validity.aphReference ?? d.aphReference,
        explanation: `${d.name}: ${d.validity.description}`,
        correctiveAction: 'Upload a currently valid certificate and enter its expiry date.',
      });
    }
    if (d.validity.kind === 'FIXED_PERIOD_FROM_ISSUE' && d.validity.years) {
      out.push({
        ...common,
        ruleId: `${cat.code}.DOC.${d.id}.VALID_FROM_ISSUE`,
        ruleType: 'DOC_VALID_FROM_ISSUE',
        condition: { ...docScope, years: d.validity.years },
        expectedResult: `Issued within the last ${d.validity.years} years`,
        severity: 'BLOCKING',
        aphReference: d.validity.aphReference ?? d.aphReference,
        explanation: `${d.name}: ${d.validity.description}`,
        correctiveAction: `Upload a certificate issued within the last ${d.validity.years} years.`,
      });
    }
    if (d.validity.kind === 'PERIOD_COVERED') {
      out.push({
        ...common,
        ruleId: `${cat.code}.DOC.${d.id}.PERIOD`,
        ruleType: 'DOC_PERIOD_COVERED',
        condition: { ...docScope, expected: 'PREVIOUS_FY_OF_ACADEMIC_YEAR' },
        expectedResult: 'Financial year covered is the year preceding the academic year',
        severity: 'ADVISORY',
        verificationStatus: 'NEEDS_VERIFICATION',
        lifecycleStatus: 'NEEDS_VERIFICATION',
        sourceEvidence: 'APH: Annexure 2 §2.1(vii) "previous year" — the reference point is not defined; interpreted as the financial year preceding the academic year (needs verification).',
        explanation: 'Audited accounts must be for the previous year. The portal compares the stated financial year with the year before the academic year; a mismatch is sent for human review.',
        correctiveAction: 'Check that the audited statement covers the previous financial year.',
      });
    }
    const requiredMeta: DocMetaKey[] = [];
    if (d.validity.kind === 'FIXED_PERIOD_FROM_ISSUE') requiredMeta.push('issueDate');
    if (d.validity.kind === 'PERIOD_COVERED') requiredMeta.push('financialYear');
    for (const m of requiredMeta) {
      out.push({
        ...common,
        ruleId: `${cat.code}.DOC.${d.id}.META.${m}`,
        ruleType: 'DOC_METADATA',
        condition: { ...docScope, metaKey: m },
        expectedResult: `The ${metaLabels[m]} is recorded`,
        severity: 'BLOCKING',
        sourceEvidence: 'Portal SYSTEM_POLICY (metadata needed to evaluate an APH validity rule)',
        explanation: `The ${metaLabels[m]} of ${d.name} is needed to evaluate its validity.`,
        correctiveAction: `Enter the ${metaLabels[m]} when uploading the document.`,
      });
    }
  }
  return out;
}

function checkRules(cat: CategoryDef): RuleDef[] {
  return cat.checks.map((c) => ({
    ruleId: `${cat.code}.CHECK.${c.id}`,
    ruleVersion: 1,
    applicationType: cat.code,
    actionSubtype: null,
    ruleType: 'CATEGORY_CHECK' as const,
    condition: { failWhen: c.failWhen, applicableWhen: c.applicableWhen ?? null },
    expectedResult: c.title,
    severity: c.severity,
    aphReference: c.aphReference,
    sourceEvidence: `APH: ${c.aphReference}`,
    verificationStatus: c.verificationStatus,
    lifecycleStatus: (c.verificationStatus === 'VERIFIED' ? 'APPROVED_FOR_EXECUTION' : 'NEEDS_VERIFICATION') as Lifecycle,
    targetType: c.target ? ('FIELD' as const) : ('APPLICATION' as const),
    targetId: c.target ?? null,
    targetLabel: c.title,
    explanation: c.explanation,
    correctiveAction: c.correctiveAction,
  }));
}

function noticeRules(cat: CategoryDef): RuleDef[] {
  const out: RuleDef[] = [
    {
      ruleId: `${cat.code}.NOTICE.AUTHENTICITY`,
      ruleVersion: 1,
      applicationType: cat.code,
      actionSubtype: null,
      ruleType: 'HUMAN_REVIEW_NOTICE',
      condition: { applicableWhen: null },
      expectedResult: 'Authorised reviewer confirms authenticity and substantive adequacy',
      severity: 'ADVISORY',
      aphReference: 'Ch. I §1.8(e)',
      sourceEvidence: 'APH: Ch. I §1.8(e) (Scrutiny Committee verifies authenticity of documents)',
      verificationStatus: 'VERIFIED',
      lifecycleStatus: 'APPROVED_FOR_EXECUTION',
      targetType: 'APPLICATION',
      targetId: null,
      targetLabel: 'Document authenticity & substantive review',
      explanation: `A successful upload does not prove a document is genuine. ${cat.reviewGuidance}`,
      correctiveAction: 'No action needed now — an authorised reviewer will assess.',
    },
  ];
  cat.verificationNotes
    .filter(() => cat.code === 'INSTITUTION_TYPE_UNIVERSITY')
    .forEach((note, i) =>
      out.push({ ...out[0], ruleId: `${cat.code}.NOTICE.VERIFY.${i + 1}`, targetLabel: 'Additional provisions to verify', explanation: note, aphReference: cat.aphReferences, expectedResult: 'Reviewer verifies additional provisions' }),
    );
  return out;
}

export function buildRuleset(categories: CategoryDef[] = CATEGORIES): RuleDef[] {
  const rules: RuleDef[] = [];
  for (const cat of categories) {
    for (const fd of cat.fields) rules.push(...fieldRules(cat, fd));
    rules.push(...documentRules(cat), ...checkRules(cat), ...noticeRules(cat));
  }
  return rules;
}
