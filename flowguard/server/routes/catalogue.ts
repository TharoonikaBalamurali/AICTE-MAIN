import { Router } from 'express';
import { CATEGORIES, getCategory } from '../catalogue/categories.ts';
import { DISCREPANCIES } from '../catalogue/discrepancies.ts';
import { ah, HttpError } from '../http.ts';
import { RULESET_VERSION } from '../rules/ruleset.ts';
import { ROLE_LABELS, routeStages, STATE_LABELS } from '../workflow/stateMachine.ts';

export function catalogueRouter() {
  const r = Router();
  r.get('/categories', (_req, res) => {
    res.json({
      rulesetVersion: RULESET_VERSION,
      categories: CATEGORIES.map((c) => ({
        code: c.code,
        menuNumber: c.menuNumber,
        title: c.title,
        shortTitle: c.shortTitle,
        keywords: c.keywords,
        aphReferences: c.aphReferences,
        summary: c.summary,
        subtypes: c.subtypes ?? [],
        subtypeLabel: c.subtypeLabel ?? null,
        route: c.route,
        stages: routeStages(c.route),
        fieldCount: c.fields.length,
        mandatoryFieldCount: c.fields.filter((f) => f.required).length,
        documentCount: c.documents.length,
        mandatoryDocumentCount: c.documents.filter((d) => d.level === 'MANDATORY').length,
        conditionalDocumentCount: c.documents.filter((d) => d.level === 'CONDITIONAL').length,
        submissionEnabled: c.submissionEnabled,
        verificationStatus: c.verificationStatus,
        verificationNotes: c.verificationNotes,
      })),
    });
  });
  r.get(
    '/categories/:code',
    ah(async (req, res) => {
      const c = getCategory(req.params.code);
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'Unknown category.');
      res.json({ category: { ...c, stages: routeStages(c.route) }, rulesetVersion: RULESET_VERSION });
    }),
  );
  r.get('/discrepancies', (_req, res) => res.json({ discrepancies: DISCREPANCIES }));
  r.get('/meta', (_req, res) => res.json({ states: STATE_LABELS, roles: ROLE_LABELS, rulesetVersion: RULESET_VERSION }));
  return r;
}
