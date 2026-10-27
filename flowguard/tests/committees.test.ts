/**
 * Committee workflows across the dashboards: SHC → EC (speaking order) → appeal → SAC (orders a further EVC) →
 * SAC again → Council (final), with institution-disclosable updates, privacy of deliberations, access control,
 * appeal timeliness from the verified clause, and append-only records. All data is synthetic TEST data.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createDb, migrate, type Db } from '../server/db/index.ts';
import { DEMO_ACCOUNTS, seed } from '../server/db/seed.ts';
import { appealEligibility, type AppRow } from '../server/services.ts';
import { MemoryStorage } from '../server/storage.ts';

let db: Db;
let app: ReturnType<typeof createApp>['app'];
const PDF = (tag = 'SYNTHETIC TEST FILE') => Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF`);
const pw = (l: string) => DEMO_ACCOUNTS.find((a) => a.loginId === l)!.password;
const agents = new Map<string, request.Agent>();
async function login(l: string) {
  if (agents.has(l)) return agents.get(l)!;
  const a = request.agent(app);
  expect((await a.post('/api/auth/login').send({ loginId: l, password: pw(l) })).status).toBe(200);
  agents.set(l, a);
  return a;
}
const ist = (days: number, hh: number) => {
  const d = new Date(Date.now() + days * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  return new Date(`${d}T${String(hh).padStart(2, '0')}:00:00+05:30`).toISOString();
};
const status = async (id: string) => (await db.one<{ status: string }>('SELECT status FROM applications WHERE id = $1', [id]))!.status;
const notified = async (login: string, id: string, type: string) =>
  (await db.query('SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = $1 AND n.application_id = $2 AND n.event_type = $3', [login, id, type])).length;

let committee: Array<{ expertId: string; seat: string }>;
/** Runs one complete EVC for the application (visit `days` from today, 10:00–11:00 IST) up to the submitted report. */
async function runEvc(id: string, days: number) {
  const RO = await login('regional.officer');
  const act = (a: string, b: object = {}) => RO.post(`/api/official/applications/${id}/actions/${a}`).send(b);
  expect((await act('PROPOSE_EVC_DATE', { mode: 'ONLINE', scheduledStart: ist(days, 10), scheduledEnd: ist(days, 11), meetingLink: 'https://meet.example.test/evc' })).status).toBe(200);
  expect((await act('ASSIGN_EVC_MEMBERS', { members: committee })).status).toBe(200);
  const v = (await db.one<{ id: string }>("SELECT id FROM evc_visits WHERE application_id = $1 AND status = 'PROPOSED'", [id]))!.id;
  for (const m of ['evc.member', 'evc.member2', 'evc.member3']) expect((await (await login(m)).post(`/api/evc/visits/${v}/respond`).send({ response: 'ACCEPTED' })).status).toBe(200);
  expect((await act('CONFIRM_EVC')).status).toBe(200);
  const M = await login('evc.member');
  expect((await M.post(`/api/official/applications/${id}/actions/START_EVC`)).status).toBe(200);
  expect((await M.post(`/api/evc/visits/${v}/attendance`).send({ attendance: 'PRESENT' })).status).toBe(200);
  const rep = await M.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send({ declaration: true, observations: 'Facilities verified against Annexure 3 (TEST).', recommendation: 'As verified (TEST)' });
  expect(rep.status, JSON.stringify(rep.body)).toBe(200);
}

beforeAll(async () => {
  db = await createDb({ dataDir: 'memory://' });
  await migrate(db);
  await seed(db);
  app = createApp({ db, storage: new MemoryStorage(), silent: true, loginsPerMinute: 1000 }).app;
  for (const l of ['applicant.demo', 'applicant.sample'])
    await (await login(l)).put('/api/institution/profile').send({
      name: `${l} institute (TEST)`, address: 'Survey No. 12, Demo Road', state: 'Maharashtra', district: 'Pune', pincode: '411001',
      official_email: 'office@demo-institute.test', applicant_name: 'Demo Applicant', applicant_designation: 'Principal',
    });
  const list = (await (await login('regional.officer')).get('/api/evc/experts')).body.experts as Array<{ id: string; member_code: string }>;
  const pick = (c: string) => list.find((e) => e.member_code === c)!.id;
  committee = [
    { expertId: pick('EVC-DEMO-0001'), seat: 'ACADEMICIAN' },
    { expertId: pick('EVC-DEMO-0002'), seat: 'EXPERT' },
    { expertId: pick('EVC-DEMO-0003'), seat: 'ARCHITECT_PLANNING' },
  ];
});
afterAll(async () => db?.close());

