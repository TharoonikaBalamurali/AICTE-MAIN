/**
 * Database adapter.
 * - DATABASE_URL set  → node-postgres pool (e.g. Supabase Postgres connection string).
 * - otherwise         → embedded PostgreSQL (PGlite) persisted under PGLITE_DATA_DIR,
 *                       or in-memory when PGLITE_DATA_DIR=memory:// (tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: 'pglite' | 'postgres';
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function wrap(q: QueryFn, tx: Db['tx'], exec: Db['exec'], close: Db['close'], kind: Db['kind']): Db {
  return {
    kind,
    async query<T>(sql: string, params: unknown[] = []) {
      return (await q(sql, params)).rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const rows = (await q(sql, params)).rows as T[];
      return rows[0] ?? null;
    },
    tx,
    exec,
    close,
  };
}

export async function createDb(opts: { databaseUrl?: string; dataDir?: string } = {}): Promise<Db> {
  if (opts.databaseUrl) {
    const pg = await import('pg');
    // Supabase's session pooler (Supavisor) caps total concurrent clients per project on shared
    // plans (commonly 15, shared with Supabase's own internal connections) — a pool much larger
    // than that starves other connections, including this app's own next restart. Keep it modest.
    const POOL_SIZE = 5;
    const pool = new pg.default.Pool({
      connectionString: opts.databaseUrl,
      max: POOL_SIZE,
      ssl: opts.databaseUrl.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      // pg's default (10s) closes idle connections between clicks — against a remote database
      // (e.g. Supabase) that means every click after a short pause re-pays a ~1s TLS handshake.
      // Keep connections open for the length of a session instead.
      idleTimeoutMillis: 30 * 60_000,
      keepAlive: true,
    });
    // Pre-warm the whole pool up front so the first real requests after startup — which fan out
    // into several concurrent queries (dashboards, visit detail) — don't each pay that handshake
    // for every connection the pool opens.
    await Promise.all(Array.from({ length: POOL_SIZE }, () => pool.query('SELECT 1'))).catch(() => undefined);
    const self: Db = wrap(
      (sql, params) => pool.query(sql, params as unknown[]),
      async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const inner = wrap(
            (s, p) => client.query(s, p as unknown[]),
            (f) => f(inner),
            async (s) => void (await client.query(s)),
            async () => undefined,
            'postgres',
          );
          const r = await fn(inner);
          await client.query('COMMIT');
          return r;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      async (sql) => void (await pool.query(sql)),
      () => pool.end(),
      'postgres',
    );
    return self;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  // btree_gist powers the EVC reservation exclusion constraint (no overlapping slots per official).
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const dir = opts.dataDir ?? 'memory://';
  if (!dir.startsWith('memory://')) fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir, { extensions: { btree_gist } });
  await pg.waitReady;
  const self: Db = wrap(
    (sql, params) => pg.query(sql, params as unknown[]),
    (fn) =>
      pg.transaction(async (t) => {
        const inner: Db = wrap(
          (s, p) => t.query(s, p as unknown[]),
          (f) => f(inner),
          async (s) => void (await t.exec(s)),
          async () => undefined,
          'pglite',
        );
        return fn(inner);
      }) as Promise<never>,
    async (sql) => void (await pg.exec(sql)),
    () => pg.close(),
    'pglite',
  );
  return self;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(db: Db): Promise<string[]> {
  const dir = path.join(here, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());');
  const applied: string[] = [];
  for (const f of files) {
    const done = await db.one('SELECT 1 FROM schema_migrations WHERE version = $1', [f]);
    if (done) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
