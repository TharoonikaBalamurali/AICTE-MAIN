/**
 * Types for the source-referenced regulatory catalogue.
 *
 * Every field, document requirement and rule carries a classification so that
 * APH-derived requirements are never confused with software metadata or policy.
 */

export type Classification =
  | 'APH_REQUIREMENT' // explicitly supported by a source clause
  | 'SYSTEM_METADATA' // needed for tracking / software operation
  | 'NEEDS_VERIFICATION' // cannot be conclusively established from the supplied sources
  | 'HUMAN_REVIEW_REQUIRED' // requires authorised human assessment
  | 'SYSTEM_POLICY'; // technical / operational control that is not an APH mandate

export type VerificationStatus = 'VERIFIED' | 'NEEDS_VERIFICATION';

/** Safe, structured condition schema. Never executed as code. */
export type Condition =
  | { op: 'eq'; field: string; value: string | number | boolean }
  | { op: 'neq'; field: string; value: string | number | boolean }
  | { op: 'in'; field: string; values: Array<string | number> }
  | { op: 'truthy'; field: string }
  | { op: 'falsy'; field: string }
  | { op: 'subtypeIn'; values: string[] }
  /** true when the date in `field` is at least `years` before the evaluation date */
  | { op: 'yearsSinceGte'; field: string; years: number }
  | { op: 'lt' | 'gt' | 'lte' | 'gte'; field: string; value: number }
  /** field > ratio * ofField */
  | { op: 'gtRatioOf'; field: string; ofField: string; ratio: number }
  /** field < ratio * ofField */
  | { op: 'ltRatioOf'; field: string; ofField: string; ratio: number }
  /** number of entries in an array field (e.g. a course list) is below value */
  | { op: 'lengthLt'; field: string; value: number }
  /** whole years between two date fields is below `years` */
  | { op: 'yearsBetweenLt'; from: string; to: string; years: number }
  /** years from the evaluation date until the date in `field` is below `years` */
  | { op: 'yearsUntilLt'; field: string; years: number }
  /** years from the evaluation date until the date in `field` is below the number in `yearsField` */
  | { op: 'yearsUntilLtField'; field: string; yearsField: string }
  /** academic years elapsed between the AY in `fromField` and the AY in `toField` is >= years */
  | { op: 'academicYearsBetweenGte'; fromField: string; toField: string; years: number }
  /** case-insensitive whole-word / abbreviation match against a fixed word list */
  | { op: 'containsWord'; field: string; words: string[] }
  | { op: 'present'; field: string }
  | { op: 'and'; conditions: Condition[] }
  | { op: 'or'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'courses';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldValidation {
  min?: number;
  max?: number;
  pattern?: string;
  patternMessage?: string;
  maxLength?: number;
}

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  group: string;
  required: boolean;
  /** Field is shown / required only when this condition holds. */
  showWhen?: Condition;
  options?: FieldOption[];
  validation?: FieldValidation;
  help?: string;
  placeholder?: string;
  aphReference?: string;
  classification: Classification;
  humanReview?: string;
}

export type DocRequirementLevel = 'MANDATORY' | 'CONDITIONAL' | 'OPTIONAL';
export type DocStage = 'SUBMISSION' | 'EVC' | 'POST_APPROVAL';

export type DocMetaKey =
  | 'issueDate'
  | 'expiryDate'
  | 'issuer'
  | 'signatory'
  | 'referenceNumber'
  | 'financialYear'
  | 'dscDeclared';

export interface DocValidity {
  kind: 'NONE_STATED' | 'MUST_BE_VALID' | 'FIXED_PERIOD_FROM_ISSUE' | 'PERIOD_COVERED';
  years?: number;
  description: string;
  aphReference?: string;
}

export interface DocumentRequirement {
  id: string;
  name: string;
  aphReference: string;
  level: DocRequirementLevel;
  /** For CONDITIONAL documents: when the document becomes required. */
  trigger?: Condition;
  triggerDescription?: string;
  /** Documents sharing a oneOfGroup satisfy the requirement together (any one is enough). */
  oneOfGroup?: string;
  stage: DocStage;
  issuer?: string;
  format?: string;
  authentication?: string;
  validity: DocValidity;
  metadata: DocMetaKey[];
  automatedChecks: string[];
  humanReview: string;
  verificationStatus: VerificationStatus;
  classification: Classification;
  explanation: string;
  verificationNote?: string;
}

export type RouteStep = 'SELF_DISCLOSURE' | 'SCRUTINY' | 'EVC' | 'SHC_AS_APPLICABLE';

export interface ProcessingRoute {
  /** Table 2.3 / Chapter I routing for this category. */
  scrutiny: boolean;
  evc: 'YES' | 'NO';
  shc: 'AS_APPLICABLE' | 'NO';
  processingPeriod: 'PUBLIC_NOTICE' | 'YEAR_ROUND' | 'YEAR_ROUND_TWICE_A_YEAR';
  aphReference: string;
  notes?: string;
}

export interface SubtypeDef {
  value: string;
  label: string;
  aphReference?: string;
}

/**
 * A category-specific deterministic check.
 * BLOCKING checks prevent final submission when they fail (explicit, objective APH limits).
 * ADVISORY checks never block: they raise a warning for authorised human review
 * (eligibility statements whose assessment belongs to the competent committee).
 */
export interface CategoryCheck {
  id: string;
  title: string;
  aphReference: string;
  severity: 'BLOCKING' | 'ADVISORY';
  /** Condition that indicates the APH statement is NOT met. */
  failWhen: Condition;
  /** Only evaluated when this condition holds (e.g. the inputs are present). */
  applicableWhen?: Condition;
  target?: string;
  explanation: string;
  correctiveAction: string;
  verificationStatus: VerificationStatus;
}

export interface CategoryDef {
  code: string;
  menuNumber: number;
  title: string;
  shortTitle: string;
  keywords: string[];
  aphReferences: string;
  matrixRow: string;
  summary: string;
  subtypes?: SubtypeDef[];
  subtypeLabel?: string;
  route: ProcessingRoute;
  fields: FieldDef[];
  documents: DocumentRequirement[];
  checks: CategoryCheck[];
  reviewGuidance: string;
  /** VERIFIED categories may be finally submitted. NEEDS_VERIFICATION categories accept drafts only. */
  submissionEnabled: boolean;
  verificationStatus: VerificationStatus;
  verificationNotes: string[];
}

export interface Discrepancy {
  id: string;
  categories: string[];
  matrixStatement: string;
  aphStatement: string;
  handling: string;
}
