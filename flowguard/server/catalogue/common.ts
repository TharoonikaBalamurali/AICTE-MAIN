/**
 * Reusable, source-referenced building blocks for the category catalogue.
 * Source: AICTE Approval Process Handbook 2024-25 to 2026-27 (APH) and the
 * AICTE APH Document Requirements Matrix supplied with the project.
 */
import type { Condition, DocumentRequirement, FieldDef } from './types.ts';

// ---------------------------------------------------------------- authentication texts

export const AFFIDAVIT_OATH =
  'Rs. 100 Non-Judicial stamp paper / e-stamp paper, sworn before a First Class Judicial Magistrate, Notary or Oath Commissioner';
export const DSC_NOTE =
  'Documents uploaded to the portal must be digitally signed (DSC) — APH Ch. I §1.4.3, §1.4.6; Ch. II §2.3.4(a). Signature validity is not cryptographically verified by the portal; the applicant declares it and an authorised reviewer confirms.';

// ---------------------------------------------------------------- common fields

export const fAcademicYear: FieldDef = {
  id: 'academicYear',
  label: 'Academic year',
  type: 'select',
  group: 'Application',
  required: true,
  options: [
    { value: '2024-25', label: '2024-25' },
    { value: '2025-26', label: '2025-26' },
    { value: '2026-27', label: '2026-27' },
  ],
  help: 'APH 2024-25 to 2026-27 cycle. Stored to link the application and documents to an academic year.',
  classification: 'SYSTEM_METADATA',
};

export const fSignatoryName: FieldDef = {
  id: 'authorisedSignatoryName',
  label: 'Authorised signatory (Chairman / Secretary)',
  type: 'text',
  group: 'Applicant',
  required: true,
  validation: { maxLength: 120 },
  help: 'Format 3 resolutions are signed by the Chairman/Secretary of the Trust/Society/Company (Annexure 2).',
  aphReference: 'Annexure 2 (Format 3 signatory)',
  classification: 'APH_REQUIREMENT',
};

export const fSignatoryDesignation: FieldDef = {
  id: 'authorisedSignatoryDesignation',
  label: 'Signatory designation',
  type: 'select',
  group: 'Applicant',
  required: true,
  options: [
    { value: 'CHAIRMAN', label: 'Chairman / Chairperson' },
    { value: 'SECRETARY', label: 'Secretary' },
    { value: 'AUTHORISED_GOVT', label: 'Authorised person (Government / Government-aided)' },
  ],
  aphReference: 'Annexure 2 §2.1 (authentication paragraph)',
  classification: 'APH_REQUIREMENT',
};

export const fInstitutionCategory: FieldDef = {
  id: 'institutionCategory',
  label: 'Institution category',
  type: 'select',
  group: 'Institution',
  required: true,
  options: [
    { value: 'SELF_FINANCING', label: 'Self-financing (Trust / Society / Section 8 Company)' },
    { value: 'GOVERNMENT', label: 'Government' },
    { value: 'GOVERNMENT_AIDED', label: 'Government-aided' },
  ],
  help: 'Determines who authenticates supporting documents (Annexure 2 §2.1).',
  aphReference: 'Annexure 2 §2.1; Definitions 32, 33, 50',
  classification: 'APH_REQUIREMENT',
};

export const fAffiliatingBody: FieldDef = {
  id: 'affiliatingBody',
  label: 'Affiliating University / Board',
  type: 'text',
  group: 'Institution',
  required: true,
  validation: { maxLength: 160 },
  aphReference: 'Format 2 NOC issuer (Annexure 2)',
  classification: 'APH_REQUIREMENT',
};

export const fResolutionDate: FieldDef = {
  id: 'resolutionDate',
  label: 'Date of Format 3 resolution',
  type: 'date',
  group: 'Approvals',
  required: true,
  classification: 'SYSTEM_METADATA',
  help: 'Captured for cross-checking against the uploaded resolution.',
};

export const fNocReference: FieldDef = {
  id: 'nocReference',
  label: 'NOC (Format 2) reference / receipt number',
  type: 'text',
  group: 'Approvals',
  required: true,
  validation: { maxLength: 80 },
  classification: 'SYSTEM_METADATA',
};

export const fCourses = (id: string, label: string, required = true, help?: string): FieldDef => ({
  id,
  label,
  type: 'courses',
  group: 'Programmes & courses',
  required,
  help,
  classification: 'SYSTEM_METADATA',
});

// ---------------------------------------------------------------- building / EoA fields

