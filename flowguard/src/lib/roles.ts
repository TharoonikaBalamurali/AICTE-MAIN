/** Short workspace names shown in the sidebar switcher and page headers. */
export const WORKSPACE_NAME: Record<string, string> = {
  INSTITUTION_APPLICANT: 'Institution applicant',
  SCRUTINY_OFFICIAL: 'Scrutiny official',
  RE_SCRUTINY_OFFICIAL: 'Re-scrutiny official',
  REGIONAL_OFFICER: 'EVC coordinator',
  EVC_MEMBER: 'EVC member',
  SHC_MEMBER: 'SHC member',
  DECISION_AUTHORITY: 'Administrative authority',
  SAC_MEMBER: 'SAC member',
  EC_OFFICIAL: 'Executive Committee',
  COUNCIL_OFFICIAL: 'Council',
  SUPERVISOR: 'Supervisor',
  SYSTEM_ADMIN: 'Administrator',
  RULES_GOVERNANCE: 'Rules governance',
  REGULATION_BUREAU: 'Regulation Bureau',
};

/** Human wording for workflow actions in activity feeds. */
export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    SUBMIT: 'Application submitted',
    START_SCRUTINY: 'Scrutiny started',
    ISSUE_DEFICIENCY_NOTICE: 'Correction notice issued',
    REQUEST_FURTHER_CORRECTION: 'Further correction requested',
    SUBMIT_CORRECTIONS: 'Correction package submitted',
    START_RE_SCRUTINY: 'Re-scrutiny started',
    COMPLETE_SCRUTINY: 'Scrutiny completed',
    COMPLETE_RE_SCRUTINY: 'Re-scrutiny completed',
    APPROVE_EVC_HANDOFF: 'Forwarded to EVC coordinator',
    PROPOSE_EVC_DATE: 'EVC date proposed',
    CONFIRM_EVC: 'EVC visit confirmed',
    SCHEDULE_EVC: 'EVC visit scheduled',
    RESCHEDULE_EVC: 'EVC visit rescheduled',
    CANCEL_EVC: 'EVC visit cancelled',
    START_EVC: 'EVC visit started',
    SUBMIT_EVC_REPORT: 'EVC report submitted',
    FORWARD_AFTER_EVC: 'Forwarded after EVC',
    ROUTE_TO_DECISION: 'Routed to decision stage',
    ISSUE_DECISION: 'Decision recorded',
    SUBMIT_APPEAL: 'Appeal submitted',
    START_APPEAL_REVIEW: 'Appeal taken up by the SAC',
    RECORD_SAC_RECOMMENDATION: 'SAC recommendation recorded',
    RECORD_SHC_OUTCOME: 'SHC recommendation recorded',
    RETURN_TO_SAC: 'Placed before the SAC again',
    CLOSE: 'Application closed',
  };
  return map[action] ?? action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export const initialsOf = (name?: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