describe('SHC → EC → appeal → SAC → Council', () => {
  let id: string;
  const A = () => login('applicant.demo');
  const act = async (who: string, a: string, b: object = {}) => (await login(who)).post(`/api/official/applications/${id}/actions/${a}`).send(b);
  const decide = async (who: string, type: string, ref: string, reasons?: string) => {
    const r = (await login(who)).post(`/api/official/applications/${id}/actions/ISSUE_DECISION`).field('decisionType', type).field('referenceNo', ref).field('issuingAuthority', who === 'ec.official' ? 'Executive Committee, AICTE' : 'Council, AICTE').field('decisionDate', '2026-10-24');
    if (reasons) r.field('reasons', reasons);
    return r.attach('file', PDF('DECISION'), 'decision.pdf');
  };

  it('an application reaches the SHC only when referred, and only the SHC desk holds it', async () => {
    const Ap = await A();
    const c = await Ap.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
    id = c.body.application.id;
    await Ap.patch(`/api/applications/${id}`).send({
      rowVersion: c.body.application.row_version,
      fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'TEST University', proposedCourses: [{ course: 'MBA committee' }], nocReference: 'N', resolutionDate: '2026-09-01' },
    });
    for (const r of ['NPL-NOC', 'NPL-RES']) await Ap.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF(), `${r}.pdf`);
    expect((await Ap.post(`/api/applications/${id}/submit`).send({ declaration: true })).status).toBe(200);
    expect((await act('scrutiny.officer', 'FORWARD_TO_EVC', { reason: 'In order (TEST).' })).status).toBe(200);
    await runEvc(id, -1);
    expect(await status(id)).toBe('EVC_REPORT_SUBMITTED');
    // Nothing is before the SHC or the EC yet.
    expect((await (await login('shc.member')).get('/api/committee/queue')).body.cases.some((x: { id: string }) => x.id === id)).toBe(false);
    expect((await act('regional.officer', 'FORWARD_AFTER_EVC', { toShc: true })).status).toBe(200);
    expect(await status(id)).toBe('AWAITING_COMMITTEE_REVIEW');
    const shc = (await (await login('shc.member')).get('/api/committee/queue')).body;
    expect(shc.cases.find((x: { id: string }) => x.id === id)).toMatchObject({ pending: true, holder: 'SHC' });
    expect((await (await login('ec.official')).get('/api/committee/queue')).body.cases.some((x: { id: string; pending: boolean }) => x.id === id && x.pending)).toBe(false);
    expect((await (await login('ec.official')).post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'REVIEW_NOTE', body: 'Not yet ours (TEST).' })).status).toBe(404); // EC cannot even open it yet
  });

  it('SHC hearing notice reaches the institution; internal notes and the recommendation do not', async () => {
    const S = await login('shc.member');
    expect((await S.post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'HEARING_NOTICE', body: 'Present compliance for the EVC observations (TEST).' })).body.error).toBe('HEARING_DETAILS_REQUIRED');
    expect((await S.post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'HEARING_NOTICE', body: 'Present compliance for the EVC observations (TEST).', hearingAt: ist(3, 11), hearingMode: 'ONLINE', hearingVenue: 'https://meet.example.test/shc' })).status).toBe(201);
    expect((await S.post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'REVIEW_NOTE', body: 'Internal: library shortfall looks resolved (TEST).' })).status).toBe(201);
    expect(await notified('applicant.demo', id, 'HEARING_NOTICE')).toBe(1);
    // The institution places its compliance before the SHC.
    const sub = await (await A()).post(`/api/applications/${id}/committee-submissions`).field('note', 'Compliance: library books purchased (TEST).').attach('file', PDF('COMPLIANCE'), 'compliance.pdf');
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.submission.committee).toBe('SHC');
    expect(await notified('shc.member', id, 'COMMITTEE_SUBMISSION')).toBe(1);
    expect((await S.get(`/api/committee/submissions/${sub.body.submission.id}/download`)).status).toBe(200);
    expect((await (await login('applicant.sample')).get(`/api/committee/submissions/${sub.body.submission.id}/download`)).status).toBe(404);
    // Recommendation → EC; the institution learns only where the case stands.
    const rec = await act('shc.member', 'RECORD_SHC_OUTCOME', { outcome: 'COMPLIANCE_SATISFACTORY', notes: 'Internal SHC reasoning (TEST).' });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(await status(id)).toBe('AWAITING_AUTHORISED_DECISION');
    expect(await notified('ec.official', id, 'AWAITING_DECISION')).toBeGreaterThan(0);
    expect(await notified('applicant.demo', id, 'SHC_CONCLUDED')).toBe(1);
    const mine = (await (await A()).get(`/api/applications/${id}`)).body;
    expect(mine.committeeProceedings.map((p: { kind: string }) => p.kind)).toEqual(['HEARING_NOTICE']);
    expect(JSON.stringify(mine)).not.toMatch(/Internal SHC reasoning|Internal: library/);
    expect(mine.committeeReviews[0]).toEqual({ id: expect.any(String), committee: 'SHC', recorded_at: expect.any(String) });
    expect((await S.post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'REVIEW_NOTE', body: 'Too late (TEST).' })).body.error).toBe('NOT_BEFORE_COMMITTEE');
  });

  it('the EC asks for clarification, then records its decision with a speaking order', async () => {
    const EC = await login('ec.official');
    const file = (await EC.get(`/api/committee/applications/${id}`)).body;
    expect(file).toMatchObject({ holder: 'EC', canAct: true });
    expect(file.committeeReviews[0].notes).toBe('Internal SHC reasoning (TEST).'); // officials see the SHC record
    expect((await EC.post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'HEARING_NOTICE', body: 'x'.repeat(10), hearingAt: ist(2, 10), hearingMode: 'ONLINE' })).body.error).toBe('KIND_NOT_ALLOWED');
    expect((await EC.post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'CLARIFICATION_REQUEST', body: 'Confirm the faculty appointment dates (TEST).' })).status).toBe(201);
    expect(await notified('applicant.demo', id, 'COMMITTEE_CLARIFICATION')).toBe(1);
    expect((await (await A()).post(`/api/applications/${id}/committee-submissions`).field('note', 'Appointment orders dated 1 July (TEST).')).body.submission.committee).toBe('EC');
    expect((await decide('council.official', 'LOD', 'C/2026/1', 'x')).status).toBe(404); // no appeal: the Council cannot even open the case
    expect((await decide('ec.official', 'LOD', 'EC/2026/TEST/LOD1')).body.error).toBe('REASONS_REQUIRED');
    const d = await decide('ec.official', 'LOD', 'EC/2026/TEST/LOD1', 'Faculty cadre ratio not met on the date of the EVC (TEST).');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const row = await db.one<{ decision_body: string; recorded_role: string; aph_reference: string }>('SELECT decision_body, recorded_role, aph_reference FROM decisions WHERE application_id = $1', [id]);
    expect(row).toMatchObject({ decision_body: 'EXECUTIVE_COMMITTEE', recorded_role: 'EC_OFFICIAL', aph_reference: 'Ch. II §2.23.3; Ch. I §1.10' });
    expect(await notified('applicant.demo', id, 'DECISION_ISSUED')).toBe(1);
  });

  it('appeal timeliness comes from the verified clause (Ch. II §2.24(a): 7 days from upload), not a guess', async () => {
    const a = (await db.one<AppRow>('SELECT * FROM applications WHERE id = $1', [id]))!;
    const now = await appealEligibility(db, a);
    expect(now).toMatchObject({ eligible: true, aphReference: 'Ch. II §2.24(a)' });
    const late = await appealEligibility(db, a, new Date(Date.now() + 9 * 86400000));
    expect(late.eligible).toBe(false);
    // Chapter I (new institutions): only an LoD opens the appeal, counted from its issue date (Ch. I §1.11(a)).
    expect((await appealEligibility(db, { ...a, category_code: 'NEW_TECHNICAL_INSTITUTION' })).aphReference).toBe('Ch. I §1.11(a)');
  });

  it('SAC orders a further EVC; its report returns to the SAC before the Council decides', async () => {
    const ap = await (await A()).post(`/api/applications/${id}/appeal`).field('grounds', 'Faculty were appointed before the EVC; orders attached (TEST).').attach('file', PDF('APPEAL'), 'appeal.pdf');
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    expect(await status(id)).toBe('APPEAL_SUBMITTED');
    expect((await (await login('council.official')).post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'REVIEW_NOTE', body: 'Not yet (TEST).' })).body.error).toBe('NOT_BEFORE_COMMITTEE');
    expect((await act('sac.member', 'START_APPEAL_REVIEW')).status).toBe(200);
    const SAC = await login('sac.member');
    expect((await SAC.post(`/api/committee/applications/${id}/proceedings`).send({ kind: 'HEARING_NOTICE', body: 'Two representatives with photo ID (Ch. II §2.24(e)) (TEST).', hearingAt: ist(4, 15), hearingMode: 'ONLINE' })).status).toBe(201);
    expect((await (await A()).post(`/api/applications/${id}/committee-submissions`).field('note', 'Supporting documents for the SAC (TEST).').attach('file', PDF('SAC'), 'sac.pdf')).body.submission.committee).toBe('SAC');
    expect((await act('sac.member', 'RECORD_SAC_RECOMMENDATION', { outcome: 'REFER_EVC', notes: 'Verify faculty in person (TEST).' })).status).toBe(200);
    expect(await status(id)).toBe('AWAITING_EVC_SCHEDULING');
    await runEvc(id, -2);
    expect((await act('regional.officer', 'FORWARD_AFTER_EVC', { toShc: false })).status).toBe(200);
    expect(await status(id)).toBe('AWAITING_AUTHORISED_DECISION');
    expect(await notified('sac.member', id, 'STAGE_READY')).toBeGreaterThan(0); // back to the SAC, not the EC
    expect((await decide('council.official', 'LOA', 'COUNCIL/2026/TEST/1')).body.error).toBe('RETURN_TO_SAC');
    expect((await act('sac.member', 'RETURN_TO_SAC')).status).toBe(200);
    expect(await status(id)).toBe('APPEAL_UNDER_REVIEW');
    expect((await act('sac.member', 'RECORD_SAC_RECOMMENDATION', { outcome: 'RECOMMEND', notes: 'Faculty verified (TEST).' })).status).toBe(200);
    expect(await notified('council.official', id, 'AWAITING_DECISION')).toBe(1);
    const appealMine = (await (await A()).get(`/api/applications/${id}`)).body.appeal;
    expect(appealMine.sac_notes).toBeUndefined(); // SAC deliberations are not disclosed
  });

  it('the Council records the final decision; the original EC decision is preserved', async () => {
    expect((await decide('ec.official', 'LOA', 'EC/2026/TEST/2')).body.error).toBe('COUNCIL_DECIDES');
    const fin = await decide('council.official', 'LOA', 'COUNCIL/2026/TEST/1');
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    const ds = await db.query<{ decision_body: string; decision_type: string; is_appeal_outcome: boolean; aph_reference: string }>('SELECT decision_body, decision_type, is_appeal_outcome, aph_reference FROM decisions WHERE application_id = $1 ORDER BY uploaded_at', [id]);
    expect(ds).toEqual([
      expect.objectContaining({ decision_body: 'EXECUTIVE_COMMITTEE', decision_type: 'LOD', is_appeal_outcome: false }),
      expect.objectContaining({ decision_body: 'COUNCIL', decision_type: 'LOA', is_appeal_outcome: true, aph_reference: 'Ch. II §2.24(f)' }),
    ]);
    expect((await (await A()).get(`/api/applications/${id}/appeal-eligibility`)).body.eligible).toBe(false); // Council's decision is final
    // Every institution-disclosable step reached the institution's notification centre.
    for (const t of ['HEARING_NOTICE', 'SHC_CONCLUDED', 'COMMITTEE_CLARIFICATION', 'DECISION_ISSUED', 'APPEAL_UPDATE', 'COMMITTEE_SUBMISSION_RECEIVED']) expect(await notified('applicant.demo', id, t), t).toBeGreaterThan(0);
    await expect(db.query("UPDATE decisions SET decision_type = 'LOR' WHERE application_id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM committee_proceedings WHERE application_id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE committee_reviews SET outcome = 'X' WHERE application_id = $1", [id])).rejects.toThrow(/append-only/);
  });

  it('desks and institutions see only what their role permits', async () => {
    expect((await (await login('applicant.demo')).get('/api/committee/queue')).status).toBe(403);
    expect((await (await login('evc.member')).get('/api/committee/queue')).status).toBe(403);
    expect((await (await login('applicant.sample')).get(`/api/applications/${id}`)).status).toBe(404);
    expect((await (await login('applicant.sample')).post(`/api/applications/${id}/committee-submissions`).field('note', 'Not my application (TEST).')).status).toBe(404);
    // The Council desk lists only appeal cases.
    const council = (await (await login('council.official')).get('/api/committee/queue')).body.cases;
    expect(council.every((x: { appeal_ref: string | null }) => x.appeal_ref)).toBe(true);
    // A decided case accepts no further committee submissions.
    expect((await (await login('applicant.demo')).post(`/api/applications/${id}/committee-submissions`).field('note', 'After the decision (TEST).')).body.error).toBe('NO_COMMITTEE_SUBMISSION');
  });
});
