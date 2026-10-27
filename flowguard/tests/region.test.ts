/** Regional oversight overview: region scoping, drafts excluded, cycle filter, access control. Synthetic TEST data. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createDb, migrate, type Db } from '../server/db/index.ts';
import { DEMO_ACCOUNTS, seed } from '../server/db/seed.ts';
import { MemoryStorage } from '../server/storage.ts';

let db: Db;
let app: ReturnType<typeof createApp>['app'];
const PDF = Buffer.from('%PDF-1.4\n% SYNTHETIC TEST FILE\n%%EOF');
const pw = (l: string) => DEMO_ACCOUNTS.find((a) => a.loginId === l)!.password;
async function login(l: string) {
  const a = request.agent(app);
  expect((await a.post('/api/auth/login').send({ loginId: l, password: pw(l) })).status).toBe(200);
  return a;
}
async function submitted(who: string, year: string) {
  const A = await login(who);
  const c = await A.post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' });
  const id = c.body.application.id as string;
  await A.patch(`/api/applications/${id}`).send({
    rowVersion: c.body.application.row_version,
    fields: { academicYear: year, authorisedSignatoryName: 'TEST', authorisedSignatoryDesignation: 'CHAIRMAN', affiliatingBody: 'TEST University', proposedCourses: [{ course: 'MBA' }], nocReference: 'N', resolutionDate: '2026-09-01' },
  });
  for (const r of ['NPL-NOC', 'NPL-RES']) await A.post(`/api/applications/${id}/documents`).field('requirementId', r).field('metadata', '{"dscDeclared":true}').attach('file', PDF, `${r}.pdf`);
  const s = await A.post(`/api/applications/${id}/submit`).send({ declaration: true });
  expect(s.status, `${who} ${year} ${JSON.stringify(s.body).slice(0, 400)}`).toBe(200);
  return id;
}

let west: string;
let south: string;
let draft: string;
beforeAll(async () => {
  db = await createDb({ dataDir: 'memory://' });
  await migrate(db);
  await seed(db);
  app = createApp({ db, storage: new MemoryStorage(), silent: true, loginsPerMinute: 1000 }).app;
  for (const l of ['applicant.demo', 'applicant.sample'])
    await (await login(l)).put('/api/institution/profile').send({ name: `${l} institute (TEST)`, address: 'Survey No. 12, Demo Road', state: 'Maharashtra', district: 'Pune', pincode: '411001', official_email: 'office@demo-institute.test', applicant_name: 'Demo Applicant', applicant_designation: 'Principal' });
  west = await submitted('applicant.demo', '2026-27');
  south = await submitted('applicant.sample', '2025-26');
  draft = (await (await login('applicant.demo')).post('/api/applications').send({ categoryCode: 'NEW_PROGRAMME_LEVEL' })).body.application.id;
});
afterAll(async () => db?.close());

describe('regional oversight overview', () => {
  it('a Regional Officer sees every submitted application in their regions only, at every stage', async () => {
    const o = (await (await login('regional.officer')).get('/api/region/overview')).body;
    const ids = o.applications.map((a: { id: string }) => a.id);
    expect(ids).toContain(west);
    expect(ids).not.toContain(south);
    expect(ids).not.toContain(draft); // drafts stay private to the institution
    const row = o.applications.find((a: { id: string }) => a.id === west);
    expect(row).toMatchObject({ status: 'SUBMITTED', stage: 'SUBMITTED', pendingWith: 'OFFICIAL', canOpen: false, submitted_by_name: expect.any(String) });
    expect(row.institution_name).toMatch(/TEST/);
    expect(o.scope.regions.map((r: { code: string }) => r.code)).toEqual(['DEMO-RO-WEST']);
    expect(o.kpis).toMatchObject({ submitted: 1, active: 1, withOfficials: 1, decided: 0 });
    expect(o.monthly).toHaveLength(12);
    expect(o.monthly.at(-1).submitted).toBe(1);
    expect(o.stages).toEqual([{ stage: 'SUBMITTED', label: 'Submitted', n: 1 }]);
    const s = (await (await login('regional.officer2')).get('/api/region/overview')).body;
    expect(s.applications.map((a: { id: string }) => a.id)).toEqual([south]);
  });

  it('oversight roles see all regions; the cycle filter narrows by academic year', async () => {
    const S = await login('supervisor');
    const all = (await S.get('/api/region/overview')).body;
    expect(all.scope.allRegions).toBe(true);
    expect(all.applications.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining([west, south]));
    expect(all.cycles).toEqual(expect.arrayContaining(['2026-27', '2025-26']));
    const y = (await S.get('/api/region/overview?cycle=2025-26')).body;
    expect(y.applications.map((a: { id: string }) => a.id)).toEqual([south]);
    expect((await (await login('regulation.bureau')).get('/api/region/overview')).status).toBe(200);
  });

  it('institutions, scrutiny officials and EVC members cannot open the regional overview', async () => {
    for (const l of ['applicant.demo', 'scrutiny.officer', 'evc.member']) expect((await (await login(l)).get('/api/region/overview')).status, l).toBe(403);
    expect((await request(app).get('/api/region/overview')).status).toBe(401);
  });
});
