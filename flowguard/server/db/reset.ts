/**
 * Deletes the LOCAL embedded database and local document storage (development only).
 * Refuses to run when DATABASE_URL is set, so it can never touch a remote/Supabase database.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — refusing to reset. This script only clears the local embedded database.');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const dir of [process.env.PGLITE_DATA_DIR ?? path.join(root, 'data', 'pgdata'), process.env.STORAGE_DIR ?? path.join(root, 'data', 'storage')]) {
  const abs = path.resolve(root, dir);
  if (!abs.startsWith(path.join(root, 'data'))) {
    console.error(`Refusing to delete ${abs}: outside ./data`);
    process.exit(1);
  }
  fs.rmSync(abs, { recursive: true, force: true });
  console.log(`Cleared ${abs}`);
}
console.log('Local data cleared. Start the server to re-create the schema and demo accounts.');
