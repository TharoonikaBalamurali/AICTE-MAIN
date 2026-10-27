/**
 * Development / demo seed. Creates TEST accounts and DEMO institutions only —
 * no applications, statistics or decisions are seeded (all dashboard data comes
 * from records you create). Never use these credentials outside local testing.
 */
import type { Db } from './index.ts';
import { hashPassword } from '../auth.ts';
import { buildRuleset } from '../rules/ruleset.ts';
import type { Role } from '../workflow/stateMachine.ts';
import { seedOperationalPolicies } from '../policy.ts';

export const DEMO_INSTITUTIONS = [
  {
    key: 'A',
    region: 'DEMO-RO-WEST',
    aicteId: 'DEMO-INST-0001',
    name: 'Demo Institute of Technology, Pune',
    address: 'Survey No. 12, Demo Road, Pune',
    state: 'Maharashtra',
    district: 'Pune',
    pincode: '411001',
    email: 'office@demo-institute.test',
  },
  {
    key: 'B',
    region: 'DEMO-RO-SOUTH',
    aicteId: 'DEMO-INST-0002',
    name: 'Sample College of Engineering, Chennai',
    address: 'Plot 4, Sample Nagar, Chennai',
    state: 'Tamil Nadu',
    district: 'Chennai',
    pincode: '600001',
    email: 'office@sample-college.test',
  },
];

/** Test accounts. Login ID / password pairs are for local development only. */
export const DEMO_ACCOUNTS: Array<{ loginId: string; password: string; fullName: string; designation: string; roles: Role[]; institution?: 'A' | 'B' }> = [
  { loginId: 'applicant.demo', password: 'Applicant@2026', fullName: 'Demo Applicant (Institute A)', designation: 'Principal', roles: ['INSTITUTION_APPLICANT'], institution: 'A' },
  { loginId: 'applicant.sample', password: 'Applicant@2026', fullName: 'Sample Applicant (Institute B)', designation: 'Director', roles: ['INSTITUTION_APPLICANT'], institution: 'B' },
  { loginId: 'scrutiny.officer', password: 'Official@2026', fullName: 'Test Scrutiny Official', designation: 'Scrutiny Committee', roles: ['SCRUTINY_OFFICIAL'] },
  { loginId: 'scrutiny.officer2', password: 'Official@2026', fullName: 'Second Scrutiny Official', designation: 'Scrutiny Committee', roles: ['SCRUTINY_OFFICIAL'] },
  { loginId: 'rescrutiny.officer', password: 'Official@2026', fullName: 'Test Re-Scrutiny Official', designation: 'Re-Scrutiny Committee', roles: ['RE_SCRUTINY_OFFICIAL'] },
  { loginId: 'supervisor', password: 'Official@2026', fullName: 'Test Supervisor', designation: 'Supervisor (system policy role)', roles: ['SUPERVISOR'] },
  { loginId: 'sys.admin', password: 'Official@2026', fullName: 'Test System Administrator', designation: 'Administrator', roles: ['SYSTEM_ADMIN'] },
  { loginId: 'evc.member2', password: 'Official@2026', fullName: 'Second EVC Member', designation: 'Expert Visit Committee', roles: ['EVC_MEMBER'] },
  { loginId: 'regional.officer', password: 'Official@2026', fullName: 'Test Regional Officer', designation: 'Regional Office', roles: ['REGIONAL_OFFICER'] },
  { loginId: 'evc.member', password: 'Official@2026', fullName: 'Test EVC Member', designation: 'Expert Visit Committee', roles: ['EVC_MEMBER'] },
  { loginId: 'shc.member', password: 'Official@2026', fullName: 'Test SHC Member', designation: 'Standing Hearing Committee', roles: ['SHC_MEMBER'] },
  { loginId: 'decision.authority', password: 'Official@2026', fullName: 'Test Decision Official', designation: 'Records EC / Council decisions', roles: ['DECISION_AUTHORITY'] },
  { loginId: 'sac.member', password: 'Official@2026', fullName: 'Test SAC Member', designation: 'Standing Appellate Committee', roles: ['SAC_MEMBER'] },
  { loginId: 'ec.official', password: 'Official@2026', fullName: 'Test EC Official', designation: 'Executive Committee (records EC decisions)', roles: ['EC_OFFICIAL'] },
  { loginId: 'council.official', password: 'Official@2026', fullName: 'Test Council Official', designation: 'Council (records decisions on appeal)', roles: ['COUNCIL_OFFICIAL'] },
  { loginId: 'rules.governance', password: 'Official@2026', fullName: 'Test Rules Governance Official', designation: 'Rules governance', roles: ['RULES_GOVERNANCE'] },
  { loginId: 'rules.publisher', password: 'Official@2026', fullName: 'Test Rules Publisher', designation: 'Rules governance (second approver)', roles: ['RULES_GOVERNANCE'] },
  { loginId: 'regional.officer2', password: 'Official@2026', fullName: 'Second Regional Officer', designation: 'Regional Office (South demo region)', roles: ['REGIONAL_OFFICER'] },
  { loginId: 'evc.member3', password: 'Official@2026', fullName: 'Third EVC Member', designation: 'Expert Visit Committee', roles: ['EVC_MEMBER'] },
  { loginId: 'regulation.bureau', password: 'Official@2026', fullName: 'Test Regulation Bureau Officer', designation: 'Regulation Bureau', roles: ['REGULATION_BUREAU'] },
];

