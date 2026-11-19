// In-memory store used by tests and dry runs. The Postgres store (db/migrations) implements
// the same shape; agents only ever talk to `GrowthStore`, never to a database driver.
import type { CommercialPolicy, Offer } from "../core/policy";
import type { ContactAttempt, ContactConsent, Lead, LeadStatus } from "../core/types";
import type { AgentAction } from "../core/permissions";
import { canTransition, type TransitionActor } from "../core/pipeline";
import { findDuplicates, type DuplicateMatch } from "../core/dedupe";
import { normalizeIndianPhone } from "../core/phone";

export interface LeadEvent {
  leadId: string;
  at: Date;
  actor: string;
  type: "created" | "status_changed" | "note" | "contact" | "merged";
  from?: LeadStatus;
  to?: LeadStatus;
  detail?: string;
}

export interface AgentActionLog {
  id: string;
  at: Date;
  agentKey: string;
  action: AgentAction | string;
  input: unknown;
  result: "done" | "dry_run" | "blocked" | "pending_approval" | "failed";
  detail?: string;
  /** Provider confirmation id (call sid, WhatsApp message id…). "done" without one is a dry run. */
  providerRef?: string;
}

export interface Approval {
  id: string;
  createdAt: Date;
  agentKey: string;
  action: AgentAction;
  approverRole: string;
  summary: string;
  payload: unknown;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: Date;
}

export interface Expense {
  id: string;
  campaignId?: string;
  trackingCode?: string;
  amountInr: number;
  description: string;
  incurredOn: Date;
}

let seq = 0;
const id = (p: string) => `${p}_${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

export class GrowthStore {
  leads = new Map<string, Lead>();
  events: LeadEvent[] = [];
  consents: ContactConsent[] = [];
  attempts: ContactAttempt[] = [];
  policies: CommercialPolicy[] = [];
  offers: Offer[] = [];
  actions: AgentActionLog[] = [];
  approvals: Approval[] = [];
  expenses: Expense[] = [];
  killSwitch = { global: false, agents: new Set<string>() };

  createLead(input: Omit<Lead, "id" | "createdAt" | "status" | "optedOut"> & Partial<Pick<Lead, "status">>, actor: string):
    { lead: Lead; duplicates: DuplicateMatch[]; created: boolean } {
    const phone = normalizeIndianPhone(input.phoneE164) ?? undefined;
    const duplicates = findDuplicates({ ...input, phoneE164: phone }, [...this.leads.values()]);
    const exact = duplicates.find((d) => d.score >= 0.95);
    if (exact) return { lead: this.leads.get(exact.leadId)!, duplicates, created: false };
    const lead: Lead = { ...input, phoneE164: phone, id: id("lead"), status: input.status ?? "new_lead", optedOut: false, createdAt: new Date() };
    this.leads.set(lead.id, lead);
    this.events.push({ leadId: lead.id, at: new Date(), actor, type: "created", to: lead.status });
    return { lead, duplicates, created: true };
  }

  setStatus(leadId: string, to: LeadStatus, actor: string, actorType: TransitionActor, detail?: string): { ok: boolean; reason?: string } {
    const lead = this.leads.get(leadId);
    if (!lead) return { ok: false, reason: "lead not found" };
    const check = canTransition(lead.status, to, actorType);
    if (!check.ok) return check;
    const from = lead.status;
    lead.status = to;
    if (to === "do_not_contact") lead.optedOut = true;
    this.events.push({ leadId, at: new Date(), actor, type: "status_changed", from, to, detail });
    return { ok: true };
  }

  recordOptOut(leadId: string, evidence: string, actor: string) {
    const lead = this.leads.get(leadId);
    if (!lead) return;
    lead.optedOut = true;
    for (const channel of ["call", "whatsapp", "sms", "email"] as const) {
      this.consents.push({ phoneE164: lead.phoneE164, email: lead.email, channel, granted: false, evidence, capturedAt: new Date() });
    }
    const from = lead.status;
    lead.status = "do_not_contact";
    this.events.push({ leadId, at: new Date(), actor, type: "status_changed", from, to: "do_not_contact", detail: evidence });
  }

  log(entry: Omit<AgentActionLog, "id" | "at">): AgentActionLog {
    const e = { ...entry, id: id("act"), at: new Date() };
    this.actions.push(e);
    return e;
  }

  requestApproval(a: Omit<Approval, "id" | "createdAt" | "status">): Approval {
    const ap: Approval = { ...a, id: id("apr"), createdAt: new Date(), status: "pending" };
    this.approvals.push(ap);
    return ap;
  }

  decideApproval(approvalId: string, decision: "approved" | "rejected", by: string): Approval | undefined {
    const ap = this.approvals.find((x) => x.id === approvalId);
    if (!ap || ap.status !== "pending") return ap;
    ap.status = decision;
    ap.decidedBy = by;
    ap.decidedAt = new Date();
    return ap;
  }

  countToday(agentKey: string, action: string, now = new Date()): number {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return this.actions.filter((a) => a.agentKey === agentKey && a.action === action && a.result === "done" && a.at >= start).length;
  }
}
