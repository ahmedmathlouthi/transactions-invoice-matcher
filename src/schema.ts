import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

const ROOT = path.join(__dirname, '..');

async function runSqlFiles(pool: Pool, directory: string) {
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(directory, file), 'utf8'));
  }
}

/** Drops everything, re-applies migrations, reseeds. */
export async function resetSchema(pool: Pool) {
  await pool.query('drop schema public cascade');
  await pool.query('create schema public');
  await runSqlFiles(pool, path.join(ROOT, 'migrations'));
  await runSqlFiles(pool, path.join(ROOT, 'seeds'));
}
