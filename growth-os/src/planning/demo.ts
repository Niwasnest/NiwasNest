// Sample data for demos and screenshots. Never written to the database.
import { GrowthStore } from "../store/memory";

export function demoStore(): GrowthStore {
  const store = new GrowthStore();
  const demo: [string, string, string, string, number, string?][] = [
    ["Sri Sai PG for Men", "Ravi Kumar", "BTM Layout", "interested", 6, "TEA-BTM-01"],
    ["Green Nest Ladies PG", "Meena R", "HSR Layout", "onboarding_started", 3],
    ["Royal Stay Gents PG", "Suresh", "Electronic City", "no_answer", 10, "LIFT-ECITY-01"],
    ["Sunrise Co-living", "Anil", "Marathahalli", "live", 0, "TEA-BTM-01"],
    ["Lakshmi PG", "Lakshmi Devi", "Bommanahalli", "contacted", 4],
    ["Kiran Residency", "Kiran", "Electronic City", "new_lead", 8, "LIFT-ECITY-01"],
  ];
  let i = 1;
  for (const [pgName, ownerName, locality, status, vacantBeds, trackingCode] of demo) {
    const { lead } = store.createLead({ kind: "pg_owner", pgName, ownerName, locality, city: "Bengaluru", phoneE164: `90000000${(i++).toString().padStart(2, "0")}`, source: "demo", trackingCode, vacantBeds, language: "te" }, "demo");
    lead.status = status as typeof lead.status;
    store.consents.push({ phoneE164: lead.phoneE164, channel: "call", granted: true, evidence: "demo data", capturedAt: new Date(0) });
  }
  store.expenses.push({ id: "x1", trackingCode: "TEA-BTM-01", amountInr: 1500, description: "30 tea-shop stickers (demo)", incurredOn: new Date() });
  store.expenses.push({ id: "x2", trackingCode: "LIFT-ECITY-01", amountInr: 2400, description: "12 lift stickers (demo)", incurredOn: new Date() });
  store.requestApproval({ agentKey: "campaigns", action: "publish_offer", approverRole: "founder", summary: "First 100 owners: featured listing for 30 days (no cash), Dec 1–31", payload: { budget_inr: 0, max_redemptions: 100, tracking_code: "FIRST100" } });
  store.requestApproval({ agentKey: "partnerships", action: "send_email", approverRole: "founder", summary: "Send email to placement office, sample engineering college (demo)", payload: { subject: "Accommodation help for your incoming students" } });
  store.log({ agentKey: "owner_sales", action: "send_routine_message", input: {}, result: "dry_run", detail: "no channel provider configured" });
  store.log({ agentKey: "owner_sales", action: "reply_guard", input: {}, result: "blocked", detail: "unverified figures: 10%" });
  store.log({ agentKey: "owner_sales", action: "send_routine_message", input: {}, result: "blocked", detail: "no recorded opt-in for whatsapp" });
  return store;
}
