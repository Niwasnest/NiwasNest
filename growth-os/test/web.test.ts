import { describe, expect, it } from "vitest";
import { createApp } from "../src/web/app";
import { createSessionToken, hashPassword, readSessionToken, verifyPassword } from "../src/web/auth";
import { GrowthStore } from "../src/store/memory";

const SECRET = "x".repeat(40);
const NOON = new Date("2026-11-19T05:30:00Z");

function setup() {
  const store = new GrowthStore();
  const flags: [string, boolean][] = [];
  const app = createApp({
    openStore: async () => store,
    setAgentFlag: async (k, p) => { flags.push([k, p]); if (k === "*") store.killSwitch.global = p; },
    recentActions: async () => store.actions.slice().reverse(),
    auth: { user: "Founder", passwordHash: hashPassword("correct horse battery"), sessionSecret: SECRET, secureCookies: false },
    now: () => NOON,
  });
  const { token, session } = createSessionToken("Founder", SECRET);
  const cookie = `gos_session=${token}`;
  const get = (path: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, fields: Record<string, string>, csrf = session.csrf) =>
    app.request(path, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, _csrf: csrf }).toString() });
  return { app, store, flags, get, post };
}

describe("auth primitives", () => {
  it("hashes and verifies passwords", () => {
    const h = hashPassword("secret-password-1");
    expect(verifyPassword("secret-password-1", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
  it("rejects tampered or expired sessions", () => {
    const { token } = createSessionToken("Founder", SECRET, 1000, 0);
    expect(readSessionToken(token, SECRET, 500)?.user).toBe("Founder");
    expect(readSessionToken(token, SECRET, 2000)).toBeNull();
    expect(readSessionToken(token, "y".repeat(40), 500)).toBeNull();
    expect(readSessionToken(token.replace(/^./, "A"), SECRET, 500)).toBeNull();
  });
});

describe("console access control", () => {
  it("redirects anonymous users to login and rejects anonymous POSTs", async () => {
    const { app } = setup();
    const r = await app.request("/");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/login");
    expect((await app.request("/settings/flag", { method: "POST" })).status).toBe(401);
  });
  it("logs in with the right password only, and throttles guessing", async () => {
    const { app } = setup();
    const login = (pw: string) => app.request("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "1.2.3.4" }, body: `password=${encodeURIComponent(pw)}` });
    const ok = await login("correct horse battery");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("set-cookie")).toMatch(/gos_session=.*HttpOnly.*SameSite=Strict/i);
    for (let i = 0; i < 5; i++) expect((await login("nope")).status).toBe(401);
    expect(await (await login("correct horse battery")).text()).toContain("Too many attempts");
  });
  it("rejects POSTs without the CSRF token", async () => {
    const { post, flags } = setup();
    const r = await post("/settings/flag", { agent: "*", paused: "true" }, "forged");
    expect(r.status).toBe(403);
    expect(flags).toHaveLength(0);
  });
  it("sets strict security headers", async () => {
    const { get } = setup();
    const r = await get("/");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("console features", () => {
  it("adds a lead, escapes HTML, records consent only with evidence", async () => {
    const { post, get, store } = setup();
    const r = await post("/leads", { pg_name: "<script>alert(1)</script> PG", phone: "98480 12345", locality: "BTM", consent_call: "yes", consent_evidence: "", language: "te", source: "field_visit" });
    expect(r.status).toBe(303);
    const lead = [...store.leads.values()][0]!;
    expect(store.consents).toHaveLength(0);
    const html = await (await get(`/leads/${lead.id}`)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    // duplicate by phone goes to the existing lead
    const dup = await post("/leads", { pg_name: "Other", phone: "+91 98480-12345" });
    expect(dup.headers.get("location")).toContain(`/leads/${lead.id}`);
    expect(store.leads.size).toBe(1);
  });

  it("humans can move a lead but cannot mark it Live", async () => {
    const { post, store } = setup();
    await post("/leads", { pg_name: "A PG", phone: "9000000001" });
    const lead = [...store.leads.values()][0]!;
    await post(`/leads/${lead.id}/status`, { status: "contacted" });
    expect(lead.status).toBe("contacted");
    const r = await post(`/leads/${lead.id}/status`, { status: "live" });
    expect(decodeURIComponent(r.headers.get("location")!)).toMatch(/admin verification/);
    expect(lead.status).toBe("contacted");
  });

  it("records opt-out and the lead page then forbids contact", async () => {
    const { post, get, store } = setup();
    await post("/leads", { pg_name: "B PG", phone: "9000000002" });
    const lead = [...store.leads.values()][0]!;
    await post(`/leads/${lead.id}/optout`, {});
    expect(lead.optedOut).toBe(true);
    const html = await (await get(`/leads/${lead.id}`)).text();
    expect(html).toContain("Do not contact");
    expect(html).not.toContain("Update status");
  });

  it("approves and rejects pending approvals once", async () => {
    const { post, get, store } = setup();
    const ap = store.requestApproval({ agentKey: "campaigns", action: "publish_offer", approverRole: "founder", summary: "Offer X", payload: {} });
    expect(await (await get("/approvals")).text()).toContain("Offer X");
    await post(`/approvals/${ap.id}/approved`, {});
    expect(ap.status).toBe("approved");
    expect(ap.decidedBy).toBe("Founder");
    const again = await post(`/approvals/${ap.id}/rejected`, {});
    expect(decodeURIComponent(again.headers.get("location")!)).toContain("Already decided");
    expect(ap.status).toBe("approved");
  });

  it("previews then imports CSV", async () => {
    const { post, store } = setup();
    const csv = "pg_name,phone,locality\nA PG,9000000011,HSR\nB PG,12,HSR\n";
    const prev = await (await post("/import", { csv, mode: "preview" })).text();
    expect(prev).toContain("would be created");
    expect(store.leads.size).toBe(0);
    await post("/import", { csv, mode: "commit" });
    expect(store.leads.size).toBe(1);
  });

  it("kill switch toggles and shows a banner", async () => {
    const { post, get, flags } = setup();
    await post("/settings/flag", { agent: "*", paused: "true" });
    expect(flags).toEqual([["*", true]]);
    expect(await (await get("/")).text()).toContain("ALL AI AGENTS PAUSED");
    expect((await post("/settings/flag", { agent: "made_up", paused: "true" })).status).toBe(400);
  });
});
