// Starts the founder console: `npm start`. Requires a database and login settings in the environment.
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadStore } from "../store/postgres";
import { sqlClientFromEnv } from "../store/sql";
import type { AgentActionLog } from "../store/memory";

function need(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name}. See .env.example.`); process.exit(2); }
  return v;
}

const db = sqlClientFromEnv();
if (!db) { console.error("No database configured (DATABASE_URL or SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF)."); process.exit(2); }
const sessionSecret = need("SESSION_SECRET");
if (sessionSecret.length < 32) { console.error("SESSION_SECRET must be at least 32 characters."); process.exit(2); }

const app = createApp({
  openStore: () => loadStore(db),
  async setAgentFlag(agentKey, paused, by) {
    await db.query(
      "insert into agent_flags (agent_key, paused, updated_at) values ($1, $2, now()) on conflict (agent_key) do update set paused = excluded.paused, updated_at = now()",
      [agentKey, paused],
    );
    await db.query("insert into agent_actions (agent_key, action, input, result, detail, provider_ref) values ($1, $2, $3::jsonb, 'done', $4, 'console')",
      [`human:${by}`, paused ? "pause_agent" : "resume_agent", { agentKey }, agentKey === "*" ? "global kill switch" : agentKey]);
  },
  async recentActions(limit) {
    const rows = await db.query<Record<string, unknown>>("select * from agent_actions order by at desc limit $1", [limit]);
    return rows.map((r): AgentActionLog => ({
      id: String(r.id), at: new Date(String(r.at)), agentKey: String(r.agent_key), action: String(r.action), input: r.input,
      result: r.result as AgentActionLog["result"], detail: r.detail == null ? undefined : String(r.detail), providerRef: r.provider_ref == null ? undefined : String(r.provider_ref),
    }));
  },
  auth: {
    user: process.env.ADMIN_NAME || "Founder",
    passwordHash: need("ADMIN_PASSWORD_HASH"),
    sessionSecret,
    secureCookies: process.env.COOKIE_SECURE !== "false",
  },
});

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST || "0.0.0.0" }, (i) => console.log(`Growth OS console on http://localhost:${i.port}`));
