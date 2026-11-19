// Growth OS founder console. Separate web app on its own subdomain; talks only to the Growth OS DB.
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { AGENTS } from "../agents/definitions";
import { parseCsv } from "../core/csv";
import { canTransition, STATUS_LABELS } from "../core/pipeline";
import { LEAD_STATUSES, type Lead, type LeadStatus } from "../core/types";
import { importLeads } from "../planning/import-leads";
import { buildDailyPlan, campaignRoi } from "../planning/daily-plan";
import { GrowthStore, type AgentActionLog } from "../store/memory";
import { createSessionToken, LoginThrottle, readSessionToken, verifyPassword, type Session } from "./auth";
import { csrfField, esc, inr, page, statusChip } from "./views";

export interface WebDeps {
  openStore(): Promise<GrowthStore>;
  setAgentFlag(agentKey: string, paused: boolean, by: string): Promise<void>;
  recentActions(limit: number): Promise<AgentActionLog[]>;
  auth: { user: string; passwordHash: string; sessionSecret: string; secureCookies: boolean };
  now?: () => Date;
}

type Env = { Variables: { session: Session } };
const COOKIE = "gos_session";
const HUMAN_STATUSES = LEAD_STATUSES.filter((s) => s !== "approved" && s !== "live");

function clientKey(c: Context): string {
  return (c.req.header("x-forwarded-for") ?? "").split(",")[0]!.trim() || "local";
}

function redirect(c: Context, to: string, kind?: "ok" | "bad", msg?: string) {
  const q = msg ? `${to.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}` : "";
  return c.redirect(`${to}${q}`, 303);
}

