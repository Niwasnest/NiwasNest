// Postgres persistence for GrowthStore: hydrate the working set, and write every change back.
import type { CommercialPolicy, Offer } from "../core/policy";
import type { Channel, ContactAttempt, ContactConsent, Lead, LeadStatus } from "../core/types";
import { GrowthStore, type AgentActionLog, type Approval, type Expense, type LeadEvent, type StoreSink } from "./memory";
import type { SqlClient } from "./sql";

const LEAD_COLS = [
  "id", "kind", "owner_name", "pg_name", "phone_e164", "email", "address", "locality", "city", "lat", "lng",
  "property_type", "total_beds", "vacant_beds", "rent_min", "rent_max", "source", "tracking_code",
  "assigned_agent", "language", "status", "interest_level", "last_contact_at", "next_follow_up_at",
  "opted_out", "niwasnest_property_id", "notes", "created_at",
] as const;

function leadRow(l: Lead): unknown[] {
  return [
    l.id, l.kind, l.ownerName, l.pgName, l.phoneE164, l.email, l.address, l.locality, l.city, l.lat, l.lng,
    l.propertyType, l.totalBeds, l.vacantBeds, l.rentMin, l.rentMax, l.source, l.trackingCode,
    l.assignedAgent, l.language, l.status, l.interestLevel, l.lastContactAt, l.nextFollowUpAt,
    l.optedOut, l.niwasnestPropertyId, l.notes, l.createdAt,
  ];
}

type Row = Record<string, unknown>;
const d = (v: unknown) => (v == null ? undefined : new Date(v as string));
const n = (v: unknown) => (v == null ? undefined : Number(v));
const s = (v: unknown) => (v == null ? undefined : String(v));

export function rowToLead(r: Row): Lead {
  return {
    id: String(r.id), kind: r.kind as Lead["kind"], ownerName: s(r.owner_name), pgName: s(r.pg_name),
    phoneE164: s(r.phone_e164), email: s(r.email), address: s(r.address), locality: s(r.locality), city: String(r.city),
    lat: n(r.lat), lng: n(r.lng), propertyType: s(r.property_type) as Lead["propertyType"],
    totalBeds: n(r.total_beds), vacantBeds: n(r.vacant_beds), rentMin: n(r.rent_min), rentMax: n(r.rent_max),
    source: String(r.source), trackingCode: s(r.tracking_code), assignedAgent: s(r.assigned_agent),
    language: r.language as Lead["language"], status: r.status as LeadStatus, interestLevel: n(r.interest_level) as Lead["interestLevel"],
    lastContactAt: d(r.last_contact_at), nextFollowUpAt: d(r.next_follow_up_at), optedOut: Boolean(r.opted_out),
    niwasnestPropertyId: s(r.niwasnest_property_id), notes: s(r.notes), createdAt: new Date(String(r.created_at)),
  };
}

export class PostgresSink implements StoreSink {
  constructor(private db: SqlClient) {}

  async leadInserted(l: Lead) {
    const ph = LEAD_COLS.map((_, i) => `$${i + 1}`).join(",");
    await this.db.query(`insert into leads (${LEAD_COLS.join(",")}) values (${ph})`, leadRow(l));
  }
  async leadUpdated(l: Lead) {
    const cols = LEAD_COLS.filter((c) => c !== "id" && c !== "created_at");
    const row = leadRow(l);
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    const vals = cols.map((c) => row[LEAD_COLS.indexOf(c)]);
    await this.db.query(`update leads set ${set} where id = $1`, [l.id, ...vals]);
  }
  async event(e: LeadEvent) {
    await this.db.query(
      `insert into lead_events (lead_id, at, actor, type, from_status, to_status, detail) values ($1,$2,$3,$4,$5,$6,$7)`,
      [e.leadId, e.at, e.actor, e.type, e.from, e.to, e.detail],
    );
  }
  async consent(c: ContactConsent) {
    await this.db.query(
      `insert into contact_consents (phone_e164, email, channel, granted, evidence, captured_at) values ($1,$2,$3,$4,$5,$6)`,
      [c.phoneE164, c.email, c.channel, c.granted, c.evidence, c.capturedAt],
    );
  }
  async attempt(a: ContactAttempt) {
    await this.db.query(`insert into contact_attempts (lead_id, channel, at, outcome) values ($1,$2,$3,$4)`, [a.leadId, a.channel, a.at, a.outcome]);
  }
  async action(a: AgentActionLog) {
    await this.db.query(
      `insert into agent_actions (at, agent_key, action, input, result, detail, provider_ref) values ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [a.at, a.agentKey, a.action, a.input ?? null, a.result, a.detail, a.providerRef],
    );
  }
  async approvalInserted(a: Approval) {
    await this.db.query(
      `insert into approvals (id, created_at, agent_key, action, approver_role, summary, payload, status) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [a.id, a.createdAt, a.agentKey, a.action, a.approverRole, a.summary, a.payload ?? {}, a.status],
    );
  }
  async approvalUpdated(a: Approval) {
    await this.db.query(`update approvals set status = $2, decided_by_name = $3, decided_at = $4 where id = $1 and status = 'pending'`, [a.id, a.status, a.decidedBy, a.decidedAt]);
  }
  async expense(e: Expense) {
    await this.db.query(
      `insert into expenses (id, campaign_id, tracking_code, amount_inr, description, incurred_on) values ($1,$2,$3,$4,$5,$6)`,
      [e.id, e.campaignId, e.trackingCode, e.amountInr, e.description, e.incurredOn],
    );
  }
}

