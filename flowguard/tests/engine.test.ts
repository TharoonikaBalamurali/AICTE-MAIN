import { describe, expect, it } from 'vitest';
import { CATEGORIES, getCategory } from '../server/catalogue/categories.ts';
import { evaluate, isCondition } from '../server/rules/conditions.ts';
import { runEngine, type EngineInput } from '../server/rules/engine.ts';
import { buildRuleset, type RuleDef } from '../server/rules/ruleset.ts';

const rules = buildRuleset();
const doc = (requirementId: string, metadata: Record<string, unknown> = {}) => ({
  requirementId,
  documentId: requirementId,
  version: 1,
  sha256: 'x'.repeat(64),
  metadata: { dscDeclared: true, ...metadata },
});

const eoaBase = (): EngineInput => ({
  applicationType: 'EOA_SELF_DISCLOSURE',
  subtype: null,
  evaluationDate: '2026-10-24',
  documentStage: 'SUBMISSION',
  fields: {
    academicYear: '2026-27',
    authorisedSignatoryName: 'A Person',
    authorisedSignatoryDesignation: 'SECRETARY',
    institutionCategory: 'SELF_FINANCING',
    buildingCompletionCertificateDate: '2010-01-01',
    occupancyCertificateType: 'FULL',
    mainEntranceLatitude: 18.52,
    mainEntranceLongitude: 73.85,
    auditedAccountsFinancialYear: '2025-26',
  },
  documents: [doc('EOA-AFF2'), doc('EOA-OC', { expiryDate: '2030-01-01' }), doc('EOA-FIRE', { expiryDate: '2027-03-31' }), doc('EOA-SATMAP'), doc('EOA-AUDIT', { financialYear: '2025-26' })],
});

const blockers = (input: EngineInput, r: RuleDef[] = rules) => runEngine(input, r).findings.filter((f) => f.blocking).map((f) => f.ruleId);

describe('catalogue', () => {
  it('defines exactly the 22 requested menu categories, all searchable', () => {
    expect(CATEGORIES).toHaveLength(22);
    expect(new Set(CATEGORIES.map((c) => c.menuNumber)).size).toBe(22);
    for (const c of CATEGORIES) expect(c.keywords.length).toBeGreaterThan(0);
  });
  it('gives every category its own checklist (no generic list)', () => {
    const signatures = CATEGORIES.filter((c) => c.documents.length).map((c) => c.documents.map((d) => d.name).join('|'));
    // Categories sharing a checklist are allowed only where the APH itself shares it.
    expect(new Set(signatures).size).toBeGreaterThan(15);
  });
  it('every document requirement carries a source reference and classification', () => {
    for (const c of CATEGORIES)
      for (const d of c.documents) {
        expect(d.aphReference, `${c.code}/${d.id}`).toBeTruthy();
        expect(d.classification).toBeTruthy();
        expect(d.explanation).toBeTruthy();
      }
  });
  it('disables final submission for ODL/OL pending verification', () => {
    expect(getCategory('ODL_OL')!.submissionEnabled).toBe(false);
  });
  it('rule conditions are well-formed structured data', () => {
    for (const r of rules) {
      for (const k of ['trigger', 'applicableWhen', 'failWhen'] as const) {
        const c = r.condition[k];
        if (c) expect(isCondition(c), r.ruleId).toBe(true);
      }
    }
  });
});

describe('conditions', () => {
  const ctx = (fields: Record<string, unknown>) => ({ fields, subtype: null, evaluationDate: '2026-10-24' });
  it('yearsSinceGte is exact on the anniversary', () => {
    expect(evaluate({ op: 'yearsSinceGte', field: 'd', years: 30 }, ctx({ d: '1996-10-24' }))).toBe(true);
    expect(evaluate({ op: 'yearsSinceGte', field: 'd', years: 30 }, ctx({ d: '1996-10-25' }))).toBe(false);
  });
  it('containsWord matches whole words only', () => {
    expect(evaluate({ op: 'containsWord', field: 'n', words: ['IIT'] }, ctx({ n: 'Pune IIT College' }))).toBe(true);
    expect(evaluate({ op: 'containsWord', field: 'n', words: ['IIT'] }, ctx({ n: 'Kiitx Institute' }))).toBe(false);
  });
  it('rejects malformed conditions', () => {
    expect(isCondition({ op: 'eval', code: 'process.exit()' })).toBe(false);
  });
});

