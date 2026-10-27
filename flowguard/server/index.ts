import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.ts';
import { createDb, migrate } from './db/index.ts';
import { seed } from './db/seed.ts';
import { startScheduler } from './scheduler.ts';
import { LocalStorage } from './storage.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3000);
const prod = process.env.NODE_ENV === 'production';

async function main() {
  const db = await createDb({ databaseUrl: process.env.DATABASE_URL || undefined, dataDir: process.env.PGLITE_DATA_DIR ?? path.join(root, 'data', 'pgdata') });
  const applied = await migrate(db);
  const seeded = process.env.SEED_DEMO === 'false' ? null : await seed(db);
  const storage = new LocalStorage(process.env.STORAGE_DIR ?? path.join(root, 'data', 'storage'));
  const { app, log } = createApp({ db, storage, secureCookies: prod });
  log('startup', { database: db.kind, migrationsApplied: applied, seeded });
  if (process.env.DISABLE_SCHEDULER !== 'true') startScheduler(db, log);
  // Close pooled connections on shutdown — without this, a killed dev process leaves its
  // connections open against a remote database (e.g. Supabase) until the server times them out,
  // which can exhaust a shared session-pooler's client limit across repeated restarts.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      db.close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  }

  if (prod) {
    app.use(express.static(path.join(root, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ root, server: { middlewareMode: true, hmr: process.env.DISABLE_HMR === 'true' ? false : undefined }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  app.listen(PORT, () => log('listening', { url: `http://localhost:${PORT}` }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
