// End-to-end recorded demo of the AICTE Approval Portal, driven through the real UI.
// Usage: npm run demo            (starts the dev server if it is not already running)
// Output: demo/output/<run-id>/  (raw .webm, final .mp4, screenshots, report, narration script)
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEMO_DIR, '..');
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';
// Seeded development accounts (server/db/seed.ts). Override through the environment for any other environment.
const PASSWORD = { applicant: process.env.DEMO_APPLICANT_PASSWORD ?? 'Applicant@2026', official: process.env.DEMO_OFFICIAL_PASSWORD ?? 'Official@2026' };
const HEADED = process.env.DEMO_HEADED === '1';
const PACE = Number(process.env.DEMO_PACE ?? '1');

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(DEMO_DIR, 'output', RUN_ID);
const SHOTS = path.join(OUT, 'screenshots');
const ASSETS = path.join(OUT, 'assets');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

const MEMBER_LOGIN = { 'Test EVC Member': 'evc.member', 'Second EVC Member': 'evc.member2', 'Third EVC Member': 'evc.member3' };

// ------------------------------------------------------------------ server + API helpers

async function serverUp() {
  try {
    const r = await fetch(`${BASE}/api/auth/me`);
    return r.status === 200 || r.status === 401;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp()) return null;
  console.log('Dev server not running; starting it…');
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'server/index.ts'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await serverUp()) return child;
  }
  child.kill();
  throw new Error(`The application did not start at ${BASE} within 90 s.`);
}

/** A read-only API session used to verify state independently of the recorded browser. */
async function apiSession(loginId, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password }) });
  if (!r.ok) throw new Error(`API login failed for ${loginId}: ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (method, url, body) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b) };
}

// ------------------------------------------------------------------ sample documents (synthetic)

function makePdf(file, title, lines) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const s = fs.createWriteStream(file);
    doc.pipe(s);
    doc.fontSize(9).fillColor('#888').text('SYNTHETIC DEMONSTRATION DOCUMENT — NOT A REAL RECORD', { align: 'right' });
    doc.moveDown(2).fontSize(17).fillColor('#111').text(title);
    doc.moveDown();
    doc.fontSize(11).fillColor('#222');
    for (const l of lines) doc.text(l).moveDown(0.5);
    doc.end();
    s.on('finish', resolve);
  });
}

async function makeAssets() {
  const f = (n) => path.join(ASSETS, n);
  await makePdf(f('noc_format2.pdf'), 'No Objection Certificate (Format 2)', [
    'Issued by: Savitribai Phule Pune University',
    'Reference: SPPU/NOC/2025/4521   Date: 10-09-2025',
    'To: Demo Institute of Technology, Pune (DEMO-INST-0001)',
    'The University has no objection to the conversion of the Diploma level courses of the institution into Degree level courses in the same specialisation.',
  ]);
  await makePdf(f('resolution_format3.pdf'), 'Resolution of the Trust (Format 3)', [
    'Demo Education Trust, Pune — meeting held on 15-09-2025',
    'Resolved that the Trust approves the conversion of the Diploma level into the Degree level for Computer Engineering (intake 60).',
    'Signed: Dr. Rajesh Kumar, Chairman',
  ]);
  await makePdf(f('evc_inspection_report.pdf'), 'Expert Visit Committee — Inspection Report', [
    'Institution: Demo Institute of Technology, Pune',
    'Committee: Academician, Expert member, Architect / Planning',
    'Infrastructure, laboratories, library holdings and faculty records were verified against the application.',
  ]);
  await makePdf(f('ec_decision_letter.pdf'), 'Executive Committee — Letter of Approval', [
    'All India Council for Technical Education — synthetic demonstration letter',
    'Decision: Letter of Approval for the Diploma-to-Degree conversion (Computer Engineering).',
  ]);
  return { noc: f('noc_format2.pdf'), res: f('resolution_format3.pdf'), evc: f('evc_inspection_report.pdf'), loa: f('ec_decision_letter.pdf') };
}

// ------------------------------------------------------------------ on-screen overlay (cursor + captions)

const OVERLAY = () => {
  const S = 'demoOverlay';
  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(S) || '{}');
    } catch {
      return {};
    }
  };
  const write = (v) => {
    try {
      sessionStorage.setItem(S, JSON.stringify({ ...read(), ...v }));
    } catch {}
  };
  const mount = () => {
    if (document.getElementById('demo-cursor')) return;
    const st = document.createElement('style');
    st.textContent = `
      #demo-cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-4px 0 0 -4px;pointer-events:none;transition:left .45s cubic-bezier(.3,.7,.2,1),top .45s cubic-bezier(.3,.7,.2,1)}
      #demo-cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
      #demo-ring{position:fixed;z-index:2147483646;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #2563eb;opacity:0;pointer-events:none}
      #demo-ring.on{animation:demoRing .5s ease-out}
      @keyframes demoRing{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}
      #demo-cap{position:fixed;z-index:2147483645;left:50%;bottom:28px;transform:translateX(-50%);max-width:1180px;display:flex;align-items:center;gap:14px;
        background:rgba(15,23,42,.92);color:#fff;padding:14px 22px;border-radius:14px;font:500 20px/1.35 Inter,Segoe UI,Arial,sans-serif;pointer-events:none;box-shadow:0 10px 30px rgba(0,0,0,.25)}
      #demo-cap .tag{flex:none;background:#f59e0b;color:#111;font-weight:700;font-size:14px;letter-spacing:.04em;text-transform:uppercase;padding:5px 10px;border-radius:8px}
      #demo-cap:empty,#demo-cap.off{display:none}`;
    document.head.appendChild(st);
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2l17 11-7.5 1.6L15 23l-3.2 1.4-3.6-8.3L2 21z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div');
    ring.id = 'demo-ring';
    const cap = document.createElement('div');
    cap.id = 'demo-cap';
    document.body.append(c, ring, cap);
    const s = read();
    c.style.left = (s.x ?? 960) + 'px';
    c.style.top = (s.y ?? 540) + 'px';
    window.__setCaption(s.cap ?? null);
  };
  window.__setCaption = (cap) => {
    write({ cap });
    const el = document.getElementById('demo-cap');
    if (!el) return;
    el.innerHTML = '';
    if (!cap) return;
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = cap.tag;
    const x = document.createElement('span');
    x.textContent = cap.text;
    el.append(t, x);
  };
  window.__moveCursor = (x, y) => {
    write({ x, y });
    const c = document.getElementById('demo-cursor');
    if (c) {
      c.style.left = x + 'px';
      c.style.top = y + 'px';
    }
  };
  window.__pulse = (x, y) => {
    const r = document.getElementById('demo-ring');
    if (!r) return;
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    r.classList.remove('on');
    void r.offsetWidth;
    r.classList.add('on');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
};

