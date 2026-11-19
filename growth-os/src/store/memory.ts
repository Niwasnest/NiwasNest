// GrowthStore: the working set agents operate on. Every mutation goes through a method here,
// which (a) updates memory and (b) forwards the change to an optional StoreSink (Postgres).
// Call `await store.flush()` to make sure everything reached the database.
import { randomUUID } from "node:crypto";
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

/** Receives every change. Implementations must not throw synchronously. */
export interface StoreSink {
  leadInserted(l: Lead): Promise<void>;
  leadUpdated(l: Lead): Promise<void>;
  event(e: LeadEvent): Promise<void>;
  consent(c: ContactConsent): Promise<void>;
  attempt(a: ContactAttempt): Promise<void>;
  action(a: AgentActionLog): Promise<void>;
  approvalInserted(a: Approval): Promise<void>;
  approvalUpdated(a: Approval): Promise<void>;
  expense(e: Expense): Promise<void>;
}

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

  private pending: Promise<void>[] = [];
  errors: Error[] = [];
  constructor(private sink?: StoreSink) {}

  private emit(p: (s: StoreSink) => Promise<void>) {
    if (!this.sink) return;
    // Chain writes so they reach the database in the order they happened
    // (a lead must exist before its events).
    const prev = this.pending[this.pending.length - 1] ?? Promise.resolve();
    this.pending.push(prev.then(() => p(this.sink!)).catch((e: Error) => { this.errors.push(e); }));
  }

  /** Waits for all writes. Throws if any write failed, so callers never report unsaved work as done. */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
    this.pending = [];
    if (this.errors.length) {
      const msg = this.errors.map((e) => e.message).join("; ");
      this.errors = [];
      throw new Error(`database write failed: ${msg}`);
    }
  }

  createLead(input: Omit<Lead, "id" | "createdAt" | "status" | "optedOut"> & Partial<Pick<Lead, "status">>, actor: string):
    { lead: Lead; duplicates: DuplicateMatch[]; created: boolean } {
    const phone = normalizeIndianPhone(input.phoneE164) ?? undefined;
    const duplicates = findDuplicates({ ...input, phoneE164: phone }, [...this.leads.values()]);
    const exact = duplicates.find((d) => d.score >= 0.95);
    if (exact) return { lead: this.leads.get(exact.leadId)!, duplicates, created: false };
    const lead: Lead = { ...input, phoneE164: phone, id: randomUUID(), status: input.status ?? "new_lead", optedOut: false, createdAt: new Date() };
    this.leads.set(lead.id, lead);
    this.emit((s) => s.leadInserted(lead));
    this.addEvent({ leadId: lead.id, at: new Date(), actor, type: "created", to: lead.status });
    return { lead, duplicates, created: true };
  }

  /** Persist field changes made to a lead (follow-up dates, last contact, notes…). */
  saveLead(lead: Lead) {
    this.leads.set(lead.id, lead);
    const snapshot = { ...lead };
    this.emit((s) => s.leadUpdated(snapshot));
  }

  addEvent(e: LeadEvent) {
    this.events.push(e);
    this.emit((s) => s.event(e));
  }

  addConsent(c: ContactConsent) {
    this.consents.push(c);
    this.emit((s) => s.consent(c));
  }

  addAttempt(a: ContactAttempt) {
    this.attempts.push(a);
    this.emit((s) => s.attempt(a));
  }

  addExpense(e: Omit<Expense, "id">): Expense {
    const ex = { ...e, id: randomUUID() };
    this.expenses.push(ex);
    this.emit((s) => s.expense(ex));
    return ex;
  }

  setStatus(leadId: string, to: LeadStatus, actor: string, actorType: TransitionActor, detail?: string): { ok: boolean; reason?: string } {
    const lead = this.leads.get(leadId);
    if (!lead) return { ok: false, reason: "lead not found" };
    const check = canTransition(lead.status, to, actorType);
    if (!check.ok) return check;
    const from = lead.status;
    lead.status = to;
    if (to === "do_not_contact") lead.optedOut = true;
    this.saveLead(lead);
    this.addEvent({ leadId, at: new Date(), actor, type: "status_changed", from, to, detail });
    return { ok: true };
  }

  recordOptOut(leadId: string, evidence: string, actor: string) {
    const lead = this.leads.get(leadId);
    if (!lead) return;
    for (const channel of ["call", "whatsapp", "sms", "email"] as const) {
      this.addConsent({ phoneE164: lead.phoneE164, email: lead.email, channel, granted: false, evidence, capturedAt: new Date() });
    }
    const from = lead.status;
    lead.optedOut = true;
    lead.status = "do_not_contact";
    this.saveLead(lead);
    this.addEvent({ leadId, at: new Date(), actor, type: "status_changed", from, to: "do_not_contact", detail: evidence });
  }

  log(entry: Omit<AgentActionLog, "id" | "at">): AgentActionLog {
    const e = { ...entry, id: randomUUID(), at: new Date() };
    this.actions.push(e);
    this.emit((s) => s.action(e));
    return e;
  }

  requestApproval(a: Omit<Approval, "id" | "createdAt" | "status">): Approval {
    const ap: Approval = { ...a, id: randomUUID(), createdAt: new Date(), status: "pending" };
    this.approvals.push(ap);
    this.emit((s) => s.approvalInserted(ap));
    return ap;
  }

  decideApproval(approvalId: string, decision: "approved" | "rejected", by: string): Approval | undefined {
    const ap = this.approvals.find((x) => x.id === approvalId);
    if (!ap || ap.status !== "pending") return ap;
    ap.status = decision;
    ap.decidedBy = by;
    ap.decidedAt = new Date();
    this.emit((s) => s.approvalUpdated(ap));
    return ap;
  }

  countToday(agentKey: string, action: string, now = new Date()): number {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return this.actions.filter((a) => a.agentKey === agentKey && a.action === action && a.result === "done" && a.at >= start).length;
  }
}
