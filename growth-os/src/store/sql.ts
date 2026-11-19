// Minimal SQL client abstraction with two transports:
//  - PgClient: direct Postgres connection (DATABASE_URL) — use this in production.
//  - SupabaseManagementClient: Supabase Management API SQL endpoint (SUPABASE_ACCESS_TOKEN +
//    SUPABASE_PROJECT_REF) — for setup, admin CLIs and environments without a DB connection.
import pg from "pg";

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close?(): Promise<void>;
}

export class PgClient implements SqlClient {
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5, ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false } });
  }
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params.map(toPgParam));
    return r.rows as T[];
  }
  async close() {
    await this.pool.end();
  }
}

function toPgParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date || v === null || typeof v !== "object") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  return JSON.stringify(v);
}

/** SQL literal for inlining a parameter (used only by the Management API transport). */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return `ARRAY[${v.map(sqlLiteral).join(",")}]::text[]`;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.includes("\u0000")) throw new Error("NUL byte in parameter");
  // standard_conforming_strings is on in Postgres ≥9.1: only single quotes need escaping.
  return `'${s.replace(/'/g, "''")}'`;
}

/** Replaces $1..$n with literals. Ignores $n inside quoted strings in the SQL text itself. */
export function inlineParams(sql: string, params: unknown[]): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") inQuote = !inQuote;
    if (!inQuote && c === "$" && /\d/.test(sql[i + 1] ?? "")) {
      let j = i + 1;
      while (/\d/.test(sql[j] ?? "")) j++;
      const n = Number(sql.slice(i + 1, j));
      if (n < 1 || n > params.length) throw new Error(`missing parameter $${n}`);
      out += sqlLiteral(params[n - 1]);
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

export class SupabaseManagementClient implements SqlClient {
  constructor(private projectRef: string, private token: string, private fetchImpl: typeof fetch = fetch) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.fetchImpl(`https://api.supabase.com/v1/projects/${encodeURIComponent(this.projectRef)}/database/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: inlineParams(sql, params) }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`SQL failed (${res.status}): ${body.slice(0, 300)}`);
    return JSON.parse(body) as T[];
  }
}

/** Picks a transport from the environment, or null when no database is configured (demo mode). */
export function sqlClientFromEnv(env = process.env): SqlClient | null {
  if (env.DATABASE_URL) return new PgClient(env.DATABASE_URL);
  if (env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_PROJECT_REF) return new SupabaseManagementClient(env.SUPABASE_PROJECT_REF, env.SUPABASE_ACCESS_TOKEN);
  return null;
}
