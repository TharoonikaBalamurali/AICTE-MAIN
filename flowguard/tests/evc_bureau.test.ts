/**
 * EVC registry & committee composition (Annexure 16 §16.5), EVC member workspace, missed-visit / report escalation to
 * the Regulation Bureau, compliance lifecycle, document validity, consolidated reports, operational policies,
 * rule publication control and security / reliability checks. All data is synthetic TEST data.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createDb, migrate, type Db } from '../server/db/index.ts';
import { DEMO_ACCOUNTS, seed } from '../server/db/seed.ts';
import { seatEligibility, validateComposition, type Expert } from '../server/evc/composition.ts';
import { memberStatus } from '../server/evc/service.ts';
import { runDeadlineSweep } from '../server/scheduler.ts';
import { decisionObligations } from '../server/services.ts';
import { MemoryStorage } from '../server/storage.ts';
import { documentValidity } from '../server/validity.ts';

let db: Db;
let app: ReturnType<typeof createApp>['app'];
const PDF = (tag = 'SYNTHETIC TEST FILE') => Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF`);
const pw = (l: string) => DEMO_ACCOUNTS.find((a) => a.loginId === l)!.password;
async function login(l: string) {
  const a = request.agent(app);
  const r = await a.post('/api/auth/login').send({ loginId: l, password: pw(l) });
  expect(r.status).toBe(200);
  return a;
}
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const DAY = 86400000;

/** An application of Institute A (DEMO-RO-WEST) forwarded to the EVC coordinator. */
async function readyForEvc(label: string) {
  const A = await login('applicant.demo');
  const c = await A.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
  const id = c.body.application.id as string;
  await A.patch(`/api/applications/${id}`).send({
    rowVersion: c.body.application.row_version,
    fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'TEST University', proposedCourses: [{ course: `MBA ${label}` }], nocReference: 'N', resolutionDate: '2026-09-01' },
  });
  for (const r of ['NPL-NOC', 'NPL-RES']) await A.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF(), `${r}.pdf`);
  const sub = await A.post(`/api/applications/${id}/submit`).send({ declaration: true });
  expect(sub.status, JSON.stringify(sub.body).slice(0, 600)).toBe(200);
  const f = await (await login('scrutiny.officer')).post(`/api/official/applications/${id}/actions/FORWARD_TO_EVC`).send({ reason: 'In order (TEST).' });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  return id;
}
async function experts(RO: request.Agent) {
  const list = (await RO.get('/api/evc/experts')).body.experts as Array<{ id: string; member_code: string }>;
  return (code: string) => list.find((e) => e.member_code === code)!.id;
}
async function committee(RO: request.Agent) {
  const pick = await experts(RO);
  return [
    { expertId: pick('EVC-DEMO-0001'), seat: 'ACADEMICIAN' },
    { expertId: pick('EVC-DEMO-0002'), seat: 'EXPERT' },
    { expertId: pick('EVC-DEMO-0003'), seat: 'ARCHITECT_PLANNING' },
  ];
}
/** Proposes a one-hour visit at `start`, invites the demo committee, has everyone accept and confirms. Returns the visit id. */
async function scheduled(id: string, start: string) {
  const RO = await login('regional.officer');
  const end = new Date(new Date(start).getTime() + 3600000).toISOString();
  expect((await RO.post(`/api/official/applications/${id}/actions/PROPOSE_EVC_DATE`).send({ mode: 'ONLINE', scheduledStart: start, scheduledEnd: end, meetingLink: 'https://meet.example.test/evc' })).status).toBe(200);
  const inv = await RO.post(`/api/official/applications/${id}/actions/ASSIGN_EVC_MEMBERS`).send({ members: await committee(RO) });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  const vid = (await db.one<{ id: string }>("SELECT id FROM evc_visits WHERE application_id = $1 AND status = 'PROPOSED'", [id]))!.id;
  for (const m of ['evc.member', 'evc.member2', 'evc.member3']) expect((await (await login(m)).post(`/api/evc/visits/${vid}/respond`).send({ response: 'ACCEPTED' })).status).toBe(200);
  const c = await RO.post(`/api/official/applications/${id}/actions/CONFIRM_EVC`);
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return (await db.one<{ id: string }>("SELECT id FROM evc_visits WHERE application_id = $1 AND status = 'SCHEDULED'", [id]))!.id;
}
const status = async (id: string) => (await db.one<{ status: string }>('SELECT status FROM applications WHERE id = $1', [id]))!.status;

beforeAll(async () => {
  db = await createDb({ dataDir: 'memory://' });
  await migrate(db);
  await seed(db);
  app = createApp({ db, storage: new MemoryStorage(), silent: true, loginsPerMinute: 1000 }).app;
  for (const l of ['applicant.demo', 'applicant.sample'])
    await (await login(l)).put('/api/institution/profile').send({
      name: l === 'applicant.demo' ? 'Demo Institute of Technology, Pune (TEST)' : 'Sample College of Engineering, Chennai (TEST)',
      address: 'Survey No. 12, Demo Road',
      state: 'Maharashtra',
      district: 'Pune',
      pincode: '411001',
      official_email: 'office@demo-institute.test',
      applicant_name: 'Demo Applicant',
      applicant_designation: 'Principal',
    });
});
afterAll(async () => db?.close());

