/**
 * Backend-controlled workflow state machine.
 * State names are FlowGuard implementation states, not APH terms. Transitions are
 * configured per category route (Ch. I §1.8-1.11; Ch. II §2.23-2.24, Table 2.3).
 * The client can only request named actions; it can never set a state.
 */
import type { ProcessingRoute } from '../catalogue/types.ts';

export const STATES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_SCRUTINY',
  'DEFICIENCY_RAISED',
  'CORRECTION_IN_PROGRESS',
  'READY_FOR_RE_SCRUTINY',
  'UNDER_RE_SCRUTINY',
  'SCRUTINY_COMPLETED',
  'AWAITING_EVC_SCHEDULING',
  'EVC_SCHEDULED',
  'EVC_IN_PROGRESS',
  'EVC_REPORT_SUBMITTED',
  'AWAITING_COMMITTEE_REVIEW',
  'AWAITING_AUTHORISED_DECISION',
  'DECISION_ISSUED',
  'APPEAL_SUBMITTED',
  'APPEAL_UNDER_REVIEW',
  'CLOSED',
] as const;
export type AppState = (typeof STATES)[number];

export const ROLES = [
  'INSTITUTION_APPLICANT',
  'SCRUTINY_OFFICIAL',
  'RE_SCRUTINY_OFFICIAL',
  'REGIONAL_OFFICER',
  'EVC_MEMBER',
  'SHC_MEMBER',
  'DECISION_AUTHORITY',
  'SAC_MEMBER',
  'EC_OFFICIAL',
  'COUNCIL_OFFICIAL',
  'SUPERVISOR',
  'SYSTEM_ADMIN',
  'RULES_GOVERNANCE',
  'REGULATION_BUREAU',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  INSTITUTION_APPLICANT: 'Institution applicant',
  SCRUTINY_OFFICIAL: 'Scrutiny Committee official',
  RE_SCRUTINY_OFFICIAL: 'Re-Scrutiny Committee official',
  SUPERVISOR: 'Supervisor (escalations, verification requests, assignment) — system policy role',
  SYSTEM_ADMIN: 'System administrator (notification delivery, background jobs)',
  REGIONAL_OFFICER: 'Regional Officer / EVC coordinator (committee constitution & scheduling within assigned regions)',
  EVC_MEMBER: 'Expert Visit Committee member',
  SHC_MEMBER: 'Standing Hearing Committee member',
  DECISION_AUTHORITY: 'Administrative authority (reopen approvals, compliance review, closure)',
  EC_OFFICIAL: 'Executive Committee — authorised official (records EC decisions; Ch. I §1.10, Ch. II §2.23.3)',
  COUNCIL_OFFICIAL: 'Council — authorised official (records Council decisions on appeal; Ch. I §1.11(e), Ch. II §2.24(f))',
  SAC_MEMBER: 'Standing Appellate Committee member',
  RULES_GOVERNANCE: 'Rules governance official',
  REGULATION_BUREAU: 'Regulation Bureau officer (EVC escalations, cross-region pendency) — portal design role',
};

export const STATE_LABELS: Record<AppState, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted — scrutiny pending',
  UNDER_SCRUTINY: 'Under scrutiny',
  DEFICIENCY_RAISED: 'Deficiency raised',
  CORRECTION_IN_PROGRESS: 'Correction in progress',
  READY_FOR_RE_SCRUTINY: 'Ready for re-scrutiny',
  UNDER_RE_SCRUTINY: 'Under re-scrutiny',
  SCRUTINY_COMPLETED: 'Scrutiny completed',
  AWAITING_EVC_SCHEDULING: 'Awaiting EVC scheduling',
  EVC_SCHEDULED: 'EVC scheduled',
  EVC_IN_PROGRESS: 'EVC in progress',
  EVC_REPORT_SUBMITTED: 'EVC report submitted',
  AWAITING_COMMITTEE_REVIEW: 'Awaiting SHC review',
  AWAITING_AUTHORISED_DECISION: 'Awaiting authorised decision',
  DECISION_ISSUED: 'Decision issued',
  APPEAL_SUBMITTED: 'Appeal submitted',
  APPEAL_UNDER_REVIEW: 'Appeal under SAC review',
  CLOSED: 'Closed',
};

/** Who must act next, for "pending action" columns. */
export function pendingActor(state: AppState): 'APPLICANT' | 'OFFICIAL' | 'NONE' {
  if (state === 'DRAFT' || state === 'DEFICIENCY_RAISED' || state === 'CORRECTION_IN_PROGRESS') return 'APPLICANT';
  if (state === 'CLOSED' || state === 'DECISION_ISSUED') return 'NONE';
  return 'OFFICIAL';
}

