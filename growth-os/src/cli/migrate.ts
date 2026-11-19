// Applies db/migrations/*.sql that have not run yet (tracked in schema_migrations).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireDb } from "./_db";

const db = requireDb();
const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
let applied = new Set<string>();
try {
  applied = new Set((await db.query<{ version: string }>("select version from schema_migrations")).map((r) => r.version));
} catch {
  // schema_migrations does not exist yet; 0001 may still have been applied manually.
  const t = await db.query("select 1 from pg_tables where schemaname='public' and tablename='leads'");
  if (t.length) applied.add("0001_growth_os");
}
for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  const v = f.replace(/\.sql$/, "");
  if (applied.has(v)) { console.log(`= ${v} (already applied)`); continue; }
  await db.query(readFileSync(join(dir, f), "utf8"));
  await db.query("insert into schema_migrations (version) values ($1) on conflict do nothing", [v]).catch(() => {});
  console.log(`+ ${v} applied`);
}
await db.close?.();
