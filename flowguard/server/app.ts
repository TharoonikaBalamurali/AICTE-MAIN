import cookieParser from 'cookie-parser';
import express, { type Request } from 'express';
import { authRouter, requireAuth, sessionMiddleware } from './auth.ts';
import type { Db } from './db/index.ts';
import { errorHandler, HttpError, makeLogger, rateLimit } from './http.ts';
import { catalogueRouter } from './routes/catalogue.ts';
import { institutionRouter, sharedRouter } from './routes/institution.ts';
import { officialRouter, rulesRouter } from './routes/official.ts';
import { evcRouter } from './routes/evc.ts';
import { schedulerRouter } from './routes/scheduler.ts';
import { bureauRouter } from './routes/bureau.ts';
import { committeeRouter, committeeSubmissionRouter } from './routes/committee.ts';
import { regionRouter } from './routes/region.ts';
import { reportsRouter } from './routes/reports.ts';
import { inspectionRouter } from './routes/inspection.ts';
import type { Storage } from './storage.ts';

export interface AppOptions {
  db: Db;
  storage: Storage;
  secureCookies?: boolean;
  silent?: boolean;
  /** Per-IP login attempts per minute (default 20). */
  loginsPerMinute?: number;
}

export function createApp({ db, storage, secureCookies = false, silent = false, loginsPerMinute }: AppOptions) {
  const log = makeLogger(silent);
  const app = express();
  app.disable('x-powered-by');
  // Behind a hosting proxy, req.ip (used by the rate limits) must come from X-Forwarded-For; set TRUST_PROXY to the hop count (e.g. 1).
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', !tp ? 'loopback' : /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  // Never serve server code, tests, data, configuration or dotfiles through the web server (incl. the dev UI server).
  app.use((req, _res, next) => {
    const p = decodeURIComponent(req.path);
    // The browser wizard shares the pure condition evaluator with the server (no secrets, no I/O).
    if (p === '/server/rules/conditions.ts') return next();
    if (/^\/(server|tests|data|supabase|scripts|\.claude)(\/|$)/i.test(p) || /^\/\.[^/]*$/.test(p) || /^\/\.env/i.test(p) || /^\/(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.ts|vitest\.config\.ts|README\.md)$/i.test(p))
      return next(new HttpError(404, 'NOT_FOUND', 'Not found.'));
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  const api = express.Router();
  // CSRF defence for cookie auth: state-changing requests must come from our own origin (SameSite=strict also applies).
  api.use((req: Request, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return next(new HttpError(403, 'BAD_ORIGIN', 'Cross-origin request rejected.'));
    }
    next();
  });
  api.use(rateLimit({ windowMs: 60_000, max: 600 }));
  api.use(sessionMiddleware(db));
  api.get('/health', async (_req, res) => {
    await db.one('SELECT 1 AS ok');
    res.json({ status: 'ok', database: db.kind, time: new Date().toISOString() });
  });
  api.use('/auth', authRouter(db, { secureCookies, loginsPerMinute }));
  api.use(catalogueRouter());
  api.use(requireAuth);
  api.use(sharedRouter(db, storage));
  api.use('/rules', rulesRouter(db));
  api.use('/official', officialRouter(db, storage));
  api.use('/evc/scheduler', schedulerRouter(db));
  api.use('/evc', evcRouter(db, storage));
  api.use('/bureau', bureauRouter(db));
  api.use('/committee', committeeRouter(db, storage));
  api.use('/region', regionRouter(db));
  api.use(inspectionRouter(db, storage));
  api.use(committeeSubmissionRouter(db, storage));
  api.use('/reports', reportsRouter(db));
  api.use(institutionRouter(db, storage));
  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Unknown API endpoint.')));

  app.use('/api', (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => log('request', { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - start, user: req.user?.loginId }));
    next();
  });
  app.use('/api', api);
  app.use(errorHandler(log));
  return { app, log };
}
