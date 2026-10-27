/**
 * Consolidated pendency report with filters and CSV export.
 * Data minimisation: no personal contact details, no document contents. Regional Officers see only their regions.
 * Every export is recorded in the audit log.
 */
import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES } from '../catalogue/categories.ts';
import type { Db } from '../db/index.ts';
import { ah, audit, requireRole, user } from '../http.ts';
import { REGION_SCOPE_SQL } from '../services.ts';
import { STATE_LABELS, stageOf, type AppState } from '../workflow/stateMachine.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function reportsRouter(db: Db) {
  const r = Router();
  r.use(requireRole('SUPERVISOR', 'REGULATION_BUREAU', 'REGIONAL_OFFICER', 'DECISION_AUTHORITY'));

  r.get(
    '/pendency',
    ah(async (req, res) => {
      const u = user(req);
      const q = z
        .object({
          from: dateStr.optional(),
          to: dateStr.optional(),
          region: z.string().max(40).optional(),
          category: z.string().max(60).optional(),
          stage: z.string().max(40).optional(),
          assignee: z.string().uuid().optional(),
          evcStatus: z.string().max(40).optional(),
          complianceStatus: z.enum(['ANY_OPEN', 'OVERDUE', 'NONE']).optional(),
          overdue: z.enum(['true', 'false']).optional(),
          format: z.enum(['json', 'csv']).optional(),
        })
        .parse(req.query);
      const rows = await db.query<Record<string, any>>(
        `WITH base AS (
           SELECT a.id, a.reference_no, a.category_code, a.status, a.submitted_at, i.aicte_institution_id, i.name AS institution_name, i.region_code,
                  coalesce((SELECT max(w.created_at) FROM workflow_events w WHERE w.application_id = a.id), a.submitted_at) AS stage_entered_at,
                  (SELECT string_agg(uu.full_name || ' (' || s.role || ')', '; ') FROM assignments s JOIN users uu ON uu.id = s.user_id WHERE s.application_id = a.id AND s.active) AS assigned,
                  (SELECT v.status FROM evc_visits v WHERE v.application_id = a.id AND v.status <> 'CANCELLED' ORDER BY v.scheduled_at DESC LIMIT 1) AS evc_status,
                  (SELECT max(rp.version) FROM evc_reports rp WHERE rp.application_id = a.id) AS evc_report_version,
                  (SELECT count(*)::int FROM deficiencies d WHERE d.application_id = a.id AND d.status IN ('OPEN','RESPONDED','UNRESOLVED','PARTIALLY_RESOLVED')) AS open_items,
                  (SELECT min(x.due_at) FROM deadline_register x WHERE x.application_id = a.id AND x.status = 'OPEN') AS next_due_at,
                  (SELECT count(*)::int FROM deadline_register x WHERE x.application_id = a.id AND x.status = 'OPEN' AND x.due_at < now()) AS overdue_count,
                  (SELECT count(*)::int FROM compliance_obligations o WHERE o.application_id = a.id AND o.status NOT IN ('ACCEPTED_BY_AUTHORISED_REVIEWER')) AS compliance_open,
                  (SELECT count(*)::int FROM compliance_obligations o WHERE o.application_id = a.id AND o.status IN ('OPEN','DEFICIENT') AND o.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date) AS compliance_overdue
           FROM applications a JOIN institutions i ON i.id = a.institution_id
           WHERE a.status <> 'DRAFT' AND ($1::boolean = false OR ${REGION_SCOPE_SQL})
             AND ($3::date IS NULL OR (a.submitted_at AT TIME ZONE 'Asia/Kolkata')::date >= $3) AND ($4::date IS NULL OR (a.submitted_at AT TIME ZONE 'Asia/Kolkata')::date <= $4)
             AND ($5::text IS NULL OR i.region_code = $5) AND ($6::text IS NULL OR a.category_code = $6) AND ($7::text IS NULL OR a.status = $7)
             AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id AND s.user_id = $8 AND s.active))
         )
         SELECT * FROM base
         WHERE ($9::text IS NULL OR evc_status = $9)
           AND ($10::text IS NULL OR ($10 = 'ANY_OPEN' AND compliance_open > 0) OR ($10 = 'OVERDUE' AND compliance_overdue > 0) OR ($10 = 'NONE' AND compliance_open = 0))
           AND ($11::boolean IS NULL OR (overdue_count > 0) = $11)
         ORDER BY stage_entered_at`,
        [
          u.activeRole === 'REGIONAL_OFFICER',
          u.id,
          q.from ?? null,
          q.to ?? null,
          q.region ?? null,
          q.category ?? null,
          q.stage ?? null,
          q.assignee ?? null,
          q.evcStatus ?? null,
          q.complianceStatus ?? null,
          q.overdue ? q.overdue === 'true' : null,
        ],
      );
      const now = Date.now();
      const out = rows.map((x) => ({
        applicationRef: x.reference_no,
        applicationId: x.id,
        institution: x.institution_name,
        aicteInstitutionId: x.aicte_institution_id,
        region: x.region_code ?? 'Not configured',
        category: CATEGORIES.find((c) => c.code === x.category_code)?.title ?? x.category_code,
        stage: STATE_LABELS[x.status as AppState],
        stageGroup: stageOf(x.status as AppState),
        submittedAt: x.submitted_at,
        stageEnteredAt: x.stage_entered_at,
        daysAtStage: Math.floor((now - new Date(x.stage_entered_at).getTime()) / 86400000),
        assigned: x.assigned ?? '',
        evcStatus: x.evc_status ?? '',
        evcReportVersion: x.evc_report_version ?? '',
        openCorrectionItems: x.open_items,
        nextDueAt: x.next_due_at,
        overdueDeadlines: x.overdue_count,
        complianceOpen: x.compliance_open,
        complianceOverdue: x.compliance_overdue,
      }));
      if (q.format === 'csv') {
        await audit(db, req, 'REPORT_EXPORTED', 'report', 'pendency', { filters: q, rows: out.length });
        const cols = Object.keys(out[0] ?? { applicationRef: '' }).filter((c) => c !== 'applicationId');
        const csv = [cols.map(csvCell).join(','), ...out.map((o) => cols.map((c) => csvCell((o as Record<string, unknown>)[c])).join(','))].join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="flowguard-pendency-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.send(`﻿${csv}`);
      }
      const regions = await db.query('SELECT code, name, is_demo FROM regions ORDER BY code');
      const summary: Record<string, { stage: string; count: number; avgDays: number; maxDays: number; overdue: number }> = {};
      for (const o of out) {
        const s = (summary[o.stage] ??= { stage: o.stage, count: 0, avgDays: 0, maxDays: 0, overdue: 0 });
        s.count++;
        s.avgDays += o.daysAtStage;
        s.maxDays = Math.max(s.maxDays, o.daysAtStage);
        if (o.overdueDeadlines > 0) s.overdue++;
      }
      res.json({
        rows: out,
        summary: Object.values(summary).map((s) => ({ ...s, avgDays: Math.round((s.avgDays / s.count) * 10) / 10 })),
        regions,
        scope: u.activeRole === 'REGIONAL_OFFICER' ? 'Your configured regions' : 'All regions',
      });
    }),
  );

  return r;
}
