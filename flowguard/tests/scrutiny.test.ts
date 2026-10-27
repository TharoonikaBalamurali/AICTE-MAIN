/**
 * Scrutiny → deficiency notice → correction → targeted re-scrutiny → EVC handoff → scheduling,
 * plus edge cases (missing / unreadable files, unknown expiry, unresolved corrections, overdue
 * deadlines, duplicate notifications, unauthorised access, failed delivery).
 * All data is synthetic and labelled as test data.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createDb, migrate, type Db } from '../server/db/index.ts';
import { DEMO_ACCOUNTS, seed } from '../server/db/seed.ts';
import { setDeliveryHook } from '../server/notify.ts';
import { runDeadlineSweep } from '../server/scheduler.ts';
import { addDays, todayIST } from '../server/services.ts';
import { inspectFile, MemoryStorage } from '../server/storage.ts';

let db: Db;
let app: ReturnType<typeof createApp>['app'];
const PDF = (tag = 'SYNTHETIC TEST FILE') => Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF`);
const SIGNED_PDF = Buffer.from('%PDF-1.7\n% SYNTHETIC SIGNED TEST FILE\n1 0 obj << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 10 20 30] >> endobj\n%%EOF');
const TRUNCATED_PDF = Buffer.from('%PDF-1.4\n% SYNTHETIC TRUNCATED FILE, no end marker\n1 0 obj << >>');
const pw = (l: string) => DEMO_ACCOUNTS.find((a) => a.loginId === l)!.password;
async function login(l: string) {
  const a = request.agent(app);
  const r = await a.post('/api/auth/login').send({ loginId: l, password: pw(l) });
  expect(r.status).toBe(200);
  return a;
}
/** The three verified DEMO registry experts, one per §16.5 seat. */
async function demoCommittee(RO: request.Agent) {
  const experts = (await RO.get('/api/evc/experts')).body.experts as Array<{ id: string; member_code: string }>;
  const pick = (code: string) => experts.find((e) => e.member_code === code)!.id;
  return [
    { expertId: pick('EVC-DEMO-0001'), seat: 'ACADEMICIAN' },
    { expertId: pick('EVC-DEMO-0002'), seat: 'EXPERT' },
    { expertId: pick('EVC-DEMO-0003'), seat: 'ARCHITECT_PLANNING' },
  ];
}
const notifs = async (userLogin: string) => db.query<{ event_type: string; dedupe_key: string | null; delivery_status: string }>(
  'SELECT n.event_type, n.dedupe_key, n.delivery_status FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = $1',
  [userLogin],
);

beforeAll(async () => {
  db = await createDb({ dataDir: 'memory://' });
  await migrate(db);
  await seed(db);
  app = createApp({ db, storage: new MemoryStorage(), silent: true, loginsPerMinute: 500 }).app;
  const A = await login('applicant.demo');
  await A.put('/api/institution/profile').send({
    name: 'Demo Institute of Technology, Pune (TEST)',
    address: 'Survey No. 12, Demo Road, Pune',
    state: 'Maharashtra',
    district: 'Pune',
    pincode: '411001',
    official_email: 'office@demo-institute.test',
    applicant_name: 'Demo Applicant',
    applicant_designation: 'Principal',
  });
});
afterAll(async () => db?.close());

describe('login rate limit', () => {
  it('blocks bursts of login attempts at the default limit', async () => {
    const limited = createApp({ db, storage: new MemoryStorage(), silent: true }).app;
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await request(limited).post('/api/auth/login').send({ loginId: 'nobody', password: 'x' })).status;
    expect(last).toBe(429);
  });
});

describe('technical file inspection', () => {
  it('detects truncated files and embedded signature structures (not proof of authenticity)', () => {
    expect(inspectFile(PDF(), 'pdf').readable).toBe(true);
    expect(inspectFile(TRUNCATED_PDF, 'pdf').readable).toBe(false);
    expect(inspectFile(SIGNED_PDF, 'pdf').signatureStructure).toBe(true);
    expect(inspectFile(PDF(), 'pdf').signatureStructure).toBe(false);
  });
});

