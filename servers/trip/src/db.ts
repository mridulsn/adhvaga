// Database access. Locally: PGlite (Postgres in WebAssembly, in memory or a folder).
// Later: Neon Postgres through the same small interface.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Tx {
  transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export async function openPglite(dataDir?: string): Promise<Db> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.exec(SCHEMA);
  const wrap = (q: { query: PGlite["query"] }): Tx => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await q.query<T>(sql, params as never[]);
      return { rows: r.rows };
    },
  });
  return {
    ...wrap(pg),
    async transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
      return pg.transaction(async (t) => fn(wrap(t as unknown as { query: PGlite["query"] })));
    },
    async close() {
      await pg.close();
    },
  };
}