/** DEMONSTRATION regions. The APH does not map states to AICTE regional offices; real regions must be configured. */
export const DEMO_REGIONS = [
  { code: 'DEMO-RO-WEST', name: 'Demo Region West (sample data)' },
  { code: 'DEMO-RO-SOUTH', name: 'Demo Region South (sample data)' },
];
const DEMO_USER_REGIONS: Array<[string, string]> = [
  ['regional.officer', 'DEMO-RO-WEST'],
  ['regional.officer2', 'DEMO-RO-SOUTH'],
];

/**
 * DEMONSTRATION EVC expert registry entries (sample people, not a real AICTE panel). Entries 1-3 are verified
 * demo records able to fill the three seats of Annexure 16 §16.5; entry 4 is deliberately unverified.
 */
export const DEMO_EXPERTS = [
  { code: 'EVC-DEMO-0001', login: 'evc.member', name: 'Test EVC Member', level: 'PROFESSOR', discipline: 'ENGINEERING_TECHNOLOGY', specialisation: 'Mechanical Engineering', organisation: 'Demo Institute of National Importance (sample)', orgType: 'IIT', years: 22, coa: null, panel: 'ON_APPROVED_PANEL', verified: true },
  { code: 'EVC-DEMO-0002', login: 'evc.member2', name: 'Second EVC Member', level: 'ASSOCIATE_PROFESSOR', discipline: 'MANAGEMENT', specialisation: 'Business Administration', organisation: 'Demo Government Institute (sample)', orgType: 'GOVERNMENT', years: 14, coa: null, panel: 'ON_APPROVED_PANEL', verified: true },
  { code: 'EVC-DEMO-0003', login: 'evc.member3', name: 'Third EVC Member', level: 'ARCHITECT', discipline: 'ARCHITECTURE', specialisation: 'Institutional buildings', organisation: 'Demo Architects (sample)', orgType: 'PRIVATE', years: 18, coa: 'CA/DEMO/0003', panel: 'NOT_ON_PANEL', verified: true },
  { code: 'EVC-DEMO-0004', login: null, name: 'Demo Industry Expert (unverified)', level: 'INDUSTRY_EXPERT', discipline: 'ENGINEERING_TECHNOLOGY', specialisation: 'Manufacturing', organisation: 'Demo Industries (sample)', orgType: 'INDUSTRY', years: 3, coa: null, panel: 'NEEDS_VERIFICATION', verified: false },
] as const;