export const fBuildingCompletionDate: FieldDef = {
  id: 'buildingCompletionCertificateDate',
  label: 'Completion Certificate issue date (main building)',
  type: 'date',
  group: 'Site & building',
  required: true,
  showWhen: { op: 'falsy', field: 'govtBuildingOver50NoOriginals' },
  help: 'Used to determine whether a Structural Stability Certificate is required (30 years after Completion Certificate).',
  aphReference: 'Ch. VI §6.17(h); Annexure 2 §2.1(iv)',
  classification: 'APH_REQUIREMENT',
};

export const fGovtBuildingException: FieldDef = {
  id: 'govtBuildingOver50NoOriginals',
  label: 'Government building older than 50 years whose original documents cannot be produced',
  type: 'boolean',
  group: 'Site & building',
  required: false,
  showWhen: { op: 'in', field: 'institutionCategory', values: ['GOVERNMENT', 'GOVERNMENT_AIDED'] },
  help: 'If yes, a Competent Authority letter confirming AICTE building norms are fulfilled is required.',
  aphReference: 'Annexure 2 §2.1 (preamble); Annexure 1 §1.1(xiii)',
  classification: 'APH_REQUIREMENT',
};

export const fOccupancyType: FieldDef = {
  id: 'occupancyCertificateType',
  label: 'Occupancy / Completion certificate type',
  type: 'select',
  group: 'Site & building',
  required: true,
  showWhen: { op: 'falsy', field: 'govtBuildingOver50NoOriginals' },
  options: [
    { value: 'FULL', label: 'Full Occupancy / Completion Certificate / Building Licence / Form D' },
    { value: 'PARTIAL', label: 'Partial / provisional Occupancy Certificate' },
  ],
  aphReference: 'Annexure 3 §3.1(c)',
  classification: 'APH_REQUIREMENT',
};

export const fPartialOcFirstYear: FieldDef = {
  id: 'partialOcFirstAcademicYear',
  label: 'Academic year from which the partial / provisional OC was first relied upon',
  type: 'select',
  group: 'Site & building',
  required: true,
  showWhen: { op: 'eq', field: 'occupancyCertificateType', value: 'PARTIAL' },
  options: [
    { value: '2022-23', label: '2022-23' },
    { value: '2023-24', label: '2023-24' },
    { value: '2024-25', label: '2024-25' },
    { value: '2025-26', label: '2025-26' },
    { value: '2026-27', label: '2026-27' },
  ],
  help: 'A partial / provisional OC is considered only for 2 consecutive academic years.',
  aphReference: 'Annexure 3 §3.1(c)',
  classification: 'APH_REQUIREMENT',
};

export const fTerPaymentMade: FieldDef = {
  id: 'terPaymentMade',
  label: 'A payment was made on the AICTE portal for this academic year',
  type: 'boolean',
  group: 'Fees',
  required: false,
  help: 'Annexure 2 §2.1(ii) requires the pay receipt print "if any".',
  aphReference: 'Annexure 2 §2.1(ii)',
  classification: 'APH_REQUIREMENT',
};

export const fLatitude: FieldDef = {
  id: 'mainEntranceLatitude',
  label: 'Latitude at entrance of main building',
  type: 'number',
  group: 'Site & building',
  required: true,
  validation: { min: 6, max: 38 },
  placeholder: 'e.g. 18.5204',
  help: 'Must also be marked on the uploaded satellite map. Range limited to India (system validation).',
  aphReference: 'Annexure 2 §2.1(vi)',
  classification: 'APH_REQUIREMENT',
};

export const fLongitude: FieldDef = {
  id: 'mainEntranceLongitude',
  label: 'Longitude at entrance of main building',
  type: 'number',
  group: 'Site & building',
  required: true,
  validation: { min: 68, max: 98 },
  placeholder: 'e.g. 73.8567',
  aphReference: 'Annexure 2 §2.1(vi)',
  classification: 'APH_REQUIREMENT',
};

export const eoaBuildingFields: FieldDef[] = [
  fInstitutionCategory,
  fGovtBuildingException,
  fBuildingCompletionDate,
  fOccupancyType,
  fPartialOcFirstYear,
  fLatitude,
  fLongitude,
  fTerPaymentMade,
];

// ---------------------------------------------------------------- documents

const baseChecks = ['Presence', 'File type PDF/JPG/PNG', 'Size limit', 'SHA-256 integrity hash recorded'];