// ------------------------------------------------------------------ run

const results = [];
const timeline = [];
let page;
let t0 = 0;
const elapsed = () => (Date.now() - t0) / 1000;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const wait = (ms) => page.waitForTimeout(ms * PACE);

async function caption(tag, text) {
  timeline.push({ at: elapsed(), tag, text });
  await page.evaluate((c) => window.__setCaption?.(c), { tag, text }).catch(() => {});
  // Slower paces give the viewer time to read each caption before the next action starts.
  if (PACE > 1) await page.waitForTimeout(Math.min(text.length * 45, 4500) * (PACE - 1));
}

async function pointAt(loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (!b) return null;
  const x = b.x + Math.min(b.width / 2, 60);
  const y = b.y + b.height / 2;
  await page.evaluate(([x, y]) => window.__moveCursor?.(x, y), [x, y]);
  await page.waitForTimeout(470 * PACE);
  return { x, y };
}

async function click(loc, after = 350) {
  await loc.waitFor({ state: 'visible', timeout: 20000 });
  const p = await pointAt(loc);
  await loc.click();
  if (p) await page.evaluate(([x, y]) => window.__pulse?.(x, y), [p.x, p.y]).catch(() => {});
  await wait(after);
}

async function type(loc, text) {
  await click(loc, 60);
  await loc.fill('');
  await loc.pressSequentially(String(text), { delay: Math.round(12 * PACE) });
  await wait(120);
}

async function fill(loc, value) {
  await loc.waitFor({ state: 'visible', timeout: 20000 });
  await pointAt(loc);
  await loc.fill(String(value));
  await wait(150);
}

async function choose(loc, value) {
  await loc.waitFor({ state: 'visible', timeout: 20000 });
  await pointAt(loc);
  await loc.selectOption(value);
  await wait(250);
}

async function shot(name) {
  await page.screenshot({ path: path.join(SHOTS, `${String(results.length + 1).padStart(2, '0')}-${name}.png`) }).catch(() => {});
}

async function step(id, title, fn, critical = true) {
  const start = elapsed();
  console.log(`[${mmss(start)}] ${id} ${title}`);
  try {
    const observed = await fn();
    results.push({ id, title, status: 'PASS', start, end: elapsed(), observed: observed ?? '' });
    await shot(id.replace(/\W+/g, '_'));
  } catch (e) {
    await shot(`FAIL-${id.replace(/\W+/g, '_')}`);
    results.push({ id, title, status: 'FAIL', start, end: elapsed(), observed: String(e.message ?? e).split('\n')[0] });
    console.error(`   ✗ ${e.message}`);
    if (critical) throw e;
  }
}

