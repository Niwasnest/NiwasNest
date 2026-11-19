// The tools agents may call. Every side effect goes through: kill switch → permission gate
// → consent gate → channel adapter → audit log. "done" is recorded only with a provider ref.
import { canContact, isOptOutMessage } from "../core/consent";
import { gate, type AgentAction } from "../core/permissions";
import { getActiveOffers, getCommercialPolicy, type Offer } from "../core/policy";
import { LEAD_STATUSES, type Channel, type Lead, type LeadStatus } from "../core/types";
import { renderContext, retrieve, type KbEntry } from "../core/knowledge";
import type { GrowthStore } from "../store/memory";
import type { ToolSpec } from "./llm";

export interface ChannelSender {
  /** Returns the provider's message/call id. Must throw if the provider did not accept it. */
  send(lead: Lead, channel: Channel, content: { templateKey?: string; text?: string }): Promise<{ providerRef: string }>;
}

export interface ToolContext {
  store: GrowthStore;
  kb: KbEntry[];
  agentKey: string;
  now: () => Date;
  sender?: ChannelSender; // absent → dry run
  isReplyToInbound?: boolean;
  onDnd?: (phoneE164: string) => boolean;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

interface Tool {
  spec: ToolSpec;
  action?: AgentAction;
  handler: Handler;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function permit(ctx: ToolContext, action: AgentAction, summary: string, payload: unknown): { ok: true } | { ok: false; message: string } {
  const decision = gate({
    action,
    agentKey: ctx.agentKey,
    killSwitch: ctx.store.killSwitch,
    usedToday: ctx.store.countToday(ctx.agentKey, action, ctx.now()),
  });
  if (decision.decision === "allow") return { ok: true };
  if (decision.decision === "deny") {
    ctx.store.log({ agentKey: ctx.agentKey, action, input: payload, result: "blocked", detail: decision.reason });
    return { ok: false, message: `BLOCKED: ${decision.reason}` };
  }
  const ap = ctx.store.requestApproval({ agentKey: ctx.agentKey, action, approverRole: decision.approverRole, summary, payload });
  ctx.store.log({ agentKey: ctx.agentKey, action, input: payload, result: "pending_approval", detail: ap.id });
  return { ok: false, message: `PENDING_APPROVAL (${ap.id}) by ${decision.approverRole}. Tell the person you will confirm; do not say it is done.` };
}

function lead(ctx: ToolContext, args: Record<string, unknown>): Lead {
  const l = ctx.store.leads.get(str(args.lead_id));
  if (!l) throw new Error(`lead ${str(args.lead_id)} not found`);
  return l;
}

export const TOOLS: Record<string, Tool> = {
  kb_search: {
    spec: {
      name: "kb_search",
      description: "Search the approved NiwasNest knowledge base (product, scripts, objections, FAQs, brand). Use before answering any factual question.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    handler: async (args, ctx) => {
      const hits = retrieve(ctx.kb, str(args.query));
      return hits.length ? renderContext(hits) : "NO_APPROVED_ANSWER — say you will check with the team.";
    },
  },

  get_commercial_policy: {
    spec: {
      name: "get_commercial_policy",
      description: "Get the approved commission/fee for a property. The ONLY source of commission numbers.",
      parameters: { type: "object", properties: { property_id: { type: "string" } } },
    },
    handler: async (args, ctx) => {
      const a = getCommercialPolicy(ctx.store.policies, "first_month_commission", str(args.property_id) || undefined, ctx.now());
      return a.known ? `APPROVED (${a.source}): ${a.policy.approvedWording}` : `UNKNOWN: ${a.reason}. Say exactly: "${a.safeReply}"`;
    },
  },

  get_active_offers: {
    spec: {
      name: "get_active_offers",
      description: "List currently approved offers for an audience. Never mention an offer not returned here.",
      parameters: { type: "object", properties: { audience: { type: "string", enum: ["pg_owner", "student", "institution", "influencer"] } }, required: ["audience"] },
    },
    handler: async (args, ctx) => {
      const offers = getActiveOffers(ctx.store.offers, str(args.audience) as Offer["audience"], ctx.now());
      return offers.length ? offers.map((o) => `${o.name}: ${o.reward}. Eligibility: ${o.eligibility}. T&C: ${o.terms}`).join("\n") : "NO_ACTIVE_OFFERS";
    },
  },

  update_lead_status: {
    action: "update_crm",
    spec: {
      name: "update_lead_status",
      description: "Move a lead in the sales pipeline. Cannot set approved/live (only admin verification can).",
      parameters: {
        type: "object",
        properties: { lead_id: { type: "string" }, status: { type: "string", enum: [...LEAD_STATUSES] }, note: { type: "string" } },
        required: ["lead_id", "status"],
      },
    },
    handler: async (args, ctx) => {
      const p = permit(ctx, "update_crm", "update lead", args);
      if (!p.ok) return p.message;
      const r = ctx.store.setStatus(str(args.lead_id), str(args.status) as LeadStatus, ctx.agentKey, "agent", str(args.note));
      ctx.store.log({ agentKey: ctx.agentKey, action: "update_crm", input: args, result: r.ok ? "done" : "blocked", detail: r.reason, providerRef: r.ok ? "crm" : undefined });
      return r.ok ? "OK" : `REJECTED: ${r.reason}`;
    },
  },

  record_opt_out: {
    action: "update_crm",
    spec: {
      name: "record_opt_out",
      description: "Call immediately if the person asks not to be contacted. Stops all channels.",
      parameters: { type: "object", properties: { lead_id: { type: "string" }, evidence: { type: "string" } }, required: ["lead_id", "evidence"] },
    },
    // Opt-outs are honoured even when the kill switch is on.
    handler: async (args, ctx) => {
      ctx.store.recordOptOut(str(args.lead_id), str(args.evidence), ctx.agentKey);
      ctx.store.log({ agentKey: ctx.agentKey, action: "update_crm", input: args, result: "done", detail: "opt-out recorded", providerRef: "crm" });
      return "OPT_OUT_RECORDED. Apologise briefly, confirm they will not be contacted again, and end the conversation.";
    },
  },

  send_message: {
    action: "send_routine_message",
    spec: {
      name: "send_message",
      description: "Send an approved WhatsApp template or a reply inside an open conversation.",
      parameters: {
        type: "object",
        properties: { lead_id: { type: "string" }, channel: { type: "string", enum: ["whatsapp", "sms"] }, template_key: { type: "string" }, text: { type: "string" } },
        required: ["lead_id", "channel"],
      },
    },
    handler: async (args, ctx) => {
      const l = lead(ctx, args);
      const channel = str(args.channel) as Channel;
      const consent = canContact({
        lead: l,
        channel,
        now: ctx.now(),
        consents: ctx.store.consents,
        attempts: ctx.store.attempts,
        onDndRegister: l.phoneE164 ? ctx.onDnd?.(l.phoneE164) : false,
        isReplyToInbound: ctx.isReplyToInbound,
      });
      if (!consent.allowed) {
        ctx.store.log({ agentKey: ctx.agentKey, action: "send_routine_message", input: args, result: "blocked", detail: consent.reason });
        return `BLOCKED: ${consent.reason}`;
      }
      if (!ctx.isReplyToInbound && !args.template_key) return "REJECTED: business-initiated WhatsApp/SMS must use an approved template_key";
      const p = permit(ctx, "send_routine_message", "send message", args);
      if (!p.ok) return p.message;
      if (!ctx.sender) {
        ctx.store.log({ agentKey: ctx.agentKey, action: "send_routine_message", input: args, result: "dry_run", detail: "no channel provider configured" });
        return "DRY_RUN: not actually sent (no provider configured). Do not tell the person it was sent.";
      }
      try {
        const { providerRef } = await ctx.sender.send(l, channel, { templateKey: str(args.template_key) || undefined, text: str(args.text) || undefined });
        ctx.store.addAttempt({ leadId: l.id, channel, at: ctx.now() });
        l.lastContactAt = ctx.now();
        ctx.store.saveLead(l);
        ctx.store.log({ agentKey: ctx.agentKey, action: "send_routine_message", input: args, result: "done", providerRef });
        return `SENT (${providerRef})`;
      } catch (e) {
        ctx.store.log({ agentKey: ctx.agentKey, action: "send_routine_message", input: args, result: "failed", detail: (e as Error).message });
        return `FAILED: ${(e as Error).message}`;
      }
    },
  },

  schedule_followup: {
    action: "schedule_followup",
    spec: {
      name: "schedule_followup",
      description: "Schedule the next contact (e.g. a callback the owner asked for).",
      parameters: { type: "object", properties: { lead_id: { type: "string" }, in_hours: { type: "number" }, note: { type: "string" } }, required: ["lead_id", "in_hours"] },
    },
    handler: async (args, ctx) => {
      const p = permit(ctx, "schedule_followup", "schedule follow-up", args);
      if (!p.ok) return p.message;
      const l = lead(ctx, args);
      l.nextFollowUpAt = new Date(ctx.now().getTime() + Number(args.in_hours) * 3_600_000);
      ctx.store.saveLead(l);
      ctx.store.addEvent({ leadId: l.id, at: ctx.now(), actor: ctx.agentKey, type: "note", detail: `follow-up: ${str(args.note)}` });
      ctx.store.log({ agentKey: ctx.agentKey, action: "schedule_followup", input: args, result: "done", providerRef: "crm" });
      return `SCHEDULED for ${l.nextFollowUpAt.toISOString()}`;
    },
  },

  handoff_to_human: {
    spec: {
      name: "handoff_to_human",
      description: "Escalate to the founder/team: angry person, legal/financial question, high-value lead, or anything you are unsure about.",
      parameters: { type: "object", properties: { lead_id: { type: "string" }, reason: { type: "string" } }, required: ["reason"] },
    },
    handler: async (args, ctx) => {
      ctx.store.requestApproval({ agentKey: ctx.agentKey, action: "update_crm", approverRole: "founder", summary: `Human handoff: ${str(args.reason)}`, payload: args });
      ctx.store.log({ agentKey: ctx.agentKey, action: "handoff", input: args, result: "done", providerRef: "crm" });
      return "HANDED_OFF. Tell the person a team member will contact them.";
    },
  },

  draft_email: {
    action: "draft_email",
    spec: {
      name: "draft_email",
      description: "Save an email draft for human review (institutions, HR, creators).",
      parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
    },
    handler: async (args, ctx) => {
      const p = permit(ctx, "draft_email", "draft email", args);
      if (!p.ok) return p.message;
      ctx.store.log({ agentKey: ctx.agentKey, action: "draft_email", input: args, result: "done", providerRef: "draft" });
      return "DRAFT_SAVED (not sent).";
    },
  },

  send_email: {
    action: "send_email",
    spec: {
      name: "send_email",
      description: "Request to send an email. Requires founder approval.",
      parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
    },
    handler: async (args, ctx) => {
      const p = permit(ctx, "send_email", `Send email to ${str(args.to)}: ${str(args.subject)}`, args);
      return p.ok ? "APPROVED" : p.message;
    },
  },

  propose_offer: {
    action: "publish_offer",
    spec: {
      name: "propose_offer",
      description: "Propose a promotional offer. Always goes to the founder; never promise it to anyone.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" }, audience: { type: "string" }, reward: { type: "string" }, budget_inr: { type: "number" },
          max_redemptions: { type: "number" }, start: { type: "string" }, end: { type: "string" }, eligibility: { type: "string" }, terms: { type: "string" },
        },
        required: ["name", "audience", "reward", "budget_inr", "max_redemptions", "start", "end", "eligibility", "terms"],
      },
    },
    handler: async (args, ctx) => {
      const p = permit(ctx, "publish_offer", `Offer "${str(args.name)}" — ${str(args.reward)}, budget ₹${str(args.budget_inr)}`, args);
      return p.ok ? "APPROVED" : p.message;
    },
  },
};

export function toolSpecs(names: string[]): ToolSpec[] {
  return names.map((n) => {
    const t = TOOLS[n];
    if (!t) throw new Error(`unknown tool ${n}`);
    return t.spec;
  });
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext, allowed: string[]): Promise<string> {
  if (!allowed.includes(name)) {
    ctx.store.log({ agentKey: ctx.agentKey, action: name, input: args, result: "blocked", detail: "tool not allowed for this agent" });
    return `BLOCKED: tool ${name} is not available to this agent`;
  }
  try {
    return await TOOLS[name]!.handler(args, ctx);
  } catch (e) {
    ctx.store.log({ agentKey: ctx.agentKey, action: name, input: args, result: "failed", detail: (e as Error).message });
    return `ERROR: ${(e as Error).message}`;
  }
}

export { isOptOutMessage };
