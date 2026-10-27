/**
 * Committee desks: Executive Committee (EC), Standing Hearing Committee (SHC), Standing Appellate Committee (SAC) and
 * Council. Each desk lists only the cases formally before it and records proceedings (notes, clarification requests,
 * hearing notices, hearing records). Recommendations and decisions are recorded through the workflow actions
 * (RECORD_SHC_OUTCOME, RECORD_SAC_RECOMMENDATION, ISSUE_DECISION) so they stay authorised, transactional and audited.
 *
 * Which body holds a case (APH 2024-27):
 *   SHC     — application referred for compliance verification (Ch. II §2.23.3).
 *   EC      — decision stage with no pending appeal (Ch. I §1.10; Ch. II §2.23.3).
 *   SAC     — appeal filed / under review, or returning after a further committee it ordered (Ch. I §1.11(b)-(d); Ch. II §2.24(b)-(e)).
 *   Council — SAC recommendation recorded, awaiting the final decision (Ch. I §1.11(e); Ch. II §2.24(f)).
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { ah, audit, HttpError, requireRole, user } from '../http.ts';
import { loadAppFor, notifyInstitution, notifyRole } from '../services.ts';
import { MAX_UPLOAD_BYTES, type Storage } from '../storage.ts';
import { STATE_LABELS, type Role } from '../workflow/stateMachine.ts';
import { applicationDetail, sendFile, storeUpload } from './institution.ts';

export type Committee = 'EC' | 'SHC' | 'SAC' | 'COUNCIL';
export const COMMITTEE_OF: Partial<Record<Role, Committee>> = { EC_OFFICIAL: 'EC', SHC_MEMBER: 'SHC', SAC_MEMBER: 'SAC', COUNCIL_OFFICIAL: 'COUNCIL' };
const ROLE_OF: Record<Committee, Role> = { EC: 'EC_OFFICIAL', SHC: 'SHC_MEMBER', SAC: 'SAC_MEMBER', COUNCIL: 'COUNCIL_OFFICIAL' };
export const COMMITTEE_NAME: Record<Committee, string> = { EC: 'Executive Committee', SHC: 'Standing Hearing Committee', SAC: 'Standing Appellate Committee', COUNCIL: 'Council' };
/** Proceedings each body may record. Only clarification requests and hearing notices reach the institution. */
const KINDS: Record<Committee, string[]> = {
  EC: ['REVIEW_NOTE', 'CLARIFICATION_REQUEST'],
  SHC: ['REVIEW_NOTE', 'CLARIFICATION_REQUEST', 'HEARING_NOTICE', 'HEARING_RECORD'],
  SAC: ['REVIEW_NOTE', 'CLARIFICATION_REQUEST', 'HEARING_NOTICE', 'HEARING_RECORD'],
  COUNCIL: ['REVIEW_NOTE'],
};
const DISCLOSED = new Set(['CLARIFICATION_REQUEST', 'HEARING_NOTICE']);

/** The body that must act on an application now, or null. */
export function holder(status: string, appealStatus: string | null): Committee | null {
  if (status === 'AWAITING_COMMITTEE_REVIEW') return 'SHC';
  if (status === 'APPEAL_SUBMITTED' || status === 'APPEAL_UNDER_REVIEW') return 'SAC';
  if (status === 'AWAITING_AUTHORISED_DECISION') {
    if (!appealStatus || appealStatus === 'DECIDED') return 'EC';
    return appealStatus === 'REFERRED' ? 'SAC' : 'COUNCIL';
  }
  return null;
}
const HOLDER_SQL = `CASE
  WHEN a.status = 'AWAITING_COMMITTEE_REVIEW' THEN 'SHC'
  WHEN a.status IN ('APPEAL_SUBMITTED','APPEAL_UNDER_REVIEW') THEN 'SAC'
  WHEN a.status = 'AWAITING_AUTHORISED_DECISION' AND (p.status IS NULL OR p.status = 'DECIDED') THEN 'EC'
  WHEN a.status = 'AWAITING_AUTHORISED_DECISION' AND p.status = 'REFERRED' THEN 'SAC'
  WHEN a.status = 'AWAITING_AUTHORISED_DECISION' THEN 'COUNCIL' END`;

const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

