/**
 * EVC scheduling: date/time-aware availability, overlap prevention (half-open [start, end)), capacity, race safety,
 * invitation responses, partial acceptance, rescheduling, report/evidence integrity and duplicate suppression.
 * All data is synthetic TEST data. The seeded registry has exactly three eligible members with accounts
 * (EVC-DEMO-0001..0003) and one unverified record without an account (EVC-DEMO-0004).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createDb, migrate, type Db } from '../server/db/index.ts';
import { DEMO_ACCOUNTS, seed } from '../server/db/seed.ts';
import { NO_CAPACITY_MESSAGE } from '../server/evc/service.ts';
import { MemoryStorage } from '../server/storage.ts';

let db: Db;
let app: ReturnType<typeof createApp>['app'];
const PDF = (tag = 'SYNTHETIC TEST FILE') => Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF`);
const pw = (l: string) => DEMO_ACCOUNTS.find((a) => a.loginId === l)!.password;
async function login(l: string) {
  const a = request.agent(app);
  expect((await a.post('/api/auth/login').send({ loginId: l, password: pw(l) })).status).toBe(200);
  return a;
}
/** An ISO instant `days` from today at hh:mm India Standard Time. */
function ist(days: number, hh: number, mm = 0) {
  const d = new Date(Date.now() + days * 86400000 + 5.5 * 3600000);
  const day = d.toISOString().slice(0, 10);
  return new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`).toISOString();
}
const MEMBERS = ['evc.member', 'evc.member2', 'evc.member3'];
let RO: request.Agent;
let pick: (code: string) => string;
const committee = () => [
  { expertId: pick('EVC-DEMO-0001'), seat: 'ACADEMICIAN' },
  { expertId: pick('EVC-DEMO-0002'), seat: 'EXPERT' },
  { expertId: pick('EVC-DEMO-0003'), seat: 'ARCHITECT_PLANNING' },
];
const act = (id: string, action: string, body: object = {}) => RO.post(`/api/official/applications/${id}/actions/${action}`).send(body);
const propose = (id: string, start: string, end: string, extra: object = {}) => act(id, 'PROPOSE_EVC_DATE', { mode: 'ONLINE', scheduledStart: start, scheduledEnd: end, meetingLink: 'https://meet.example.test/evc', ...extra });
const visitOf = async (id: string) => (await db.one<{ id: string }>("SELECT id FROM evc_visits WHERE application_id = $1 AND status <> 'CANCELLED' ORDER BY scheduled_at DESC LIMIT 1", [id]))!.id;
const userId = async (l: string) => (await db.one<{ id: string }>('SELECT id FROM users WHERE login_id = $1', [l]))!.id;
const respond = async (l: string, visit: string, response: string, reason?: string) => (await login(l)).post(`/api/evc/visits/${visit}/respond`).send({ response, reason });
const avail = (start: string, end: string, extra: object = {}) => RO.post('/api/evc/scheduler/availability').send({ start, end, ...extra });
const statusOf = (body: { officials: Array<{ member_code: string; status: string }> }, code: string) => body.officials.find((o) => o.member_code === code)!.status;

async function readyForEvc(label: string) {
  const A = await login('applicant.demo');
  const c = await A.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
  const id = c.body.application.id as string;
  await A.patch(`/api/applications/${id}`).send({
    rowVersion: c.body.application.row_version,
    fields: { academicYear: '2026-27', authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'TEST University', proposedCourses: [{ course: `MBA ${label}` }], nocReference: 'N', resolutionDate: '2026-09-01' },
  });
  for (const r of ['NPL-NOC', 'NPL-RES']) await A.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF(), `${r}.pdf`);
  expect((await A.post(`/api/applications/${id}/submit`).send({ declaration: true })).status).toBe(200);
  expect((await (await login('scrutiny.officer')).post(`/api/official/applications/${id}/actions/FORWARD_TO_EVC`).send({ reason: 'In order (TEST).' })).status).toBe(200);
  return id;
}

beforeAll(async () => {
  db = await createDb({ dataDir: 'memory://' });
  await migrate(db);
  await seed(db);
  app = createApp({ db, storage: new MemoryStorage(), silent: true, loginsPerMinute: 1000 }).app;
  await (await login('applicant.demo')).put('/api/institution/profile').send({
    name: 'Demo Institute of Technology, Pune (TEST)', address: 'Survey No. 12, Demo Road', state: 'Maharashtra', district: 'Pune', pincode: '411001',
    official_email: 'office@demo-institute.test', applicant_name: 'Demo Applicant', applicant_designation: 'Principal',
  });
  RO = await login('regional.officer');
  const list = (await RO.get('/api/evc/experts')).body.experts as Array<{ id: string; member_code: string }>;
  pick = (code) => list.find((e) => e.member_code === code)!.id;
});
afterAll(async () => db?.close());

describe('EVC scheduling — availability, overlap and capacity', () => {
  let app1: string;
  let app2: string;

  it('1. lists registry officials with date/time availability and the reason for anyone not selectable', async () => {
    const r = await avail(ist(3, 10), ist(3, 12));
    expect(r.status).toBe(200);
    for (const c of ['EVC-DEMO-0001', 'EVC-DEMO-0002', 'EVC-DEMO-0003']) expect(statusOf(r.body, c)).toBe('AVAILABLE');
    const unverified = r.body.officials.find((o: { member_code: string }) => o.member_code === 'EVC-DEMO-0004');
    expect(['NOT_VERIFIED', 'NO_ACCOUNT']).toContain(unverified.status);
    expect(unverified.reason).toBeTruthy();
    expect(r.body.capacity.satisfiable).toBe(true);
    expect(r.body.message).toBeNull();
    expect(Array.isArray(r.body.officials[0].dayAssignments)).toBe(true);
    // Members and institutions cannot read the availability of officials.
    expect((await (await login('evc.member')).post('/api/evc/scheduler/availability').send({ start: ist(3, 10), end: ist(3, 12) })).status).toBe(403);
    expect((await (await login('applicant.demo')).post('/api/evc/scheduler/availability').send({ start: ist(3, 10), end: ist(3, 12) })).status).toBe(403);
  });

  it('6. pending invitations reserve the slot; 2. a busy official is blocked; 3. a fully occupied slot cannot be staffed', async () => {
    app1 = await readyForEvc('sched-1');
    expect((await propose(app1, ist(3, 10), ist(3, 12))).status).toBe(200);
    const inv = await act(app1, 'ASSIGN_EVC_MEMBERS', { members: committee() });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(inv.body.invited).toBe(3);
    // Nobody has accepted yet, but the invitations already hold the time.
    const r = await avail(ist(3, 11), ist(3, 12, 30));
    for (const c of ['EVC-DEMO-0001', 'EVC-DEMO-0002', 'EVC-DEMO-0003']) expect(statusOf(r.body, c)).toBe('BUSY');
    const busy = r.body.officials.find((o: { member_code: string }) => o.member_code === 'EVC-DEMO-0001');
    expect(busy.conflicts.length).toBeGreaterThan(0);
    expect(r.body.capacity.satisfiable).toBe(false);
    expect(r.body.message).toBe(NO_CAPACITY_MESSAGE);
    expect(r.body.alternatives.length).toBeGreaterThan(0);
    // Inviting the same officials to an overlapping slot is refused by the server.
    app2 = await readyForEvc('sched-2');
    expect((await propose(app2, ist(3, 11), ist(3, 12, 30))).status).toBe(200);
    const clash = await act(app2, 'ASSIGN_EVC_MEMBERS', { members: committee() });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('MEMBER_UNAVAILABLE');
    // The visit context reports the conflict for the draft panel.
    await propose(app2, ist(3, 11), ist(3, 12, 30), { panel: committee() });
    const ctx = (await RO.get(`/api/evc/scheduler/applications/${app2}`)).body;
    expect(ctx.conflicts.length).toBeGreaterThan(0);
    expect(ctx.alternatives.length).toBeGreaterThan(0);
  });

  it('half-open intervals: a visit ending at 12:00 does not block one starting at 12:00', async () => {
    const r = await avail(ist(3, 12), ist(3, 13));
    for (const c of ['EVC-DEMO-0001', 'EVC-DEMO-0002', 'EVC-DEMO-0003']) expect(statusOf(r.body, c)).toBe('AVAILABLE');
    expect((await propose(app2, ist(3, 12), ist(3, 13))).status).toBe(200);
    const inv = await act(app2, 'ASSIGN_EVC_MEMBERS', { members: committee() });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  });

  it('the database itself refuses an overlapping reservation for the same official', async () => {
    const m = await db.one<{ visit_id: string; user_id: string }>('SELECT visit_id, user_id FROM evc_visit_members m JOIN evc_visits v ON v.id = m.visit_id WHERE v.application_id = $1 LIMIT 1', [app1]);
    await expect(
      db.query("UPDATE evc_visit_members SET reserved_period = tstzrange($1::timestamptz, $2::timestamptz, '[)') WHERE visit_id = (SELECT id FROM evc_visits WHERE application_id = $3 AND status <> 'CANCELLED' LIMIT 1) AND user_id = $4", [ist(3, 11), ist(3, 12, 30), app2, m!.user_id]),
    ).rejects.toThrow(/evc_member_no_overlap|conflicting key/);
  });

  it('5. a rejection releases that member; cancellation releases the whole committee', async () => {
    const v1 = await visitOf(app1);
    expect((await respond('evc.member', v1, 'REJECTED')).body.error).toBe('REASON_REQUIRED');
    const rej = await respond('evc.member', v1, 'REJECTED', 'On examination duty that day (TEST).');
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.assignmentStatus).toBe('RESCHEDULING_REQUIRED');
    let r = await avail(ist(3, 10, 30), ist(3, 11, 30));
    expect(statusOf(r.body, 'EVC-DEMO-0001')).toBe('AVAILABLE');
    expect(statusOf(r.body, 'EVC-DEMO-0002')).toBe('BUSY');
    // The RO is told the committee is incomplete; nothing is replaced automatically.
    expect(await db.query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = 'regional.officer' AND n.event_type = 'EVC_COMMITTEE_INCOMPLETE' AND n.application_id = $1", [app1])).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND active', [v1])).length).toBe(3);
    // A decline is not overwritten by re-inviting the same official to the same time.
    const again = await act(app1, 'ASSIGN_EVC_MEMBERS', { members: committee() });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('MEMBER_DECLINED');
    expect((await db.one<{ response_status: string }>('SELECT response_status FROM evc_visit_members WHERE visit_id = $1 AND user_id = $2', [v1, await userId('evc.member')]))!.response_status).toBe('REJECTED');
    expect((await act(app1, 'CANCEL_EVC', { reason: 'Rescheduling with a new committee (TEST).' })).status).toBe(200);
    r = await avail(ist(3, 10, 30), ist(3, 11, 30));
    for (const c of ['EVC-DEMO-0001', 'EVC-DEMO-0002', 'EVC-DEMO-0003']) expect(statusOf(r.body, c)).toBe('AVAILABLE');
    expect(await db.query('SELECT 1 FROM evc_visit_members WHERE visit_id = $1 AND reserved_period IS NOT NULL', [v1])).toHaveLength(0);
  });

  it('recorded unavailability blocks a member only for its period; members record only their own', async () => {
    const M = await login('evc.member2');
    const own = await M.post('/api/evc/scheduler/unavailability').send({ startsAt: ist(9, 9), endsAt: ist(9, 18), reason: 'University examination (TEST).' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect((await M.post('/api/evc/scheduler/unavailability').send({ expertId: pick('EVC-DEMO-0001'), startsAt: ist(9, 9), endsAt: ist(9, 18), reason: 'Not mine (TEST).' })).status).toBe(403);
    expect(statusOf((await avail(ist(9, 10), ist(9, 11))).body, 'EVC-DEMO-0002')).toBe('UNAVAILABLE');
    expect(statusOf((await avail(ist(10, 10), ist(10, 11))).body, 'EVC-DEMO-0002')).toBe('AVAILABLE');
    expect((await M.delete(`/api/evc/scheduler/unavailability/${own.body.unavailability.id}`)).status).toBe(200);
    expect(statusOf((await avail(ist(9, 10), ist(9, 11))).body, 'EVC-DEMO-0002')).toBe('AVAILABLE');
  });
});

describe('EVC scheduling — concurrency, responses, reschedule, duplicates', () => {
  let a3: string;
  let a4: string;

  it('4. simultaneous invitations for the same officials and time: exactly one succeeds', async () => {
    a3 = await readyForEvc('race-a');
    a4 = await readyForEvc('race-b');
    expect((await propose(a3, ist(5, 10), ist(5, 11))).status).toBe(200);
    expect((await propose(a4, ist(5, 10, 30), ist(5, 11, 30))).status).toBe(200);
    const [x, y] = await Promise.all([act(a3, 'ASSIGN_EVC_MEMBERS', { members: committee() }), act(a4, 'ASSIGN_EVC_MEMBERS', { members: committee() })]);
    const codes = [x.status, y.status].sort();
    expect(codes).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(['MEMBER_UNAVAILABLE', 'MEMBER_SLOT_TAKEN']).toContain(loser.body.error);
    // No official holds two overlapping reservations.
    const overlaps = await db.query(
      `SELECT 1 FROM evc_visit_members p JOIN evc_visit_members q ON p.user_id = q.user_id AND p.visit_id < q.visit_id
       WHERE p.reserved_period && q.reserved_period`,
    );
    expect(overlaps).toHaveLength(0);
    if (x.status === 409) [a3, a4] = [a4, a3]; // a3 is the winner from here on
  });

  it('10. members respond only for themselves; 7. each response updates the right member', async () => {
    const v = await visitOf(a3);
    const m3 = await userId('evc.member3');
    const M2 = await login('evc.member2');
    const r = await M2.post(`/api/evc/visits/${v}/respond`).send({ response: 'ACCEPTED', userId: m3 }); // userId is ignored
    expect(r.status).toBe(200);
    const rows = await db.query<{ login_id: string; response_status: string }>('SELECT u.login_id, m.response_status FROM evc_visit_members m JOIN users u ON u.id = m.user_id WHERE m.visit_id = $1 ORDER BY u.login_id', [v]);
    expect(Object.fromEntries(rows.map((x) => [x.login_id, x.response_status]))).toEqual({ 'evc.member': 'INVITED', 'evc.member2': 'ACCEPTED', 'evc.member3': 'INVITED' });
    expect((await M2.post(`/api/evc/visits/${v}/respond`).send({ response: 'ACCEPTED' })).body.error).toBe('ALREADY_RECORDED');
    // A visit the caller is not on is not found; institutions cannot respond at all.
    const losing = await visitOf(a4);
    expect((await M2.post(`/api/evc/visits/${losing}/respond`).send({ response: 'ACCEPTED' })).status).toBe(404);
    expect((await (await login('applicant.demo')).post(`/api/evc/visits/${v}/respond`).send({ response: 'ACCEPTED' })).status).toBe(403);
  });

  it('8. partial acceptance is never confirmed', async () => {
    const v = await visitOf(a3);
    expect((await respond('evc.member', v, 'ACCEPTED')).body.assignmentStatus).toBe('PARTIALLY_ACCEPTED');
    const c = await act(a3, 'CONFIRM_EVC');
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('RESPONSES_PENDING');
    expect((await db.one<{ status: string }>('SELECT status FROM evc_visits WHERE id = $1', [v]))!.status).toBe('PROPOSED');
    expect((await db.one<{ status: string }>('SELECT status FROM applications WHERE id = $1', [a3]))!.status).toBe('AWAITING_EVC_SCHEDULING');
    expect((await respond('evc.member3', v, 'ACCEPTED')).body.assignmentStatus).toBe('AWAITING_CONFIRMATION');
    expect((await act(a3, 'CONFIRM_EVC')).status).toBe(200);
    expect((await RO.get(`/api/evc/scheduler/applications/${a3}`)).body.assignmentStatus).toBe('CONFIRMED');
  });

  it('9. rescheduling revalidates availability, bumps the version, resets responses and notifies', async () => {
    const v = await visitOf(a3);
    // Book the committee elsewhere first, so the reschedule target is taken.
    expect((await propose(a4, ist(7, 10), ist(7, 12))).status).toBe(200);
    expect((await act(a4, 'ASSIGN_EVC_MEMBERS', { members: committee() })).status).toBe(200);
    const taken = await act(a3, 'RESCHEDULE_EVC', { scheduledStart: ist(7, 11), scheduledEnd: ist(7, 12), reason: 'Institution requested (TEST).' });
    expect(taken.status).toBe(409);
    expect((await db.one<{ schedule_version: number }>('SELECT schedule_version FROM evc_visits WHERE id = $1', [v]))!.schedule_version).toBe(1);
    const ok = await act(a3, 'RESCHEDULE_EVC', { scheduledStart: ist(8, 14), scheduledEnd: ist(8, 15), reason: 'Institution requested (TEST).' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await db.one<{ schedule_version: number; status: string }>('SELECT schedule_version, status FROM evc_visits WHERE id = $1', [v]);
    expect(after).toMatchObject({ schedule_version: 2, status: 'RESCHEDULED' });
    expect((await db.query<{ response_status: string }>('SELECT response_status FROM evc_visit_members WHERE visit_id = $1 AND active', [v])).every((m) => m.response_status === 'INVITED')).toBe(true);
    expect(await db.query("SELECT 1 FROM notifications WHERE application_id = $1 AND event_type = 'EVC_RESCHEDULED'", [a3])).toHaveLength(4); // three members + institution
    const hist = await db.query<{ new_status: string; schedule_version: number; reason: string }>('SELECT new_status, schedule_version, reason FROM evc_schedule_history WHERE visit_id = $1 ORDER BY id', [v]);
    expect(hist.at(-1)).toMatchObject({ new_status: 'RESCHEDULED', schedule_version: 2, reason: 'Institution requested (TEST).' });
    // The old slot is free again; the new one is held.
    expect(statusOf((await avail(ist(5, 10), ist(5, 11))).body, 'EVC-DEMO-0001')).toBe('AVAILABLE');
    expect(statusOf((await avail(ist(8, 14), ist(8, 15))).body, 'EVC-DEMO-0001')).toBe('BUSY');
  });

  it('13. repeated requests create no duplicate members, invitations or notifications', async () => {
    const v = await visitOf(a4);
    const before = (await db.query("SELECT 1 FROM notifications WHERE application_id = $1 AND event_type = 'EVC_ASSIGNED'", [a4])).length;
    expect((await act(a4, 'ASSIGN_EVC_MEMBERS', { members: committee() })).status).toBe(200);
    expect((await act(a4, 'ASSIGN_EVC_MEMBERS', { members: committee() })).status).toBe(200);
    expect(await db.query('SELECT 1 FROM evc_visit_members WHERE visit_id = $1', [v])).toHaveLength(3);
    expect((await db.query("SELECT 1 FROM notifications WHERE application_id = $1 AND event_type = 'EVC_ASSIGNED'", [a4])).length).toBe(before);
    await propose(a4, ist(7, 10), ist(7, 12), { coordinationNote: 'Same slot again (TEST).' });
    expect(await db.query("SELECT 1 FROM evc_visits WHERE application_id = $1 AND status <> 'CANCELLED'", [a4])).toHaveLength(1);
  });
});

describe('EVC reports and evidence', () => {
  it('11. a report cannot be submitted before the visit occurred; submissions are versioned and timestamped; 12. evidence stays private', async () => {
    const id = await readyForEvc('report-sched');
    expect((await propose(id, ist(-1, 10), ist(-1, 11))).status).toBe(200);
    expect((await act(id, 'ASSIGN_EVC_MEMBERS', { members: committee() })).status).toBe(200);
    const v = await visitOf(id);
    for (const m of MEMBERS) expect((await respond(m, v, 'ACCEPTED')).status).toBe(200);
    expect((await act(id, 'CONFIRM_EVC')).status).toBe(200);
    const M = await login('evc.member');
    const body = { declaration: true, observations: 'Instructional area verified (TEST).', recommendation: 'As verified (TEST)', sections: { INSTRUCTIONAL: { finding: 'VERIFIED_AVAILABLE' } } };
    expect((await M.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send(body)).status).toBe(409); // not started
    expect((await M.post(`/api/official/applications/${id}/actions/START_EVC`)).status).toBe(200);
    const early = await M.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send(body);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('VISIT_NOT_OCCURRED'); // no attendance recorded
    expect((await M.post(`/api/evc/visits/${v}/attendance`).send({ attendance: 'PRESENT' })).status).toBe(200);
    const ev = await M.post(`/api/evc/visits/${v}/evidence`).field('note', 'Lab photo (TEST)').attach('file', PDF('EVIDENCE'), 'lab.pdf');
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect((await (await login('applicant.demo')).get(`/api/evc/evidence/${ev.body.evidence.id}/download`)).status).toBe(403);
    expect((await (await login('regional.officer2')).get(`/api/evc/evidence/${ev.body.evidence.id}/download`)).status).toBe(404);
    expect((await request(app).get(`/api/evc/evidence/${ev.body.evidence.id}/download`)).status).toBe(401);
    // Inspection updates reach the Regional Officer; supporting documents are categorised.
    const up = await M.post(`/api/evc/visits/${v}/updates`).send({ note: 'Instructional block inspected; library pending (TEST).' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(await db.query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = 'regional.officer' AND n.event_type = 'EVC_INSPECTION_UPDATE' AND n.application_id = $1", [id])).toHaveLength(1);
    const doc = await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'SUPPORTING_DOCUMENT').field('note', 'Building plan (TEST)').attach('file', PDF('PLAN'), 'plan.pdf');
    expect(doc.body.evidence.category).toBe('SUPPORTING_DOCUMENT');
    expect((await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'NOT_A_CATEGORY').attach('file', PDF(), 'x.pdf')).status).toBe(400);
    // Report documents and visit evidence accept different file types (checked from content, not the name).
    const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32), Buffer.from([0xff, 0xd9])]);
    const rpt = await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'INSPECTION_REPORT').attach('file', PDF('SIGNED REPORT'), 'inspection-report.pdf');
    expect(rpt.status, JSON.stringify(rpt.body)).toBe(201);
    expect((await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'INSPECTION_REPORT').attach('file', JPG, 'report.jpg')).status).toBe(415);
    const vid = await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'VIDEO_RECORDING').attach('file', MP4, 'walkthrough.mp4');
    expect(vid.status, JSON.stringify(vid.body)).toBe(201);
    expect((await db.one<{ mime_type: string }>('SELECT mime_type FROM evc_report_evidence WHERE id = $1', [vid.body.evidence.id]))!.mime_type).toBe('video/mp4');
    expect((await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'VISIT_PHOTO').attach('file', MP4, 'fake.jpg')).status).toBe(415);
    expect((await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'VISIT_PHOTO').attach('file', JPG, 'lab.jpg')).status).toBe(201);
    expect((await M.post(`/api/evc/visits/${v}/evidence`).field('category', 'SUPPORTING_DOCUMENT').attach('file', MP4, 'clip.mp4')).status).toBe(415);
    expect((await M.get(`/api/evc/evidence/${vid.body.evidence.id}/download?inline=1`)).headers['content-type']).toMatch(/video\/mp4/);
    expect((await M.post(`/api/evc/visits/${v}/complete`).send({ note: 'Completed online (TEST).' })).status).toBe(200);
    const noDecl = await M.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send({ ...body, declaration: undefined });
    expect(noDecl.status).toBe(400);
    const rep = await M.post(`/api/official/applications/${id}/actions/SUBMIT_EVC_REPORT`).send(body);
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.report.version).toBe(1);
    const row = await db.one<{ submitted_at: string | null; submitted_by: string | null; declaration_at: string | null }>('SELECT submitted_at, submitted_by, declaration_at FROM evc_reports WHERE id = $1', [rep.body.report.id]);
    expect(row!.submitted_at).toBeTruthy();
    expect(row!.declaration_at).toBeTruthy();
    expect(row!.submitted_by).toBe(await userId('evc.member'));
    expect((await db.one<{ report_id: string }>('SELECT report_id FROM evc_report_evidence WHERE id = $1', [ev.body.evidence.id]))!.report_id).toBe(rep.body.report.id);
    expect((await db.one<{ report_id: string }>('SELECT report_id FROM evc_report_evidence WHERE id = $1', [doc.body.evidence.id]))!.report_id).toBe(rep.body.report.id);
    // The final report goes to the Regulation Bureau for its views (APH Ch. I §1.10(a)); its evidence is then frozen.
    expect(await db.query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = 'regulation.bureau' AND n.event_type = 'EVC_REPORT' AND n.application_id = $1", [id])).toHaveLength(1);
    expect((await M.post(`/api/evc/visits/${v}/evidence`).attach('file', PDF('LATE'), 'late.pdf')).body.error).toBe('REPORT_SUBMITTED');
    expect((await RO.get(`/api/evc/scheduler/applications/${id}`)).body.assignmentStatus).toBe('COMPLETED');
  });

  it('members see their own schedule but cannot schedule, invite, confirm or read the coordinator view', async () => {
    const id = await readyForEvc('member-readonly');
    const M = await login('evc.member');
    expect((await M.get('/api/evc/scheduler')).status).toBe(403);
    expect((await M.get(`/api/evc/scheduler/applications/${id}`)).status).toBe(403);
    for (const [a, b] of [
      ['PROPOSE_EVC_DATE', { mode: 'ONLINE', scheduledStart: ist(12, 10), scheduledEnd: ist(12, 11) }],
      ['ASSIGN_EVC_MEMBERS', { members: committee() }],
      ['CONFIRM_EVC', {}],
      ['RESCHEDULE_EVC', { scheduledStart: ist(12, 10), scheduledEnd: ist(12, 11), reason: 'Member attempt (TEST).' }],
    ] as const)
      expect([403, 404]).toContain((await M.post(`/api/official/applications/${id}/actions/${a}`).send(b)).status);
    // After the Regional Officer invites them, the visit appears on the member's own list.
    expect((await propose(id, ist(12, 10), ist(12, 11))).status).toBe(200);
    expect((await act(id, 'ASSIGN_EVC_MEMBERS', { members: committee() })).status).toBe(200);
    const mine = (await M.get('/api/evc/my-assignments')).body.assignments.find((x: { application_id: string }) => x.application_id === id);
    expect(mine).toMatchObject({ response_status: 'INVITED', memberStatus: 'INVITED' });
    expect(await db.query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.login_id = 'evc.member' AND n.event_type = 'EVC_ASSIGNED' AND n.application_id = $1", [id])).toHaveLength(1);
  });
});
