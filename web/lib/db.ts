import { Pool, type QueryResultRow } from 'pg';

// ponytail: one pg.Pool, stashed on globalThis so Next dev hot-reload doesn't leak
// a pool per recompile. Ceiling: single process, small pool, no read replicas.
// Upgrade path: swap the connection string for a pgbouncer/Neon pooled URL.
const g = globalThis as unknown as { __docloopPool?: Pool };

const connectionString = process.env.DATABASE_URL;

// Three ways this connects, and only one of them wants TLS.
//
//   local          postgresql://you@localhost:5432/docloop        no TLS at all
//   Cloud SQL      postgresql://u:p@/docloop?host=/cloudsql/…     UNIX SOCKET — no TLS either
//   hosted TCP     postgresql://u:p@host.example.com/db           TLS, chain node-postgres
//                                                                 will not verify by default
//
// The socket case is the trap. Cloud Run reaches Cloud SQL over a unix socket at
// /cloudsql/<connection-name>, which carries no hostname and therefore matched neither branch of
// the old check — so `ssl` was set on a transport that cannot do TLS, and every query failed with
// a connection error that reads like a bad password. Socket connections are detected explicitly.
const isSocket = /host=\/cloudsql\/|^\/|host=%2Fcloudsql/.test(connectionString ?? '');
const isLocal = /(^|@|\/\/)(localhost|127\.0\.0\.1)/.test(connectionString ?? '');
const noTls = isSocket || isLocal || !connectionString;

export const pool: Pool =
  g.__docloopPool ??
  (g.__docloopPool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: noTls ? undefined : { rejectUnauthorized: false },
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