export function committeeRouter(db: Db, storage: Storage) {
  const r = Router();
  const desk = requireRole('EC_OFFICIAL', 'SHC_MEMBER', 'SAC_MEMBER', 'COUNCIL_OFFICIAL');
  const committeeOf = (role: Role) => COMMITTEE_OF[role]!;

  /** Cases before this body now, plus those it has already handled (its own recorded actions). */
  r.get(
    '/queue',
    desk,
    ah(async (req, res) => {
      const u = user(req);
      const c = committeeOf(u.activeRole);
      const rows = await db.query<Record<string, any>>(
        `SELECT a.id, a.reference_no, a.category_code, a.status, a.academic_year, a.submitted_at, i.name AS institution_name, i.state, i.district,
                ${HOLDER_SQL} AS holder,
                (SELECT max(e.created_at) FROM workflow_events e WHERE e.application_id = a.id) AS since,
                p.reference_no AS appeal_ref, p.status AS appeal_status, p.submitted_at AS appeal_submitted_at, p.deadline_at AS appeal_deadline,
                (SELECT count(*)::int FROM deficiencies d WHERE d.application_id = a.id AND d.status NOT IN ('DRAFT','WITHDRAWN','RESOLVED')) AS open_deficiencies,
                (SELECT count(*)::int FROM evc_reports r WHERE r.application_id = a.id) AS evc_reports,
                (SELECT c.outcome FROM committee_reviews c WHERE c.application_id = a.id AND c.committee = 'SHC' ORDER BY c.recorded_at DESC LIMIT 1) AS shc_outcome,
                (SELECT c.outcome FROM committee_reviews c WHERE c.application_id = a.id AND c.committee = 'SAC' ORDER BY c.recorded_at DESC LIMIT 1) AS sac_outcome,
                (SELECT d.decision_type || ' · ' || d.decision_body FROM decisions d WHERE d.application_id = a.id ORDER BY d.uploaded_at DESC LIMIT 1) AS last_decision,
                (SELECT max(x.hearing_at) FROM committee_proceedings x WHERE x.application_id = a.id AND x.committee = $1 AND x.kind = 'HEARING_NOTICE') AS hearing_at,
                (SELECT max(x.created_at) FROM committee_proceedings x WHERE x.application_id = a.id AND x.committee = $1 AND x.kind = 'CLARIFICATION_REQUEST') AS clarification_at,
                (SELECT max(s.submitted_at) FROM committee_submissions s WHERE s.application_id = a.id) AS last_submission_at,
                EXISTS (SELECT 1 FROM workflow_events e WHERE e.application_id = a.id AND e.actor_id = $2) AS handled_by_me
         FROM applications a JOIN institutions i ON i.id = a.institution_id LEFT JOIN appeals p ON p.application_id = a.id
         WHERE (${HOLDER_SQL}) = $1
            OR EXISTS (SELECT 1 FROM workflow_events e WHERE e.application_id = a.id AND e.actor_role = $3)
            OR EXISTS (SELECT 1 FROM committee_proceedings x WHERE x.application_id = a.id AND x.committee = $1)
         ORDER BY since DESC NULLS LAST`,
        [c, u.id, ROLE_OF[c]],
      );
      const out = rows.map((x): Record<string, any> => ({
        ...x,
        statusLabel: STATE_LABELS[x.status as keyof typeof STATE_LABELS],
        pending: x.holder === c,
        awaitingInstitution: !!x.clarification_at && (!x.last_submission_at || new Date(x.last_submission_at) < new Date(x.clarification_at)),
      }));
      const now = Date.now();
      res.json({
        committee: c,
        name: COMMITTEE_NAME[c],
        cases: out,
        kpis: {
          pending: out.filter((x) => x.pending).length,
          awaitingInstitution: out.filter((x) => x.pending && x.awaitingInstitution).length,
          hearingsUpcoming: out.filter((x) => x.pending && x.hearing_at && new Date(x.hearing_at).getTime() > now).length,
          handled: out.filter((x) => !x.pending).length,
        },
      });
    }),
  );

  /** The case file: application, findings, reports, recommendations, decisions, proceedings, submissions and history. */
  r.get(
    '/applications/:id',
    desk,
    ah(async (req, res) => {
      const u = user(req);
      const c = committeeOf(u.activeRole);
      const app = await loadAppFor(db, u, req.params.id, req);
      // None of these four depend on each other's results, so run concurrently rather than paying
      // four serial round trips.
      const [appeal, inst, detail, evidence] = await Promise.all([
        db.one<{ status: string }>('SELECT status FROM appeals WHERE application_id = $1', [app.id]),
        db.one('SELECT name, aicte_institution_id, address, district, state, region_code FROM institutions WHERE id = $1', [app.institution_id]),
        applicationDetail(db, app, { official: true }),
        db.query(
          'SELECT x.id, x.visit_id, x.report_id, x.category, x.file_name, x.mime_type, x.note, x.uploaded_at FROM evc_report_evidence x WHERE x.application_id = $1 AND x.report_id IS NOT NULL ORDER BY x.uploaded_at',
          [app.id],
        ),
      ]);
      const h = holder(app.status, appeal?.status ?? null);
      res.json({
        ...detail,
        institution: inst,
        committee: c,
        committeeName: COMMITTEE_NAME[c],
        holder: h,
        holderName: h ? COMMITTEE_NAME[h] : null,
        canAct: h === c,
        allowedKinds: h === c ? KINDS[c] : [],
        evcEvidence: evidence,
      });
    }),
  );

  /** Records a proceeding. Disclosed kinds notify the institution and appear on its timeline. */
  r.post(
    '/applications/:id/proceedings',
    desk,
    ah(async (req, res) => {
      const u = user(req);
      const c = committeeOf(u.activeRole);
      const b = z
        .object({
          kind: z.enum(['REVIEW_NOTE', 'CLARIFICATION_REQUEST', 'HEARING_NOTICE', 'HEARING_RECORD']),
          body: z.string().trim().min(5).max(8000),
          hearingAt: z.string().datetime({ offset: true }).optional(),
          hearingMode: z.enum(['ONLINE', 'PHYSICAL']).optional(),
          hearingVenue: z.string().trim().max(400).optional(),
        })
        .parse(req.body);
      const app = await loadAppFor(db, u, req.params.id, req);
      const appeal = await db.one<{ status: string }>('SELECT status FROM appeals WHERE application_id = $1', [app.id]);
      if (holder(app.status, appeal?.status ?? null) !== c) throw new HttpError(409, 'NOT_BEFORE_COMMITTEE', `This case is not before the ${COMMITTEE_NAME[c]} now.`);
      if (!KINDS[c].includes(b.kind)) throw new HttpError(400, 'KIND_NOT_ALLOWED', `The ${COMMITTEE_NAME[c]} does not record ${b.kind.replace(/_/g, ' ').toLowerCase()}s here.`);
      if (b.kind === 'HEARING_NOTICE' && (!b.hearingAt || !b.hearingMode)) throw new HttpError(400, 'HEARING_DETAILS_REQUIRED', 'A hearing notice needs the date, time and mode.');
      if (b.kind === 'HEARING_NOTICE' && new Date(b.hearingAt!).getTime() <= Date.now()) throw new HttpError(400, 'HEARING_IN_PAST', 'The hearing must be in the future.');
      const disclosed = DISCLOSED.has(b.kind);
      const row = await db.tx(async (t) => {
        const p = await t.one<{ id: string; created_at: string }>(
          `INSERT INTO committee_proceedings(application_id, committee, kind, body, hearing_at, hearing_mode, hearing_venue, disclosed, application_status, created_by, created_role)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
          [app.id, c, b.kind, b.body, b.hearingAt ?? null, b.hearingMode ?? null, b.hearingVenue ?? null, disclosed, app.status, u.id, u.activeRole],
        );
        if (b.kind === 'CLARIFICATION_REQUEST')
          await notifyInstitution(t, app, 'COMMITTEE_CLARIFICATION', `${COMMITTEE_NAME[c]} requests clarification: ${app.reference_no}`, b.body, `proc:${p!.id}`);
        if (b.kind === 'HEARING_NOTICE') {
          const when = new Date(b.hearingAt!).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
          await notifyInstitution(t, app, 'HEARING_NOTICE', `${COMMITTEE_NAME[c]} hearing on ${when} IST: ${app.reference_no}`, `${b.body}${b.hearingVenue ? ` · ${b.hearingVenue}` : ''}`, `proc:${p!.id}`);
        }
        return p;
      });
      await audit(db, req, `COMMITTEE_${b.kind}`, 'application', app.id, { committee: c, proceedingId: row!.id, disclosed }, app.institution_id);
      res.status(201).json({ proceeding: { ...row, kind: b.kind, disclosed } });
    }),
  );

  /** The supporting document filed with the appeal. */
  r.get(
    '/applications/:id/appeal-document',
    requireRole('SAC_MEMBER', 'COUNCIL_OFFICIAL', 'EC_OFFICIAL', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (req, res) => {
      const app = await loadAppFor(db, user(req), req.params.id, req);
      const p = await db.one<{ supporting_storage_key: string | null; supporting_name: string | null }>('SELECT supporting_storage_key, supporting_name FROM appeals WHERE application_id = $1', [app.id]);
      if (!p?.supporting_storage_key) throw new HttpError(404, 'NOT_FOUND', 'No supporting document was filed with the appeal.');
      await audit(db, req, 'APPEAL_DOCUMENT_DOWNLOADED', 'application', app.id, {}, app.institution_id);
      sendFile(res, await storage.read(p.supporting_storage_key), p.supporting_name ?? 'appeal.pdf', p.supporting_storage_key.endsWith('.pdf') ? 'application/pdf' : p.supporting_storage_key.endsWith('.png') ? 'image/png' : 'image/jpeg', req.query.inline === '1');
    }),
  );

  /** Downloads a file the institution placed before a committee (committee desks and oversight roles). */
  r.get(
    '/submissions/:id/download',
    requireRole('EC_OFFICIAL', 'SHC_MEMBER', 'SAC_MEMBER', 'COUNCIL_OFFICIAL', 'SUPERVISOR', 'REGULATION_BUREAU', 'INSTITUTION_APPLICANT'),
    ah(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      const s = await db.one<{ application_id: string; storage_key: string | null; file_name: string; mime_type: string }>('SELECT application_id, storage_key, file_name, mime_type FROM committee_submissions WHERE id = $1', [req.params.id]);
      if (!s?.storage_key) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      await loadAppFor(db, user(req), s.application_id, req);
      await audit(db, req, 'COMMITTEE_SUBMISSION_DOWNLOADED', 'committee_submission', req.params.id, {});
      sendFile(res, await storage.read(s.storage_key), s.file_name, s.mime_type, req.query.inline === '1');
    }),
  );

  return r;
}

/**
 * Institution side: places compliance / supporting material before the body that holds the case — the SHC (Ch. II
 * §2.23.3), the SAC (Ch. I §1.11(c); Ch. II §2.24(c)), or the EC when it has asked for clarification.
 */
export function committeeSubmissionRouter(db: Db, storage: Storage) {
  const r = Router();
  r.post(
    '/applications/:id/committee-submissions',
    requireRole('INSTITUTION_APPLICANT'),
    evidenceUpload.single('file'),
    ah(async (req, res) => {
      const u = user(req);
      const app = await loadAppFor(db, u, req.params.id, req);
      const b = z.object({ note: z.string().trim().min(5).max(4000), respondsTo: z.string().uuid().optional() }).parse(req.body ?? {});
      const appeal = await db.one<{ status: string }>('SELECT status FROM appeals WHERE application_id = $1', [app.id]);
      const h = holder(app.status, appeal?.status ?? null);
      const openClarification = h
        ? await db.one<{ id: string }>("SELECT id FROM committee_proceedings WHERE application_id = $1 AND committee = $2 AND kind = 'CLARIFICATION_REQUEST' ORDER BY created_at DESC LIMIT 1", [app.id, h])
        : null;
      if (!h || h === 'COUNCIL' || (h === 'EC' && !openClarification))
        throw new HttpError(409, 'NO_COMMITTEE_SUBMISSION', 'Submissions to a committee are accepted while the SHC or SAC holds the case, or when the Executive Committee has asked for clarification.');
      if (b.respondsTo) {
        const p = await db.one('SELECT 1 FROM committee_proceedings WHERE id = $1 AND application_id = $2 AND disclosed', [b.respondsTo, app.id]);
        if (!p) throw new HttpError(404, 'NOT_FOUND', 'Request not found.');
      }
      const f = req.file ? await storeUpload(storage, req.file) : null;
      const row = await db.tx(async (t) => {
        const s = await t.one<{ id: string; submitted_at: string }>(
          `INSERT INTO committee_submissions(application_id, committee, responds_to, note, file_name, mime_type, size_bytes, sha256, storage_key, submitted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, submitted_at`,
          [app.id, h, b.respondsTo ?? openClarification?.id ?? null, b.note, f?.name ?? null, f?.mime ?? null, req.file?.size ?? null, f?.sha256 ?? null, f?.key ?? null, u.id],
        );
        await notifyRole(t, ROLE_OF[h], app.id, 'COMMITTEE_SUBMISSION', `Submission from the institution: ${app.reference_no}`, b.note.slice(0, 300));
        await notifyInstitution(t, app, 'COMMITTEE_SUBMISSION_RECEIVED', `Submission received by the ${COMMITTEE_NAME[h]}: ${app.reference_no}`, `Your submission of ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST was recorded.`, `csub:${s!.id}`);
        return s;
      });
      await audit(db, req, 'COMMITTEE_SUBMISSION', 'application', app.id, { committee: h, sha256: f?.sha256 ?? null }, app.institution_id);
      res.status(201).json({ submission: { ...row, committee: h } });
    }),
  );
  return r;
}