describe('end-to-end scrutiny, re-scrutiny and EVC workflow (synthetic data)', () => {
  let A: request.Agent;
  let S: request.Agent;
  let R: request.Agent;
  let RO: request.Agent;
  let id: string;
  const upload = (agent: request.Agent, req: string, buf: Buffer, meta: Record<string, unknown> = {}, deficiencyId?: string) => {
    const r = agent.post(`/api/applications/${id}/documents`).field('requirementId', req).field('metadata', JSON.stringify({ dscDeclared: true, ...meta }));
    if (deficiencyId) r.field('deficiencyId', deficiencyId);
    return r.attach('file', buf, `${req}-TEST.pdf`);
  };

  it('1. institution submits; scrutiny queue and institution are notified; checks run and a report is saved', async () => {
    A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
    id = c.body.application.id;
    await A.patch(`/api/applications/${id}`).send({
      rowVersion: c.body.application.row_version,
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST Chair', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'TEST University', proposedCourses: [{ course: 'MBA (TEST)', proposedIntake: 60 }], nocReference: 'TEST/NOC/1', resolutionDate: '2026-09-01' },
    });
    expect((await upload(A, 'NPL-NOC', PDF(), { issueDate: '2026-09-05' })).status).toBe(201);
    expect((await upload(A, 'NPL-RES', SIGNED_PDF, { issueDate: '2026-09-01', signatory: 'TEST Chair' })).status).toBe(201);
    const s = await A.post(`/api/applications/${id}/submit`).send({ declaration: true });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.application.status).toBe('SUBMITTED');
    expect(s.body.application.submission_version).toBe(1);
    expect((await notifs('scrutiny.officer')).filter((n) => n.event_type === 'NEW_SUBMISSION')).toHaveLength(1);
    expect((await notifs('applicant.demo')).filter((n) => n.event_type === 'APPLICATION_RECEIVED')).toHaveLength(1);
  });

  it('2-3. the scrutiny report is explainable and flags human-verification items without deciding', async () => {
    S = await login('scrutiny.officer');
    const d = await S.get(`/api/official/applications/${id}`);
    expect(d.status).toBe(200);
    const rep = d.body.reports.find((r: { kind: string }) => r.kind === 'SCRUTINY').content;
    expect(rep.application.submissionVersion).toBe(1);
    expect(rep.summary.readyForOfficerReview).toBe(true);
    expect(rep.disclaimer).toMatch(/does not approve or reject/);
    const sig = rep.signatures.filter((f: { ruleType: string }) => f.ruleType === 'DOC_SIGNATURE_TECHNICAL');
    expect(sig.find((f: { targetId: string }) => f.targetId === 'NPL-NOC').status).toBe('HUMAN_REVIEW_REQUIRED'); // no embedded signature
    expect(sig.find((f: { targetId: string }) => f.targetId === 'NPL-RES').status).toBe('PASS'); // structure present, still needs human verification
    expect(sig.find((f: { targetId: string }) => f.targetId === 'NPL-RES').humanVerification).toBe(true);
    for (const f of rep.fields.flatMap((x: { findings: unknown[] }) => x.findings)) expect(f).toHaveProperty('ruleVersion');
    // Report status alone does not change the application
    expect(d.body.application.status).toBe('SUBMITTED');
  });

  it('dashboards and queues list the application with filters (scrutiny + supervisor)', async () => {
    for (const [agent, scope] of [
      [S, 'mine'],
      [S, 'all'],
      [await login('supervisor'), 'all'],
    ] as const) {
      const q = await agent.get(`/api/official/queue?scope=${scope}&q=FG-&category=NEW_PROGRAMME_LEVEL&assigned=any`);
      expect(q.status, JSON.stringify(q.body)).toBe(200);
      expect(q.body.applications.some((a: { id: string }) => a.id === id)).toBe(true);
    }
    expect((await S.get('/api/official/queue?assigned=unassigned')).status).toBe(200);
    expect((await S.get('/api/official/queue?assigned=me')).status).toBe(200);
    const dash = await S.get('/api/official/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.queueCounts.SUBMITTED).toBeGreaterThanOrEqual(1);
    // EVC scheduling dashboard cannot see an application still in scrutiny
    expect((await (await login('regional.officer')).get(`/api/official/applications/${id}`)).status).toBe(404);
  });

  it('access control: another scrutiny official cannot act once assigned; re-scrutiny official cannot act on scrutiny', async () => {
    expect((await S.post(`/api/official/applications/${id}/actions/START_SCRUTINY`)).status).toBe(200);
    const S2 = await login('scrutiny.officer2');
    const r = await S2.post(`/api/official/applications/${id}/deficiency-drafts`).send({ targetType: 'APPLICATION', category: 'OTHER', explanation: 'x'.repeat(10), correctiveAction: 'fix it' });
    expect(r.status).toBe(403);
    R = await login('rescrutiny.officer');
    expect((await R.post(`/api/official/applications/${id}/actions/ISSUE_DEFICIENCY_NOTICE`).send({ reason: 'not my stage' })).status).toBe(403);
    const B = await login('applicant.sample');
    expect((await B.get(`/api/applications/${id}`)).status).toBe(404);
    expect((await B.get(`/api/official/applications/${id}`)).status).toBe(403);
  });

  let defId: string;
  let noticeId: string;
  it('4. officer drafts a deficiency, sees a deadline needs a basis, and issues a PDF notice with a reason', async () => {
    const bad = await S.post(`/api/official/applications/${id}/deficiency-drafts`).send({ targetType: 'DOCUMENT', targetId: 'NPL-NOC', category: 'SIGNATURE_AUTHENTICATION', explanation: 'NOC is unsigned (TEST).', correctiveAction: 'Upload a signed NOC.', deadline: addDays(todayIST(), 10) });
    expect(bad.status).toBe(400);
    const d = await S.post(`/api/official/applications/${id}/deficiency-drafts`).send({
      targetType: 'DOCUMENT',
      targetId: 'NPL-NOC',
      category: 'SIGNATURE_AUTHENTICATION',
      explanation: 'The NOC does not carry a verifiable signature (TEST).',
      sourceReference: 'Annexure 2 §2.3(ii); Ch. I §1.4.6',
      correctiveAction: 'Upload the NOC digitally signed by the University.',
      requiredReplacement: 'Signed Format 2 NOC',
      deadlineType: 'OPERATIONAL',
      deadline: addDays(todayIST(), 2),
      deadlineBasis: 'TEST operational setting',
      sourceFindingRuleId: 'NEW_PROGRAMME_LEVEL.DOC.NPL-NOC.SIGNATURE_TECH',
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    defId = d.body.deficiency.id;
    // Draft is invisible to the institution
    expect((await A.get(`/api/applications/${id}`)).body.deficiencies).toHaveLength(0);
    expect((await S.post(`/api/official/applications/${id}/actions/ISSUE_DEFICIENCY_NOTICE`).send({})).status).toBe(400); // reason required
    const n = await S.post(`/api/official/applications/${id}/actions/ISSUE_DEFICIENCY_NOTICE`).send({ reason: 'Signature on NOC must be verifiable.' });
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    noticeId = (n.body.notice as { id: string }).id;
    const actions = await db.query("SELECT action, reason FROM officer_actions WHERE application_id = $1 AND action = 'ISSUE_DEFICIENCY_NOTICE'", [id]);
    expect(actions[0].reason).toBe('Signature on NOC must be verifiable.');
  });

  it('5. institution sees the notice (PDF), deadline type and next action, and submits a correction', async () => {
    const det = await A.get(`/api/applications/${id}`);
    expect(det.body.notices).toHaveLength(1);
    expect(det.body.deficiencies[0].deadline_type).toBe('OPERATIONAL');
    expect(det.body.nextAction).toMatch(/Respond to each deficiency/);
    const pdf = await A.get(`/api/notices/${noticeId}/pdf`).buffer(true).parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (x: Buffer) => c.push(x));
      res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await (await login('applicant.sample')).get(`/api/notices/${noticeId}/pdf`)).status).toBe(404);
    // A file upload alone is not a response; unreadable file is accepted but flagged.
    expect((await upload(A, 'NPL-NOC', TRUNCATED_PDF, {}, defId)).status).toBe(201);
    expect((await A.post(`/api/applications/${id}/corrections/submit`)).status).toBe(422);
    expect((await A.post(`/api/deficiencies/${defId}/respond`).send({ note: 'Uploaded signed NOC (TEST).' })).status).toBe(200);
    const cs = await A.post(`/api/applications/${id}/corrections/submit`);
    expect(cs.status, JSON.stringify(cs.body)).toBe(200);
    expect(cs.body.correctionSubmission.version).toBe(1);
  });

  it('6-7. re-scrutiny queue is notified; only affected rules are re-run; unreadable file keeps it UNRESOLVED', async () => {
    expect((await notifs('rescrutiny.officer')).filter((n) => n.event_type === 'CORRECTIONS_SUBMITTED')).toHaveLength(1);
    const det = await R.get(`/api/official/applications/${id}`);
    const rep = det.body.reports.find((r: { kind: string }) => r.kind === 'RE_SCRUTINY').content;
    expect(rep.correctionSubmission.changedDocs).toEqual(['NPL-NOC']);
    const entry = rep.deficiencies[0];
    expect(entry.correction.documents[0].before.version).toBe(1);
    expect(entry.correction.documents[0].after.version).toBe(2);
    expect(entry.automatedAssessment).toBe('UNRESOLVED'); // unreadable replacement is a blocking discrepancy
    const ruleIds: string[] = [...entry.newResults, ...rep.dependentChecks].map((f: { ruleId: string }) => f.ruleId);
    expect(ruleIds.every((r) => r.includes('NPL-NOC') || r.includes('NOTICE'))).toBe(true); // nothing unrelated (e.g. NPL-RES, fields) re-run
    expect(ruleIds.some((r) => r.includes('NPL-RES'))).toBe(false);
    // Original findings and reports are preserved
    expect(det.body.reports.filter((r: { kind: string }) => r.kind === 'SCRUTINY')).toHaveLength(1);
  });

  it('8. officer records outcomes; unresolved items get an updated notice; then a valid correction resolves them', async () => {
    expect((await R.post(`/api/official/applications/${id}/actions/START_RE_SCRUTINY`)).status).toBe(200);
    // Out-of-scope new deficiency is refused during re-scrutiny
    expect((await R.post(`/api/official/applications/${id}/deficiency-drafts`).send({ targetType: 'APPLICATION', category: 'OTHER', explanation: 'brand new issue', correctiveAction: 'fix' })).status).toBe(422);
    expect((await R.post(`/api/official/applications/${id}/actions/REQUEST_FURTHER_CORRECTION`).send({ reason: 'Replacement unreadable.' })).status).toBe(409); // must review first
    expect((await R.post(`/api/official/deficiencies/${defId}/review`).send({ outcome: 'UNRESOLVED', note: 'The replacement file is truncated (TEST).' })).status).toBe(200);
    const fc = await R.post(`/api/official/applications/${id}/actions/REQUEST_FURTHER_CORRECTION`).send({ reason: 'Replacement unreadable.' });
    expect(fc.status, JSON.stringify(fc.body)).toBe(200);
    expect(fc.body.notice.version).toBe(2);
    const det = await A.get(`/api/applications/${id}`);
    expect(det.body.deficiencies[0].officer_response).toMatch(/truncated/);
    expect(det.body.deficiencies[0].status).toBe('OPEN');
    // Second correction with a readable, signed file
    expect((await upload(A, 'NPL-NOC', SIGNED_PDF, { issueDate: '2026-10-01' }, defId)).status).toBe(201);
    await A.post(`/api/deficiencies/${defId}/respond`).send({ note: 'Readable signed NOC uploaded (TEST).' });
    const cs2 = await A.post(`/api/applications/${id}/corrections/submit`);
    expect(cs2.body.correctionSubmission.version).toBe(2);
    const rep = (await R.get(`/api/official/applications/${id}`)).body.reports.find((r: { kind: string }) => r.kind === 'RE_SCRUTINY').content;
    expect(rep.version).toBe(2);
    expect(['HUMAN_REVIEW_REQUIRED', 'RESOLVED']).toContain(rep.deficiencies[0].automatedAssessment); // signature category always needs the officer
    await R.post(`/api/official/applications/${id}/actions/START_RE_SCRUTINY`);
    expect((await R.post(`/api/official/applications/${id}/actions/APPROVE_EVC_HANDOFF`).send({ reason: 'too early' })).status).toBe(409);
    await R.post(`/api/official/deficiencies/${defId}/review`).send({ outcome: 'RESOLVED', note: 'Signature verified by officer (TEST).' });
    const done = await R.post(`/api/official/applications/${id}/actions/COMPLETE_RE_SCRUTINY`).send({ reason: 'All deficiencies resolved.' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.application.status).toBe('SCRUTINY_COMPLETED'); // no automatic EVC handoff
    expect(done.body.evcEligibility.eligible).toBe(true);
  });

  it('9. EVC handoff happens only by an authorised action and is recorded', async () => {
    RO = await login('regional.officer');
    expect((await RO.post(`/api/official/applications/${id}/actions/APPROVE_EVC_HANDOFF`).send({ reason: 'not permitted' })).status).toBe(403);
    expect((await R.post(`/api/official/applications/${id}/actions/APPROVE_EVC_HANDOFF`).send({})).status).toBe(400);
    const h = await R.post(`/api/official/applications/${id}/actions/APPROVE_EVC_HANDOFF`).send({ reason: 'Re-scrutiny complete; route includes EVC.' });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const rows = await db.query<{ eligibility: { conditions: unknown[] } }>('SELECT eligibility FROM evc_handoffs WHERE application_id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].eligibility.conditions.length).toBeGreaterThan(3);
    expect((await notifs('regional.officer')).some((n) => n.event_type === 'EVC_HANDOFF')).toBe(true);
  });

  it('10. EVC team proposes, assigns members and confirms; institution is notified at each step', async () => {
    const p = await RO.post(`/api/official/applications/${id}/actions/PROPOSE_EVC_DATE`).send({ mode: 'ONLINE', scheduledStart: '2026-12-01T10:00:00+05:30', scheduledEnd: '2026-12-01T12:00:00+05:30', meetingLink: 'https://meet.example.test/evc-test', agenda: 'TEST agenda' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.application.status).toBe('AWAITING_EVC_SCHEDULING');
    // Confirming without a committee is blocked (Annexure 16 §16.5).
    expect((await RO.post(`/api/official/applications/${id}/actions/CONFIRM_EVC`)).status).toBe(409);
    const a = await RO.post(`/api/official/applications/${id}/actions/ASSIGN_EVC_MEMBERS`).send({ members: await demoCommittee(RO) });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.invited).toBe(3);
    // Not confirmed merely because invitations were sent.
    expect((await RO.post(`/api/official/applications/${id}/actions/CONFIRM_EVC`)).body.error).toBe('RESPONSES_PENDING');
    const visitId = (await db.one<{ id: string }>("SELECT id FROM evc_visits WHERE application_id = $1 AND status = 'PROPOSED'", [id]))!.id;
    for (const m of ['evc.member', 'evc.member2', 'evc.member3']) expect((await (await login(m)).post(`/api/evc/visits/${visitId}/respond`).send({ response: 'ACCEPTED' })).status).toBe(200);
    const c = await RO.post(`/api/official/applications/${id}/actions/CONFIRM_EVC`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.application.status).toBe('EVC_SCHEDULED');
    const n = await notifs('applicant.demo');
    expect(n.some((x) => x.event_type === 'EVC_PROPOSED')).toBe(true);
    expect(n.some((x) => x.event_type === 'EVC_SCHEDULED')).toBe(true);
    // Only an assigned committee member can start the visit.
    expect((await RO.post(`/api/official/applications/${id}/actions/START_EVC`)).status).toBe(403);
    expect((await (await login('evc.member')).post(`/api/official/applications/${id}/actions/START_EVC`)).status).toBe(200);
  });
});

describe("scrutiny officer's two actions", () => {
  async function submitted(label: string) {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
    const id = c.body.application.id;
    await A.patch(`/api/applications/${id}`).send({
      rowVersion: c.body.application.row_version,
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'TEST University', proposedCourses: [{ course: `MBA ${label}` }], nocReference: 'N', resolutionDate: '2026-09-01' },
    });
    for (const r of ['NPL-NOC', 'NPL-RES']) await A.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF(), `${r}.pdf`);
    expect((await A.post(`/api/applications/${id}/submit`).send({ declaration: true })).status).toBe(200);
    return { A, id };
  }

  it('Send for re-scrutiny: explanations become a notice; corrections then reach the re-scrutiny queue', async () => {
    const { A, id } = await submitted('send');
    const S = await login('scrutiny.officer');
    expect((await S.post(`/api/official/applications/${id}/actions/SEND_FOR_RESCRUTINY`).send({ reason: 'Deficiency found (TEST).', deficiencies: [] })).status).toBe(422);
    const r = await S.post(`/api/official/applications/${id}/actions/SEND_FOR_RESCRUTINY`).send({
      reason: 'NOC signature not verifiable (TEST).',
      deficiencies: [
        { targetType: 'DOCUMENT', targetId: 'NPL-NOC', category: 'SIGNATURE_AUTHENTICATION', explanation: 'No embedded signature in the NOC (TEST).', correctiveAction: 'Upload a digitally signed NOC.', sourceFindingRuleId: 'NEW_PROGRAMME_LEVEL.DOC.NPL-NOC.SIGNATURE_TECH' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.application.status).toBe('DEFICIENCY_RAISED'); // took up scrutiny automatically, then issued the notice
    const det = await A.get(`/api/applications/${id}`);
    expect(det.body.notices).toHaveLength(1);
    expect(det.body.deficiencies[0].explanation).toMatch(/No embedded signature/);
    const d = det.body.deficiencies[0].id;
    await A.post(`/api/applications/${id}/documents`).field('requirementId', 'NPL-NOC').field('deficiencyId', d).field('metadata', '{"dscDeclared":true}').attach('file', PDF('SIGNED TEST'), 'noc2.pdf');
    await A.post(`/api/deficiencies/${d}/respond`).send({ note: 'Signed NOC uploaded (TEST).' });
    await A.post(`/api/applications/${id}/corrections/submit`);
    const q = await (await login('rescrutiny.officer')).get('/api/official/queue?scope=mine');
    expect(q.body.applications.some((a: { id: string }) => a.id === id)).toBe(true);
  });

  it('Forward to EVC Coordinator: one action records scrutiny and hands off with an audit record', async () => {
    const { id } = await submitted('forward');
    const S = await login('scrutiny.officer');
    expect((await S.post(`/api/official/applications/${id}/actions/FORWARD_TO_EVC`).send({})).status).toBe(400); // reason required
    const f = await S.post(`/api/official/applications/${id}/actions/FORWARD_TO_EVC`).send({ reason: 'All in order (TEST).' });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.application.status).toBe('AWAITING_EVC_SCHEDULING');
    expect(f.body.forwardedTo).toBe('EVC');
    expect(await db.query('SELECT 1 FROM evc_handoffs WHERE application_id = $1', [id])).toHaveLength(1);
    const events = await db.query<{ action: string }>('SELECT action FROM workflow_events WHERE application_id = $1 ORDER BY id', [id]);
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['START_SCRUTINY', 'COMPLETE_SCRUTINY', 'APPROVE_EVC_HANDOFF']));
    const q = await (await login('regional.officer')).get('/api/official/queue?scope=mine');
    expect(q.body.applications.some((a: { id: string }) => a.id === id)).toBe(true);
    // Other roles cannot use these actions
    expect((await (await login('regional.officer')).post(`/api/official/applications/${id}/actions/FORWARD_TO_EVC`).send({ reason: 'not allowed' })).status).toBe(403);
  });

  it('Forward routes to the decision stage when the category has no EVC (Table 2.3)', async () => {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'INSTITUTION_NAME_CHANGE' });
    const id = c.body.application.id;
    await A.patch(`/api/applications/${id}`).send({
      rowVersion: c.body.application.row_version,
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', institutionCategory: 'SELF_FINANCING', affiliatingBody: 'U', currentName: 'A', proposedName: 'B College of Engineering', nameChangeReason: 'TEST', resolutionDate: '2026-09-01' },
    });
    for (const r of ['NAME-RES', 'NAME-RCPT']) await A.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF(), `${r}.pdf`);
    await A.post(`/api/applications/${id}/submit`).send({ declaration: true });
    const f = await (await login('scrutiny.officer')).post(`/api/official/applications/${id}/actions/FORWARD_TO_EVC`).send({ reason: 'In order (TEST).' });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.application.status).toBe('AWAITING_AUTHORISED_DECISION');
    expect(f.body.forwardedTo).toBe('DECISION');
  });
});

