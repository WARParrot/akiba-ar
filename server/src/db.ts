import { readFileSync } from 'node:fs';
// pg is CJS: named ESM imports don't resolve, so default-import and destructure.
import pg from 'pg';

// No default connection string: with DATABASE_URL unset, pg reads PGHOST/PGUSER/PGDATABASE itself.
export const pool = new pg.Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
);

export async function migrate(schemaPath = new URL('../db/schema.sql', import.meta.url)) {
  await pool.query(readFileSync(schemaPath, 'utf8'));
}
