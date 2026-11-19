import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { GrowthStore } from "../src/store/memory";
import { loadKnowledgeDir, retrieve } from "../src/core/knowledge";
import { ScriptedProvider } from "../src/agents/llm";
import { runAgentTurn, SAFE_FALLBACK, unverifiedFigures } from "../src/agents/orchestrator";
import type { ChannelSender } from "../src/agents/tools";
import { NiwasNestApi } from "../src/integrations/niwasnest-api";
import { buildDailyPlan, campaignRoi, renderBrief } from "../src/planning/daily-plan";

const kb = loadKnowledgeDir(join(__dirname, "..", "knowledge"));
const NOON = new Date("2026-11-19T05:30:00Z");

function setup() {
  const store = new GrowthStore();
  const { lead } = store.createLead({ kind: "pg_owner", ownerName: "Ravi", pgName: "Sri Sai PG", phoneE164: "98480 12345", city: "Bengaluru", locality: "BTM Layout", source: "field_visit", language: "te" }, "test");
  return { store, lead };
}

describe("knowledge base", () => {
  it("loads every file and keeps historical commission out of retrieval", () => {
    expect(kb.length).toBeGreaterThanOrEqual(10);
    const hits = retrieve(kb, "what is your commission percent first month");
    expect(hits.some((h) => h.authority === 5)).toBe(false);
    expect(retrieve(kb, "commission history 30%", { includeHistorical: true }).some((h) => h.authority === 5)).toBe(true);
  });
  it("unconfirmed referral amounts are not visible to agents", () => {
    expect(retrieve(kb, "referral ₹500 owner bookings").some((h) => h.category === "referrals")).toBe(false);
  });
});

describe("number guard", () => {
  it("flags figures not present in approved sources", () => {
    expect(unverifiedFigures("Our fee is 20% and you get ₹1,000 off", ["approved: 20% of first month"])).toEqual(["1000"]);
    expect(unverifiedFigures("Listing is free", [])).toEqual([]);
  });
});