export type Action =
  | 'SUBMIT'
  | 'APPROVE_REOPEN'
  | 'START_SCRUTINY'
  | 'FORWARD_SELF_DISCLOSURE'
  | 'ISSUE_DEFICIENCY_NOTICE'
  | 'REQUEST_FURTHER_CORRECTION'
  | 'BEGIN_CORRECTION'
  | 'SUBMIT_CORRECTIONS'
  | 'START_RE_SCRUTINY'
  | 'COMPLETE_SCRUTINY'
  | 'COMPLETE_RE_SCRUTINY'
  | 'ROUTE_TO_DECISION'
  | 'REFER_UNRESOLVED'
  | 'APPROVE_EVC_HANDOFF'
  | 'PROPOSE_EVC_DATE'
  | 'CONFIRM_EVC'
  | 'SCHEDULE_EVC'
  | 'RESCHEDULE_EVC'
  | 'CANCEL_EVC'
  | 'START_EVC'
  | 'SUBMIT_EVC_REPORT'
  | 'FORWARD_AFTER_EVC'
  | 'RECORD_SHC_OUTCOME'
  | 'ISSUE_DECISION'
  | 'SUBMIT_APPEAL'
  | 'START_APPEAL_REVIEW'
  | 'RECORD_SAC_RECOMMENDATION'
  | 'RETURN_TO_SAC'
  | 'CLOSE';

interface TransitionDef {
  from: AppState[];
  /** Resolved target; may depend on the route and on action parameters. */
  to: (route: ProcessingRoute, params: Record<string, unknown>) => AppState;
  roles: Role[];
  when?: (route: ProcessingRoute) => boolean;
  aphReference: string;
}

/**
 * After scrutiny / re-scrutiny is completed: routes with an EVC stay in SCRUTINY_COMPLETED until an
 * authorised official approves the EVC handoff (after the eligibility evaluation); routes without an
 * EVC go to the authorised decision stage (Table 2.3).
 */
const afterScrutiny = (route: ProcessingRoute): AppState => (route.evc === 'YES' ? 'SCRUTINY_COMPLETED' : 'AWAITING_AUTHORISED_DECISION');

