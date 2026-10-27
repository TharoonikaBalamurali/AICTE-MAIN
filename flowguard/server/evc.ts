/**
 * EVC eligibility evaluator. Explains each condition; never hands off automatically.
 * Handoff requires an authorised official's action (APPROVE_EVC_HANDOFF).
 */
import { getCategory } from './catalogue/categories.ts';
import type { Db } from './db/index.ts';
import type { AppRow } from './services.ts';

export interface EligibilityCondition {
  id: string;
  label: string;
  basis: 'APH' | 'SYSTEM_POLICY';
  reference: string;
  passed: boolean;
  detail: string;
}

export async function evaluateEvcEligibility(db: Db, app: AppRow) {
  const cat = getCategory(app.category_code)!;
  const conds: EligibilityCondition[] = [];
  const add = (c: EligibilityCondition) => conds.push(c);

  add({
    id: 'ROUTE_INCLUDES_EVC',
    label: 'Processing route for this category includes an EVC',
    basis: 'APH',
    reference: cat.route.aphReference,
    passed: cat.route.evc === 'YES',
    detail: cat.route.evc === 'YES' ? 'This category\'s processing route includes an EVC step.' : 'This category has no EVC step; it goes to the authorised decision stage instead.',
  });
  add({
    id: 'SCRUTINY_IN_ORDER',
    label: 'Scrutiny / re-scrutiny recorded the application as in order',
    basis: 'APH',
    reference: 'Ch. I §1.8(h)',
    passed: app.status === 'SCRUTINY_COMPLETED',
    detail: app.status === 'SCRUTINY_COMPLETED' ? 'The authorised official completed scrutiny.' : `Current status is ${app.status}.`,
  });
  const open = await db.query<{ reference_no: string; status: string }>(
    "SELECT reference_no, status FROM deficiencies WHERE application_id = $1 AND status NOT IN ('RESOLVED','WITHDRAWN')",
    [app.id],
  );
  add({
    id: 'NO_OUTSTANDING_DEFICIENCIES',
    label: 'No outstanding deficiencies',
    basis: 'APH',
    reference: 'Ch. I §1.8(h) ("found to be in order in all respect")',
    passed: open.length === 0,
    detail: open.length ? `Outstanding: ${open.map((o) => `${o.reference_no} (${o.status.toLowerCase()})`).join(', ')}` : 'All raised deficiencies are resolved or withdrawn.',
  });
  const run = await db.one<{ summary: { blocking: number }; stage: string }>('SELECT summary, stage FROM validation_runs WHERE application_id = $1 ORDER BY run_at DESC LIMIT 1', [app.id]);
  add({
    id: 'NO_BLOCKING_FINDINGS',
    label: 'Latest automated validation has no blocking discrepancy',
    basis: 'SYSTEM_POLICY',
    reference: 'Approved APH rules in the rule registry',
    passed: !!run && run.summary.blocking === 0,
    detail: run ? `${run.summary.blocking} blocking finding(s) in the latest ${run.stage.toLowerCase()} run.` : 'No validation run found.',
  });
  const vr = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM verification_requests WHERE application_id = $1 AND status = 'OPEN'", [app.id]);
  add({
    id: 'NO_OPEN_VERIFICATION_REQUESTS',
    label: 'No open requests for further verification',
    basis: 'SYSTEM_POLICY',
    reference: 'Portal workflow control',
    passed: (vr?.n ?? 0) === 0,
    detail: vr?.n ? `${vr.n} verification request(s) still open.` : 'None open.',
  });
  add({
    id: 'CATEGORY_VERIFIED',
    label: 'Category requirements are verified',
    basis: 'SYSTEM_POLICY',
    reference: 'Catalogue verification status',
    passed: cat.verificationStatus === 'VERIFIED',
    detail: cat.verificationStatus === 'VERIFIED' ? 'Checklist verified.' : 'Category pending regulatory verification.',
  });
  const unresolved = conds.filter((c) => !c.passed);
  return {
    eligible: unresolved.length === 0,
    evaluatedAt: new Date().toISOString(),
    conditions: conds,
    unresolvedPrerequisites: unresolved.map((c) => c.label),
    note: 'Eligibility is advisory. Forwarding to EVC requires an authorised official to approve the handoff.',
  };
}