describe("agent turns", () => {
  it("replaces an invented commission with the safe fallback and logs it", async () => {
    const { store, lead } = setup();
    const llm = new ScriptedProvider([{ text: "Mana commission kevalam 10% matrame sir!", toolCalls: [] }]);
    const r = await runAgentTurn({ agentKey: "owner_sales", llm, ctx: { store, kb, now: () => NOON }, userMessage: "commission entha?", leadId: lead.id });
    expect(r.reply).toBe(SAFE_FALLBACK);
    expect(store.actions.some((a) => a.action === "reply_guard" && a.result === "blocked")).toBe(true);
  });

  it("allows a figure that came from the policy tool", async () => {
    const { store, lead } = setup();
    store.policies.push({ id: "p", scope: { kind: "default" }, type: "first_month_commission", percent: 20, appliesToMonths: "first_month_only", approvedWording: "20% of the first month's rent, one time only. No charge from the second month.", status: "approved", approvedBy: "founder", effectiveFrom: new Date("2026-01-01") });
    const llm = new ScriptedProvider([
      { toolCalls: [{ name: "get_commercial_policy", args: {} }] },
      { text: "Listing free sir. Booking vaste first month rent lo 20% okkasari matrame.", toolCalls: [] },
    ]);
    const r = await runAgentTurn({ agentKey: "owner_sales", llm, ctx: { store, kb, now: () => NOON }, userMessage: "commission entha?", leadId: lead.id });
    expect(r.guarded).toBe(false);
    expect(r.reply).toContain("20%");
  });

  it("records an opt-out deterministically without asking the model", async () => {
    const { store, lead } = setup();
    const llm = new ScriptedProvider([]);
    const r = await runAgentTurn({ agentKey: "owner_sales", llm, ctx: { store, kb, now: () => NOON }, userMessage: "inka call vaddu", leadId: lead.id });
    expect(llm.seen).toHaveLength(0);
    expect(store.leads.get(lead.id)?.status).toBe("do_not_contact");
    expect(r.reply).toMatch(/won't contact/);
  });

  it("never claims a send without a provider, and blocks sends without consent", async () => {
    const { store, lead } = setup();
    const llm = new ScriptedProvider([{ toolCalls: [{ name: "send_message", args: { lead_id: lead.id, channel: "whatsapp", template_key: "owner_intro" } }] }, { text: "ok", toolCalls: [] }]);
    const r = await runAgentTurn({ agentKey: "owner_sales", llm, ctx: { store, kb, now: () => NOON }, userMessage: "send details", leadId: lead.id });
    expect(r.toolTrace[0]?.result).toMatch(/^BLOCKED: no recorded opt-in/);

    store.consents.push({ phoneE164: lead.phoneE164, channel: "whatsapp", granted: true, evidence: "said yes on call", capturedAt: new Date("2026-11-18") });
    const llm2 = new ScriptedProvider([{ toolCalls: [{ name: "send_message", args: { lead_id: lead.id, channel: "whatsapp", template_key: "owner_intro" } }] }, { text: "ok", toolCalls: [] }]);
    const r2 = await runAgentTurn({ agentKey: "owner_sales", llm: llm2, ctx: { store, kb, now: () => NOON }, userMessage: "send details", leadId: lead.id });
    expect(r2.toolTrace[0]?.result).toMatch(/^DRY_RUN/);

    const sender: ChannelSender = { send: async () => ({ providerRef: "wamid.123" }) };
    const llm3 = new ScriptedProvider([{ toolCalls: [{ name: "send_message", args: { lead_id: lead.id, channel: "whatsapp", template_key: "owner_intro" } }] }, { text: "sent", toolCalls: [] }]);
    const r3 = await runAgentTurn({ agentKey: "owner_sales", llm: llm3, ctx: { store, kb, now: () => NOON, sender }, userMessage: "send details", leadId: lead.id });
    expect(r3.toolTrace[0]?.result).toBe("SENT (wamid.123)");
    expect(store.actions.find((a) => a.providerRef === "wamid.123")?.result).toBe("done");
  });

  it("agents cannot mark a listing live, or use tools outside their role", async () => {
    const { store, lead } = setup();
    const llm = new ScriptedProvider([
      { toolCalls: [{ name: "update_lead_status", args: { lead_id: lead.id, status: "live" } }, { name: "propose_offer", args: {} }] },
      { text: "done", toolCalls: [] },
    ]);
    const r = await runAgentTurn({ agentKey: "owner_sales", llm, ctx: { store, kb, now: () => NOON }, userMessage: "hi", leadId: lead.id });
    expect(r.toolTrace[0]?.result).toMatch(/REJECTED/);
    expect(r.toolTrace[1]?.result).toMatch(/not available to this agent/);
    expect(store.leads.get(lead.id)?.status).toBe("new_lead");
  });

  it("offers go to the founder's approval queue", async () => {
    const store = new GrowthStore();
    const llm = new ScriptedProvider([
      { toolCalls: [{ name: "propose_offer", args: { name: "First 100 owners", audience: "pg_owner", reward: "Featured listing for 30 days", budget_inr: 0, max_redemptions: 100, start: "2026-12-01", end: "2026-12-31", eligibility: "new owners", terms: "…" } }] },
      { text: "Proposed for approval.", toolCalls: [] },
    ]);
    const r = await runAgentTurn({ agentKey: "campaigns", llm, ctx: { store, kb, now: () => NOON }, userMessage: "make an owner offer" });
    expect(r.toolTrace[0]?.result).toMatch(/PENDING_APPROVAL/);
    expect(store.approvals[0]).toMatchObject({ status: "pending", approverRole: "founder", action: "publish_offer" });
  });

  it("kill switch silences agents but still honours opt-outs", async () => {
    const { store, lead } = setup();
    store.killSwitch.global = true;
    const llm = new ScriptedProvider([{ text: "hello", toolCalls: [] }]);
    const r = await runAgentTurn({ agentKey: "owner_sales", llm, ctx: { store, kb, now: () => NOON }, userMessage: "STOP", leadId: lead.id });
    expect(r.reply).toBe("");
    expect(llm.seen).toHaveLength(0);
    expect(store.leads.get(lead.id)?.optedOut).toBe(true);
  });
});

describe("main app bridge", () => {
  it("is read-only by default and refuses non-allowlisted paths", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(url); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const api = new NiwasNestApi({ baseUrl: "https://api.example", token: "t", writesEnabled: false, fetchImpl });
    await api.get("/marketing/leads?limit=100");
    await expect(api.get("/admin/users")).rejects.toThrow(/not allowed/);
    await expect(api.post("/marketing/leads/new-pg", {}, "apr_1")).rejects.toThrow(/disabled/);
    const w = new NiwasNestApi({ baseUrl: "https://api.example", token: "t", writesEnabled: true, fetchImpl });
    await expect(w.post("/admin/properties/x/approve", {}, "apr_1")).rejects.toThrow(/not allowed/);
    await expect(w.post("/marketing/leads/new-pg", {}, "")).rejects.toThrow(/approval/);
    expect(calls).toEqual(["https://api.example/marketing/leads?limit=100"]);
  });
});

describe("daily plan and ROI", () => {
  it("prioritises leads closest to live and measures cost per live PG", () => {
    const store = new GrowthStore();
    const a = store.createLead({ kind: "pg_owner", pgName: "A PG", phoneE164: "9000000001", city: "Bengaluru", locality: "HSR Layout", source: "qr", trackingCode: "TEA-HSR-01", language: "te" }, "t").lead;
    const b = store.createLead({ kind: "pg_owner", pgName: "B PG", phoneE164: "9000000002", city: "Bengaluru", locality: "HSR Layout", source: "qr", trackingCode: "TEA-HSR-01", language: "te" }, "t").lead;
    const c = store.createLead({ kind: "pg_owner", pgName: "C PG", phoneE164: "9000000003", city: "Bengaluru", locality: "BTM Layout", source: "field", language: "te" }, "t").lead;
    store.setStatus(a.id, "live", "sync", "main_app_sync");
    store.setStatus(b.id, "contacted", "t", "agent");
    store.setStatus(b.id, "interested", "t", "agent");
    store.setStatus(c.id, "contacted", "t", "agent");
    for (const l of [b, c]) store.consents.push({ phoneE164: l.phoneE164, channel: "call", granted: true, evidence: "x", capturedAt: new Date("2026-11-01") });
    store.expenses.push({ id: "e", trackingCode: "TEA-HSR-01", amountInr: 2000, description: "40 stickers", incurredOn: new Date() });

    const plan = buildDailyPlan(store, NOON);
    expect(plan.callList.map((x) => x.lead.pgName)).toEqual(["B PG", "C PG"]);
    expect(plan.funnel.live).toBe(1);
    expect(campaignRoi(store)[0]).toMatchObject({ trackingCode: "TEA-HSR-01", costPerLivePgInr: 2000, costPerLeadInr: 1000 });
    expect(renderBrief(plan)).toContain("₹2000 per live PG");
  });
});