describe('rules engine — EoA Self-Disclosure', () => {
  it('passes a complete, valid application', () => {
    expect(blockers(eoaBase())).toEqual([]);
  });
  it('is deterministic for the same input and rule versions', () => {
    const a = runEngine(eoaBase(), rules);
    const b = runEngine(eoaBase(), rules);
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.findings).toEqual(b.findings);
  });
  it('detects a missing mandatory document', () => {
    const i = eoaBase();
    i.documents = i.documents.filter((d) => d.requirementId !== 'EOA-FIRE');
    expect(blockers(i)).toContain('EOA_SELF_DISCLOSURE.DOC.EOA-FIRE.PRESENT');
  });
  it('detects an expired Fire Safety Certificate', () => {
    const i = eoaBase();
    i.documents.find((d) => d.requirementId === 'EOA-FIRE')!.metadata.expiryDate = '2026-01-01';
    expect(blockers(i)).toContain('EOA_SELF_DISCLOSURE.DOC.EOA-FIRE.NOT_EXPIRED');
  });
  it('sends a fire certificate without a stated expiry to human review instead of inventing a period', () => {
    const i = eoaBase();
    delete i.documents.find((d) => d.requirementId === 'EOA-FIRE')!.metadata.expiryDate;
    const f = runEngine(i, rules).findings.find((x) => x.ruleId === 'EOA_SELF_DISCLOSURE.DOC.EOA-FIRE.NOT_EXPIRED')!;
    expect(f.outcome).toBe('HUMAN_REVIEW');
    expect(f.blocking).toBe(false);
  });
  it('requires the Structural Stability Certificate only when the building is 30+ years old', () => {
    const young = eoaBase();
    expect(blockers(young)).not.toContain('EOA_SELF_DISCLOSURE.DOC.EOA-SSC.PRESENT');
    const old = eoaBase();
    old.fields.buildingCompletionCertificateDate = '1990-06-01';
    expect(blockers(old)).toContain('EOA_SELF_DISCLOSURE.DOC.EOA-SSC.PRESENT');
  });
  it('enforces the 5-year validity of the Structural Stability Certificate', () => {
    const i = eoaBase();
    i.fields.buildingCompletionCertificateDate = '1990-06-01';
    i.documents.push(doc('EOA-SSC', { issueDate: '2020-01-01' }));
    expect(blockers(i)).toContain('EOA_SELF_DISCLOSURE.DOC.EOA-SSC.VALID_FROM_ISSUE');
    i.documents[i.documents.length - 1].metadata.issueDate = '2023-01-01';
    expect(blockers(i)).toEqual([]);
  });
  it('limits a partial OC to two consecutive academic years', () => {
    const i = eoaBase();
    i.fields.occupancyCertificateType = 'PARTIAL';
    i.fields.partialOcFirstAcademicYear = '2025-26';
    expect(blockers(i)).toEqual([]);
    i.fields.partialOcFirstAcademicYear = '2024-25';
    expect(blockers(i)).toContain('EOA_SELF_DISCLOSURE.CHECK.PARTIAL_OC_2AY');
  });
  it('switches to the Government-building letter when the >50-year exception applies', () => {
    const i = eoaBase();
    i.fields.institutionCategory = 'GOVERNMENT';
    i.fields.govtBuildingOver50NoOriginals = true;
    delete i.fields.buildingCompletionCertificateDate;
    delete i.fields.occupancyCertificateType;
    i.documents = i.documents.filter((d) => d.requirementId !== 'EOA-OC');
    const b = blockers(i);
    expect(b).toContain('EOA_SELF_DISCLOSURE.DOC.EOA-GOVTLTR.PRESENT');
    expect(b).not.toContain('EOA_SELF_DISCLOSURE.DOC.EOA-OC.PRESENT');
    expect(b).not.toContain('EOA_SELF_DISCLOSURE.FIELD.buildingCompletionCertificateDate.REQUIRED');
  });
  it('blocks documents without the DSC declaration', () => {
    const i = eoaBase();
    i.documents[0].metadata.dscDeclared = false;
    expect(blockers(i)).toContain('EOA_SELF_DISCLOSURE.DOC.EOA-AFF2.DSC');
  });
  it('flags an audited-accounts year mismatch for human review only (rule not approved)', () => {
    const i = eoaBase();
    i.documents.find((d) => d.requirementId === 'EOA-AUDIT')!.metadata.financialYear = '2022-23';
    const r = runEngine(i, rules);
    expect(r.summary.blocking).toBe(0);
    expect(r.findings.find((f) => f.ruleId.endsWith('EOA-AUDIT.PERIOD'))!.outcome).toBe('HUMAN_REVIEW');
  });
  it('does not execute retired rules, and non-approved rules never block', () => {
    const i = eoaBase();
    i.documents = i.documents.filter((d) => d.requirementId !== 'EOA-FIRE');
    const retired = rules.map((r) => (r.ruleId === 'EOA_SELF_DISCLOSURE.DOC.EOA-FIRE.PRESENT' ? { ...r, lifecycleStatus: 'RETIRED' as const } : r));
    expect(blockers(i, retired)).not.toContain('EOA_SELF_DISCLOSURE.DOC.EOA-FIRE.PRESENT');
    const unverified = rules.map((r) => (r.ruleId === 'EOA_SELF_DISCLOSURE.DOC.EOA-FIRE.PRESENT' ? { ...r, lifecycleStatus: 'NEEDS_VERIFICATION' as const } : r));
    const f = runEngine(i, unverified).findings.find((x) => x.ruleId === 'EOA_SELF_DISCLOSURE.DOC.EOA-FIRE.PRESENT')!;
    expect(f.outcome).toBe('HUMAN_REVIEW');
    expect(f.blocking).toBe(false);
  });
});