/** Loads the working set from the database into a GrowthStore that writes back to it. */
export async function loadStore(db: SqlClient): Promise<GrowthStore> {
  const store = new GrowthStore(new PostgresSink(db));
  const [leads, consents, attempts, policies, offers, approvals, expenses, flags] = await Promise.all([
    db.query(`select * from leads`),
    db.query(`select * from contact_consents order by captured_at`),
    db.query(`select * from contact_attempts where at > now() - interval '8 days'`),
    db.query(`select * from commercial_policies where status = 'approved'`),
    db.query(`select * from offers where status = 'approved'`),
    db.query(`select * from approvals where status = 'pending' or created_at > now() - interval '30 days'`),
    db.query(`select * from expenses`),
    db.query(`select agent_key, paused from agent_flags`),
  ]);
  for (const r of leads) {
    const l = rowToLead(r);
    store.leads.set(l.id, l);
  }
  store.consents = consents.map((r) => ({
    phoneE164: s(r.phone_e164), email: s(r.email), channel: r.channel as Channel, granted: Boolean(r.granted),
    evidence: String(r.evidence), capturedAt: new Date(String(r.captured_at)),
  }));
  store.attempts = attempts.map((r) => ({ leadId: String(r.lead_id), channel: r.channel as Channel, at: new Date(String(r.at)), outcome: s(r.outcome) }));
  store.policies = policies.map((r): CommercialPolicy => ({
    id: String(r.id),
    scope: r.niwasnest_property_id ? { kind: "property", propertyId: String(r.niwasnest_property_id) } : { kind: "default" },
    type: r.type as CommercialPolicy["type"], percent: n(r.percent), flatInr: n(r.flat_inr),
    appliesToMonths: r.applies_to_months as CommercialPolicy["appliesToMonths"], approvedWording: String(r.approved_wording),
    status: r.status as CommercialPolicy["status"], isHistorical: Boolean(r.is_historical),
    approvedBy: s(r.approved_by) ?? s(r.approved_by_name), approvedAt: d(r.approved_at),
    effectiveFrom: new Date(String(r.effective_from)), effectiveTo: d(r.effective_to),
  }));
  store.offers = offers.map((r): Offer => ({
    id: String(r.id), name: String(r.name), audience: r.audience as Offer["audience"], startsAt: new Date(String(r.starts_at)),
    endsAt: new Date(String(r.ends_at)), eligibility: String(r.eligibility), reward: String(r.reward), budgetInr: Number(r.budget_inr),
    maxRedemptions: Number(r.max_redemptions), redemptions: Number(r.redemptions), trackingCode: String(r.tracking_code),
    terms: String(r.terms), status: r.status as Offer["status"], approvedBy: s(r.approved_by) ?? s(r.approved_by_name),
  }));
  store.approvals = approvals.map((r): Approval => ({
    id: String(r.id), createdAt: new Date(String(r.created_at)), agentKey: String(r.agent_key), action: r.action as Approval["action"],
    approverRole: String(r.approver_role), summary: String(r.summary), payload: r.payload, status: r.status as Approval["status"],
    decidedBy: s(r.decided_by_name), decidedAt: d(r.decided_at),
  }));
  store.expenses = expenses.map((r) => ({
    id: String(r.id), campaignId: s(r.campaign_id), trackingCode: s(r.tracking_code), amountInr: Number(r.amount_inr),
    description: String(r.description), incurredOn: new Date(String(r.incurred_on)),
  }));
  for (const f of flags) {
    if (!f.paused) continue;
    if (f.agent_key === "*") store.killSwitch.global = true;
    else store.killSwitch.agents.add(String(f.agent_key));
  }
  return store;
}