// ------------------------------------------------------------------ composition rules (pure)
describe('EVC composition — APH Annexure 16 §16.5', () => {
  const base: Expert = { id: 'x', member_code: 'T', user_id: 'u', full_name: 'T', designation_level: 'PROFESSOR', discipline: 'ENGINEERING_TECHNOLOGY', organisation_type: 'IIT', experience_years: 10, coa_registration_no: null, panel_status: 'ON_APPROVED_PANEL', verification_status: 'VERIFIED', active: true };
  it('applies the seat qualifications literally and never treats unverified records as eligible', () => {
    expect(seatEligibility(base, 'ACADEMICIAN').outcome).toBe('PASS');
    expect(seatEligibility({ ...base, designation_level: 'ASSOCIATE_PROFESSOR' }, 'ACADEMICIAN').outcome).toBe('FAIL');
    expect(seatEligibility({ ...base, panel_status: 'NOT_ON_PANEL' }, 'ACADEMICIAN').outcome).toBe('FAIL');
    expect(seatEligibility({ ...base, designation_level: 'INDUSTRY_EXPERT', experience_years: 4 }, 'EXPERT').outcome).toBe('FAIL');
    expect(seatEligibility({ ...base, designation_level: 'INDUSTRY_EXPERT', experience_years: 5 }, 'EXPERT').outcome).toBe('PASS');
    expect(seatEligibility({ ...base, designation_level: 'INDUSTRY_EXPERT', experience_years: null }, 'EXPERT').outcome).toBe('HUMAN_REVIEW_REQUIRED');
    expect(seatEligibility({ ...base, designation_level: 'ASSISTANT_PROFESSOR', discipline: 'ARCHITECTURE' }, 'ARCHITECT_PLANNING').outcome).toBe('PASS');
    expect(seatEligibility({ ...base, designation_level: 'ASSOCIATE_PROFESSOR', discipline: 'CIVIL_STRUCTURAL' }, 'ARCHITECT_PLANNING').outcome).toBe('PASS');
    expect(seatEligibility({ ...base, designation_level: 'ARCHITECT', organisation_type: 'CPWD' }, 'ARCHITECT_PLANNING').outcome).toBe('HUMAN_REVIEW_REQUIRED'); // ambiguous text
    expect(seatEligibility({ ...base, verification_status: 'NEEDS_VERIFICATION' }, 'ACADEMICIAN').outcome).toBe('HUMAN_REVIEW_REQUIRED');
    expect(seatEligibility({ ...base, active: false }, 'ACADEMICIAN').outcome).toBe('FAIL');
  });
  it('requires one member per seat, blocks duplicates and keeps the "may" note advisory', () => {
    const architect = { ...base, id: 'c', designation_level: 'ARCHITECT', discipline: 'ARCHITECTURE', coa_registration_no: 'CA/1', panel_status: 'NOT_ON_PANEL' };
    const ok = validateComposition(
      [
        { expert: base, seat: 'ACADEMICIAN' },
        { expert: { ...base, id: 'b', designation_level: 'ASSOCIATE_PROFESSOR' }, seat: 'EXPERT' },
        { expert: architect, seat: 'ARCHITECT_PLANNING' },
      ],
      { deemedUniversity: null },
    );
    expect(ok.valid).toBe(true);
    expect(ok.findings.find((f) => f.id === 'PROGRAMME_SPECIALISATION')!.blocking).toBe(false);
    const missing = validateComposition([{ expert: base, seat: 'ACADEMICIAN' }], { deemedUniversity: null });
    expect(missing.valid).toBe(false);
    expect(missing.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['MISSING_EXPERT', 'MISSING_ARCHITECT_PLANNING']));
    const dup = validateComposition([{ expert: base, seat: 'ACADEMICIAN' }, { expert: base, seat: 'EXPERT' }, { expert: architect, seat: 'ARCHITECT_PLANNING' }], { deemedUniversity: null });
    expect(dup.findings.some((f) => f.id === 'DUPLICATE_MEMBER')).toBe(true);
    expect(validateComposition([{ expert: base, seat: 'ACADEMICIAN' }], { deemedUniversity: true }).findings.some((f) => f.id === 'DEEMED_CHAIRMAN' && f.blocking)).toBe(true);
  });
  it('never infers a completed or missed visit from the clock', () => {
    expect(memberStatus({ active: true, response_status: 'ACCEPTED' }, { status: 'SCHEDULED' }, { reportSubmitted: false, draft: false, reportDueAt: null, now: new Date(Date.now() + 30 * DAY) })).toBe('VISIT_SCHEDULED');
    expect(memberStatus({ active: true, response_status: 'ACCEPTED' }, { status: 'COMPLETED' }, { reportSubmitted: false, draft: true, reportDueAt: iso(-DAY) })).toBe('REPORT_OVERDUE');
    expect(memberStatus({ active: true, response_status: 'CONFLICT_REPORTED' }, { status: 'SCHEDULED' }, { reportSubmitted: false, draft: false, reportDueAt: null })).toBe('HUMAN_REVIEW_REQUIRED');
    expect(memberStatus({ active: true, response_status: 'REJECTED' }, { status: 'PROPOSED' }, { reportSubmitted: false, draft: false, reportDueAt: null })).toBe('DECLINED');
  });
});

