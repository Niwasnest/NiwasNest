// Prints the founder's morning brief from the Growth OS database (or demo data with --demo).
import { demoStore } from "../planning/demo";
import { sqlClientFromEnv } from "../store/sql";
import { loadStore } from "../store/postgres";
import { buildDailyPlan, renderBrief } from "../planning/daily-plan";

const db = process.argv.includes("--demo") ? null : sqlClientFromEnv();
if (!db) console.log("[DEMO DATA — no database configured]\n");
const store = db ? await loadStore(db) : demoStore();
console.log(renderBrief(buildDailyPlan(store)));
if (db && store.leads.size === 0) console.log("\nNo leads yet. Add some with: npm run import:leads -- path/to/leads.csv");
await db?.close?.();
