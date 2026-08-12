import { Pool, type QueryResultRow } from 'pg';

// ponytail: one pg.Pool, stashed on globalThis so Next dev hot-reload doesn't leak
// a pool per recompile. Ceiling: single process, small pool, no read replicas.
// Upgrade path: swap the connection string for a pgbouncer/Neon pooled URL.
const g = globalThis as unknown as { __docloopPool?: Pool };

const connectionString = process.env.DATABASE_URL;

// Hosted Postgres (Vercel Marketplace) terminates TLS with a chain node-postgres
// won't verify by default; local Postgres has no TLS at all.
const isLocal = /(^|@|\/\/)(localhost|127\.0\.0\.1)/.test(connectionString ?? '');

export const pool: Pool =
  g.__docloopPool ??
  (g.__docloopPool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: isLocal || !connectionString ? undefined : { rejectUnauthorized: false },
  }));

/** Parameterised query. NEVER interpolate user input into `sql`. */
export function q<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}

/** Store one webhook event, return its id. */
export async function insertEvent(source: string, type: string, payload: unknown): Promise<string> {
  const r = await q<{ id: string }>(
    'insert into events (source, type, payload) values ($1, $2, $3::jsonb) returning id',
    [source, type, JSON.stringify(payload ?? {})],
  );
  return r.rows[0].id;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
