/**
 * Local authentication: scrypt password hashes, opaque session tokens stored hashed,
 * HttpOnly cookies. Roles are always read from the database — never from the client.
 * (Supabase Auth integration is awaiting configuration; see README.)
 */
import crypto from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Db } from './db/index.ts';
import { ah, audit, HttpError, rateLimit, user, type AuthUser } from './http.ts';
import { ROLES, type Role } from './workflow/stateMachine.ts';

const SESSION_COOKIE = 'fg_session';
const SESSION_HOURS = 8;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
// Used to equalise timing when the login ID does not exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/** Single round trip: user row + aggregated roles + aggregated institution memberships. */
async function loadUser(db: Db, userId: string, activeRole: Role): Promise<AuthUser | null> {
  const u = await db.one<{
    id: string; login_id: string; full_name: string; email: string; designation: string | null; status: string;
    roles: Role[] | null; institution_ids: string[] | null;
  }>(
    `SELECT u.id, u.login_id, u.full_name, u.email, u.designation, u.status,
            (SELECT array_agg(role ORDER BY role) FROM user_roles WHERE user_id = u.id) AS roles,
            (SELECT array_agg(institution_id) FROM institution_memberships WHERE user_id = u.id) AS institution_ids
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!u || u.status !== 'ACTIVE') return null;
  const roles = u.roles ?? [];
  if (!roles.includes(activeRole)) return null;
  return { id: u.id, loginId: u.login_id, fullName: u.full_name, email: u.email, designation: u.designation, roles, activeRole, institutionIds: u.institution_ids ?? [] };
}

/**
 * Attaches req.user when a valid session cookie is present. Runs on every request, so this is
 * one joined round trip (session + user + roles + institutions) rather than four serial ones —
 * each round trip costs real latency against a remote (e.g. Supabase) database.
 */
export function sessionMiddleware(db: Db): RequestHandler {
  return ah(async (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length === 64) {
      const th = sha(token);
      const row = await db.one<{
        user_id: string; active_role: Role; expires_at: string;
        login_id: string; full_name: string; email: string; designation: string | null; status: string;
        roles: Role[] | null; institution_ids: string[] | null;
      }>(
        `SELECT s.user_id, s.active_role, s.expires_at,
                u.login_id, u.full_name, u.email, u.designation, u.status,
                (SELECT array_agg(role ORDER BY role) FROM user_roles WHERE user_id = u.id) AS roles,
                (SELECT array_agg(institution_id) FROM institution_memberships WHERE user_id = u.id) AS institution_ids
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1`,
        [th],
      );
      const roles = row?.roles ?? [];
      if (row && new Date(row.expires_at) > new Date() && row.status === 'ACTIVE' && roles.includes(row.active_role)) {
        req.user = {
          id: row.user_id, loginId: row.login_id, fullName: row.full_name, email: row.email, designation: row.designation,
          roles, activeRole: row.active_role, institutionIds: row.institution_ids ?? [],
        };
        req.sessionTokenHash = th;
      }
    }
    next();
  });
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Your session has expired or you are not signed in.'));
  next();
};

export function workspaceFor(role: Role): 'INSTITUTION' | 'OFFICIAL' | 'GOVERNANCE' {
  if (role === 'INSTITUTION_APPLICANT') return 'INSTITUTION';
  if (role === 'RULES_GOVERNANCE') return 'GOVERNANCE';
  return 'OFFICIAL';
}

export function authRouter(db: Db, opts: { secureCookies: boolean; loginsPerMinute?: number }) {
  const r = Router();
  const loginSchema = z.object({ loginId: z.string().trim().min(1).max(120), password: z.string().min(1).max(200) });

  const cookieOpts = { httpOnly: true, sameSite: 'strict' as const, secure: opts.secureCookies, path: '/' };

  r.post(
    '/login',
    rateLimit({ windowMs: 60_000, max: opts.loginsPerMinute ?? 20, key: (req: Request) => `login:${req.ip}` }),
    ah(async (req, res) => {
      const { loginId, password } = loginSchema.parse(req.body);
      const u = await db.one<{ id: string; password_hash: string; status: string; failed_attempts: number; locked_until: string | null }>(
        'SELECT id, password_hash, status, failed_attempts, locked_until FROM users WHERE lower(login_id) = lower($1)',
        [loginId],
      );
      if (u?.locked_until && new Date(u.locked_until) > new Date()) {
        await audit(db, req, 'LOGIN_LOCKED', 'user', u.id);
        throw new HttpError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`);
      }
      const ok = verifyPassword(password, u?.password_hash ?? DUMMY_HASH) && !!u;
      if (!ok || !u) {
        if (u) {
          const failed = u.failed_attempts + 1;
          await db.query('UPDATE users SET failed_attempts = $2, locked_until = $3 WHERE id = $1', [
            u.id,
            failed >= MAX_FAILED ? 0 : failed,
            failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
          ]);
        }
        await audit(db, req, 'LOGIN_FAILED', 'user', u?.id ?? null, { loginId });
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid User ID or password.');
      }
      if (u.status !== 'ACTIVE') {
        await audit(db, req, 'LOGIN_DENIED_INACTIVE', 'user', u.id);
        throw new HttpError(403, 'ACCOUNT_INACTIVE', 'This account is not active. Contact your administrator.');
      }
      const roles = (await db.query<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [u.id])).map((x) => x.role);
      if (roles.length === 0) throw new HttpError(403, 'NO_ROLE', 'No role is assigned to this account.');
      const active = roles[0];
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
      await db.query('INSERT INTO sessions(token_hash, user_id, active_role, expires_at, ip) VALUES ($1,$2,$3,$4,$5)', [sha(token), u.id, active, expires.toISOString(), req.ip ?? null]);
      await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
      res.cookie(SESSION_COOKIE, token, { ...cookieOpts, expires });
      const au = (await loadUser(db, u.id, active))!;
      req.user = au;
      await audit(db, req, 'LOGIN_SUCCESS', 'user', u.id);
      res.json({ user: publicUser(au), workspace: workspaceFor(active) });
    }),
  );

  r.post(
    '/logout',
    ah(async (req, res) => {
      if (req.sessionTokenHash) {
        await db.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionTokenHash]);
        await audit(db, req, 'LOGOUT', 'user', req.user?.id ?? null);
      }
      res.clearCookie(SESSION_COOKIE, cookieOpts);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/me',
    ah(async (req, res) => {
      const u = user(req);
      res.json({ user: publicUser(u), workspace: workspaceFor(u.activeRole) });
    }),
  );

  r.post(
    '/switch-role',
    ah(async (req, res) => {
      const u = user(req);
      const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
      if (!u.roles.includes(role)) {
        await audit(db, req, 'ROLE_SWITCH_DENIED', 'user', u.id, { role });
        throw new HttpError(403, 'FORBIDDEN', 'That role is not assigned to your account.');
      }
      await db.query('UPDATE sessions SET active_role = $2 WHERE token_hash = $1', [req.sessionTokenHash, role]);
      await audit(db, req, 'ROLE_SWITCH', 'user', u.id, { role });
      res.json({ user: publicUser({ ...u, activeRole: role }), workspace: workspaceFor(role) });
    }),
  );
  return r;
}

export function publicUser(u: AuthUser) {
  return { id: u.id, loginId: u.loginId, fullName: u.fullName, email: u.email, designation: u.designation, roles: u.roles, activeRole: u.activeRole };
}
