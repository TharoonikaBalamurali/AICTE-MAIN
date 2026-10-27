/**
 * Regional oversight: every submitted application in the caller's regions (Regional Officer) or in all regions
 * (Supervisor, Regulation Bureau) — stage, status, who applied, monthly flow, upcoming deadlines and decisions.
 * Read-only; drafts are excluded (they are the institution's own work until submitted).
 */
import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES } from '../catalogue/categories.ts';
import type { Db } from '../db/index.ts';
import { ah, requireRole, user } from '../http.ts';
import { VISIBLE_STATES } from '../services.ts';
import { pendingActor, STATE_LABELS, stageOf, type AppState } from '../workflow/stateMachine.ts';

const STAGE_LABEL: Record<string, string> = {
  SUBMITTED: 'Submitted',
  SCRUTINY: 'Scrutiny & correction',
  EVC: 'Expert visit',
  SHC: 'Standing Hearing Committee',
  DECISION: 'Decision',
  APPEAL: 'Appeal',
  CLOSED: 'Closed',
};

export function regionRouter(db: Db) {
  const r = Router();
  r.get(
    '/overview',
    requireRole('REGIONAL_OFFICER', 'SUPERVISOR', 'REGULATION_BUREAU'),
    ah(async (req, res) => {
      const u = user(req);
      const q = z.object({ cycle: z.string().max(20).optional() }).parse(req.query);
      const scoped = u.activeRole === 'REGIONAL_OFFICER';
      const scopeUser = scoped ? u.id : null;
      // $1 = cycle (academic year) or null, $2 = Regional Officer id or null (all regions).
      const SCOPE = `a.status <> 'DRAFT' AND ($1::text IS NULL OR a.academic_year = $1)
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM institutions ri JOIN user_regions ur ON ur.region_code = ri.region_code WHERE ri.id = a.institution_id AND ur.user_id = $2))`;
      const params = [q.cycle || null, scopeUser];

      // None of these seven queries depend on each other's results, so they run concurrently
      // rather than paying seven serial round trips — each costs real latency against a remote
      // (e.g. Supabase) database.
      const [regions, cyclesRows, rows, monthly, deadlines, institutions, evc] = await Promise.all([
        scoped
          ? db.query<{ code: string; name: string }>('SELECT g.code, g.name FROM regions g JOIN user_regions ur ON ur.region_code = g.code WHERE ur.user_id = $1 ORDER BY g.name', [u.id])
          : db.query<{ code: string; name: string }>('SELECT code, name FROM regions ORDER BY name'),
        db.query<{ y: string }>(
          `SELECT DISTINCT a.academic_year AS y FROM applications a
           WHERE a.academic_year IS NOT NULL AND a.status <> 'DRAFT'
             AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM institutions ri JOIN user_regions ur ON ur.region_code = ri.region_code WHERE ri.id = a.institution_id AND ur.user_id = $1))
           ORDER BY 1 DESC`,
          [scopeUser],
        ),
        db.query<Record<string, any>>(
          `SELECT a.id, a.reference_no, a.category_code, a.subtype, a.academic_year, a.status, a.submitted_at, a.updated_at, a.applicant_name, a.applicant_designation,
                  i.name AS institution_name, i.aicte_institution_id, i.district, i.state, i.region_code, sb.full_name AS submitted_by_name,
                  (SELECT max(e.created_at) FROM workflow_events e WHERE e.application_id = a.id) AS stage_since,
                  (SELECT d.decision_type FROM decisions d WHERE d.application_id = a.id ORDER BY d.uploaded_at DESC LIMIT 1) AS decision_type,
                  (SELECT min(df.deadline)::text FROM deficiencies df WHERE df.application_id = a.id AND df.status = 'OPEN' AND df.deadline IS NOT NULL) AS correction_due,
                  (SELECT count(*)::int FROM assignments s WHERE s.application_id = a.id AND s.active) AS assigned
           FROM applications a JOIN institutions i ON i.id = a.institution_id LEFT JOIN users sb ON sb.id = a.submitted_by
           WHERE ${SCOPE} ORDER BY a.submitted_at DESC`,
          params,
        ),
        db.query<{ month: string; submitted: number; decided: number }>(
          `WITH months AS (SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')) - (g || ' months')::interval, 'YYYY-MM') AS month FROM generate_series(0, 11) g)
           SELECT m.month,
                  (SELECT count(*)::int FROM applications a WHERE ${SCOPE} AND to_char(a.submitted_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = m.month) AS submitted,
                  (SELECT count(*)::int FROM decisions d JOIN applications a ON a.id = d.application_id WHERE ${SCOPE} AND to_char(d.uploaded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = m.month) AS decided
           FROM months m ORDER BY m.month`,
          params,
        ),
        // Upcoming dates from real records only: correction response deadlines, EVC follow-up deadlines, compliance due dates.
        db.query<Record<string, any>>(
          `(SELECT 'CORRECTION' AS kind, 'Correction response due' AS title, a.id AS application_id, a.reference_no, i.name AS institution_name, (df.deadline::timestamp AT TIME ZONE 'Asia/Kolkata') AS due_at, df.deadline_type AS source
             FROM deficiencies df JOIN applications a ON a.id = df.application_id JOIN institutions i ON i.id = a.institution_id
             WHERE df.status = 'OPEN' AND df.deadline IS NOT NULL AND df.deadline >= (now() AT TIME ZONE 'Asia/Kolkata')::date AND ${SCOPE})
           UNION ALL
           (SELECT 'EVC', replace(initcap(replace(dl.subject_type, '_', ' ')), 'Evc', 'EVC'), a.id, a.reference_no, i.name, dl.due_at, dl.source_type
             FROM deadlines dl JOIN applications a ON a.id = dl.application_id JOIN institutions i ON i.id = a.institution_id
             WHERE dl.status IN ('OPEN','OVERDUE') AND dl.due_at >= now() AND ${SCOPE})
           UNION ALL
           (SELECT 'COMPLIANCE', o.title, a.id, a.reference_no, i.name, (o.due_date::timestamp AT TIME ZONE 'Asia/Kolkata'), o.aph_reference
             FROM compliance_obligations o JOIN applications a ON a.id = o.application_id JOIN institutions i ON i.id = a.institution_id
             WHERE o.due_date IS NOT NULL AND o.due_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date AND o.status NOT IN ('ACCEPTED_BY_AUTHORISED_REVIEWER','COMPLETED') AND ${SCOPE})
           ORDER BY due_at LIMIT 6`,
          params,
        ),
        db.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM institutions i WHERE $1::uuid IS NULL OR EXISTS (SELECT 1 FROM user_regions ur WHERE ur.region_code = i.region_code AND ur.user_id = $1)`,
          [scopeUser],
        ),
        db.one<{ proposed: number; scheduled: number }>(
          `SELECT count(*) FILTER (WHERE v.status = 'PROPOSED')::int AS proposed, count(*) FILTER (WHERE v.status IN ('SCHEDULED','RESCHEDULED','IN_PROGRESS'))::int AS scheduled
           FROM evc_visits v JOIN applications a ON a.id = v.application_id WHERE ${SCOPE}`,
          params,
        ),
      ]);
      const cycles = cyclesRows.map((x) => x.y);
      const now = Date.now();
      const canSeeAll = !scoped;
      const applications = rows.map((a): Record<string, any> => {
        const status = a.status as AppState;
        return {
          ...a,
          categoryTitle: CATEGORIES.find((c) => c.code === a.category_code)?.title ?? a.category_code,
          statusLabel: STATE_LABELS[status],
          stage: stageOf(status),
          stageLabel: STAGE_LABEL[stageOf(status)] ?? stageOf(status),
          pendingWith: pendingActor(status),
          daysAtStage: a.stage_since ? Math.floor((now - new Date(a.stage_since).getTime()) / 86400000) : null,
          // Regional Officers open applications at the stages they handle; the overview itself shows every stage.
          canOpen: canSeeAll || (VISIBLE_STATES.REGIONAL_OFFICER ?? []).includes(status),
        };
      });

      const decided = applications.filter((a) => ['DECISION_ISSUED', 'CLOSED'].includes(a.status));
      const stages = Object.entries(
        applications.reduce<Record<string, number>>((m, a) => ((m[a.stage] = (m[a.stage] ?? 0) + 1), m), {}),
      ).map(([stage, n]) => ({ stage, label: STAGE_LABEL[stage] ?? stage, n }));

      res.json({
        scope: { regions, allRegions: canSeeAll },
        cycles,
        cycle: q.cycle || null,
        kpis: {
          institutions: institutions?.n ?? 0,
          submitted: applications.length,
          active: applications.length - decided.length,
          withOfficials: applications.filter((a) => a.pendingWith === 'OFFICIAL').length,
          awaitingInstitution: applications.filter((a) => a.pendingWith === 'APPLICANT').length,
          decided: decided.length,
          approvals: decided.filter((a) => ['LOA', 'EOA'].includes(a.decision_type)).length,
          unassigned: applications.filter((a) => a.pendingWith === 'OFFICIAL' && !a.assigned && ['SUBMITTED', 'UNDER_SCRUTINY', 'READY_FOR_RE_SCRUTINY', 'UNDER_RE_SCRUTINY'].includes(a.status)).length,
          visitsProposed: evc?.proposed ?? 0,
          visitsScheduled: evc?.scheduled ?? 0,
        },
        stages,
        decisionMix: Object.entries(decided.reduce<Record<string, number>>((m, a) => ((m[a.decision_type ?? 'OTHER'] = (m[a.decision_type ?? 'OTHER'] ?? 0) + 1), m), {})).map(([type, n]) => ({ type, n })),
        monthly,
        deadlines,
        applications: applications.map(({ stage_since: _s, assigned: _a, ...rest }) => rest),
      });
    }),
  );
  return r;
}
