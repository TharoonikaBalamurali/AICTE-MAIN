/**
 * Builds the horizontal step bar for an application from its route stages (served by the API)
 * and its current workflow state. The scrutiny stage is split into scrutiny / correction /
 * re-scrutiny so the institution and officials can see where a correction loop stands.
 */
export function workflowSteps(status: string, stages: Array<{ key: string; label: string }>) {
  const steps: Array<{ key: string; label: string }> = [];
  for (const s of stages) {
    if (s.key === 'SUBMITTED') steps.push({ key: 'SUBMITTED', label: 'Submitted' });
    else if (s.key === 'SCRUTINY') steps.push({ key: 'SCRUTINY', label: 'Scrutiny' }, { key: 'CORRECTION', label: 'Correction' }, { key: 'RE_SCRUTINY', label: 'Re-scrutiny' });
    else if (s.key === 'SELF_DISCLOSURE') steps.push({ key: 'SELF_DISCLOSURE', label: 'Self-disclosure check' });
    else if (s.key === 'EVC') steps.push({ key: 'EVC', label: 'EVC' });
    else if (s.key === 'SHC') steps.push({ key: 'SHC', label: 'SHC' });
    else if (s.key === 'DECISION') steps.push({ key: 'DECISION', label: 'Decision' });
  }
  const at = (k: string) => steps.findIndex((x) => x.key === k);
  const afterScrutiny = steps.findIndex((x) => ['EVC', 'SHC', 'DECISION'].includes(x.key));
  let current: number;
  switch (status) {
    case 'DRAFT':
      current = 0;
      break;
    case 'SUBMITTED':
    case 'UNDER_SCRUTINY':
      current = Math.max(at('SCRUTINY'), at('SELF_DISCLOSURE'), 1);
      break;
    case 'DEFICIENCY_RAISED':
    case 'CORRECTION_IN_PROGRESS':
      current = at('CORRECTION');
      break;
    case 'READY_FOR_RE_SCRUTINY':
    case 'UNDER_RE_SCRUTINY':
      current = at('RE_SCRUTINY');
      break;
    case 'SCRUTINY_COMPLETED':
      current = afterScrutiny;
      break;
    case 'AWAITING_EVC_SCHEDULING':
    case 'EVC_SCHEDULED':
    case 'EVC_IN_PROGRESS':
    case 'EVC_REPORT_SUBMITTED':
      current = at('EVC');
      break;
    case 'AWAITING_COMMITTEE_REVIEW':
      current = at('SHC');
      break;
    case 'AWAITING_AUTHORISED_DECISION':
    case 'APPEAL_SUBMITTED':
    case 'APPEAL_UNDER_REVIEW':
      current = at('DECISION');
      break;
    default:
      current = steps.length; // decision issued / closed: every step complete
  }
  if (current < 0) current = afterScrutiny >= 0 ? afterScrutiny : steps.length - 1;
  return { steps, current, attention: ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'].includes(status) };
}