export const TRANSITIONS: Record<Action, TransitionDef> = {
  SUBMIT: { from: ['DRAFT'], to: () => 'SUBMITTED', roles: ['INSTITUTION_APPLICANT'], aphReference: 'Ch. I §1.4.3; Ch. II §2.3.3' },
  APPROVE_REOPEN: { from: ['SUBMITTED'], to: () => 'DRAFT', roles: ['DECISION_AUTHORITY'], aphReference: 'Ch. II §2.3.3(d)-(e)' },
  START_SCRUTINY: { from: ['SUBMITTED'], to: () => 'UNDER_SCRUTINY', roles: ['SCRUTINY_OFFICIAL'], when: (r) => r.scrutiny, aphReference: 'Ch. I §1.8; Ch. II §2.23.1' },
  FORWARD_SELF_DISCLOSURE: {
    from: ['SUBMITTED'],
    to: () => 'AWAITING_AUTHORISED_DECISION',
    roles: ['SCRUTINY_OFFICIAL'],
    when: (r) => !r.scrutiny,
    aphReference: 'Ch. II §2.5; Table 2.3',
  },
  ISSUE_DEFICIENCY_NOTICE: {
    from: ['SUBMITTED', 'UNDER_SCRUTINY'],
    to: () => 'DEFICIENCY_RAISED',
    roles: ['SCRUTINY_OFFICIAL'],
    aphReference: 'Ch. I §1.8(f); Ch. II §2.4',
  },
  REQUEST_FURTHER_CORRECTION: {
    from: ['UNDER_RE_SCRUTINY'],
    to: () => 'DEFICIENCY_RAISED',
    roles: ['RE_SCRUTINY_OFFICIAL'],
    aphReference: 'Ch. I §1.8(g); Ch. II §2.4',
  },
  BEGIN_CORRECTION: { from: ['DEFICIENCY_RAISED'], to: () => 'CORRECTION_IN_PROGRESS', roles: ['INSTITUTION_APPLICANT'], aphReference: 'Ch. II §2.4' },
  SUBMIT_CORRECTIONS: {
    from: ['DEFICIENCY_RAISED', 'CORRECTION_IN_PROGRESS'],
    to: () => 'READY_FOR_RE_SCRUTINY',
    roles: ['INSTITUTION_APPLICANT'],
    aphReference: 'Ch. I §1.8(f); Ch. II §2.4',
  },
  START_RE_SCRUTINY: { from: ['READY_FOR_RE_SCRUTINY'], to: () => 'UNDER_RE_SCRUTINY', roles: ['RE_SCRUTINY_OFFICIAL'], aphReference: 'Ch. I §1.8(g)' },
  COMPLETE_SCRUTINY: {
    from: ['UNDER_SCRUTINY'],
    to: () => 'SCRUTINY_COMPLETED',
    roles: ['SCRUTINY_OFFICIAL'],
    aphReference: 'Ch. I §1.8(h)',
  },
  COMPLETE_RE_SCRUTINY: {
    from: ['UNDER_RE_SCRUTINY'],
    to: () => 'SCRUTINY_COMPLETED',
    roles: ['RE_SCRUTINY_OFFICIAL'],
    aphReference: 'Ch. I §1.8(g)-(h)',
  },
  ROUTE_TO_DECISION: { from: ['SCRUTINY_COMPLETED'], to: () => 'AWAITING_AUTHORISED_DECISION', roles: [], when: (r) => r.evc === 'NO', aphReference: 'Ch. II Table 2.3' },
  REFER_UNRESOLVED: {
    from: ['UNDER_RE_SCRUTINY'],
    to: (r) => (r.shc === 'AS_APPLICABLE' ? 'AWAITING_COMMITTEE_REVIEW' : 'AWAITING_AUTHORISED_DECISION'),
    roles: ['RE_SCRUTINY_OFFICIAL'],
    aphReference: 'Ch. II §2.23.3, §2.25(c)',
  },
  APPROVE_EVC_HANDOFF: {
    from: ['SCRUTINY_COMPLETED'],
    to: () => 'AWAITING_EVC_SCHEDULING',
    roles: ['SCRUTINY_OFFICIAL', 'RE_SCRUTINY_OFFICIAL', 'SUPERVISOR'],
    when: (r) => r.evc === 'YES',
    aphReference: 'Ch. I §1.8(h), §1.9; Ch. II §2.23.2; Table 2.3',
  },
  PROPOSE_EVC_DATE: { from: ['AWAITING_EVC_SCHEDULING'], to: () => 'AWAITING_EVC_SCHEDULING', roles: ['REGIONAL_OFFICER'], when: (r) => r.evc === 'YES', aphReference: 'Ch. I §1.9; Definition 29' },
  CONFIRM_EVC: { from: ['AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED'], to: () => 'EVC_SCHEDULED', roles: ['REGIONAL_OFFICER'], when: (r) => r.evc === 'YES', aphReference: 'Ch. I §1.9; Definition 29' },
  SCHEDULE_EVC: { from: ['AWAITING_EVC_SCHEDULING'], to: () => 'EVC_SCHEDULED', roles: ['REGIONAL_OFFICER'], when: (r) => r.evc === 'YES', aphReference: 'Ch. I §1.9; Definition 29' },
  RESCHEDULE_EVC: { from: ['AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED'], to: (_r, p) => (p.from === 'AWAITING_EVC_SCHEDULING' ? 'AWAITING_EVC_SCHEDULING' : 'EVC_SCHEDULED'), roles: ['REGIONAL_OFFICER'], aphReference: 'Ch. I §1.9' },
  CANCEL_EVC: { from: ['EVC_SCHEDULED'], to: () => 'AWAITING_EVC_SCHEDULING', roles: ['REGIONAL_OFFICER'], aphReference: 'Ch. I §1.9' },
  START_EVC: { from: ['EVC_SCHEDULED'], to: () => 'EVC_IN_PROGRESS', roles: ['EVC_MEMBER'], aphReference: 'Ch. I §1.9(c)' },
  SUBMIT_EVC_REPORT: { from: ['EVC_IN_PROGRESS'], to: () => 'EVC_REPORT_SUBMITTED', roles: ['EVC_MEMBER'], aphReference: 'Ch. I §1.9(h)' },
  FORWARD_AFTER_EVC: {
    from: ['EVC_REPORT_SUBMITTED'],
    to: (r, p) => (r.shc === 'AS_APPLICABLE' && p.toShc === true ? 'AWAITING_COMMITTEE_REVIEW' : 'AWAITING_AUTHORISED_DECISION'),
    roles: ['REGIONAL_OFFICER'],
    aphReference: 'Ch. II §2.23.3; Ch. I §1.10(a)',
  },
  RECORD_SHC_OUTCOME: { from: ['AWAITING_COMMITTEE_REVIEW'], to: () => 'AWAITING_AUTHORISED_DECISION', roles: ['SHC_MEMBER'], aphReference: 'Ch. II §2.23.3' },
  // EC decides in the first instance; on appeal the Council decides (the handler checks which body applies).
  ISSUE_DECISION: { from: ['AWAITING_AUTHORISED_DECISION'], to: () => 'DECISION_ISSUED', roles: ['EC_OFFICIAL', 'COUNCIL_OFFICIAL'], aphReference: 'Ch. I §1.10, §1.11(e); Ch. II §2.23.3, §2.24(f)' },
  SUBMIT_APPEAL: { from: ['DECISION_ISSUED'], to: () => 'APPEAL_SUBMITTED', roles: ['INSTITUTION_APPLICANT'], aphReference: 'Ch. I §1.11(a); Ch. II §2.24(a)' },
  START_APPEAL_REVIEW: { from: ['APPEAL_SUBMITTED'], to: () => 'APPEAL_UNDER_REVIEW', roles: ['SAC_MEMBER'], aphReference: 'Ch. II §2.24(b)' },
  RECORD_SAC_RECOMMENDATION: {
    from: ['APPEAL_UNDER_REVIEW'],
    to: (_r, p) => (p.outcome === 'REFER_SCRUTINY' ? 'UNDER_SCRUTINY' : p.outcome === 'REFER_EVC' ? 'AWAITING_EVC_SCHEDULING' : 'AWAITING_AUTHORISED_DECISION'),
    roles: ['SAC_MEMBER'],
    aphReference: 'Ch. I §1.11(d)-(e); Ch. II §2.24(f)',
  },
  // After a further Scrutiny / EVC ordered on appeal, its reports go before another SAC (Ch. I §1.11(d)).
  RETURN_TO_SAC: { from: ['AWAITING_AUTHORISED_DECISION'], to: () => 'APPEAL_UNDER_REVIEW', roles: ['SAC_MEMBER'], aphReference: 'Ch. I §1.11(d)' },
  CLOSE: { from: ['DECISION_ISSUED'], to: () => 'CLOSED', roles: ['DECISION_AUTHORITY'], aphReference: 'Portal SYSTEM_POLICY' },
};