async function titleCard(title, subtitle, bullets = [], ms = 5000) {
  await page.evaluate(() => window.__setCaption?.(null)).catch(() => {});
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;font-family:Inter,Segoe UI,Arial,sans-serif;color:#fff">
    <div style="max-width:1300px;padding:0 80px">
      <div style="color:#f59e0b;font-weight:700;letter-spacing:.12em;font-size:20px;text-transform:uppercase">Smart India Hackathon · SIH26262</div>
      <h1 style="font-size:64px;margin:18px 0 10px;line-height:1.1">${title}</h1>
      <p style="font-size:28px;color:#cbd5e1;margin:0 0 30px">${subtitle}</p>
      ${bullets.map((b) => `<div style="font-size:24px;color:#e2e8f0;margin:12px 0;padding-left:26px;border-left:4px solid #f59e0b">${b}</div>`).join('')}
    </div></body></html>`);
  await page.waitForTimeout(ms * PACE);
}

async function signOut() {
  const btn = page.getByRole('button', { name: 'Sign out' });
  if (await btn.isVisible().catch(() => false)) {
    await click(btn, 200);
    await page.waitForURL('**/login', { timeout: 10000 });
  } else {
    await page.goto(`${BASE}/login`);
  }
}

async function login(loginId, password, who) {
  if (!page.url().endsWith('/login')) await signOut();
  await caption('Sign in', `${who} signs in (${loginId})`);
  await type(page.locator('#uid'), loginId);
  await type(page.locator('#pw'), password);
  await click(page.locator('button[type="submit"]'), 200);
  await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await wait(600);
}

async function findFreeSlot(ro) {
  const day = new Date();
  for (let i = 3; i < 60; i++) {
    const d = new Date(day.getTime() + i * 86400000);
    const dow = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    for (const [s, e] of [['10:00', '12:00'], ['14:00', '16:00']]) {
      const av = await ro.post('/api/evc/scheduler/availability', { start: `${ymd}T${s}:00+05:30`, end: `${ymd}T${e}:00+05:30` });
      const officials = av.officials ?? [];
      const free = Object.keys(MEMBER_LOGIN).every((n) => officials.some((o) => (o.fullName ?? o.full_name ?? o.name) === n && o.status === 'AVAILABLE'));
      if (free) return { ymd, s, e };
    }
  }
  throw new Error('No free slot for the demo EVC panel in the next 60 days.');
}

async function main() {
  const server = await ensureServer();
  const files = await makeAssets();
  const applicantApi = await apiSession('applicant.demo', PASSWORD.applicant);
  const roApi = await apiSession('regional.officer', PASSWORD.official);
  const slot = await findFreeSlot(roApi);
  const [yy, mm, dd] = slot.ymd.split('-');
  console.log(`Run ${RUN_ID}; EVC slot ${slot.ymd} ${slot.s}-${slot.e}`);

  const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER_CHANNEL ?? 'msedge', headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
  await context.addInitScript(OVERLAY);
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  t0 = Date.now();

  let appId = '';
  let ref = '';
  const status = async () => (await applicantApi.get(`/api/applications/${appId}`)).application.status;
  const expectStatus = async (want) => {
    for (let i = 0; i < 10; i++) {
      const s = await status();
      if (s === want) return `Server status: ${s}`;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Expected status ${want}, server reports ${await status()}`);
  };

  try {
    await titleCard('AICTE Approval Portal', 'One platform for approval workflows, EVC scheduling and institutional compliance', [], 4500);
    await titleCard('The problem', 'Approvals move through many hands with manual follow-up', [
      'Applications pass scrutiny, re-scrutiny, an Expert Visit Committee and a decision body',
      'Pendency, deadlines and committee scheduling are tracked by hand',
      'This demo runs one real application end to end through the live portal',
    ], 7000);

    // ---------------------------------------------------------------- 1. Institution
    await page.goto(`${BASE}/login`);
    await step('1.1', 'Institution signs in and sees its dashboard', async () => {
      await login('applicant.demo', PASSWORD.applicant, 'The institution');
      await caption('Institution', 'Dashboard: active applications, required actions, upcoming EVC visits and decisions');
      await page.getByText('Your institution, at a glance').waitFor();
      await wait(2800);
    });

    await step('1.2', 'Start a Diploma-to-Degree conversion application', async () => {
      await caption('Institution', 'New application: 22 application types configured from the Approval Process Handbook');
      await click(page.getByRole('link', { name: 'New application', exact: true }).first());
      const search = page.getByRole('combobox', { name: 'Search application types' });
      await click(search);
      await wait(900);
      await search.pressSequentially('Diploma-to-Degree', { delay: 25 });
      await click(page.getByRole('option').filter({ hasText: 'Diploma-to-Degree / Degree-to-Diploma Conversion' }));
      await choose(page.locator('#subtype'), 'DIPLOMA_TO_DEGREE');
      await caption('Institution', 'Choosing the type loads only the fields and documents this application needs');
      await click(page.getByRole('button', { name: 'Continue to required information' }), 900);
    });

    await step('1.3', 'Fill every required field', async () => {
      await caption('Institution', 'Filling the required information');
      await choose(page.locator('#f-academicYear'), '2025-26');
      await choose(page.locator('#f-onRejectionChoice'), 'EOA');
      await type(page.locator('#f-authorisedSignatoryName'), 'Dr. Rajesh Kumar');
      await choose(page.locator('#f-authorisedSignatoryDesignation'), 'CHAIRMAN');
      await type(page.locator('#f-affiliatingBody'), 'Savitribai Phule Pune University');
      await type(page.locator('#f-yearsInExistence'), '22');
      await click(page.getByRole('button', { name: 'Add course' }));
      await type(page.getByLabel('Row 1 programme'), 'Engineering & Technology');
      await type(page.getByLabel('Row 1 level'), 'Diploma');
      await type(page.getByLabel('Row 1 course'), 'Computer Engineering');
      await type(page.getByLabel('Row 1 current intake'), '60');
      await type(page.getByLabel('Row 1 proposed intake'), '60');
      await type(page.locator('#f-nocReference'), 'SPPU/NOC/2025/4521');
      await fill(page.locator('#f-resolutionDate'), '2025-09-15');
      await wait(700);
      await click(page.getByRole('button', { name: 'Continue to documents' }), 900);
      appId = page.url().match(/applications\/([0-9a-f-]{36})/)?.[1] ?? '';
      if (!appId) throw new Error('Draft id not found in the URL');
      return `Draft ${appId}`;
    });

    const upload = async (file, meta) => {
      await click(page.getByRole('button', { name: 'Choose file' }).first(), 500);
      const dlg = page.getByRole('dialog');
      await dlg.locator('input[type="file"]').setInputFiles(file);
      for (const inp of await dlg.locator('input[id^="m-"]').all()) {
        const key = (await inp.getAttribute('id')).slice(2);
        if (meta[key] === undefined) continue;
        if ((await inp.getAttribute('type')) === 'date') await fill(inp, meta[key]);
        else await type(inp, meta[key]);
      }
      await click(dlg.getByRole('checkbox'));
      await click(dlg.getByRole('button', { name: 'Upload' }), 300);
      await dlg.waitFor({ state: 'detached', timeout: 20000 });
      await wait(700);
    };

    await step('1.4', 'Upload the two required documents with DSC declaration', async () => {
      await caption('Documents', 'Document checklist: Format 2 NOC and Format 3 resolution, each with a DSC declaration');
      await upload(files.noc, { issueDate: '2025-09-10', issuer: 'Savitribai Phule Pune University', referenceNumber: 'SPPU/NOC/2025/4521', signatory: 'Registrar, SPPU' });
      await upload(files.res, { issueDate: '2025-09-15', issuer: 'Demo Education Trust, Pune', referenceNumber: 'DET/RES/2025/07', signatory: 'Dr. Rajesh Kumar' });
      const docs = (await applicantApi.get(`/api/applications/${appId}`)).documents ?? [];
      if (docs.length < 2) throw new Error(`Expected 2 documents on the server, found ${docs.length}`);
      return `${docs.length} documents stored with SHA-256`;
    });

    await step('1.5', 'Run deterministic validation and submit', async () => {
      await caption('Rules engine', 'Validation runs the configured deterministic rules; no AI decides a regulatory outcome');
      await click(page.getByRole('button', { name: 'Run validation' }), 2600);
      await caption('Institution', 'Final submission requires an explicit declaration');
      await click(page.getByRole('button', { name: 'Complete application' }), 500);
      const dlg = page.getByRole('dialog');
      await click(dlg.getByRole('checkbox'));
      await click(dlg.getByRole('button', { name: 'Submit application' }), 400);
      await page.getByRole('button', { name: 'Track this application' }).waitFor({ timeout: 20000 });
      ref = (await page.locator('text=/FG-\\d{6}-\\d{6}/').first().innerText()).match(/FG-\d{6}-\d{6}/)[0];
      await caption('Institution', `Submitted. Reference ${ref} is issued and the application is locked`);
      await wait(2800);
      await click(page.getByRole('button', { name: 'Track this application' }), 1500);
      await caption('Tracking', 'Stage tracker and shared workflow history, visible to the institution');
      await wait(2500);
      return `${ref} · ${await expectStatus('SUBMITTED')}`;
    });

    // ---------------------------------------------------------------- 2. Scrutiny
    await step('2.1', 'Scrutiny official reviews the automated checks report', async () => {
      await login('scrutiny.officer', PASSWORD.official, 'The scrutiny official');
      await caption('Scrutiny', 'Review queue: every submitted application with its stage and owner');
      await click(page.getByRole('link', { name: 'Review queue' }).first(), 1200);
      const row = page.locator('tr', { hasText: ref }).first();
      await click(row.getByText(ref).first(), 1200);
      if (!page.url().includes(appId)) await page.goto(`${BASE}/official/applications/${appId}`);
      await page.getByText(ref).first().waitFor();
      const tab = page.getByRole('button', { name: 'Checks report' }).or(page.getByRole('tab', { name: 'Checks report' })).first();
      await click(tab, 800);
      await caption('Rules engine', 'Each finding cites its rule ID and a verdict: pass, fail or human review');
      await wait(3500);
    });

    await step('2.2', 'Scrutiny official issues a correction notice', async () => {
      await caption('Scrutiny', 'A deficiency is found: the official sends a reasoned correction notice');
      await click(page.getByText('Send for re-scrutiny', { exact: true }).first(), 700);
      const dlg = page.getByRole('dialog');
      for (const cb of await dlg.locator('input[type="checkbox"]').all()) if (await cb.isChecked()) await click(cb, 120);
      await click(dlg.getByRole('button', { name: /Add a deficiency you observed/ }), 400);
      await choose(dlg.locator('select[aria-label="Affected item type"]').last(), 'FIELD');
      await choose(dlg.locator('select[aria-label="Affected item"]').last(), 'nocReference');
      await type(dlg.locator('textarea').first(), 'The NOC receipt number entered does not match the number printed on the uploaded NOC.');
      await type(dlg.locator('input:not([type="checkbox"]):not([type="date"])').first(), 'Enter the NOC reference exactly as printed on the certificate.');
      await type(dlg.locator('textarea').last(), 'NOC reference mismatch; institution to correct the field.');
      await click(dlg.getByRole('button', { name: 'Send for re-scrutiny' }), 400);
      await dlg.waitFor({ state: 'detached', timeout: 20000 });
      await caption('Scrutiny', 'Notice issued. The application returns to the institution for correction');
      await wait(2200);
      return await expectStatus('DEFICIENCY_RAISED');
    });

    // ---------------------------------------------------------------- 3. Institution correction
    await step('3.1', 'Institution responds to the notice and resubmits', async () => {
      await login('applicant.demo', PASSWORD.applicant, 'The institution');
      await caption('Institution', 'The dashboard now shows an action required: respond to the correction notice');
      await wait(1800);
      await click(page.getByRole('link', { name: 'Respond to notice' }).first(), 1200);
      await page.getByText('Respond to correction notice').waitFor();
      await caption('Institution', 'Each notice item shows the explanation and the required correction');
      await wait(1500);
      await type(page.locator('#f-nocReference'), 'SPPU/NOC/2025/4521-A');
      await type(page.locator('#resp'), 'Corrected the NOC reference to match the certificate issued by SPPU.');
      await click(page.getByRole('button', { name: 'Save response' }), 1000);
      await click(page.getByRole('button', { name: 'Submit correction package' }).first(), 500);
      const dlg = page.getByRole('dialog');
      await click(dlg.getByRole('checkbox'));
      await click(dlg.getByRole('button', { name: 'Submit correction package' }), 400);
      await dlg.waitFor({ state: 'detached', timeout: 20000 });
      await caption('Institution', 'Correction package submitted to the Re-Scrutiny Committee');
      await wait(2000);
      return await expectStatus('READY_FOR_RE_SCRUTINY');
    });

    // ---------------------------------------------------------------- 4. Re-scrutiny
    await step('4.1', 'Re-scrutiny official compares the response and completes re-scrutiny', async () => {
      await login('rescrutiny.officer', PASSWORD.official, 'The re-scrutiny official');
      await caption('Re-scrutiny', 'Only the items in the notice are re-checked');
      const row = page.locator('tr', { hasText: ref }).first();
      await click(row.getByText(/Review|Open/).first(), 1200);
      await click(page.getByRole('button', { name: 'Take up' }), 1200);
      await caption('Re-scrutiny', 'Original notice and the institution response, side by side');
      await type(page.locator('#in'), 'NOC reference now matches the certificate.');
      await click(page.getByRole('button', { name: /Record: resolved/ }), 1200);
      await type(page.locator('#rn'), 'The only notice item is resolved; scrutiny is in order.');
      await choose(page.locator('#na'), 'COMPLETE_RE_SCRUTINY');
      await click(page.getByRole('button', { name: 'Submit review' }), 1500);
      return await expectStatus('SCRUTINY_COMPLETED');
    });

    await step('4.2', 'Re-scrutiny official approves the EVC handoff', async () => {
      await click(page.getByText('Full workspace').first(), 1500);
      await caption('Re-scrutiny', 'EVC eligibility is checked before the handoff; the reason is stored in the audit trail');
      const evcTab = page.getByRole('button', { name: 'EVC', exact: true }).or(page.getByRole('tab', { name: 'EVC', exact: true })).first();
      if (await evcTab.isVisible().catch(() => false)) await click(evcTab, 1500);
      await click(page.getByRole('button', { name: 'Approve EVC handoff' }), 400);
      await type(page.locator('textarea').last(), 'Re-scrutiny complete; the application is eligible for the Expert Visit Committee.');
      await click(page.getByRole('button', { name: 'Confirm', exact: true }), 1500);
      return await expectStatus('AWAITING_EVC_SCHEDULING');
    });

    // ---------------------------------------------------------------- 5. EVC scheduling
    let panel = [];
    await step('5.1', 'Regional Officer schedules the EVC and invites a valid committee', async () => {
      await login('regional.officer', PASSWORD.official, 'The Regional Officer');
      await caption('Regional Officer', 'Regional dashboard: applications, pendency and upcoming deadlines');
      await wait(2200);
      await click(page.getByRole('link', { name: /EVC schedule/ }).first(), 1500);
      const row = page.locator('tr', { hasText: ref }).first();
      await click(row.getByRole('button').or(row.getByRole('link')).last(), 1500);
      if (!page.url().includes('/schedule/')) await page.goto(`${BASE}/official/evc/schedule/${appId}`);
      await caption('EVC scheduling', `Proposing ${dd}-${mm}-${yy}, ${slot.s}–${slot.e} IST, virtual visit`);
      await fill(page.locator('#d'), slot.ymd);
      await fill(page.locator('#s'), slot.s);
      await fill(page.locator('#e'), slot.e);
      await choose(page.locator('#m'), 'ONLINE');
      await wait(1200);
      await caption('EVC scheduling', 'Fill vacant seats proposes free, verified officials who qualify for each required seat');
      await click(page.getByRole('button', { name: /Fill vacant seats/ }), 2000);
      for (const n of Object.keys(MEMBER_LOGIN)) if (await page.getByText(n, { exact: true }).first().isVisible().catch(() => false)) panel.push(n);
      if (panel.length < 3) throw new Error(`Panel shows ${panel.length} known members: ${panel.join(', ')}`);
      await caption('EVC scheduling', 'Database constraints prevent double-booking any committee member');
      await wait(2500);
      await click(page.getByRole('button', { name: /Send invitations/ }), 2500);
      await page.getByText('Invited · Awaiting').first().waitFor({ timeout: 20000 });
      return `Invited: ${panel.join(', ')}`;
    });

    // ---------------------------------------------------------------- 6. Acceptances
    for (const [i, name] of panel.entries()) {
      await step(`6.${i + 1}`, `${name} accepts the invitation`, async () => {
        await login(MEMBER_LOGIN[name], PASSWORD.official, name);
        await caption('EVC member', `${name} sees the invitation in their own portal and accepts`);
        await click(page.getByRole('link', { name: /Invitations/ }).first(), 1000);
        const card = page.locator('li, div').filter({ hasText: ref }).filter({ has: page.getByRole('button', { name: 'Accept' }) }).last();
        await click(card.getByRole('button', { name: 'Accept' }), 1200);
        await page.getByText(/You accepted the/).waitFor();
        await wait(i === 0 ? 1500 : 500);
      });
    }

    await step('7.1', 'Regional Officer confirms the visit', async () => {
      await login('regional.officer', PASSWORD.official, 'The Regional Officer');
      await page.goto(`${BASE}/official/evc/schedule/${appId}`);
      await page.getByRole('button', { name: /Confirm visit/ }).waitFor();
      await caption('EVC scheduling', 'All three members accepted; the Regional Officer confirms and the institution is notified');
      await click(page.getByRole('button', { name: /Confirm visit/ }), 2500);
      return await expectStatus('EVC_SCHEDULED');
    });

    // ---------------------------------------------------------------- 8. Visit + report
    const reporter = panel.includes('Third EVC Member') ? 'Third EVC Member' : panel[0];
    await step('8.1', 'EVC member starts the visit, records attendance and submits the report', async () => {
      await login(MEMBER_LOGIN[reporter], PASSWORD.official, reporter);
      const app = await applicantApi.get(`/api/applications/${appId}`);
      const visit = (app.evcVisits ?? []).find((v) => v.status === 'SCHEDULED') ?? app.evcVisits?.[0];
      await click(page.getByRole('link', { name: /My schedule/ }).first(), 1200);
      const open = page.getByRole('button', { name: 'Open visit' });
      if (await open.isVisible().catch(() => false)) await click(open, 1500);
      if (!page.url().includes('/official/visits/')) await page.goto(`${BASE}/official/visits/${visit.id}`);
      await caption('EVC visit', 'On the day, an accepted member starts the visit; nothing is assumed from the clock');
      await click(page.getByRole('button', { name: 'Start visit' }), 1500);
      await click(page.getByRole('button', { name: 'Present', exact: true }).first(), 600);
      await page.getByText('Attendance recorded.').waitFor();
      await caption('EVC visit', 'Attendance recorded; the signed inspection report is uploaded');
      await page.locator('input[type="file"]').first().setInputFiles(files.evc);
      await click(page.getByRole('button', { name: /Upload inspection report/ }), 1500);
      await caption('EVC report', 'Recommendation, summary for the institution and overall observations');
      const after = (label, tag) => page.locator('label', { hasText: label }).last().locator(`xpath=following::${tag}[1]`);
      await type(after(/^\s*Committee recommendation/, 'input'), 'The EVC recommends approval of the Diploma-to-Degree conversion; requirements verified on site.');
      await type(after(/^\s*Summary disclosed to the institution/, 'textarea'), 'Infrastructure, faculty and library holdings were verified; no deficiencies were noted.');
      await type(after(/^\s*Overall observations/, 'textarea'),'Committee inspected campus, laboratories, library and faculty records; infrastructure and staffing match the proposed intake.');
      const decl = page.locator('label', { hasText: 'I confirm this report records' }).locator('input[type="checkbox"]');
      if (!(await decl.isChecked())) await click(decl, 200);
      await click(page.getByRole('button', { name: 'Submit final report' }), 2000);
      await page.getByText('Final report submitted').first().waitFor({ timeout: 20000 });
      await caption('EVC report', 'Report recorded with a receipt and sent to the Regional Officer and the Regulation Bureau');
      await wait(2800);
      return await expectStatus('EVC_REPORT_SUBMITTED');
    });

    // ---------------------------------------------------------------- 9. Forward + decision
    await step('9.1', 'Regional Officer forwards the case for the authorised decision', async () => {
      await login('regional.officer', PASSWORD.official, 'The Regional Officer');
      await click(page.getByRole('link', { name: 'Review queue' }).first(), 1200);
      const row = page.locator('tr', { hasText: ref }).first();
      if (await row.isVisible().catch(() => false)) await click(row.getByText(ref).first(), 1500);
      if (!page.url().includes(appId)) await page.goto(`${BASE}/official/applications/${appId}`);
      await caption('Regional Officer', 'With the EVC report in, the case goes to the Executive Committee');
      await click(page.getByRole('button', { name: 'Forward for authorised decision' }), 2000);
      return await expectStatus('AWAITING_AUTHORISED_DECISION');
    });

    await step('9.2', 'Executive Committee records the decision with the signed letter', async () => {
      await login('ec.official', PASSWORD.official, 'The Executive Committee official');
      await page.goto(`${BASE}/official/committee/${appId}`);
      await caption('Executive Committee', 'The competent body records its decision and uploads the signed letter');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      await choose(page.locator('#dt'), 'LOA');
      await fill(page.locator('#dd'), today);
      await type(page.locator('#rn'), `AICTE/EC/${yy}/DEMO-${RUN_ID.slice(11, 19).replace(/-/g, '')}`);
      await type(page.locator('#rs'), 'Scrutiny and EVC verified all requirements for the conversion.');
      await page.locator('#df').setInputFiles(files.loa);
      await click(page.getByRole('button', { name: /Record decision/ }), 2500);
      return await expectStatus('DECISION_ISSUED');
    });

    // ---------------------------------------------------------------- 10. Close the loop
    await step('10.1', 'Institution sees the decision, history, compliance and notifications', async () => {
      await login('applicant.demo', PASSWORD.applicant, 'The institution');
      await page.goto(`${BASE}/applications/${appId}`);
      await caption('Institution', `${ref}: decision issued, with every step in the shared workflow history`);
      await wait(4000);
      await page.mouse.wheel(0, 600);
      await wait(2500);
      await click(page.getByRole('link', { name: 'Compliance' }).first(), 1500);
      await caption('Compliance', 'Undertakings, document validity and renewal obligations are tracked with reminders and escalation');
      await wait(3500);
      await click(page.getByRole('link', { name: /Notifications/ }).first(), 1500);
      await caption('Notifications', 'Every stage change produced an in-app notification for the right party');
      await wait(3500);
    }, false);

    await titleCard('Demonstrated end to end', `Application ${ref} — live portal, real data flow`, [
      'Submission with document checks and declarations',
      'Scrutiny → correction notice → institution response → re-scrutiny',
      'EVC scheduling with a valid, conflict-free committee, acceptance and confirmation',
      'EVC report, forwarding and the Executive Committee decision',
      'Deterministic, explainable rules and a complete audit trail',
    ], 7000);
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();
    const raw = video ? await video.path() : null;
    const finalStatus = appId ? await status().catch(() => 'unknown') : 'not created';
    finish({ raw, ref, appId, finalStatus, slot });
    if (server) server.kill();
  }
}