describe('document examination records and overview data', () => {
  let id: string;
  let docId: string;
  beforeAll(async () => {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
    id = c.body.application.id;
    await A.patch(`/api/applications/${id}`).send({
      rowVersion: c.body.application.row_version,
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'TEST University', proposedCourses: [{ course: 'MBA examined' }], nocReference: 'N', resolutionDate: '2026-09-01' },
    });
    for (const r of ['NPL-NOC', 'NPL-RES']) await A.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF(), `${r}.pdf`);
    expect((await A.post(`/api/applications/${id}/submit`).send({ declaration: true })).status).toBe(200);
    docId = (await A.get(`/api/applications/${id}`)).body.documents.find((d: { requirement_id: string }) => d.requirement_id === 'NPL-NOC').id;
  });

  it('a scrutiny official records an append-only examination per document; it never changes the application', async () => {
    const S = await login('scrutiny.officer2');
    const url = `/api/official/applications/${id}/documents/${docId}/review`;
    expect((await S.post(url).send({ status: 'OBSERVATION_RECORDED' })).status).toBe(400); // observation required
    const ok = await S.post(url).send({ status: 'OBSERVATION_RECORDED', observation: 'Signatory name not legible (TEST).', sourceReference: 'Annexure 2' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await S.post(url).send({ status: 'EXAMINED_NO_OBSERVATION' })).status).toBe(200);
    const det = await S.get(`/api/official/applications/${id}`);
    expect(det.body.application.status).toBe('SUBMITTED');
    expect(det.body.documentReviews.map((r: { status: string }) => r.status)).toEqual(['EXAMINED_NO_OBSERVATION', 'OBSERVATION_RECORDED']);
    expect(await db.query("SELECT 1 FROM officer_actions WHERE application_id = $1 AND action = 'RECORD_DOCUMENT_REVIEW'", [id])).toHaveLength(2);
    await expect(db.query("UPDATE document_reviews SET observation = 'tampered' WHERE application_id = $1", [id])).rejects.toThrow(/append-only/);
  });

  it('document examination is limited to reviewing roles, their stage and documents of the application', async () => {
    const url = `/api/official/applications/${id}/documents/${docId}/review`;
    expect((await (await login('applicant.demo')).post(url).send({ status: 'EXAMINED_NO_OBSERVATION' })).status).toBe(403);
    expect((await (await login('regional.officer')).post(url).send({ status: 'EXAMINED_NO_OBSERVATION' })).status).toBe(403);
    expect((await (await login('rescrutiny.officer')).post(url).send({ status: 'EXAMINED_NO_OBSERVATION' })).status).toBe(404); // a submitted application is not visible to re-scrutiny
    const other = (await db.one<{ id: string }>('SELECT id FROM documents WHERE application_id <> $1 LIMIT 1', [id]))!.id;
    expect((await (await login('scrutiny.officer2')).post(`/api/official/applications/${id}/documents/${other}/review`).send({ status: 'EXAMINED_NO_OBSERVATION' })).status).toBe(404);
  });

  it('role dashboards report persisted activity; pipeline and people are supervisor-only', async () => {
    const s = (await (await login('scrutiny.officer')).get('/api/official/dashboard')).body;
    expect(Array.isArray(s.recentActivity)).toBe(true);
    expect(s.recentActivity.some((e: { application_id: string }) => e.application_id === id)).toBe(true);
    expect(s.pipeline).toEqual([]);
    expect(s.supervisor).toBeNull();
    const sv = (await (await login('supervisor')).get('/api/official/dashboard')).body;
    const total = (await db.one<{ n: number }>("SELECT count(*)::int AS n FROM applications WHERE status <> 'DRAFT'"))!.n;
    expect(sv.pipeline.reduce((n: number, p: { n: number }) => n + p.n, 0)).toBe(total);
    expect(sv.supervisor.people.length).toBeGreaterThan(0);
    expect(sv.supervisor.people.every((p: { roles: string[] }) => !p.roles.includes('INSTITUTION_APPLICANT'))).toBe(true);
    expect(sv.supervisor.ruleCounts.length).toBeGreaterThan(0);
    const q = (await (await login('supervisor')).get('/api/official/queue?scope=all')).body.applications;
    expect(q.find((a: { id: string }) => a.id === id)).toHaveProperty('assigned_any');
  });

  it('the institution overview shows its own current application and activity only', async () => {
    const own = (await (await login('applicant.demo')).get('/api/dashboard')).body;
    expect(own.currentApplication).not.toBeNull();
    expect(own.currentApplication.stages.map((x: { key: string }) => x.key)).toContain('SUBMITTED');
    expect(own.recentActivity.length).toBeGreaterThan(0);
    const other = (await (await login('applicant.sample')).get('/api/dashboard')).body;
    const ownRefs = new Set(own.recentActivity.map((e: { reference_no: string }) => e.reference_no));
    expect(other.recentActivity.some((e: { reference_no: string }) => ownRefs.has(e.reference_no))).toBe(false);
  });
});