export function resolutionFormat3(id: string, purpose: string, aphReference: string, extra: Partial<DocumentRequirement> = {}): DocumentRequirement {
  return {
    id,
    name: `Resolution of the Trust/Society/Company approving ${purpose} (Format 3)`,
    aphReference,
    level: 'MANDATORY',
    stage: 'SUBMISSION',
    issuer: 'Trust / Society / Company',
    format: 'Format 3',
    authentication: 'Signed by the Chairman / Secretary; uploaded with DSC',
    validity: { kind: 'NONE_STATED', description: 'No expiry period is stated for the resolution.' },
    metadata: ['issueDate', 'signatory', 'dscDeclared'],
    automatedChecks: [...baseChecks, 'Resolution date and signatory captured', 'DSC declaration recorded'],
    humanReview: 'Reviewer confirms the resolution is in Format 3, signed by the Chairman/Secretary and authorises the requested action.',
    verificationStatus: 'VERIFIED',
    classification: 'APH_REQUIREMENT',
    explanation: `Upload the Format 3 resolution approving ${purpose}, signed by the Chairman or Secretary.`,
    ...extra,
  };
}

export function nocFormat2(id: string, aphReference: string, extra: Partial<DocumentRequirement> = {}): DocumentRequirement {
  return {
    id,
    name: 'No Objection Certificate from the affiliating University / Board (Format 2)',
    aphReference,
    level: 'MANDATORY',
    stage: 'SUBMISSION',
    issuer: 'Affiliating University / Board',
    format: 'Format 2',
    authentication: 'Issued by the affiliating University / Board',
    validity: { kind: 'NONE_STATED', description: 'No fixed expiry period is stated for the NOC in Annexure 2.' },
    metadata: ['issueDate', 'issuer', 'referenceNumber', 'dscDeclared'],
    automatedChecks: [...baseChecks, 'Issuer and reference captured'],
    humanReview: 'Reviewer confirms the NOC is in Format 2, issued by the affiliating body named in the application, and covers the requested change.',
    verificationStatus: 'VERIFIED',
    classification: 'APH_REQUIREMENT',
    explanation: 'Upload the NOC (Format 2) issued by your affiliating University / Board.',
    ...extra,
  };
}

export function affidavit(
  id: string,
  number: number,
  statement: string,
  aphReference: string,
  extra: Partial<DocumentRequirement> = {},
): DocumentRequirement {
  return {
    id,
    name: `Affidavit ${number}${statement ? ` — ${statement}` : ''}`,
    aphReference,
    level: 'MANDATORY',
    stage: 'SUBMISSION',
    issuer: 'Applicant (deponent)',
    format: `Affidavit ${number} (prescribed format)`,
    authentication: AFFIDAVIT_OATH,
    validity: { kind: 'NONE_STATED', description: 'No general expiry duration is stated for affidavits in the cited clauses.' },
    metadata: ['issueDate', 'signatory', 'dscDeclared'],
    automatedChecks: [...baseChecks, 'Execution date and deponent captured', 'DSC declaration recorded'],
    humanReview: 'Reviewer verifies prescribed format/version, stamp paper value, oath authority and deponent.',
    verificationStatus: 'VERIFIED',
    classification: 'APH_REQUIREMENT',
    explanation: `Affidavit ${number} on ${AFFIDAVIT_OATH}.`,
    ...extra,
  };
}

const govtExceptionOff: Condition = { op: 'falsy', field: 'govtBuildingOver50NoOriginals' };