// ------------------------------------------------------------------ export + reports

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  for (const py of ['python3', 'python']) {
    try {
      const p = execFileSync(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {}
  return null;
}

function finish({ raw, ref, appId, finalStatus, slot }) {
  let mp4 = null;
  let probe = '';
  const ff = findFfmpeg();
  if (raw && ff) {
    fs.renameSync(raw, path.join(OUT, 'raw-recording.webm'));
    raw = path.join(OUT, 'raw-recording.webm');
    mp4 = path.join(OUT, 'AICTE_Approval_Portal_Demo.mp4');
    execFileSync(ff, ['-y', '-loglevel', 'error', '-i', raw, '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    const info = (f) => {
      try {
        execFileSync(ff, ['-i', f], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        return String(e.stderr).split('\n').filter((l) => /Duration|Stream/.test(l)).map((l) => l.trim()).join('\n');
      }
      return '';
    };
    probe = info(mp4);
    // Hackathon cut: the same footage sped up uniformly to the target length (default 5:00); nothing is cut out.
    const target = Number(process.env.DEMO_TARGET_SECONDS ?? '300');
    const [, h, m, s] = probe.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? [];
    const dur = h ? Number(h) * 3600 + Number(m) * 60 + Number(s) : 0;
    if (dur > target + 5) {
      const factor = (dur / (target - 2)).toFixed(3);
      const cut = path.join(OUT, `AICTE_Approval_Portal_Demo_${Math.round(target / 60)}min.mp4`);
      execFileSync(ff, ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `setpts=PTS/${factor}`, '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', cut]);
      probe += `\n\n${path.basename(cut)} (${factor}× speed):\n${info(cut)}`;
    }
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  const ok = failed.length === 0 && finalStatus === 'DECISION_ISSUED';
  const report = { runId: RUN_ID, ok, application: { ref, appId, finalStatus }, evcSlot: slot, video: mp4 ? path.relative(ROOT, mp4) : null, videoProbe: probe, steps: results, captions: timeline };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    `# Demo run ${RUN_ID}`,
    '',
    `**Overall: ${ok ? 'PASS' : 'FAIL'}** — application ${ref || '(none)'} ended in status \`${finalStatus}\`.`,
    '',
    `Video: ${mp4 ? '`' + path.basename(mp4) + '`' : 'not produced'}${probe ? '\n\n```\n' + probe + '\n```' : ''}`,
    '',
    '| Step | What happened | Result | Observed | Time |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${String(r.observed).replace(/\|/g, '/')} | ${mmss(r.start)}–${mmss(r.end)} |`),
    '',
    'Data: synthetic demo institution and seeded test accounts; nothing was reset or deleted. Each run creates one new application.',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  const script = ['# Narration script', '', `Run ${RUN_ID} · application ${ref}`, '', '| Time | Section | Narration |', '|---|---|---|', ...timeline.map((c) => `| ${mmss(c.at)} | ${c.tag} | ${c.text} |`)].join('\n');
  fs.writeFileSync(path.join(OUT, 'NARRATION.md'), script);
  console.log(`\n${ok ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.status === 'PASS').length}/${results.length} steps passed; final status ${finalStatus}`);
  console.log(`Output: ${OUT}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(`\nDemo stopped: ${e.message}`);
  process.exitCode = 1;
});