describe('rules engine — category specifics', () => {
  it('NRI seats are capped at 5% of approved intake', () => {
    const input: EngineInput = {
      applicationType: 'NRI_SEATS',
      subtype: 'INTRODUCTION',
      evaluationDate: '2026-10-24',
      documentStage: 'SUBMISSION',
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'X', authorisedSignatoryDesignation: 'CHAIRMAN', nriCourses: [{ course: 'CSE' }], approvedIntake: 120, nriSeatsRequested: 7, resolutionDate: '2026-09-01' },
      documents: [doc('NRI-RES')],
    };
    expect(blockers(input)).toContain('NRI_SEATS.CHECK.NRI_MAX_5PCT');
    input.fields.nriSeatsRequested = 6;
    expect(blockers(input)).toEqual([]);
  });
  it('closure NOC applies only to the closure subtype of course changes', () => {
    const base: EngineInput = {
      applicationType: 'COURSE_CHANGES',
      subtype: 'NAME_CHANGE',
      evaluationDate: '2026-10-24',
      documentStage: 'SUBMISSION',
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'X', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'U', affectedCourses: [{ course: 'ME' }], resolutionDate: '2026-09-01', nomenclatureNotOffered: true },
      documents: [doc('CRS-RES')],
    };
    expect(blockers(base)).toEqual([]);
    const closure = { ...base, subtype: 'CLOSURE', fields: { ...base.fields, existingStudents: 10, courseDurationYears: 4, alternativeArrangements: 'Transfer' } };
    expect(blockers(closure)).toContain('COURSE_CHANGES.DOC.CRS-NOC.PRESENT');
  });
  it('name change accepts either the NOC or the sealed receipt', () => {
    const input: EngineInput = {
      applicationType: 'INSTITUTION_NAME_CHANGE',
      subtype: null,
      evaluationDate: '2026-10-24',
      documentStage: 'SUBMISSION',
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'X', authorisedSignatoryDesignation: 'CHAIRMAN', institutionCategory: 'SELF_FINANCING', affiliatingBody: 'U', currentName: 'A', proposedName: 'B College of Engineering', nameChangeReason: 'r', resolutionDate: '2026-09-01' },
      documents: [doc('NAME-RES')],
    };
    expect(blockers(input)).toContain('INSTITUTION_NAME_CHANGE.DOC.NAME_NOC_OR_RECEIPT.PRESENT');
    input.documents.push(doc('NAME-RCPT'));
    expect(blockers(input)).toEqual([]);
    input.fields.proposedName = 'National Institute of Excellence';
    const r = runEngine(input, rules);
    expect(r.findings.find((f) => f.ruleId.endsWith('NAME_RESTRICTED_WORDS'))!.outcome).toBe('WARNING');
    expect(r.summary.blocking).toBe(0);
  });
  it('lease checks: 30-year term and 5-year live period', () => {
    const cat = getCategory('NEW_TECHNICAL_INSTITUTION')!;
    const input: EngineInput = { applicationType: cat.code, subtype: null, evaluationDate: '2026-10-24', documentStage: 'SUBMISSION', fields: { landTenure: 'PRIVATE_LEASE', leaseStartDate: '2020-01-01', leaseEndDate: '2045-01-01', maxProgrammeDurationYears: 4 }, documents: [] };
    const ids = runEngine(input, rules).findings.filter((f) => f.outcome === 'FAIL').map((f) => f.ruleId);
    expect(ids).toContain('NEW_TECHNICAL_INSTITUTION.CHECK.LEASE_TERM_30Y');
    expect(ids).not.toContain('NEW_TECHNICAL_INSTITUTION.CHECK.LEASE_LIVE_5Y');
    input.fields.leaseEndDate = '2050-01-01';
    input.fields.leaseStartDate = '1995-01-01';
    expect(runEngine(input, rules).findings.find((f) => f.ruleId.endsWith('LEASE_TERM_30Y'))!.outcome).toBe('PASS');
  });
  it('EVC-stage documents are not required at submission', () => {
    const input: EngineInput = { applicationType: 'NEW_TECHNICAL_INSTITUTION', subtype: null, evaluationDate: '2026-10-24', documentStage: 'SUBMISSION', fields: {}, documents: [] };
    const ids = runEngine(input, rules).findings.map((f) => f.ruleId);
    expect(ids.some((i) => i.includes('NTI-EVC-'))).toBe(false);
    const evc = runEngine({ ...input, documentStage: 'EVC' }, rules).findings.map((f) => f.ruleId);
    expect(evc.some((i) => i.includes('NTI-EVC-VIDEO.PRESENT'))).toBe(true);
  });
});