export async function seed(db: Db): Promise<{ users: number; rules: number }> {
  const instIds: Record<string, string> = {};
  for (const i of DEMO_INSTITUTIONS) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO institutions(aicte_institution_id, name, address, state, district, pincode, official_email, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (aicte_institution_id) DO UPDATE SET aicte_institution_id = EXCLUDED.aicte_institution_id
       RETURNING id`,
      [i.aicteId, i.name, i.address, i.state, i.district, i.pincode, i.email],
    );
    instIds[i.key] = row!.id;
  }
  let users = 0;
  for (const a of DEMO_ACCOUNTS) {
    const existing = await db.one<{ id: string }>('SELECT id FROM users WHERE login_id = $1', [a.loginId]);
    if (existing) continue;
    const u = await db.one<{ id: string }>(
      'INSERT INTO users(login_id, email, full_name, designation, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [a.loginId, `${a.loginId}@flowguard.test`, a.fullName, a.designation, hashPassword(a.password)],
    );
    for (const role of a.roles) await db.query('INSERT INTO user_roles(user_id, role) VALUES ($1,$2)', [u!.id, role]);
    if (a.institution) await db.query('INSERT INTO institution_memberships(user_id, institution_id) VALUES ($1,$2)', [u!.id, instIds[a.institution]]);
    users++;
  }
  // Demo regions, Regional Officer scopes, operational policies and EVC experts (idempotent).
  for (const r of DEMO_REGIONS) await db.query('INSERT INTO regions(code, name, is_demo) VALUES ($1,$2,true) ON CONFLICT (code) DO NOTHING', [r.code, r.name]);
  for (const i of DEMO_INSTITUTIONS) await db.query('UPDATE institutions SET region_code = $2 WHERE aicte_institution_id = $1 AND region_code IS NULL', [i.aicteId, i.region]);
  for (const [login, region] of DEMO_USER_REGIONS)
    await db.query('INSERT INTO user_regions(user_id, region_code) SELECT id, $2 FROM users WHERE login_id = $1 ON CONFLICT DO NOTHING', [login, region]);
  await seedOperationalPolicies(db);
  for (const e of DEMO_EXPERTS) {
    const uid = e.login ? (await db.one<{ id: string }>('SELECT id FROM users WHERE login_id = $1', [e.login]))?.id ?? null : null;
    await db.query(
      `INSERT INTO evc_experts(member_code, user_id, full_name, official_email, designation_level, discipline, specialisation, organisation, organisation_type, experience_years,
         coa_registration_no, panel_status, panel_reference, verification_status, verification_source, verified_at, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true) ON CONFLICT (member_code) DO NOTHING`,
      [
        e.code, uid, e.name, `${(e.login ?? e.code).toLowerCase()}@flowguard.test`, e.level, e.discipline, e.specialisation, e.organisation, e.orgType, e.years, e.coa, e.panel,
        e.panel === 'ON_APPROVED_PANEL' ? 'DEMO — sample panel reference, not an Executive Committee panel' : null,
        e.verified ? 'VERIFIED' : 'NEEDS_VERIFICATION',
        e.verified ? 'DEMO seed — sample verification record' : null,
        e.verified ? new Date().toISOString() : null,
      ],
    );
  }
  const rules = await seedRules(db);
  return { users, rules };
}

/**
 * Inserts rules from the catalogue. Existing (rule_id, version) rows are never overwritten.
 * Batched as a single multi-row insert (unnest over column arrays) rather than one round trip
 * per rule — the catalogue runs into the thousands of rows, and a remote (e.g. Supabase) database
 * adds real per-round-trip latency that a loop of individual INSERTs would pay thousands of times.
 */
export async function seedRules(db: Db): Promise<number> {
  const rules = buildRuleset();
  const cols = {
    ruleId: [] as string[],
    ruleVersion: [] as number[],
    applicationType: [] as string[],
    actionSubtype: [] as (string | null)[],
    ruleType: [] as string[],
    condition: [] as string[],
    expectedResult: [] as string[],
    severity: [] as string[],
    aphReference: [] as (string | null)[],
    sourceEvidence: [] as string[],
    verificationStatus: [] as string[],
    lifecycleStatus: [] as string[],
    targetType: [] as string[],
    targetId: [] as (string | null)[],
    targetLabel: [] as string[],
    explanation: [] as string[],
    correctiveAction: [] as string[],
    approvedBy: [] as (string | null)[],
    approvedAt: [] as (string | null)[],
  };
  for (const r of rules) {
    cols.ruleId.push(r.ruleId);
    cols.ruleVersion.push(r.ruleVersion);
    cols.applicationType.push(r.applicationType);
    cols.actionSubtype.push(r.actionSubtype);
    cols.ruleType.push(r.ruleType);
    cols.condition.push(JSON.stringify(r.condition));
    cols.expectedResult.push(r.expectedResult);
    cols.severity.push(r.severity);
    cols.aphReference.push(r.aphReference);
    cols.sourceEvidence.push(r.sourceEvidence);
    cols.verificationStatus.push(r.verificationStatus);
    cols.lifecycleStatus.push(r.lifecycleStatus);
    cols.targetType.push(r.targetType);
    cols.targetId.push(r.targetId);
    cols.targetLabel.push(r.targetLabel);
    cols.explanation.push(r.explanation);
    cols.correctiveAction.push(r.correctiveAction);
    cols.approvedBy.push(r.lifecycleStatus === 'APPROVED_FOR_EXECUTION' ? 'DEVELOPMENT SEED — extraction verified against APH; pending official sign-off' : null);
    cols.approvedAt.push(r.lifecycleStatus === 'APPROVED_FOR_EXECUTION' ? new Date().toISOString() : null);
  }
  const res = await db.query<{ rule_id: string }>(
    `INSERT INTO regulatory_rules(rule_id, rule_version, application_type, action_subtype, rule_type, condition, expected_result, severity,
       aph_reference, source_evidence, verification_status, lifecycle_status, target_type, target_id, target_label, explanation, corrective_action,
       approved_by, approved_at)
     SELECT * FROM unnest(
       $1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::text[], $8::text[],
       $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[],
       $18::text[], $19::timestamptz[]
     )
     ON CONFLICT (rule_id, rule_version) DO NOTHING RETURNING rule_id`,
    [
      cols.ruleId, cols.ruleVersion, cols.applicationType, cols.actionSubtype, cols.ruleType, cols.condition, cols.expectedResult, cols.severity,
      cols.aphReference, cols.sourceEvidence, cols.verificationStatus, cols.lifecycleStatus, cols.targetType, cols.targetId, cols.targetLabel, cols.explanation, cols.correctiveAction,
      cols.approvedBy, cols.approvedAt,
    ],
  );
  return res.length;
}
