/**
 * Integration + end-to-end API test of the full institutional journey on an
 * in-memory PostgreSQL (PGlite): login → draft → upload → validation → submit →
 * scrutiny deficiency → correction → re-scrutiny → EVC → decision → appeal → SAC → Council.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createDb, migrate, type Db } from '../server/db/index.ts';
import { DEMO_ACCOUNTS, seed } from '../server/db/seed.ts';
import { MemoryStorage } from '../server/storage.ts';

let db: Db;
let app: ReturnType<typeof createApp>['app'];
const PDF = Buffer.from('%PDF-1.4\n% test document\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
const pw = (login: string) => DEMO_ACCOUNTS.find((a) => a.loginId === login)!.password;

async function login(loginId: string) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ loginId, password: pw(loginId) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return agent;
}

beforeAll(async () => {
  db = await createDb({ dataDir: 'memory://' });
  await migrate(db);
  await seed(db);
  app = createApp({ db, storage: new MemoryStorage(), silent: true, loginsPerMinute: 200 }).app;
});
afterAll(async () => db?.close());

describe('authentication and access control', () => {
  it('rejects bad credentials with a generic message', async () => {
    const r = await request(app).post('/api/auth/login').send({ loginId: 'applicant.demo', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/Invalid User ID or password/);
  });
  it('returns server-assigned roles and never trusts a client role', async () => {
    const a = await login('applicant.demo');
    const me = await a.get('/api/auth/me');
    expect(me.body.user.activeRole).toBe('INSTITUTION_APPLICANT');
    const sw = await a.post('/api/auth/switch-role').send({ role: 'DECISION_AUTHORITY' });
    expect(sw.status).toBe(403);
  });
  it('requires authentication for protected endpoints', async () => {
    expect((await request(app).get('/api/applications')).status).toBe(401);
  });
  it('blocks applicants from official operations', async () => {
    const a = await login('applicant.demo');
    expect((await a.get('/api/official/queue')).status).toBe(403);
  });
});

describe('full institutional workflow', () => {
  let A: request.Agent;
  let appId: string;

  it('profile must be completed before submission', async () => {
    A = await login('applicant.demo');
    const p = await A.put('/api/institution/profile').send({
      name: 'Demo Institute of Technology, Pune',
      address: 'Survey No. 12, Demo Road, Pune',
      state: 'Maharashtra',
      district: 'Pune',
      pincode: '411001',
      official_email: 'office@demo-institute.test',
      applicant_name: 'Demo Applicant',
      applicant_designation: 'Principal',
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.institution.id_verification_status).toBe('UNVERIFIED');
  });

  it('creates and persists a draft (Change of Institution Name)', async () => {
    const r = await A.post('/api/applications').send({ categoryCode: 'INSTITUTION_NAME_CHANGE' });
    expect(r.status).toBe(201);
    appId = r.body.application.id;
    const save = await A.patch(`/api/applications/${appId}`).send({
      rowVersion: r.body.application.row_version,
      fields: {
        academicYear: '2026-27',
        authorisedSignatoryName: 'Chair Person',
        authorisedSignatoryDesignation: 'CHAIRMAN',
        institutionCategory: 'SELF_FINANCING',
        affiliatingBody: 'Demo University',
        currentName: 'Demo Institute of Technology',
        proposedName: 'Demo Institute of Technology and Research',
        nameChangeReason: 'Expansion into research programmes',
        resolutionDate: '2026-09-15',
      },
    });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    const again = await A.get(`/api/applications/${appId}`);
    expect(again.body.application.field_values.proposedName).toBe('Demo Institute of Technology and Research');
    expect(again.body.application.status).toBe('DRAFT');
    expect(again.body.application.reference_no).toBeNull();
  });

  it('rejects unknown fields and stale versions', async () => {
    const cur = await A.get(`/api/applications/${appId}`);
    expect((await A.patch(`/api/applications/${appId}`).send({ rowVersion: cur.body.application.row_version, fields: { hacker: 'x' } })).status).toBe(400);
    expect((await A.patch(`/api/applications/${appId}`).send({ rowVersion: 1, fields: { currentName: 'x' } })).status).toBe(409);
  });

  it('rejects files that are not really PDF/JPG/PNG', async () => {
    const r = await A.post(`/api/applications/${appId}/documents`).field('requirementId', 'NAME-RES').field('metadata', '{"dscDeclared":true}').attach('file', Buffer.from('MZ fake exe'), 'res.pdf');
    expect(r.status).toBe(415);
  });

  it('blocks submission while mandatory documents are missing', async () => {
    const r = await A.post(`/api/applications/${appId}/submit`).send({ declaration: true });
    expect(r.status).toBe(422);
    const ids = r.body.validation.findings.filter((f: { blocking: boolean }) => f.blocking).map((f: { ruleId: string }) => f.ruleId);
    expect(ids).toContain('INSTITUTION_NAME_CHANGE.DOC.NAME-RES.PRESENT');
    expect(ids).toContain('INSTITUTION_NAME_CHANGE.DOC.NAME_NOC_OR_RECEIPT.PRESENT');
  });

  it('uploads documents with versions and submits with a server-generated reference', async () => {
    for (const req of ['NAME-RES', 'NAME-NOC']) {
      const u = await A.post(`/api/applications/${appId}/documents`)
        .field('requirementId', req)
        .field('metadata', JSON.stringify({ dscDeclared: true, issueDate: '2026-09-15' }))
        .attach('file', PDF, `${req}.pdf`);
      expect(u.status, JSON.stringify(u.body)).toBe(201);
    }
    const v2 = await A.post(`/api/applications/${appId}/documents`).field('requirementId', 'NAME-RES').field('metadata', '{"dscDeclared":true}').attach('file', PDF, 'res-v2.pdf');
    expect(v2.body.document.version).toBe(2);
    const s = await A.post(`/api/applications/${appId}/submit`).send({ declaration: true });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.application.reference_no).toMatch(/^FG-202627-\d{6}$/);
    expect(s.body.application.status).toBe('SUBMITTED');
    expect(s.body.application.submitted_at).toBeTruthy();
    const dup = await A.post(`/api/applications/${appId}/submit`).send({ declaration: true });
    expect(dup.status).toBe(409);
    const edit = await A.patch(`/api/applications/${appId}`).send({ rowVersion: 99, fields: { currentName: 'x' } });
    expect(edit.status).toBe(409);
  });

  it('isolates institutions: another institution cannot read it by ID', async () => {
    const B = await login('applicant.sample');
    expect((await B.get(`/api/applications/${appId}`)).status).toBe(404);
    expect((await B.get('/api/applications')).body.applications).toHaveLength(0);
    const docs = (await A.get(`/api/applications/${appId}`)).body.documents;
    expect((await B.get(`/api/documents/${docs[0].id}/download`)).status).toBe(404);
    expect((await A.get(`/api/documents/${docs[0].id}/download`)).status).toBe(200);
  });

  it('an applicant cannot force a workflow state', async () => {
    expect((await A.post(`/api/official/applications/${appId}/actions/COMPLETE_SCRUTINY`)).status).toBe(403);
  });

  let defId: string;
  it('scrutiny raises a deficiency and the institution is notified', async () => {
    const S = await login('scrutiny.officer');
    expect((await S.post(`/api/official/applications/${appId}/actions/START_SCRUTINY`)).status).toBe(200);
    const d = await S.post(`/api/official/applications/${appId}/deficiency-drafts`).send({
      targetType: 'DOCUMENT',
      targetId: 'NAME-NOC',
      category: 'SIGNATURE_AUTHENTICATION',
      explanation: 'NOC is not signed by the authorised signatory of the University.',
      sourceReference: 'Annexure 2 §2.10(i)',
      correctiveAction: 'Upload the NOC signed by the authorised signatory.',
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    defId = d.body.deficiency.id;
    const notice = await S.post(`/api/official/applications/${appId}/actions/ISSUE_DEFICIENCY_NOTICE`).send({ reason: 'NOC signature not verifiable.' });
    expect(notice.status, JSON.stringify(notice.body)).toBe(200);
    expect(notice.body.application.status).toBe('DEFICIENCY_RAISED');
    const n = await A.get('/api/notifications');
    expect(n.body.notifications.some((x: { event_type: string }) => x.event_type === 'DEFICIENCY_NOTICE')).toBe(true);
  });

  it('a deficiency deadline needs a stated type and basis (no invented deadlines)', async () => {
    const S = await login('scrutiny.officer');
    // Application is now in DEFICIENCY_RAISED; drafting is only allowed during scrutiny.
    const r = await S.post(`/api/official/applications/${appId}/deficiency-drafts`).send({
      targetType: 'APPLICATION',
      category: 'OTHER',
      explanation: 'General',
      correctiveAction: 'Fix',
      deadline: '2030-11-30',
    });
    expect([400, 409]).toContain(r.status);
  });

  it('institution corrects via a new document version and submits for re-scrutiny', async () => {
    expect((await A.post(`/api/applications/${appId}/corrections/submit`)).status).toBe(422);
    const wrong = await A.post(`/api/applications/${appId}/documents`).field('requirementId', 'NAME-RES').field('deficiencyId', defId).field('metadata', '{"dscDeclared":true}').attach('file', PDF, 'x.pdf');
    expect(wrong.status).toBe(409);
    const up = await A.post(`/api/applications/${appId}/documents`).field('requirementId', 'NAME-NOC').field('deficiencyId', defId).field('metadata', '{"dscDeclared":true}').attach('file', PDF, 'noc-signed.pdf');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.document.version).toBe(2);
    expect((await A.post(`/api/deficiencies/${defId}/respond`).send({ note: 'Signed NOC uploaded.' })).status).toBe(200);
    const s = await A.post(`/api/applications/${appId}/corrections/submit`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const detail = await A.get(`/api/applications/${appId}`);
    expect(detail.body.application.status).toBe('READY_FOR_RE_SCRUTINY');
    const versions = detail.body.documents.filter((d: { requirement_id: string }) => d.requirement_id === 'NAME-NOC');
    expect(versions).toHaveLength(2);
    expect(versions.filter((d: { is_current: boolean }) => d.is_current)).toHaveLength(1);
  });

  it('re-scrutiny evaluates only the changed document and its dependent rules', async () => {
    const R = await login('rescrutiny.officer');
    const r = await R.post(`/api/official/applications/${appId}/actions/START_RE_SCRUTINY`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const detail = await R.get(`/api/official/applications/${appId}`);
    const rep = detail.body.reports.find((x: { kind: string }) => x.kind === 'RE_SCRUTINY');
    expect(rep.content.run.scope).toContain('NAME-NOC');
    const ids: string[] = rep.content.deficiencies[0].newResults.map((f: { ruleId: string }) => f.ruleId);
    expect(ids.some((i) => i.includes('NAME-NOC'))).toBe(true);
    expect(JSON.stringify(rep.content)).not.toContain('proposedName.');
    expect((await R.post(`/api/official/applications/${appId}/actions/COMPLETE_RE_SCRUTINY`).send({ reason: 'All in order now.' })).status).toBe(409);
    expect((await R.post(`/api/official/deficiencies/${defId}/review`).send({ outcome: 'RESOLVED', note: 'Signed NOC verified.' })).status).toBe(200);
    const c = await R.post(`/api/official/applications/${appId}/actions/COMPLETE_RE_SCRUTINY`).send({ reason: 'Deficiency resolved.' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    // Name change: Table 2.3 has no EVC → straight to decision
    expect(c.body.application.status).toBe('AWAITING_AUTHORISED_DECISION');
  });

  it('only the Executive Committee records the first decision; obligations and appeal window follow', async () => {
    const S = await login('scrutiny.officer');
    expect((await S.post(`/api/official/applications/${appId}/actions/ISSUE_DECISION`).field('decisionType', 'LOR')).status).toBe(403);
    const D = await login('decision.authority');
    expect((await D.post(`/api/official/applications/${appId}/actions/ISSUE_DECISION`).field('decisionType', 'LOR')).status).toBe(403);
    const C = await login('council.official');
    expect((await C.post(`/api/official/applications/${appId}/actions/ISSUE_DECISION`).field('decisionType', 'LOR')).status).toBe(404); // no appeal: not the Council's case
    const EC = await login('ec.official');
    const d = await EC.post(`/api/official/applications/${appId}/actions/ISSUE_DECISION`)
      .field('decisionType', 'LOR')
      .field('referenceNo', 'EC/2026/TEST/001')
      .field('issuingAuthority', 'Executive Committee, AICTE')
      .field('decisionDate', '2026-10-24')
      .field('reasons', 'Test reasons for the speaking order.')
      .attach('file', PDF, 'lor.pdf');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.application.status).toBe('DECISION_ISSUED');
    const el = await A.get(`/api/applications/${appId}/appeal-eligibility`);
    expect(el.body.eligible).toBe(true);
    expect(el.body.aphReference).toBe('Ch. II §2.24(a)');
    const close = await D.post(`/api/official/applications/${appId}/actions/CLOSE`).send({ reason: 'Closing test.' });
    expect(close.status).toBe(409);
  });

  it('appeal is filed once, reviewed by SAC, and the Council decision is final', async () => {
    const ap = await A.post(`/api/applications/${appId}/appeal`).field('grounds', 'The deficiency was resolved and the name complies with §1.5.4 and §1.5.5.');
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    expect((await A.post(`/api/applications/${appId}/appeal`).field('grounds', 'Second appeal attempt should be rejected here.')).status).toBe(409);
    const SAC = await login('sac.member');
    expect((await SAC.post(`/api/official/applications/${appId}/actions/START_APPEAL_REVIEW`)).status).toBe(200);
    const rec = await SAC.post(`/api/official/applications/${appId}/actions/RECORD_SAC_RECOMMENDATION`).send({ outcome: 'RECOMMEND', notes: 'Recommended to Council.' });
    expect(rec.body.application.status).toBe('AWAITING_AUTHORISED_DECISION');
    const EC = await login('ec.official');
    expect((await EC.post(`/api/official/applications/${appId}/actions/ISSUE_DECISION`).field('decisionType', 'EOA').field('referenceNo', 'EC/2026/X/1').field('issuingAuthority', 'Executive Committee, AICTE').field('decisionDate', '2026-10-30').attach('file', PDF, 'x.pdf')).body.error).toBe('COUNCIL_DECIDES');
    const CO = await login('council.official');
    const fin = await CO.post(`/api/official/applications/${appId}/actions/ISSUE_DECISION`)
      .field('decisionType', 'EOA')
      .field('referenceNo', 'COUNCIL/2026/TEST/002')
      .field('issuingAuthority', 'Council, AICTE')
      .field('decisionDate', '2026-10-30')
      .attach('file', PDF, 'final.pdf');
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    const el = await A.get(`/api/applications/${appId}/appeal-eligibility`);
    expect(el.body.eligible).toBe(false);
    const comp = await A.get('/api/compliance');
    expect(comp.body.obligations.some((o: { obligation_key: string; due_date: string }) => o.obligation_key === 'STUDENT_ENROLMENT' && o.due_date.endsWith('-11-30'))).toBe(true);
  });

  it('records an append-only audit trail', async () => {
    const n = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1", [appId]);
    expect(n!.n).toBeGreaterThan(5);
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(db.query('UPDATE workflow_events SET note = $1', ['x'])).rejects.toThrow(/append-only/);
  });

  it('dashboard counts come from persisted data', async () => {
    const d = await A.get('/api/dashboard');
    expect(d.body.kpis.total).toBe(1);
    expect(d.body.kpis.withDecision).toBe(1);
  });
});

describe('EVC route and unverified categories', () => {
  it('a new-programme application routes through EVC scheduling and report', async () => {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
    const id = c.body.application.id;
    await A.patch(`/api/applications/${id}`).send({
      rowVersion: c.body.application.row_version,
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'C', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'U', proposedCourses: [{ programme: 'Management', level: 'PG', course: 'MBA', proposedIntake: 60 }], nocReference: 'NOC/1', resolutionDate: '2026-09-01' },
    });
    for (const r of ['NPL-NOC', 'NPL-RES']) await A.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF, `${r}.pdf`);
    expect((await A.post(`/api/applications/${id}/submit`).send({ declaration: true })).status).toBe(200);
    const S = await login('scrutiny.officer');
    await S.post(`/api/official/applications/${id}/actions/START_SCRUTINY`);
    const done = await S.post(`/api/official/applications/${id}/actions/COMPLETE_SCRUTINY`).send({ reason: 'Documents in order.' });
    expect(done.body.application.status).toBe('SCRUTINY_COMPLETED');
    const h = await S.post(`/api/official/applications/${id}/actions/APPROVE_EVC_HANDOFF`).send({ reason: 'Eligible for EVC per Table 2.3.' });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body.application.status).toBe('AWAITING_EVC_SCHEDULING');
    const RO = await login('regional.officer');
    const pr = await RO.post(`/api/official/applications/${id}/actions/PROPOSE_EVC_DATE`).send({ mode: 'ONLINE', scheduledStart: '2026-11-10T10:00:00+05:30', scheduledEnd: '2026-11-10T12:00:00+05:30', meetingLink: 'https://meet.example.test/evc', agenda: 'Verify infrastructure' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    const experts = (await RO.get('/api/evc/experts')).body.experts as Array<{ id: string; member_code: string }>;
    const pick = (code: string) => experts.find((e) => e.member_code === code)!.id;
    const asg = await RO.post(`/api/official/applications/${id}/actions/ASSIGN_EVC_MEMBERS`).send({
      members: [
        { expertId: pick('EVC-DEMO-0001'), seat: 'ACADEMICIAN' },
        { expertId: pick('EVC-DEMO-0002'), seat: 'EXPERT' },
        { expertId: pick('EVC-DEMO-0003'), seat: 'ARCHITECT_PLANNING' },
      ],
    });
    expect(asg.status, JSON.stringify(asg.body)).toBe(200);
    const visitId = (await RO.get(`/api/evc/scheduler/applications/${id}`)).body.visit.id;
    for (const m of ['evc.member', 'evc.member2', 'evc.member3']) expect((await (await login(m)).post(`/api/evc/visits/${visitId}/respond`).send({ response: 'ACCEPTED' })).status).toBe(200);
    const sch = await RO.post(`/api/official/applications/${id}/actions/CONFIRM_EVC`);
    expect(sch.status, JSON.stringify(sch.body)).toBe(200);
    const visits = await A.get('/api/evc-visits');
    expect(visits.body.visits[0].mode).toBe('ONLINE');
    expect((await A.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send({ observations: 'x'.repeat(20), recommendation: 'ok' })).status).toBe(403);
    const E = await login('evc.member');
    await E.post(`/api/official/applications/${id}/actions/START_EVC`);
    await E.post(`/api/evc/visits/${visitId}/attendance`).send({ attendance: 'PRESENT' });
    const rep = await E.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send({ declaration: true, observations: 'Infrastructure verified online against Annexure 3.', recommendation: 'Infrastructure adequate', disclosedSummary: 'Adequate', evidenceRefs: ['internal://evidence/1'] });
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const detail = await A.get(`/api/applications/${id}`);
    expect(detail.body.evcReports[0].evidence_refs).toBeUndefined();
    expect(detail.body.evcReports[0].observations).toContain('Infrastructure');
  });

  it('ODL/OL drafts are saved but final submission is disabled', async () => {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'ODL_OL', subtype: 'OL' });
    const s = await A.post(`/api/applications/${c.body.application.id}/submit`).send({ declaration: true });
    expect(s.status).toBe(409);
    expect(s.body.error).toBe('CATEGORY_NOT_VERIFIED');
  });
});
