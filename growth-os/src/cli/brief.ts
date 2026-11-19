// Prints the founder's morning brief from the Growth OS database (or demo data with --demo).
import { GrowthStore } from "../store/memory";
import { sqlClientFromEnv } from "../store/sql";
import { loadStore } from "../store/postgres";
import { buildDailyPlan, renderBrief } from "../planning/daily-plan";

function demoStore(): GrowthStore {
  const store = new GrowthStore();
  const demo: [string, string, string, number, string?][] = [
    ["Sri Sai PG", "BTM Layout", "interested", 6, "TEA-BTM-01"],
    ["Green Nest Ladies PG", "HSR Layout", "onboarding_started", 3],
    ["Royal Stay Gents PG", "Electronic City", "no_answer", 10, "LIFT-ECITY-01"],
    ["Sunrise Co-living", "Marathahalli", "live", 0, "TEA-BTM-01"],
    ["Lakshmi PG", "Bommanahalli", "contacted", 4],
  ];
  let i = 1;
  for (const [pgName, locality, status, vacantBeds, trackingCode] of demo) {
    const { lead } = store.createLead({ kind: "pg_owner", pgName, locality, city: "Bengaluru", phoneE164: `90000000${(i++).toString().padStart(2, "0")}`, source: "demo", trackingCode, vacantBeds, language: "te" }, "demo");
    lead.status = status as typeof lead.status;
    store.consents.push({ phoneE164: lead.phoneE164, channel: "call", granted: true, evidence: "demo", capturedAt: new Date(0) });
  }
  store.expenses.push({ id: "x", trackingCode: "TEA-BTM-01", amountInr: 1500, description: "30 tea-shop stickers (demo)", incurredOn: new Date() });
  return store;
}

const db = process.argv.includes("--demo") ? null : sqlClientFromEnv();
if (!db) console.log("[DEMO DATA — no database configured]\n");
const store = db ? await loadStore(db) : demoStore();
console.log(renderBrief(buildDailyPlan(store)));
if (db && store.leads.size === 0) console.log("\nNo leads yet. Add some with: npm run import:leads -- path/to/leads.csv");
await db?.close?.();
