/**
 * Document validity monitoring. Validity is computed only where the catalogue records a validity rule taken from
 * the APH (MUST_BE_VALID with a recorded expiry date, or FIXED_PERIOD_FROM_ISSUE). Where the sources state no
 * validity period, the document is reported as NEEDS_VERIFICATION — FlowGuard never invents an expiry.
 */
import { CATEGORIES } from './catalogue/categories.ts';
import type { Db } from './db/index.ts';
import { addDays, todayIST } from './services.ts';

export type ValidityStatus = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNABLE_TO_VERIFY' | 'NEEDS_VERIFICATION' | 'NOT_APPLICABLE';

export interface ValidityRow {
  documentId: string;
  applicationId: string;
  referenceNo: string | null;
  institutionId: string;
  requirementId: string;
  name: string;
  fileName: string;
  version: number;
  status: ValidityStatus;
  expiresOn: string | null;
  daysRemaining: number | null;
  basis: string;
  aphReference: string | null;
}

const days = (a: string, b: string) => Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);

export async function documentValidity(db: Db, where: { institutionId?: string; applicationId?: string }, alertDays: number, now = new Date()): Promise<ValidityRow[]> {
  const docs = await db.query<{ id: string; application_id: string; requirement_id: string; file_name: string; version: number; metadata: Record<string, string>; category_code: string; reference_no: string | null; institution_id: string }>(
    `SELECT d.id, d.application_id, d.requirement_id, d.file_name, d.version, d.metadata, a.category_code, a.reference_no, a.institution_id
     FROM documents d JOIN applications a ON a.id = d.application_id
     WHERE d.is_current AND a.status NOT IN ('CLOSED') AND ($1::uuid IS NULL OR a.institution_id = $1) AND ($2::uuid IS NULL OR a.id = $2)
     ORDER BY a.reference_no NULLS LAST, d.requirement_id`,
    [where.institutionId ?? null, where.applicationId ?? null],
  );
  const today = todayIST(now);
  return docs.map((d) => {
    const req = CATEGORIES.find((c) => c.code === d.category_code)?.documents.find((x) => x.id === d.requirement_id);
    const base = { documentId: d.id, applicationId: d.application_id, referenceNo: d.reference_no, institutionId: d.institution_id, requirementId: d.requirement_id, name: req?.name ?? d.requirement_id, fileName: d.file_name, version: d.version };
    const v = req?.validity;
    if (!v || v.kind === 'NONE_STATED')
      return { ...base, status: 'NEEDS_VERIFICATION' as const, expiresOn: null, daysRemaining: null, basis: 'No validity period is established by the supplied sources for this document.', aphReference: null };
    if (v.kind === 'PERIOD_COVERED')
      return { ...base, status: 'NOT_APPLICABLE' as const, expiresOn: null, daysRemaining: null, basis: `Period-coverage requirement, not an expiry: ${v.description}`, aphReference: v.aphReference ?? req?.aphReference ?? null };
    let expiresOn: string | null = null;
    if (v.kind === 'MUST_BE_VALID') expiresOn = d.metadata?.expiryDate ?? null;
    if (v.kind === 'FIXED_PERIOD_FROM_ISSUE' && v.years && d.metadata?.issueDate) expiresOn = addDays(d.metadata.issueDate, Math.round(365.25 * v.years));
    if (!expiresOn)
      return { ...base, status: 'UNABLE_TO_VERIFY' as const, expiresOn: null, daysRemaining: null, basis: `${v.description} The ${v.kind === 'MUST_BE_VALID' ? 'expiry' : 'issue'} date was not recorded at upload.`, aphReference: v.aphReference ?? req?.aphReference ?? null };
    const left = days(expiresOn, today);
    return {
      ...base,
      status: left < 0 ? ('EXPIRED' as const) : left <= alertDays ? ('EXPIRING_SOON' as const) : ('VALID' as const),
      expiresOn,
      daysRemaining: left,
      basis: v.description,
      aphReference: v.aphReference ?? req?.aphReference ?? null,
    };
  });
}
