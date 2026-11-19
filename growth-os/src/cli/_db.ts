import { sqlClientFromEnv, type SqlClient } from "../store/sql";
import { loadStore } from "../store/postgres";

export function requireDb(): SqlClient {
  const db = sqlClientFromEnv();
  if (!db) {
    console.error("No database configured. Set DATABASE_URL, or SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (see .env.example).");
    process.exit(2);
  }
  return db;
}

export async function openStore() {
  const db = requireDb();
  return { db, store: await loadStore(db) };
}
