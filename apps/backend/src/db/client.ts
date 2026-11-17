import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from './schema.js';

export function createDatabase(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