export class TransitionError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

export function resolveTransition(state: AppState, action: Action, role: Role, route: ProcessingRoute, params: Record<string, unknown> = {}): AppState {
  const t = TRANSITIONS[action];
  if (!t) throw new TransitionError(`Unknown action ${action}`, 400);
  if (!t.roles.includes(role)) throw new TransitionError(`Role ${role} is not permitted to perform ${action}.`, 403);
  if (!t.from.includes(state)) throw new TransitionError(`${action} is not allowed while the application is ${STATE_LABELS[state]}.`);
  if (t.when && !t.when(route)) throw new TransitionError(`${action} does not apply to this application's processing route.`);
  return t.to(route, params);
}

export { afterScrutiny };

/** The ordered stages shown on the progress timeline for a route. */
export function routeStages(route: ProcessingRoute): Array<{ key: string; label: string }> {
  const s = [{ key: 'SUBMITTED', label: 'Submitted' }];
  if (route.scrutiny) s.push({ key: 'SCRUTINY', label: 'Scrutiny / Re-scrutiny' });
  else s.push({ key: 'SELF_DISCLOSURE', label: 'Self-disclosure check' });
  if (route.evc === 'YES') s.push({ key: 'EVC', label: 'Expert Visit Committee' });
  if (route.shc === 'AS_APPLICABLE') s.push({ key: 'SHC', label: 'SHC (as applicable)' });
  s.push({ key: 'DECISION', label: 'Authorised decision' });
  return s;
}

export function stageOf(state: AppState): string {
  switch (state) {
    case 'DRAFT':
      return 'DRAFT';
    case 'SUBMITTED':
      return 'SUBMITTED';
    case 'UNDER_SCRUTINY':
    case 'DEFICIENCY_RAISED':
    case 'CORRECTION_IN_PROGRESS':
    case 'READY_FOR_RE_SCRUTINY':
    case 'UNDER_RE_SCRUTINY':
    case 'SCRUTINY_COMPLETED':
      return 'SCRUTINY';
    case 'AWAITING_EVC_SCHEDULING':
    case 'EVC_SCHEDULED':
    case 'EVC_IN_PROGRESS':
    case 'EVC_REPORT_SUBMITTED':
      return 'EVC';
    case 'AWAITING_COMMITTEE_REVIEW':
      return 'SHC';
    case 'AWAITING_AUTHORISED_DECISION':
    case 'DECISION_ISSUED':
      return 'DECISION';
    case 'APPEAL_SUBMITTED':
    case 'APPEAL_UNDER_REVIEW':
      return 'APPEAL';
    case 'CLOSED':
      return 'CLOSED';
  }
}