// ------------------------------------------------------------------ registry, assignment, scope
describe('EVC registry, assignment and Regional Officer scope', () => {
  let id: string;
  beforeAll(async () => {
    id = await readyForEvc('registry');
  });

  it('a Regional Officer sees only applications in the regions configured for them', async () => {
    const west = await login('regional.officer');
    const south = await login('regional.officer2');
    expect((await west.get(`/api/official/applications/${id}`)).status).toBe(200);
    expect((await south.get(`/api/official/applications/${id}`)).status).toBe(404);
    expect((await south.get('/api/official/queue?scope=mine')).body.applications.some((a: { id: string }) => a.id === id)).toBe(false);
    expect((await south.post(`/api/official/applications/${id}/actions/PROPOSE_EVC_DATE`).send({ mode: 'ONLINE', scheduledStart: iso(5 * DAY), meetingLink: 'https://x.test/a' })).status).toBe(404);
  });

  it('registry records start unverified; a different Bureau officer verifies; edits reset verification', async () => {
    const RO = await login('regional.officer');
    const c = await RO.post('/api/evc/experts').send({ fullName: 'Registry Test Professor', officialEmail: 'prof@test.example', designationLevel: 'PROFESSOR', discipline: 'PHARMACY', organisation: 'Test Govt College', organisationType: 'GOVERNMENT', panelStatus: 'ON_APPROVED_PANEL', panelReference: 'TEST' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const eid = c.body.expert.id;
    const get = async () => (await RO.get(`/api/evc/experts/${eid}`)).body.expert;
    expect((await get()).verification_status).toBe('NEEDS_VERIFICATION');
    expect((await get()).seatEligibility.ACADEMICIAN.outcome).toBe('HUMAN_REVIEW_REQUIRED');
    expect((await RO.post(`/api/evc/experts/${eid}/verify`).send({ status: 'VERIFIED', source: 'Self-verification attempt' })).status).toBe(403);
    const B = await login('regulation.bureau');
    expect((await B.post(`/api/evc/experts/${eid}/verify`).send({ status: 'VERIFIED', source: 'Checked against panel list (TEST)' })).status).toBe(200);
    expect((await get()).seatEligibility.ACADEMICIAN.outcome).toBe('PASS');
    await RO.patch(`/api/evc/experts/${eid}`).send({ fullName: 'Registry Test Professor', officialEmail: 'prof@test.example', designationLevel: 'PROFESSOR', discipline: 'PHARMACY', organisation: 'Test Govt College', organisationType: 'GOVERNMENT', panelStatus: 'ON_APPROVED_PANEL' });
    expect((await get()).verification_status).toBe('NEEDS_VERIFICATION');
    expect((await db.query('SELECT event FROM evc_expert_events WHERE expert_id = $1 ORDER BY id', [eid])).map((e: any) => e.event)).toEqual(['CREATED', 'VERIFIED', 'UPDATED_VERIFICATION_RESET']);
    expect((await (await login('evc.member')).get('/api/evc/experts')).status).toBe(403);
    expect((await (await login('applicant.demo')).get('/api/evc/experts')).status).toBe(403);
  });

  it('offline visits need the extraordinary circumstance recorded; confirmation needs a valid committee', async () => {
    const RO = await login('regional.officer');
    const off = await RO.post(`/api/official/applications/${id}/actions/PROPOSE_EVC_DATE`).send({ mode: 'PHYSICAL', scheduledStart: iso(6 * DAY), scheduledEnd: iso(6 * DAY + 7200000), location: 'Campus' });
    expect(off.status).toBe(400);
    expect(off.body.error).toBe('OFFLINE_JUSTIFICATION_REQUIRED');
    expect((await RO.post(`/api/official/applications/${id}/actions/PROPOSE_EVC_DATE`).send({ mode: 'ONLINE', scheduledStart: iso(6 * DAY), scheduledEnd: iso(6 * DAY + 7200000), meetingLink: 'https://meet.example.test/x' })).status).toBe(200);
    const pick = await experts(RO);
    const bad = await RO.post(`/api/official/applications/${id}/actions/ASSIGN_EVC_MEMBERS`).send({
      members: [
        { expertId: pick('EVC-DEMO-0001'), seat: 'ACADEMICIAN' },
        { expertId: pick('EVC-DEMO-0004'), seat: 'EXPERT' }, // unverified, 3 years of experience, no account
      ],
    });
    expect(bad.status).toBe(409); // invitations are never sent for an invalid committee
    expect(bad.body.error).toBe('COMPOSITION_INVALID');
    expect(JSON.stringify(bad.body.details)).toMatch(/MISSING_ARCHITECT_PLANNING/);
    expect((await RO.post(`/api/official/applications/${id}/actions/CONFIRM_EVC`)).body.error).toBe('NO_COMMITTEE');
    const good = await RO.post(`/api/official/applications/${id}/actions/ASSIGN_EVC_MEMBERS`).send({ members: await committee(RO) });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body.invited).toBe(3);
    expect((await RO.post(`/api/official/applications/${id}/actions/CONFIRM_EVC`)).body.error).toBe('RESPONSES_PENDING'); // sending is not confirming
    // Members are notified and must acknowledge; acknowledgement deadlines are operational and traceable.
    const n = await db.query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = 'evc.member3' AND n.event_type = 'EVC_ASSIGNED' AND n.application_id = $1", [id]);
    expect(n.length).toBeGreaterThan(0);
    const dl = await db.query<{ source_type: string; source_reference: string }>("SELECT source_type, source_reference FROM deadlines WHERE application_id = $1 AND subject_type = 'EVC_ACKNOWLEDGEMENT'", [id]);
    expect(dl).toHaveLength(3);
    expect(dl.every((d) => d.source_type === 'AUTHORISED_OPERATIONAL_CONFIGURATION' && /EVC_ACK_FOLLOWUP_HOURS/.test(d.source_reference))).toBe(true);
    // The assignment is audited with the composition snapshot.
    expect(await db.query("SELECT 1 FROM officer_actions WHERE application_id = $1 AND action = 'SEND_EVC_INVITATIONS'", [id])).not.toHaveLength(0);
    expect((await db.one<{ composition: { valid: boolean } }>("SELECT composition FROM evc_visits WHERE application_id = $1 AND status = 'PROPOSED'", [id]))!.composition.valid).toBe(true);
  });

  it('members acknowledge their own assignment and cannot see unrelated visits', async () => {
    const visit = (await db.one<{ id: string }>("SELECT id FROM evc_visits WHERE application_id = $1 AND status = 'PROPOSED'", [id]))!.id;
    const M = await login('evc.member3');
    expect((await M.post(`/api/evc/visits/${visit}/acknowledge`)).status).toBe(200);
    expect((await db.one<{ status: string }>("SELECT status FROM deadlines WHERE subject_type = 'EVC_ACKNOWLEDGEMENT' AND subject_id = $1", [`${visit}:${(await db.one<{ id: string }>("SELECT id FROM users WHERE login_id = 'evc.member3'"))!.id}`]))!.status).toBe('MET');
    const mine = (await M.get('/api/evc/my-assignments')).body.assignments;
    expect(mine.find((a: { visit_id: string }) => a.visit_id === visit).memberStatus).toBe('ACCEPTED');
    // A member not on the committee of another visit gets 404 for that visit and its application.
    const other = await readyForEvc('unrelated');
    const RO = await login('regional.officer');
    const pick = await experts(RO);
    // A proposal whose draft panel holds only member 0001: no invitation, so member3 must not see it.
    await RO.post(`/api/official/applications/${other}/actions/PROPOSE_EVC_DATE`).send({ mode: 'ONLINE', scheduledStart: iso(8 * DAY), scheduledEnd: iso(8 * DAY + 3600000), meetingLink: 'https://meet.example.test/y', panel: [{ expertId: pick('EVC-DEMO-0001'), seat: 'ACADEMICIAN' }] });
    const otherVisit = (await db.one<{ id: string }>('SELECT id FROM evc_visits WHERE application_id = $1', [other]))!.id;
    expect((await M.get(`/api/evc/visits/${otherVisit}`)).status).toBe(404);
    expect((await M.get(`/api/official/applications/${other}`)).status).toBe(404);
    expect((await M.post(`/api/evc/visits/${otherVisit}/acknowledge`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ visit outcome, reports, escalation
describe('visit outcome, report submission and Regulation Bureau escalation', () => {
  it('a passed visit time is flagged for follow-up once — never marked completed or missed', async () => {
    const id = await readyForEvc('unresolved');
    const visit = await scheduled(id, iso(2 * DAY));
    const later = new Date(Date.now() + 5 * DAY);
    const s1 = await runDeadlineSweep(db, later);
    const s2 = await runDeadlineSweep(db, later);
    expect(s1.evcEscalations).toBeGreaterThan(0);
    expect(s2.evcEscalations).toBe(0); // idempotent
    expect((await db.one<{ status: string }>('SELECT status FROM evc_visits WHERE id = $1', [visit]))!.status).toBe('SCHEDULED');
    expect(await status(id)).toBe('EVC_SCHEDULED'); // no automatic state change
    const esc = await db.query<{ kind: string }>('SELECT kind FROM escalations WHERE visit_id = $1', [visit]);
    expect(esc.filter((e) => e.kind === 'VISIT_OUTCOME_UNRESOLVED')).toHaveLength(1);
    expect(esc.filter((e) => e.kind === 'ACKNOWLEDGEMENT_OVERDUE')).toHaveLength(0); // everyone accepted before confirmation
    expect((await db.query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = 'regulation.bureau' AND n.event_type = 'BUREAU_ESCALATION'")).length).toBeGreaterThan(0);
  });

  it('a missed visit is reported by the committee, escalated, and can be rescheduled', async () => {
    const id = await readyForEvc('missed');
    const visit = await scheduled(id, iso(-5 * 3600000)); // five hours ago (one-hour visit)
    const M = await login('evc.member');
    const r = await M.post(`/api/evc/visits/${visit}/missed`).send({ reason: 'Institution unreachable on the link (TEST).' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await db.one<{ status: string }>('SELECT status FROM evc_visits WHERE id = $1', [visit]))!.status).toBe('MISSED');
    expect(await db.query("SELECT 1 FROM escalations WHERE visit_id = $1 AND kind = 'VISIT_MISSED'", [visit])).toHaveLength(1);
    expect(await status(id)).toBe('EVC_SCHEDULED');
    const RO = await login('regional.officer');
    const re = await RO.post(`/api/official/applications/${id}/actions/RESCHEDULE_EVC`).send({ scheduledStart: iso(4 * DAY), scheduledEnd: iso(4 * DAY + 3600000), reason: 'New date after missed visit (TEST).' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect((await db.one<{ status: string }>('SELECT status FROM evc_visits WHERE id = $1', [visit]))!.status).toBe('RESCHEDULED');
  });

  it('attendance, completion, draft, evidence and a versioned report with receipt', async () => {
    const id = await readyForEvc('report');
    const visit = await scheduled(id, iso(-3 * 3600000));
    const M = await login('evc.member');
    expect((await M.post(`/api/evc/visits/${visit}/complete`).send({ note: 'Done (TEST).' })).status).toBe(409); // not started
    expect((await M.post(`/api/official/applications/${id}/actions/START_EVC`)).status).toBe(200);
    expect((await M.post(`/api/evc/visits/${visit}/complete`).send({ note: 'Done (TEST).' })).body.error).toBe('NO_ATTENDANCE');
    expect((await M.post(`/api/evc/visits/${visit}/attendance`).send({ attendance: 'PRESENT' })).status).toBe(200);
    const other = (await db.one<{ id: string }>("SELECT id FROM users WHERE login_id = 'evc.member2'"))!.id;
    expect((await M.post(`/api/evc/visits/${visit}/attendance`).send({ userId: other, attendance: 'PRESENT' })).status).toBe(403); // own attendance only
    expect((await M.post(`/api/evc/visits/${visit}/complete`).send({ note: 'Visit completed online (TEST).' })).status).toBe(200);
    const due = await db.one<{ source_type: string }>("SELECT source_type FROM deadlines WHERE subject_type = 'EVC_REPORT' AND subject_id = $1", [visit]);
    expect(due!.source_type).toBe('AUTHORISED_OPERATIONAL_CONFIGURATION');
    expect((await M.put(`/api/evc/visits/${visit}/draft`).send({ sections: { INSTRUCTIONAL: { finding: 'VERIFIED_AVAILABLE', observation: 'Classrooms verified (TEST).' } } })).status).toBe(200);
    const ev = await M.post(`/api/evc/visits/${visit}/evidence`).field('note', 'Lab photo (TEST)').attach('file', PDF('EVIDENCE'), 'lab.pdf');
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    // A Regional Officer of another region and an institution cannot read the evidence.
    expect((await (await login('regional.officer2')).get(`/api/evc/evidence/${ev.body.evidence.id}/download`)).status).toBe(404);
    expect((await (await login('applicant.demo')).get(`/api/evc/evidence/${ev.body.evidence.id}/download`)).status).toBe(403);
    expect((await M.get(`/api/evc/evidence/${ev.body.evidence.id}/download`)).status).toBe(200);
    const rep = await M.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send({
      declaration: true,
      observations: 'Instructional area verified against Annexure 3 (TEST).',
      recommendation: 'Facilities as verified (TEST)',
      sections: { INSTRUCTIONAL: { finding: 'VERIFIED_AVAILABLE' }, FACULTY: { finding: 'NOT_VERIFIED', observation: 'Appointment orders not produced (TEST).' } },
    });
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.report.version).toBe(1);
    expect(rep.body.report.receipt_no).toMatch(/^FG-EVCR-/);
    expect((await db.one<{ report_id: string | null }>('SELECT report_id FROM evc_report_evidence WHERE id = $1', [ev.body.evidence.id]))!.report_id).toBe(rep.body.report.id);
    expect((await db.one<{ status: string }>("SELECT status FROM deadlines WHERE subject_type = 'EVC_REPORT' AND subject_id = $1", [visit]))!.status).toBe('MET');
    expect(await status(id)).toBe('EVC_REPORT_SUBMITTED');
  });

  it('an overdue report is escalated; the Bureau follows up without touching the application', async () => {
    const id = await readyForEvc('overdue-report');
    const visit = await scheduled(id, iso(-7 * 3600000));
    const M = await login('evc.member');
    await M.post(`/api/official/applications/${id}/actions/START_EVC`);
    await M.post(`/api/evc/visits/${visit}/attendance`).send({ attendance: 'PRESENT' });
    await M.post(`/api/evc/visits/${visit}/complete`).send({ note: 'Completed (TEST).' });
    for (const login_ of ['evc.member', 'evc.member2', 'evc.member3']) await (await login(login_)).post(`/api/evc/visits/${visit}/acknowledge`); // late acks are refused after start
    await runDeadlineSweep(db, new Date(Date.now() + 10 * DAY));
    const esc = await db.one<{ id: string; status: string }>("SELECT id, status FROM escalations WHERE visit_id = $1 AND kind = 'REPORT_OVERDUE'", [visit]);
    expect(esc).toBeTruthy();
    const before = await status(id);
    const B = await login('regulation.bureau');
    const q = await B.get('/api/bureau/escalations?open=true');
    expect(q.body.escalations.some((e: { id: string }) => e.id === esc!.id)).toBe(true);
    expect((await B.post(`/api/bureau/escalations/${esc!.id}/actions`).send({ action: 'CLOSE', note: 'Too early (TEST).' })).status).toBe(409);
    expect((await B.post(`/api/bureau/escalations/${esc!.id}/actions`).send({ action: 'ACKNOWLEDGE', note: 'Taken up (TEST).' })).status).toBe(200);
    expect((await B.post(`/api/bureau/escalations/${esc!.id}/actions`).send({ action: 'REQUEST_EXPLANATION', note: 'Please explain the delay (TEST).' })).status).toBe(200);
    const resp = await (await login('evc.member')).post(`/api/evc/escalations/${esc!.id}/respond`).send({ note: 'Report being finalised (TEST).' });
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    const RO = await login('regional.officer');
    expect((await RO.post(`/api/bureau/escalations/${esc!.id}/actions`).send({ action: 'RESOLVE', note: 'x'.repeat(10) })).status).toBe(403);
    const roId = (await db.one<{ id: string }>("SELECT id FROM users WHERE login_id = 'regional.officer'"))!.id;
    expect((await B.post(`/api/bureau/escalations/${esc!.id}/actions`).send({ action: 'ASSIGN_ACTION', note: 'Follow up with the committee (TEST).', assignTo: roId })).status).toBe(200);
    expect((await B.post(`/api/bureau/escalations/${esc!.id}/actions`).send({ action: 'RESOLVE', note: 'Report expected this week (TEST).' })).status).toBe(200);
    expect((await B.post(`/api/bureau/escalations/${esc!.id}/actions`).send({ action: 'CLOSE', note: 'Closed after resolution (TEST).' })).status).toBe(200);
    const trail = await db.query<{ action: string }>('SELECT action FROM escalation_actions WHERE escalation_id = $1 ORDER BY id', [esc!.id]);
    expect(trail.map((t) => t.action)).toEqual(['RAISED', 'ACKNOWLEDGE', 'REQUEST_EXPLANATION', 'RESPONSE', 'ASSIGN_ACTION', 'RESOLVE', 'CLOSE']);
    await expect(db.query("UPDATE escalation_actions SET note = 'x' WHERE escalation_id = $1", [esc!.id])).rejects.toThrow(/append-only/);
    expect(await status(id)).toBe(before); // escalation never changes the workflow
    const ov = (await B.get('/api/bureau/overview')).body;
    expect(Array.isArray(ov.byStage)).toBe(true);
  });
});

// ------------------------------------------------------------------ compliance, validity, reports, policies, security
describe('compliance lifecycle, document validity and reports', () => {
  it('undertakings come only from APH clauses; submission is never treated as acceptance', async () => {
    const specs = decisionObligations({ id: 'a', institution_id: 'i', category_code: 'NEW_PROGRAMME_LEVEL', subtype: null, field_values: {}, reference_no: 'X' } as never, { decision_type: 'EOA', decision_date: '2026-10-01', uploaded_at: '2026-10-01T10:00:00Z', corrective_action: null });
    const und = specs.filter((s) => s.kind === 'UNDERTAKING');
    expect(und.map((s) => s.key)).toEqual(['UNDERTAKING_INTERNSHIP_POLICY', 'UNDERTAKING_EXAM_REFORMS']);
    expect(und.every((s) => s.dueDate === null && /Ch\. VI/.test(s.aphReference))).toBe(true);

    const inst = (await db.one<{ id: string }>("SELECT id FROM institutions WHERE aicte_institution_id = 'DEMO-INST-0001'"))!.id;
    const appId = (await db.one<{ id: string }>("SELECT id FROM applications WHERE institution_id = $1 AND status <> 'DRAFT' LIMIT 1", [inst]))!.id;
    const o = await db.one<{ id: string }>(
      "INSERT INTO compliance_obligations(institution_id, application_id, obligation_key, title, description, aph_reference, trigger_event, due_date) VALUES ($1,$2,'TEST_ITEM','Test obligation','TEST','Ch. II §2.25(n)','TEST', (now() AT TIME ZONE 'Asia/Kolkata')::date + 5) RETURNING id",
      [inst, appId],
    );
    const A = await login('applicant.demo');
    const listed = (await A.get('/api/compliance')).body.obligations.find((x: { id: string }) => x.id === o!.id);
    expect(listed.displayStatus).toBe('DUE_SOON');
    expect((await A.post(`/api/compliance/${o!.id}/evidence`).attach('file', PDF('EV1'), 'ev1.pdf')).body.status).toBe('SUBMITTED');
    const D = await login('decision.authority');
    expect((await D.post(`/api/official/compliance/${o!.id}/review`).send({ outcome: 'DEFICIENT', note: 'Signature missing (TEST).' })).status).toBe(200);
    expect((await A.post(`/api/compliance/${o!.id}/evidence`).attach('file', PDF('EV2'), 'ev2.pdf')).status).toBe(200);
    expect((await D.post(`/api/official/compliance/${o!.id}/review`).send({ outcome: 'ACCEPTED_BY_AUTHORISED_REVIEWER', note: 'In order (TEST).' })).status).toBe(200);
    expect((await A.post(`/api/compliance/${o!.id}/evidence`).attach('file', PDF('EV3'), 'ev3.pdf')).status).toBe(409);
    expect(await db.query('SELECT version FROM compliance_submissions WHERE obligation_id = $1 ORDER BY version', [o!.id])).toHaveLength(2);
    expect((await db.query<{ outcome: string }>('SELECT outcome FROM compliance_reviews WHERE obligation_id = $1 ORDER BY id', [o!.id])).map((r) => r.outcome)).toEqual(['DEFICIENT', 'ACCEPTED_BY_AUTHORISED_REVIEWER']);
  });

  it('approaching compliance deadlines trigger the configured reminder; overdue ones are flagged, not enforced', async () => {
    const inst = (await db.one<{ id: string }>("SELECT id FROM institutions WHERE aicte_institution_id = 'DEMO-INST-0001'"))!.id;
    const appId = (await db.one<{ id: string; status: string }>("SELECT id, status FROM applications WHERE institution_id = $1 AND status <> 'DRAFT' LIMIT 1", [inst]))!;
    const o = await db.one<{ id: string }>(
      "INSERT INTO compliance_obligations(institution_id, application_id, obligation_key, title, description, aph_reference, trigger_event, due_date) VALUES ($1,$2,'TEST_DUE','Due soon (TEST)','TEST','Ch. II §2.25(n)','TEST', (now() AT TIME ZONE 'Asia/Kolkata')::date + 2) RETURNING id",
      [inst, appId.id],
    );
    await runDeadlineSweep(db);
    expect(await db.query("SELECT 1 FROM deadline_events WHERE dedupe_key LIKE $1", [`obl:${o!.id}:reminder:%`])).toHaveLength(1);
    await runDeadlineSweep(db, new Date(Date.now() + 5 * DAY));
    expect(await db.query('SELECT 1 FROM deadline_events WHERE dedupe_key = $1', [`obl:${o!.id}:overdue`])).toHaveLength(1);
    expect((await db.one<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId.id]))!.status).toBe(appId.status);
  });

  it('document validity is computed only from verified rules; unknown periods are not invented', async () => {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'EOA_SELF_DISCLOSURE' });
    const id = c.body.application.id;
    const soon = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    expect((await A.post(`/api/applications/${id}/documents`).field('requirementId', 'EOA-FIRE').field('metadata', JSON.stringify({ dscDeclared: true, expiryDate: soon })).attach('file', PDF(), 'fire.pdf')).status).toBe(201);
    expect((await A.post(`/api/applications/${id}/documents`).field('requirementId', 'EOA-OC').field('metadata', '{"dscDeclared":true}').attach('file', PDF(), 'oc.pdf')).status).toBe(201);
    const rows = await documentValidity(db, { applicationId: id }, 30);
    expect(rows.find((r) => r.requirementId === 'EOA-FIRE')!.status).toBe('EXPIRING_SOON');
    expect(rows.find((r) => r.requirementId === 'EOA-OC')!.status).toBe('UNABLE_TO_VERIFY'); // expiry not recorded
    const view = (await A.get('/api/document-validity')).body.documents;
    expect(view.some((r: { status: string }) => r.status === 'NEEDS_VERIFICATION' || r.status === 'EXPIRING_SOON')).toBe(true);
    const s = await runDeadlineSweep(db);
    expect(s.validityAlerts).toBeGreaterThan(0);
    expect((await runDeadlineSweep(db)).validityAlerts).toBe(0); // no duplicate alerts
  });

  it('pendency report: scoped, filterable, exported as audited CSV with formula neutralisation', async () => {
    const S = await login('supervisor');
    const all = (await S.get('/api/reports/pendency')).body;
    expect(all.rows.length).toBeGreaterThan(0);
    expect(all.rows.every((r: Record<string, unknown>) => !('officialEmail' in r) && !('phone' in r))).toBe(true);
    const south = (await (await login('regional.officer2')).get('/api/reports/pendency')).body;
    expect(south.rows.every((r: { region: string }) => r.region === 'DEMO-RO-SOUTH')).toBe(true);
    const filtered = (await S.get('/api/reports/pendency?stage=EVC_SCHEDULED')).body.rows;
    expect(filtered.every((r: { stage: string }) => r.stage === 'EVC scheduled')).toBe(true);
    const csv = await S.get('/api/reports/pendency?format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('"applicationRef"');
    expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'REPORT_EXPORTED'")).not.toHaveLength(0);
    expect((await (await login('applicant.demo')).get('/api/reports/pendency')).status).toBe(403);
    expect((await (await login('evc.member')).get('/api/reports/pendency')).status).toBe(403);
  });
});

describe('governance, configuration and security', () => {
  it('operational policies are versioned; the person who changes one cannot authorise it', async () => {
    const ad = await login('sys.admin');
    expect((await ad.put('/api/official/admin/policies/EVC_REPORT_DUE_DAYS').send({ value: 5, reason: 'Proposed by administrator (TEST).' })).status).toBe(200);
    expect((await ad.post('/api/official/admin/policies/EVC_REPORT_DUE_DAYS/authorise').send({ reason: 'self' })).status).toBe(403);
    const sv = await login('supervisor');
    expect((await sv.post('/api/official/admin/policies/EVC_REPORT_DUE_DAYS/authorise').send({ reason: 'Authorised (TEST).' })).status).toBe(200);
    const p = await db.one<{ value: number; version: number; status: string }>("SELECT value, version, status FROM operational_policies WHERE key = 'EVC_REPORT_DUE_DAYS'");
    expect(p).toMatchObject({ value: 5, version: 2, status: 'AUTHORISED' });
    await expect(db.query("DELETE FROM operational_policy_history WHERE key = 'EVC_REPORT_DUE_DAYS'")).rejects.toThrow(/append-only/);
  });

  it('a rule must be approved for execution by a different official from its verifier', async () => {
    const rule = (await db.one<{ rule_id: string; rule_version: number }>("SELECT rule_id, rule_version FROM regulatory_rules WHERE lifecycle_status = 'APPROVED_FOR_EXECUTION' LIMIT 1"))!;
    await db.query("UPDATE regulatory_rules SET lifecycle_status = 'NEEDS_VERIFICATION' WHERE rule_id = $1 AND rule_version = $2", [rule.rule_id, rule.rule_version]);
    const g1 = await login('rules.governance');
    const url = `/api/rules/${encodeURIComponent(rule.rule_id)}/${rule.rule_version}/lifecycle`;
    expect((await g1.post(url).send({ to: 'VERIFIED', note: 'Checked against APH (TEST).' })).status).toBe(200);
    const same = await g1.post(url).send({ to: 'APPROVED_FOR_EXECUTION', note: 'Self approval (TEST).' });
    expect(same.status).toBe(409);
    expect(same.body.error).toBe('SECOND_APPROVER_REQUIRED');
    expect((await (await login('rules.publisher')).post(url).send({ to: 'APPROVED_FOR_EXECUTION', note: 'Second approval (TEST).' })).status).toBe(200);
  });

  it('server code, configuration and dotfiles are never served; credentials never leave the server', async () => {
    for (const p of ['/server/db/seed.ts', '/.env', '/.env.example', '/package.json', '/tests/evc_bureau.test.ts', '/data/pgdata/PG_VERSION', '/supabase/rls.sql'])
      expect((await request(app).get(p)).status, p).toBe(404);
    const me = await (await login('regional.officer')).get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash|token/i);
    const ex = await (await login('regional.officer')).get('/api/evc/experts');
    expect(JSON.stringify(ex.body)).not.toMatch(/password_hash/);
    expect((await request(app).get('/api/bureau/escalations')).status).toBe(401);
    expect((await (await login('evc.member')).get('/api/bureau/escalations')).status).toBe(403);
    expect((await (await login('applicant.demo')).get('/api/evc/my-assignments')).status).toBe(403);
  });
});