describe('edge cases', () => {
  async function submitEoa(withFire: boolean, fireMeta: Record<string, unknown> = {}) {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'EOA_SELF_DISCLOSURE' });
    const id = c.body.application.id;
    await A.patch(`/api/applications/${id}`).send({
      rowVersion: c.body.application.row_version,
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', institutionCategory: 'SELF_FINANCING', buildingCompletionCertificateDate: '2015-01-01', occupancyCertificateType: 'FULL', mainEntranceLatitude: 18.5, mainEntranceLongitude: 73.8, auditedAccountsFinancialYear: '2025-26' },
    });
    const docs: Array<[string, Record<string, unknown>]> = [['EOA-AFF2', {}], ['EOA-OC', { expiryDate: '2031-01-01' }], ['EOA-SATMAP', {}], ['EOA-AUDIT', { financialYear: '2025-26' }]];
    if (withFire) docs.push(['EOA-FIRE', fireMeta]);
    for (const [req, meta] of docs) await A.post(`/api/applications/${id}/documents`).field('requirementId', req).field('metadata', JSON.stringify({ dscDeclared: true, ...meta })).attach('file', PDF(), `${req}.pdf`);
    return { A, id, submit: () => A.post(`/api/applications/${id}/submit`).send({ declaration: true }) };
  }

  it('missing document blocks submission; unknown expiry is UNABLE_TO_VERIFY, not invented', async () => {
    const m = await submitEoa(false);
    const r = await m.submit();
    expect(r.status).toBe(422);
    expect(r.body.validation.findings.find((f: { ruleId: string }) => f.ruleId.endsWith('EOA-FIRE.PRESENT')).status).toBe('DISCREPANCY_DETECTED');
    const u = await submitEoa(true, {});
    const s = await u.submit();
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const f = s.body.validation.findings.find((x: { ruleId: string }) => x.ruleId.endsWith('EOA-FIRE.NOT_EXPIRED'));
    expect(f.status).toBe('UNABLE_TO_VERIFY');
    expect(f.blocking).toBe(false);
  });

  it('invalid files are rejected; unreadable files block submission', async () => {
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'NRI_SEATS', subtype: 'INTRODUCTION' });
    const id = c.body.application.id;
    expect((await A.post(`/api/applications/${id}/documents`).field('requirementId', 'NRI-RES').field('metadata', '{"dscDeclared":true}').attach('file', Buffer.from('GIF89a fake'), 'x.pdf')).status).toBe(415);
    await A.patch(`/api/applications/${id}`).send({ rowVersion: c.body.application.row_version, fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', nriCourses: [{ course: 'CSE' }], approvedIntake: 120, nriSeatsRequested: 6, resolutionDate: '2026-09-01' } });
    await A.post(`/api/applications/${id}/documents`).field('requirementId', 'NRI-RES').field('metadata', '{"dscDeclared":true}').attach('file', TRUNCATED_PDF, 'res.pdf');
    const s = await A.post(`/api/applications/${id}/submit`).send({ declaration: true });
    expect(s.status).toBe(422);
    expect(s.body.validation.findings.some((f: { ruleId: string; blocking: boolean }) => f.ruleId.endsWith('NRI-RES.INTEGRITY') && f.blocking)).toBe(true);
  });

  it('overdue deadlines send one reminder / overdue / escalation each, never change status, and dedupe repeated sweeps', async () => {
    const S = await login('scrutiny.officer');
    const m = await submitEoa(true, { expiryDate: '2030-01-01' });
    await m.submit();
    // EoA is self-disclosure: drafting is allowed while SUBMITTED
    await S.post(`/api/official/applications/${m.id}/deficiency-drafts`).send({ targetType: 'DOCUMENT', targetId: 'EOA-SATMAP', category: 'INCOMPLETE_INFORMATION', explanation: 'Coordinates not marked on map (TEST).', correctiveAction: 'Mark coordinates.', deadlineType: 'OPERATIONAL', deadline: addDays(todayIST(), 1), deadlineBasis: 'TEST operational setting' });
    expect((await S.post(`/api/official/applications/${m.id}/actions/ISSUE_DEFICIENCY_NOTICE`).send({ reason: 'Map incomplete.' })).status).toBe(200);
    const s1 = await runDeadlineSweep(db, new Date());
    expect(s1.reminders).toBeGreaterThanOrEqual(1);
    await runDeadlineSweep(db, new Date());
    const future = new Date(Date.now() + 5 * 86400000);
    const s2 = await runDeadlineSweep(db, future);
    expect(s2.overdue).toBeGreaterThanOrEqual(1);
    expect(s2.escalations).toBeGreaterThanOrEqual(1);
    const s3 = await runDeadlineSweep(db, future);
    expect(s3.overdue).toBe(0);
    expect(s3.escalations).toBe(0);
    const keys = (await notifs('applicant.demo')).map((n) => n.dedupe_key).filter((k) => k?.startsWith('def:'));
    expect(new Set(keys).size).toBe(keys.length);
    expect((await notifs('supervisor')).filter((n) => n.event_type === 'ESCALATION').length).toBeGreaterThanOrEqual(1);
    const status = await db.one<{ status: string }>('SELECT status FROM applications WHERE id = $1', [m.id]);
    expect(status!.status).toBe('DEFICIENCY_RAISED');
    const Sup = await login('supervisor');
    const esc = await Sup.get('/api/official/escalations');
    expect(esc.status).toBe(200);
    expect(esc.body.events.filter((e: { event_type: string; entity_type: string }) => e.event_type === 'ESCALATED' && e.entity_type === 'deficiency')).toHaveLength(1);
    expect((await S.get('/api/official/escalations')).status).toBe(403);
  });

  it('failed notification delivery is recorded and retried', async () => {
    setDeliveryHook(() => 'TEST channel outage');
    const A = await login('applicant.demo');
    const c = await A.post('/api/applications').send({ categoryCode: 'ODL_OL', subtype: 'OL' });
    expect(c.status).toBe(201);
    const S = await login('scrutiny.officer');
    // Any notification created now fails
    await db.query("INSERT INTO verification_requests(application_id, requested_by, requested_role, reason) SELECT $1, id, 'SCRUTINY_OFFICIAL', 'TEST' FROM users WHERE login_id = 'scrutiny.officer'", [c.body.application.id]);
    const { notify } = await import('../server/notify.ts');
    const sup = await db.one<{ id: string }>("SELECT id FROM users WHERE login_id = 'supervisor'");
    await notify(db, { recipientUserId: sup!.id, eventType: 'TEST', title: 'TEST', message: 'TEST', dedupeKey: 'test:failed:1' });
    const failed = await db.one<{ delivery_status: string; last_error: string }>("SELECT delivery_status, last_error FROM notifications WHERE dedupe_key = 'test:failed:1'");
    expect(failed!.delivery_status).toBe('FAILED');
    expect(failed!.last_error).toMatch(/outage/);
    // Duplicate with same key is not created
    await notify(db, { recipientUserId: sup!.id, eventType: 'TEST', title: 'TEST', message: 'TEST', dedupeKey: 'test:failed:1' });
    expect((await db.query("SELECT 1 FROM notifications WHERE dedupe_key = 'test:failed:1'")).length).toBe(1);
    setDeliveryHook(null);
    const Admin = await login('sys.admin');
    const r = await Admin.post('/api/official/admin/notifications/retry');
    expect(r.body.delivered).toBeGreaterThanOrEqual(1);
    const after = await db.one<{ delivery_status: string; attempts: number }>("SELECT delivery_status, attempts FROM notifications WHERE dedupe_key = 'test:failed:1'");
    expect(after!.delivery_status).toBe('DELIVERED');
    expect(after!.attempts).toBe(2);
    expect((await S.get('/api/official/admin/notifications')).status).toBe(403);
  });
});