function flashOf(c: Context): { kind: "ok" | "bad"; text: string } | undefined {
  const ok = c.req.query("ok");
  const bad = c.req.query("bad");
  return ok ? { kind: "ok", text: ok } : bad ? { kind: "bad", text: bad } : undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function createApp(deps: WebDeps) {
  const app = new Hono<Env>();
  const now = deps.now ?? (() => new Date());
  const throttle = new LoginThrottle();

  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
  });

  app.get("/healthz", (c) => c.text("ok"));

  // ---- login -------------------------------------------------------------
  const loginPage = (c: Context, error?: string) =>
    c.html(page({
      title: "Log in", path: "/login", anon: true, flash: error ? { kind: "bad", text: error } : undefined,
      body: `<div class="card" style="max-width:380px;margin:40px auto"><h1>Founder login</h1>
<form method="post" action="/login"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<p><button class="btn primary" type="submit" style="width:100%">Log in</button></p></form></div>`,
    }), error ? 401 : 200);

  app.get("/login", (c) => loginPage(c));
  app.post("/login", async (c) => {
    const key = clientKey(c);
    if (throttle.blocked(key)) return loginPage(c, "Too many attempts. Try again in 15 minutes.");
    const body = await c.req.parseBody();
    if (!verifyPassword(str(body.password), deps.auth.passwordHash)) {
      throttle.fail(key);
      return loginPage(c, "Wrong password.");
    }
    throttle.reset(key);
    const { token } = createSessionToken(deps.auth.user, deps.auth.sessionSecret);
    setCookie(c, COOKIE, token, { httpOnly: true, secure: deps.auth.secureCookies, sameSite: "Strict", path: "/", maxAge: 12 * 3600 });
    return c.redirect("/", 303);
  });

  // ---- auth + CSRF for everything else -----------------------------------
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/login" || p === "/healthz") return next();
    const s = readSessionToken(getCookie(c, COOKIE), deps.auth.sessionSecret);
    if (!s) return c.req.method === "GET" ? c.redirect("/login", 303) : c.text("Not logged in", 401);
    if (c.req.method === "POST") {
      const body = await c.req.parseBody();
      if (str(body._csrf) !== s.csrf) return c.text("Invalid form token. Go back, reload and try again.", 403);
    }
    c.set("session", s);
    return next();
  });

  app.post("/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login", 303);
  });

  const render = (c: Context<Env>, store: GrowthStore, title: string, path: string, body: string) =>
    c.html(page({ title, path, body, flash: flashOf(c), killed: store.killSwitch.global, pending: store.approvals.filter((a) => a.status === "pending").length }));

  // ---- Today -------------------------------------------------------------
  app.get("/", async (c) => {
    const store = await deps.openStore();
    const plan = buildDailyPlan(store, now());
    const f = plan.funnel;
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
    const contactLinks = (l: Lead) =>
      l.phoneE164 ? `<a class="btn small" href="tel:${esc(l.phoneE164)}">Call</a> <a class="btn small" href="https://wa.me/${esc(l.phoneE164.slice(1))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : "";
    const roi = campaignRoi(store);
    const body = `<h1>Today · ${esc(plan.date)}</h1>
<div class="grid">
 <div class="stat hero"><b>${f.live}</b><span>Live PGs (from Growth OS leads)</span></div>
 <div class="stat"><b>${f.interested}</b><span>Interested owners</span></div>
 <div class="stat"><b>${f.onboardingStarted}</b><span>Onboarding started</span></div>
 <div class="stat"><b>${f.verificationPending}</b><span>Awaiting your verification</span></div>
 <div class="stat"><b>${plan.pendingApprovals}</b><span><a href="/approvals">Approvals waiting</a></span></div>
 <div class="stat"><b>${pct(f.live, f.leads)}</b><span>Lead → Live (${f.leads} leads)</span></div>
</div>
<h2>Call today (${plan.callList.length})</h2>
${plan.callList.length ? `<div class="list">${plan.callList.map(({ lead, why }) => `<div class="card"><div class="row"><div class="grow"><a href="/leads/${esc(lead.id)}"><b>${esc(lead.pgName ?? lead.ownerName ?? "Lead")}</b></a><div class="muted small">${esc(lead.locality ?? "")} · ${esc(why)}</div></div>${contactLinks(lead)}</div></div>`).join("")}</div>`
      : `<p class="muted">Nobody to call. Leads appear here once they have a phone, consent to calls and a due follow-up. <a href="/import">Import leads</a>.</p>`}
<h2>Finish onboarding (${plan.onboardingToChase.length})</h2>
${plan.onboardingToChase.map((l) => `<div class="card row"><div class="grow"><a href="/leads/${esc(l.id)}">${esc(l.pgName ?? l.id)}</a> ${statusChip(l.status)}</div>${contactLinks(l)}</div>`).join("") || `<p class="muted">None.</p>`}
${plan.blockedFromContact.length ? `<p class="muted small">${plan.blockedFromContact.length} lead(s) due but not contactable today (no consent, limits or opted out).</p>` : ""}
<h2>Campaign ROI</h2>
${roi.length ? `<div class="card" style="overflow-x:auto"><table><tr><th>Tracking code</th><th>Spend</th><th>Leads</th><th>Live PGs</th><th>₹ / live PG</th></tr>${roi.map((r) => `<tr><td>${esc(r.trackingCode)}</td><td>${inr(r.spendInr)}</td><td>${r.leads}</td><td>${r.live}</td><td>${r.costPerLivePgInr == null ? "–" : inr(r.costPerLivePgInr)}</td></tr>`).join("")}</table></div>` : `<p class="muted">No tracked campaigns yet. Give each sticker or QR a tracking code and record what you spend.</p>`}
<h2>Areas with most leads not yet live</h2>
<p>${plan.localityGaps.filter((g) => g.leads - g.live > 0).map((g) => `<span class="chip">${esc(g.locality)} · ${g.leads - g.live}</span>`).join(" ") || `<span class="muted">–</span>`}</p>`;
    return render(c, store, "Today", "/", body);
  });

  // ---- Approvals -----------------------------------------------------------
  app.get("/approvals", async (c) => {
    const store = await deps.openStore();
    const s = c.get("session");
    const pending = store.approvals.filter((a) => a.status === "pending").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const decided = store.approvals.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0)).slice(0, 15);
    const body = `<h1>Approvals</h1>
<p class="muted small">Agents can't spend money, publish offers, send unapproved emails or change commission without you. Approving here records your decision; it does not sign agreements or approve listings (do that in the main admin panel).</p>
${pending.map((a) => `<div class="card"><div class="row"><span class="chip">${esc(a.approverRole)}</span><b class="grow">${esc(a.summary)}</b></div>
<div class="muted small">${esc(a.action)} · requested by ${esc(a.agentKey)} · ${esc(a.createdAt.toISOString().slice(0, 16).replace("T", " "))} UTC</div>
<details><summary class="small">Details</summary><pre>${esc(JSON.stringify(a.payload, null, 2))}</pre></details>
<div class="row" style="margin-top:8px">
<form method="post" action="/approvals/${esc(a.id)}/approved">${csrfField(s.csrf)}<button class="btn ok" type="submit">Approve</button></form>
<form method="post" action="/approvals/${esc(a.id)}/rejected">${csrfField(s.csrf)}<button class="btn danger" type="submit">Reject</button></form></div></div>`).join("") || `<div class="card muted">Nothing waiting for you.</div>`}
${decided.length ? `<h2>Recently decided</h2><div class="card" style="overflow-x:auto"><table><tr><th>Decision</th><th>Item</th><th>By</th></tr>${decided.map((a) => `<tr><td>${esc(a.status)}</td><td>${esc(a.summary)}</td><td>${esc(a.decidedBy ?? "")}</td></tr>`).join("")}</table></div>` : ""}`;
    return render(c, store, "Approvals", "/approvals", body);
  });

  app.post("/approvals/:id/:decision", async (c) => {
    const decision = c.req.param("decision");
    if (decision !== "approved" && decision !== "rejected") return c.text("bad decision", 400);
    const store = await deps.openStore();
    const user = c.get("session").user;
    const existing = store.approvals.find((a) => a.id === c.req.param("id"));
    if (!existing) return redirect(c, "/approvals", "bad", "Approval not found.");
    if (existing.status !== "pending") return redirect(c, "/approvals", "bad", `Already decided (${existing.status}).`);
    const ap = store.decideApproval(existing.id, decision, user)!;
    store.log({ agentKey: `human:${user}`, action: `approval_${decision}`, input: { id: ap.id }, result: "done", providerRef: "console" });
    await store.flush();
    return redirect(c, "/approvals", "ok", `${decision === "approved" ? "Approved" : "Rejected"}: ${ap.summary}`);
  });

  // ---- Leads ---------------------------------------------------------------
  app.get("/leads", async (c) => {
    const store = await deps.openStore();
    const status = c.req.query("status") ?? "";
    const q = (c.req.query("q") ?? "").toLowerCase();
    let leads = [...store.leads.values()];
    if (status) leads = leads.filter((l) => l.status === status);
    if (q) leads = leads.filter((l) => [l.pgName, l.ownerName, l.locality, l.phoneE164].some((v) => v?.toLowerCase().includes(q)));
    leads.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const shown = leads.slice(0, 200);
    const body = `<h1>Leads <span class="muted small">(${leads.length})</span></h1>
<form method="get" class="row" style="margin-bottom:12px"><input class="grow" name="q" placeholder="Search name, area, phone" value="${esc(q)}" style="flex:2;min-width:160px">
<select name="status" style="flex:1;min-width:140px"><option value="">All statuses</option>${LEAD_STATUSES.map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${esc(STATUS_LABELS[s])}</option>`).join("")}</select>
<button class="btn" type="submit">Filter</button></form>
<div class="list">${shown.map((l) => `<a class="card" href="/leads/${esc(l.id)}"><div class="row"><b class="grow">${esc(l.pgName ?? l.ownerName ?? "Lead")}</b>${statusChip(l.status)}</div>
<div class="muted small">${esc([l.ownerName, l.locality, l.vacantBeds != null ? `${l.vacantBeds} vacant beds` : "", l.source].filter(Boolean).join(" · "))}</div></a>`).join("") || `<div class="card muted">No leads${status || q ? " match this filter" : " yet — <a href=\"/leads/new\">add one</a> or <a href=\"/import\">import a spreadsheet</a>"}.</div>`}</div>
${leads.length > shown.length ? `<p class="muted small">Showing first ${shown.length}. Narrow the filter to see more.</p>` : ""}`;
    return render(c, store, "Leads", "/leads", body);
  });

  const leadForm = (csrf: string) => `<form method="post" action="/leads">${csrfField(csrf)}<div class="fields">
<div><label>PG name</label><input name="pg_name" required></div><div><label>Owner name</label><input name="owner_name"></div>
<div><label>Mobile</label><input name="phone" inputmode="tel" placeholder="98480 12345"></div><div><label>Locality</label><input name="locality" placeholder="BTM Layout"></div>
<div><label>Address</label><input name="address"></div>
<div><label>PG type</label><select name="property_type"><option value="">–</option><option value="male">Male</option><option value="female">Female</option><option value="co_living">Co-living</option><option value="other">Other</option></select></div>
<div><label>Total beds</label><input name="total_beds" inputmode="numeric"></div><div><label>Vacant beds</label><input name="vacant_beds" inputmode="numeric"></div>
<div><label>Language</label><select name="language"><option value="te">Telugu</option><option value="en">English</option><option value="kn">Kannada</option><option value="hi">Hindi</option></select></div>
<div><label>Source</label><input name="source" value="field_visit"></div><div><label>Tracking code (QR/sticker)</label><input name="tracking_code"></div>
</div>
<div class="card" style="margin-top:12px"><b>Consent</b><p class="muted small" style="margin:4px 0">Tick only if the owner agreed. Record how and when; without that, nothing is recorded.</p>
<label><input type="checkbox" name="consent_call" value="yes" style="width:auto;min-height:0"> Agreed to calls</label>
<label><input type="checkbox" name="consent_whatsapp" value="yes" style="width:auto;min-height:0"> Agreed to WhatsApp</label>
<label>How / when they agreed</label><input name="consent_evidence" placeholder="In person at field visit, 19 Nov"></div>
<label>Notes</label><textarea name="notes" rows="2"></textarea>
<p><button class="btn primary" type="submit">Save lead</button></p></form>`;

  app.get("/leads/new", async (c) => {
    const store = await deps.openStore();
    return render(c, store, "Add lead", "/leads/new", `<h1>Add a PG owner</h1><div class="card">${leadForm(c.get("session").csrf)}</div>`);
  });

  app.post("/leads", async (c) => {
    const b = await c.req.parseBody();
    const store = await deps.openStore();
    const rep = importLeads(store, [Object.fromEntries(Object.entries(b).map(([k, v]) => [k, str(v)]))], `human:${c.get("session").user}`, now());
    if (rep.invalid[0]) return redirect(c, "/leads/new", "bad", rep.invalid[0].reason);
    await store.flush();
    if (rep.skippedDuplicates[0]) return redirect(c, `/leads/${rep.skippedDuplicates[0].existingId}`, "bad", `Already in CRM (${rep.skippedDuplicates[0].reason}). Showing the existing lead.`);
    const lead = rep.created[0]!;
    const warn = rep.possibleDuplicates.length ? " Possible duplicate — check before calling." : "";
    return redirect(c, `/leads/${lead.id}`, "ok", `Saved.${rep.consentsRecorded ? ` ${rep.consentsRecorded} consent(s) recorded.` : ""}${warn}`);
  });

  app.get("/leads/:id", async (c) => {
    const store = await deps.openStore();
    const l = store.leads.get(c.req.param("id"));
    if (!l) return c.html(page({ title: "Not found", path: "/leads", body: `<h1>Lead not found</h1>` }), 404);
    const csrf = c.get("session").csrf;
    const allowed = HUMAN_STATUSES.filter((s) => s !== l.status && canTransition(l.status, s, "human").ok);
    const consents = store.consents.filter((x) => (l.phoneE164 && x.phoneE164 === l.phoneE164) || (l.email && x.email === l.email));
    const body = `<p><a href="/leads">← Leads</a></p><h1>${esc(l.pgName ?? l.ownerName ?? "Lead")} ${statusChip(l.status)}</h1>
<div class="card"><table>
${([["Owner", l.ownerName], ["Mobile", l.phoneE164], ["Locality", l.locality], ["Address", l.address], ["Type", l.propertyType], ["Beds", l.totalBeds != null ? `${l.totalBeds} total, ${l.vacantBeds ?? "?"} vacant` : undefined], ["Language", l.language], ["Source", l.source], ["Tracking code", l.trackingCode], ["Next follow-up", l.nextFollowUpAt?.toISOString().slice(0, 16).replace("T", " ")], ["Main app property", l.niwasnestPropertyId], ["Notes", l.notes]] as [string, unknown][])
      .filter(([, v]) => v != null && v !== "").map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}
</table>${l.phoneE164 ? `<p class="row"><a class="btn" href="tel:${esc(l.phoneE164)}">Call</a><a class="btn" href="https://wa.me/${esc(l.phoneE164.slice(1))}" target="_blank" rel="noopener noreferrer">WhatsApp</a></p>` : ""}</div>
${l.optedOut ? `<div class="flash bad">Opted out. Do not contact this person.</div>` : `
<h2>Update status</h2><div class="card">${allowed.length ? `<form method="post" action="/leads/${esc(l.id)}/status" class="row">${csrfField(csrf)}<select name="status" class="grow">${allowed.map((s) => `<option value="${s}">${esc(STATUS_LABELS[s])}</option>`).join("")}</select><input name="note" placeholder="Note (optional)" class="grow"><button class="btn primary" type="submit">Update</button></form>` : `<span class="muted">No manual changes from this status.</span>`}
<p class="muted small">Approved and Live are set only when the listing is approved in the main NiwasNest admin panel.</p></div>
<h2>Follow-up</h2><div class="card"><form method="post" action="/leads/${esc(l.id)}/followup" class="row">${csrfField(csrf)}<input type="datetime-local" name="at" required class="grow"><input name="note" placeholder="Why" class="grow"><button class="btn" type="submit">Schedule</button></form></div>
<h2>Record consent</h2><div class="card"><form method="post" action="/leads/${esc(l.id)}/consent">${csrfField(csrf)}<div class="row"><select name="channel" style="flex:1"><option value="call">Calls</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">Email</option></select><input name="evidence" required placeholder="How/when they agreed" style="flex:3"><button class="btn" type="submit">Save</button></div></form></div>
<form method="post" action="/leads/${esc(l.id)}/optout" style="margin-top:12px">${csrfField(csrf)}<button class="btn danger" type="submit">Owner asked not to be contacted</button></form>`}
<h2>Consent record</h2><div class="card">${consents.map((x) => `<div class="small">${x.granted ? "✓ granted" : "✗ withdrawn"} · ${esc(x.channel)} · ${esc(x.evidence)} · ${esc(x.capturedAt.toISOString().slice(0, 10))}</div>`).join("") || `<span class="muted small">No consent recorded. Agents will not call or WhatsApp this owner first.</span>`}</div>`;
    return render(c, store, l.pgName ?? "Lead", "/leads", body);
  });

  const withLead = async (c: Context<Env>, fn: (store: GrowthStore, l: Lead, b: Record<string, string>, user: string) => string | undefined) => {
    const b = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, str(v)]));
    const store = await deps.openStore();
    const l = store.leads.get(c.req.param("id") ?? "");
    if (!l) return c.text("lead not found", 404);
    const user = c.get("session").user;
    const err = fn(store, l, b, user);
    if (err) return redirect(c, `/leads/${l.id}`, "bad", err);
    await store.flush();
    return redirect(c, `/leads/${l.id}`, "ok", "Saved.");
  };

  app.post("/leads/:id/status", (c) =>
    withLead(c, (store, l, b, user) => {
      if (!(LEAD_STATUSES as readonly string[]).includes(b.status ?? "")) return "Unknown status.";
      const r = store.setStatus(l.id, b.status as LeadStatus, `human:${user}`, "human", b.note || undefined);
      return r.ok ? undefined : r.reason;
    }));

  app.post("/leads/:id/followup", (c) =>
    withLead(c, (store, l, b, user) => {
      // datetime-local has no zone; the founder works in IST.
      const at = new Date(`${b.at}:00+05:30`);
      if (Number.isNaN(at.getTime())) return "Invalid date.";
      l.nextFollowUpAt = at;
      store.saveLead(l);
      store.addEvent({ leadId: l.id, at: now(), actor: `human:${user}`, type: "note", detail: `follow-up ${b.at} IST: ${b.note ?? ""}` });
      return undefined;
    }));

  app.post("/leads/:id/consent", (c) =>
    withLead(c, (store, l, b, user) => {
      if (!["call", "whatsapp", "sms", "email"].includes(b.channel ?? "")) return "Unknown channel.";
      if (!b.evidence) return "Write how and when they agreed.";
      if (b.channel === "email" ? !l.email : !l.phoneE164) return "This lead has no contact for that channel.";
      store.addConsent({ phoneE164: l.phoneE164, email: l.email, channel: b.channel as "call", granted: true, evidence: `${b.evidence} (recorded by ${user})`, capturedAt: now() });
      return undefined;
    }));

  app.post("/leads/:id/optout", (c) =>
    withLead(c, (store, l, _b, user) => {
      store.recordOptOut(l.id, `owner request recorded by ${user}`, `human:${user}`);
      return undefined;
    }));

  // ---- Import ----------------------------------------------------------------
  const importForm = (csrf: string, csv = "") => `<form method="post" action="/import" enctype="multipart/form-data">${csrfField(csrf)}
<label>CSV file</label><input type="file" name="file" accept=".csv,text/csv">
<label>…or paste CSV</label><textarea name="csv" rows="6" placeholder="owner_name,pg_name,phone,locality,...">${esc(csv)}</textarea>
<div class="row" style="margin-top:10px"><button class="btn" name="mode" value="preview" type="submit">Preview</button><button class="btn primary" name="mode" value="commit" type="submit">Import</button></div></form>`;

  app.get("/import", async (c) => {
    const store = await deps.openStore();
    return render(c, store, "Import", "/import", `<h1>Import leads</h1>
<p class="muted small">Columns: owner_name, pg_name, phone, email, address, locality, city, property_type, total_beds, vacant_beds, rent_min, rent_max, language, source, tracking_code, consent_call, consent_whatsapp, consent_evidence, notes. Duplicates are skipped automatically. Consent is recorded only when consent_evidence is filled.</p>
<div class="card">${importForm(c.get("session").csrf)}</div>`);
  });

  app.post("/import", async (c) => {
    const b = await c.req.parseBody();
    const file = b.file;
    let text = str(b.csv);
    if (file instanceof File && file.size > 0) {
      if (file.size > 2_000_000) return redirect(c, "/import", "bad", "File too large (max 2 MB).");
      text = await file.text();
    }
    if (!text) return redirect(c, "/import", "bad", "Choose a CSV file or paste CSV text.");
    const rows = parseCsv(text);
    if (rows.length > 5000) return redirect(c, "/import", "bad", "Max 5,000 rows per import.");
    const live = await deps.openStore();
    const commit = str(b.mode) === "commit";
    const store = commit ? live : Object.assign(new GrowthStore(), { leads: new Map(live.leads) });
    const rep = importLeads(store, rows, `human:${c.get("session").user}`, now());
    if (commit) await store.flush();
    const body = `<h1>${commit ? "Imported" : "Preview"}</h1>
<div class="grid"><div class="stat hero"><b>${rep.created.length}</b><span>${commit ? "created" : "would be created"}</span></div><div class="stat"><b>${rep.skippedDuplicates.length}</b><span>already in CRM</span></div><div class="stat"><b>${rep.invalid.length}</b><span>invalid rows</span></div><div class="stat"><b>${rep.consentsRecorded}</b><span>consents with evidence</span></div></div>
${[...rep.invalid.map((x) => `Row ${x.row}: ${x.reason}`), ...rep.skippedDuplicates.map((x) => `Row ${x.row} "${x.name}": already in CRM (${x.reason})`), ...rep.possibleDuplicates.map((x) => `Row ${x.row} "${x.name}": possible duplicate — check`)].map((t) => `<div class="small">${esc(t)}</div>`).join("")}
${commit ? `<p><a class="btn primary" href="/leads">See leads</a></p>` : `<div class="card" style="margin-top:12px">${importForm(c.get("session").csrf, text)}</div>`}`;
    return render(c, live, commit ? "Imported" : "Preview", "/import", body);
  });

  // ---- AI activity -------------------------------------------------------------
  app.get("/activity", async (c) => {
    const [store, actions] = await Promise.all([deps.openStore(), deps.recentActions(100)]);
    const body = `<h1>AI activity</h1><p class="muted small">Every agent action, newest first. "dry run" means nothing was actually sent (no provider connected).</p>
<div class="card" style="overflow-x:auto"><table><tr><th>When (UTC)</th><th>Agent</th><th>Action</th><th>Result</th><th>Detail</th></tr>
${actions.map((a) => `<tr><td class="small">${esc(a.at.toISOString().slice(0, 16).replace("T", " "))}</td><td>${esc(a.agentKey)}</td><td>${esc(a.action)}</td><td><span class="chip">${esc(a.result.replace("_", " "))}</span></td><td class="small">${esc(a.detail ?? a.providerRef ?? "")}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No activity yet.</td></tr>`}</table></div>`;
    return render(c, store, "AI activity", "/activity", body);
  });

  // ---- Controls (kill switch) -------------------------------------------------
  app.get("/settings", async (c) => {
    const store = await deps.openStore();
    const csrf = c.get("session").csrf;
    const toggle = (key: string, label: string, paused: boolean) => `<div class="card row"><div class="grow"><b>${esc(label)}</b><div class="muted small">${paused ? "Paused" : "Running"}</div></div>
<form method="post" action="/settings/flag">${csrfField(csrf)}<input type="hidden" name="agent" value="${esc(key)}"><input type="hidden" name="paused" value="${paused ? "false" : "true"}"><button class="btn ${paused ? "ok" : "danger"}" type="submit">${paused ? "Resume" : "Pause"}</button></form></div>`;
    const body = `<h1>Controls</h1><p class="muted small">Pausing stops an agent before its next action. Opt-out requests are always honoured, even while paused.</p>
${toggle("*", "EVERYTHING (global kill switch)", store.killSwitch.global)}
<h2>Agents</h2>${Object.values(AGENTS).map((a) => toggle(a.key, a.name, store.killSwitch.agents.has(a.key))).join("")}`;
    return render(c, store, "Controls", "/settings", body);
  });

  app.post("/settings/flag", async (c) => {
    const b = await c.req.parseBody();
    const agent = str(b.agent);
    if (agent !== "*" && !AGENTS[agent]) return c.text("unknown agent", 400);
    const paused = str(b.paused) === "true";
    await deps.setAgentFlag(agent, paused, c.get("session").user);
    return redirect(c, "/settings", "ok", `${agent === "*" ? "All agents" : AGENTS[agent]!.name}: ${paused ? "paused" : "resumed"}.`);
  });

  return app;
}