/** Annexure 2 §2.1 — EoA based on Self-Disclosure / after a break / restoration of intake. */
export function annexure2Section21(prefix: string): DocumentRequirement[] {
  return [
    affidavit(`${prefix}-AFF2`, 2, '', 'Annexure 2 §2.1(i); Ch. II §2.3.4(b)', {
      authentication: `Digitally signed by the Chairman/Secretary (self-financing) or authorised person (Government/Government-aided); ${AFFIDAVIT_OATH}`,
      explanation: 'Affidavit 2 with digital signature of the Chairman/Secretary (or the authorised person for Government / Government-aided institutions).',
    }),
    {
      id: `${prefix}-PAYRCPT`,
      name: 'Copy of pay receipt print made on the AICTE Web-Portal for the academic year',
      aphReference: 'Annexure 2 §2.1(ii)',
      level: 'CONDITIONAL',
      trigger: { op: 'truthy', field: 'terPaymentMade' },
      triggerDescription: 'Required when a payment was made on the AICTE portal for this academic year ("if any").',
      stage: 'SUBMISSION',
      issuer: 'AICTE Web-Portal payment gateway',
      validity: { kind: 'NONE_STATED', description: 'Linked to the respective academic year.' },
      metadata: ['issueDate', 'referenceNumber'],
      automatedChecks: [...baseChecks, 'Receipt reference captured'],
      humanReview: 'Reviewer matches the receipt to the academic year.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the portal pay receipt for this academic year, if a payment was made.',
    },
    {
      id: `${prefix}-OC`,
      name: 'Valid Occupancy Certificate / Completion Certificate / Building Licence / Form D',
      aphReference: 'Annexure 2 §2.1(iii); Ch. VI §6.17(g)',
      level: 'CONDITIONAL',
      trigger: govtExceptionOff,
      triggerDescription: 'Required unless the Government-building (>50 years, originals unavailable) exception applies.',
      stage: 'SUBMISSION',
      issuer: 'Competent Authority (Annexure 14)',
      format: 'Standard format prescribed by the issuing authority',
      validity: {
        kind: 'MUST_BE_VALID',
        description: 'Must be valid; APH does not prescribe a universal expiry period. Any expiry stated on the certificate is checked.',
        aphReference: 'Annexure 2 §2.1(iii)',
      },
      metadata: ['issueDate', 'expiryDate', 'issuer', 'referenceNumber', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Expiry date (if stated) not before submission'],
      humanReview: 'Reviewer confirms document type, issuing authority and applicability to the site.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the valid Occupancy/Completion Certificate, Building Licence or Form D issued by the Competent Authority.',
      verificationNote: 'Annexure 2 §2.1(iii) cites "Clause 7.17"; the provision on these certificates is Ch. VI §6.17(g). Recorded in the discrepancy register.',
    },
    {
      id: `${prefix}-SSC`,
      name: 'Valid Structural Stability Certificate from a registered Structural Engineer',
      aphReference: 'Annexure 2 §2.1(iv); Ch. VI §6.17(h)',
      level: 'CONDITIONAL',
      trigger: { op: 'yearsSinceGte', field: 'buildingCompletionCertificateDate', years: 30 },
      triggerDescription: 'Required when 30 or more years have passed since the Completion Certificate was issued.',
      stage: 'SUBMISSION',
      issuer: 'Registered Structural Engineer',
      validity: {
        kind: 'FIXED_PERIOD_FROM_ISSUE',
        years: 5,
        description: 'Valid for FIVE years from the date of issue.',
        aphReference: 'Ch. VI §6.17(h)',
      },
      metadata: ['issueDate', 'issuer', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Issue date within 5 years of submission'],
      humanReview: 'Reviewer confirms the engineer is registered and the certificate certifies fitness for human habitation.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Your building is 30+ years from its Completion Certificate: upload a Structural Stability Certificate issued within the last 5 years.',
    },
    {
      id: `${prefix}-FIRE`,
      name: 'Valid Fire Safety Certificate issued by the Competent Authority',
      aphReference: 'Annexure 2 §2.1(v); Ch. VI §6.17(i)',
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Competent Authority (State Fire Department)',
      validity: {
        kind: 'MUST_BE_VALID',
        description: 'Must be valid. The APH prescribes no universal number of years — the expiry stated by the issuing authority is checked.',
        aphReference: 'Ch. VI §6.17(i)',
      },
      metadata: ['issueDate', 'expiryDate', 'issuer', 'referenceNumber', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Expiry date (if stated) not before submission'],
      humanReview: 'If no expiry is stated on the certificate, validity is confirmed by an authorised reviewer.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload a currently valid Fire Safety Certificate. Enter the expiry date exactly as printed on it.',
    },
    {
      id: `${prefix}-SATMAP`,
      name: 'Satellite map showing land location with latitude/longitude at main building entrance',
      aphReference: 'Annexure 2 §2.1(vi)',
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Applicant (prepared using a suitable website)',
      validity: { kind: 'NONE_STATED', description: 'No validity period stated.' },
      metadata: ['dscDeclared'],
      automatedChecks: [...baseChecks, 'Coordinates entered in the form'],
      humanReview: 'Reviewer confirms the coordinates on the map match the form.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload a satellite map with the latitude and longitude at the entrance of the main building marked on it.',
    },
    {
      id: `${prefix}-AUDIT`,
      name: 'Audited statement of accounts of the Trust/Society/Company for the previous year',
      aphReference: 'Annexure 2 §2.1(vii)',
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Trust / Society / Company (audited)',
      validity: {
        kind: 'PERIOD_COVERED',
        description: 'Must cover the previous year. No number-of-days freshness rule is stated.',
        aphReference: 'Annexure 2 §2.1(vii)',
      },
      metadata: ['financialYear', 'issueDate', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Financial year recorded'],
      humanReview: 'Reviewer confirms the statement is audited and covers the previous year.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the audited statement of accounts for the previous year and state the financial year it covers.',
    },
    {
      id: `${prefix}-GOVTLTR`,
      name: 'Competent Authority letter confirming AICTE building norms are fulfilled (Government building > 50 years)',
      aphReference: 'Annexure 2 §2.1 (preamble)',
      level: 'CONDITIONAL',
      trigger: { op: 'truthy', field: 'govtBuildingOver50NoOriginals' },
      triggerDescription: 'Required when the building was constructed by a Government department more than 50 years ago and original documents cannot be produced.',
      stage: 'SUBMISSION',
      issuer: 'Competent Authority',
      validity: { kind: 'NONE_STATED', description: 'No validity period stated.' },
      metadata: ['issueDate', 'issuer', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Reviewer confirms the letter states AICTE building norms are fulfilled.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the Competent Authority letter that replaces the original building documents.',
    },
  ];
}

/** Annexure 1 §1.1 — scrutiny-stage documents for a new institution (also used for Change of Site). */
export function annexure1Section11(prefix: string, opts: { forSiteChange?: boolean } = {}): DocumentRequirement[] {
  const ref = (s: string) => `Annexure 1 §1.1(${s})`;
  const isLease: Condition = { op: 'in', field: 'landTenure', values: ['GOVT_LEASE', 'PRIVATE_LEASE'] };
  const isPrivateLease: Condition = { op: 'eq', field: 'landTenure', value: 'PRIVATE_LEASE' };
  const isPrivateBuildingLease: Condition = { op: 'truthy', field: 'buildingPrivatelyLeased' };
  const docs: DocumentRequirement[] = [
    {
      id: `${prefix}-BPLAN`,
      name: 'Approved Building Plan (Certificate 2) prepared by a COA-registered Architect / Licensed Surveyor (Certificate 1)',
      aphReference: `${ref('i')}; Ch. I §1.5.1(c); Annexure 14`,
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Architect / Licensed Surveyor; approved by Competent Authority designated by State/UT',
      format: 'Certificate 1 and Certificate 2; two copies of the Building Plan',
      authentication: 'Prepared by registered Architect / Licensed Surveyor; approved by Competent Authority',
      validity: { kind: 'NONE_STATED', description: 'No expiry stated.' },
      metadata: ['issueDate', 'issuer', 'referenceNumber', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Approving authority captured'],
      humanReview: 'Adequacy of plans is assessed by the Scrutiny Committee / EVC.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the approved Building Plan (Certificate 2) with the Architect/Surveyor certificate (Certificate 1).',
    },
    affidavit(`${prefix}-AFF2`, 2, '', `${ref('ii')}; Ch. I §1.4.4`),
    resolutionFormat3(`${prefix}-RES`, opts.forSiteChange ? 'the Change of Site / Location' : 'starting the Technical Institution', ref('iii')),
    {
      id: `${prefix}-OC`,
      name: 'Occupancy Certificate / Completion Certificate / Building Licence / Form D (as applicable)',
      aphReference: `${ref('iv')}; Ch. VI §6.17(g)`,
      level: 'CONDITIONAL',
      trigger: { op: 'truthy', field: 'buildingComplete' },
      triggerDescription: 'Required when the building is complete. Otherwise the affidavit undertaking below is required.',
      stage: 'SUBMISSION',
      issuer: 'Competent Authority',
      format: 'Standard format prescribed by the issuing authority',
      validity: { kind: 'MUST_BE_VALID', description: 'Applicable certificate from the Competent Authority; any stated expiry is checked.' },
      metadata: ['issueDate', 'expiryDate', 'issuer', 'referenceNumber', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Expiry date (if stated) not before submission'],
      humanReview: 'Reviewer confirms certificate type and issuing authority.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the Occupancy/Completion Certificate, Building Licence or Form D.',
    },
    affidavit(`${prefix}-OCUNDERTAKING`, 0, '', ref('iv'), {
      name: 'Affidavit undertaking that the Occupancy / Completion Certificate will be produced on completion of the building',
      format: 'Affidavit (no numbered format specified in §1.1(iv))',
      level: 'CONDITIONAL',
      trigger: { op: 'falsy', field: 'buildingComplete' },
      triggerDescription: 'Required for the rest — when the building is not yet complete.',
      explanation: 'Your building is not yet complete: upload the affidavit undertaking to produce the certificate on completion.',
    }),
    {
      id: `${prefix}-FIRE`,
      name: 'Valid Fire Safety Certificate issued by the Competent Authority',
      aphReference: `${ref('v')}; Ch. VI §6.17(i); Annexure 3 §3.1(d)`,
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Fire Department of the State Government',
      validity: { kind: 'MUST_BE_VALID', description: 'Must be valid; expiry stated by the issuing authority is checked. No universal period in the APH.' },
      metadata: ['issueDate', 'expiryDate', 'issuer', 'referenceNumber', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Expiry date (if stated) not before submission'],
      humanReview: 'If no expiry is stated, validity is confirmed by an authorised reviewer.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload a valid Fire Safety Certificate; enter the expiry date printed on it.',
    },
    {
      id: `${prefix}-CERT3`,
      name: 'Certificate 3 issued by the Bank Manager regarding financial status of the Applicant',
      aphReference: `${ref('vi')}; Ch. I §1.5.3`,
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Bank Manager (Nationalised / Scheduled Commercial Bank)',
      format: 'Certificate 3',
      validity: { kind: 'NONE_STATED', description: 'Fund position is assessed on the date of Scrutiny (Ch. I §1.5.3).' },
      metadata: ['issueDate', 'issuer', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Issue date captured'],
      humanReview: 'Scrutiny Committee verifies funds against Table 1.2 on the date of Scrutiny.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload Certificate 3 from your Bank Manager on the applicant’s financial status.',
    },
    {
      id: `${prefix}-APPCOPY`,
      name: 'Copy of the complete application as uploaded to the AICTE Web-Portal',
      aphReference: ref('vii'),
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Applicant',
      validity: { kind: 'NONE_STATED', description: 'No validity period.' },
      metadata: ['dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Reviewer confirms the copy matches the submitted application.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload a copy of your complete application as submitted on the AICTE portal.',
      verificationNote: 'APH §1.1(vii) refers to a hard copy presented at Scrutiny; the portal collects a digital copy.',
    },
    {
      id: `${prefix}-REGDOC`,
      name: 'Registration document of the Trust/Society/Company/PPP/BOT with members, objectives, MoA and Rules (attested)',
      aphReference: ref('viii'),
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Concerned Competent Authority (Registrar / Charity Commissioner / RoC)',
      authentication: 'Duly attested / certified by the concerned Competent Authority',
      validity: { kind: 'NONE_STATED', description: 'No validity period.' },
      metadata: ['issueDate', 'issuer', 'referenceNumber', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Legal reviewer confirms registration and objectives.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the attested registration document showing members, objectives, MoA and Rules.',
    },
    {
      id: `${prefix}-BOG`,
      name: 'Recommended composition of the Board of Governors (Annexure 17)',
      aphReference: ref('ix'),
      level: 'CONDITIONAL',
      trigger: { op: 'truthy', field: 'standalonePgdm' },
      triggerDescription: 'Required for Standalone PGDM institutions.',
      stage: 'SUBMISSION',
      issuer: 'Applicant',
      format: 'As per Annexure 17',
      validity: { kind: 'NONE_STATED', description: 'No validity period.' },
      metadata: ['dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Reviewer checks composition against Annexure 17.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Standalone PGDM institutions must upload the recommended BoG composition.',
    },
    {
      id: `${prefix}-SEC8`,
      name: 'MoA and Rules of the Section 8 Company containing the not-for-profit / surplus-use provision',
      aphReference: ref('x'),
      level: 'CONDITIONAL',
      trigger: { op: 'eq', field: 'legalEntityType', value: 'SECTION_8_COMPANY' },
      triggerDescription: 'Required when the applicant is a Section 8 Company.',
      stage: 'SUBMISSION',
      issuer: 'Registrar of Companies',
      validity: { kind: 'NONE_STATED', description: 'No validity period.' },
      metadata: ['issueDate', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Legal reviewer confirms the non-profit clause.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the MoA and Rules showing the company is not profit making and surplus is used only for the institution.',
    },
    resolutionFormat3(`${prefix}-PPPRES`, 'starting the Technical Institution and allocation of land/building/funds (PPP/BOT proposal)', ref('xi'), {
      level: 'CONDITIONAL',
      trigger: { op: 'eq', field: 'legalEntityType', value: 'PPP_BOT' },
      triggerDescription: 'Required for a PPP / BOT proposal.',
    }),
    {
      id: `${prefix}-LAND`,
      name: 'Land / building ownership document: registered Settlement / Sale / Irrevocable Gift deed or registered Government / Private lease deed (minimum 30 years)',
      aphReference: `${ref('xii')}; Ch. VI §6.17(a)-(b)`,
      level: 'MANDATORY',
      stage: 'SUBMISSION',
      issuer: 'Sub-Registrar / registration authority',
      authentication: 'Registered; notarised English translation if in a vernacular language',
      validity: {
        kind: 'NONE_STATED',
        description: 'For leases: minimum 30-year lease with at least 5 years of programme duration live at application time (checked from the lease dates entered).',
        aphReference: ref('xii'),
      },
      metadata: ['issueDate', 'referenceNumber', 'dscDeclared'],
      automatedChecks: [...baseChecks, 'Lease term and live period checked from form dates'],
      humanReview: 'Legal title is always verified by an authorised human reviewer.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the registered title deed or registered lease deed for the land/building.',
    },
    affidavit(`${prefix}-AFF7`, 7, 'joint affidavit of the parties that the lease of land is irrevocable for 30 years', 'Annexure 1 §1.1 (p. 78)', {
      level: 'CONDITIONAL',
      trigger: isLease,
      triggerDescription: 'Required when the land is held on lease.',
    }),
  ];
  // Private lease of land (Annexure 1, p. 78)
  docs.push(
    {
      id: `${prefix}-LUC`,
      name: 'Land Conversion Certificate issued by the Competent Authority',
      aphReference: 'Annexure 1 — Private Lease of Land (ii); Ch. VI §6.17(e)',
      level: 'CONDITIONAL',
      trigger: isPrivateLease,
      triggerDescription: 'Listed for private lease of land.',
      stage: 'SUBMISSION',
      issuer: 'Competent Authority designated by the State/UT',
      validity: { kind: 'NONE_STATED', description: 'No validity period.' },
      metadata: ['issueDate', 'issuer', 'referenceNumber', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Reviewer confirms land use permits educational purpose.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the Land Conversion Certificate for the leased land.',
      verificationNote: 'Ch. VI §6.17(e) states a Land Use/Conversion Certificate shall be obtained generally; Annexure 1 lists it under private lease. Recorded in the discrepancy register; reviewer confirms for other tenures.',
    },
    {
      id: `${prefix}-LESSORTITLE`,
      name: "Lessor's title documents showing acquisition of leasehold rights through a lawful transaction",
      aphReference: 'Annexure 1 — Private Lease of Land (iii)',
      level: 'CONDITIONAL',
      trigger: isPrivateLease,
      triggerDescription: 'Required for private lease of land.',
      stage: 'SUBMISSION',
      issuer: 'Registration authority',
      validity: { kind: 'NONE_STATED', description: 'No validity period.' },
      metadata: ['issueDate', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Legal reviewer examines the chain of title.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: "Upload the lessor's title documents.",
    },
    {
      id: `${prefix}-ENCUMB`,
      name: 'Encumbrance Certificate for the property (dated not later than the Council notification date)',
      aphReference: 'Annexure 1 — Private Lease of Land (iv)',
      level: 'CONDITIONAL',
      trigger: isPrivateLease,
      triggerDescription: 'Required for private lease of land.',
      stage: 'SUBMISSION',
      issuer: 'Sub-Registrar',
      validity: { kind: 'NONE_STATED', description: 'Date relative to the Council notification — confirmed by a reviewer.' },
      metadata: ['issueDate', 'issuer', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Reviewer compares the certificate date with the Council notification date.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the Encumbrance Certificate for the leased property.',
    },
    resolutionFormat3(`${prefix}-LESSORRES`, 'the lease (lessor is a Trust/Society/Company)', 'Annexure 1 — Private Lease of Land (v)', {
      name: 'Resolution of the lessor Trust/Society/Company',
      format: 'Resolution (format not specified)',
      level: 'CONDITIONAL',
      trigger: { op: 'and', conditions: [isPrivateLease, { op: 'truthy', field: 'lessorIsEntity' }] },
      triggerDescription: 'Required if the lessor is a Trust, Society or Company.',
      explanation: 'Upload the resolution of the lessor organisation.',
    }),
    {
      id: `${prefix}-BLDGLEASE`,
      name: 'Private lease of building: complete approved plan / floor plan, OC for leased floors, land title and registered lease deed',
      aphReference: 'Annexure 1 — Private Lease of Building (i)-(iv)',
      level: 'CONDITIONAL',
      trigger: isPrivateBuildingLease,
      triggerDescription: 'Required when the building (or floors) is privately leased.',
      stage: 'SUBMISSION',
      issuer: 'Competent Authority / registration authority',
      validity: { kind: 'NONE_STATED', description: 'No validity period stated.' },
      metadata: ['issueDate', 'referenceNumber', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Reviewer checks each listed element is present in the bundle.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the bundle of documents required for a privately leased building.',
    },
    {
      id: `${prefix}-LANDUSE`,
      name: 'Land Use Certificate (educational purpose) with topo sketch / village map and road map of the site',
      aphReference: 'Annexure 1 — Private Lease of Building (vi); Ch. VI §6.17(e)',
      level: 'CONDITIONAL',
      trigger: isPrivateBuildingLease,
      triggerDescription: 'Listed for private lease of building.',
      stage: 'SUBMISSION',
      issuer: 'Competent Authority',
      validity: { kind: 'NONE_STATED', description: 'No validity period.' },
      metadata: ['issueDate', 'issuer', 'dscDeclared'],
      automatedChecks: baseChecks,
      humanReview: 'Reviewer confirms educational land use.',
      verificationStatus: 'VERIFIED',
      classification: 'APH_REQUIREMENT',
      explanation: 'Upload the Land Use Certificate with the topo sketch and road map.',
    },
  );
  // Items printed after the building-lease list (Annexure 1 pp. 78-79). Their scope is ambiguous in the text layout.
  const ambiguous = (id: string, name: string, item: string, extra: Partial<DocumentRequirement> = {}): DocumentRequirement => ({
    id: `${prefix}-${id}`,
    name,
    aphReference: `Annexure 1 pp. 78-79, item (${item})`,
    level: 'OPTIONAL',
    stage: 'SUBMISSION',
    issuer: 'As stated in the APH item',
    validity: { kind: 'NONE_STATED', description: 'No validity period stated.' },
    metadata: ['issueDate', 'dscDeclared'],
    automatedChecks: baseChecks,
    humanReview: 'Scrutiny Committee decides applicability.',
    verificationStatus: 'NEEDS_VERIFICATION',
    classification: 'NEEDS_VERIFICATION',
    explanation: 'Upload if applicable to your case. Applicability is confirmed by the reviewer.',
    verificationNote:
      'Printed as items (vii)-(xiii) under "Private Lease of Building"; whether they apply to all applicants could not be established from the extracted text. Not enforced as mandatory.',
    ...extra,
  });
  docs.push(
    ambiguous('FLOORPLANS', 'Floor plans, sections and elevations with room-wise carpet areas, certified by a COA Architect', 'vii'),
    ambiguous('WORKCAP', 'Proof of working capital (FDs or latest bank statement) with Branch Manager certificate (Ch. I §1.5.3)', 'viii'),
    ambiguous('AUDIT3Y', 'Audited statement of accounts of the Applicant Organisation for the last three years (as applicable)', 'ix'),
    ambiguous('MINORITY', 'Minority Status certificate (if applicable)', 'x'),
    ambiguous('DPR', 'Detailed Project Report (DPR)', 'xi'),
    ambiguous('HTLINE', 'Undertaking that no high-tension line passes through the campus, or Electricity Board safety certificate', 'xii'),
    ambiguous('GOVTLTR', 'Competent Authority letter that AICTE building norms are fulfilled (Government buildings > 50 years)', 'xiii'),
  );
  return docs;
}

export function closureStudentDocs(prefix: string, ref: string): DocumentRequirement[] {
  const d = (id: string, name: string, item: string, humanReview: string): DocumentRequirement => ({
    id: `${prefix}-${id}`,
    name,
    aphReference: `${ref}(${item})`,
    level: 'MANDATORY',
    stage: 'SUBMISSION',
    issuer: 'Institution',
    validity: { kind: 'NONE_STATED', description: 'No expiry stated.' },
    metadata: ['issueDate', 'dscDeclared'],
    automatedChecks: baseChecks,
    humanReview,
    verificationStatus: 'VERIFIED',
    classification: 'APH_REQUIREMENT',
    explanation: `Upload: ${name}.`,
  });
  return [
    d('SALARY', 'Latest salary sheet (scale of pay, gross pay, PF deduction, TDS) for all faculty and non-teaching staff, with Faculty:Student ratio', 'ii', 'Reviewer reconciles staff liabilities.'),
    d('RPGF', 'Details of the RPGF / Joint FDR made with AICTE', 'iii', 'Reviewer checks deposit status.'),
    d('STUDENTS', 'Status of existing students studying in the Institution', 'iv', 'Student protection is assessed by the Committee.'),
    d('STAFF', 'Status of existing faculty and staff and liabilities thereon', 'v', 'Liabilities are assessed by the Committee.'),
    d('LITIGATION', 'Pending court cases, serious charges, violation of norms and pending ragging cases against the Institution', 'vii', 'Legal reviewer assesses declarations.'),
  ];
}
