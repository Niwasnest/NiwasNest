// Runs one agent turn: retrieve knowledge → model → tools (gated) → number guard → reply.
import { renderContext, retrieve } from "../core/knowledge";
import { isOptOutMessage } from "../core/consent";
import { AGENTS, SHARED_RULES } from "./definitions";
import type { LlmMessage, LlmProvider } from "./llm";
import { runTool, toolSpecs, type ToolContext } from "./tools";

export const SAFE_FALLBACK =
  "Let me confirm the exact details with our team and get back to you shortly.";

/** Money and percentage figures in a text, normalised ("₹5,000" → "5000", "20 %" → "20%"). */
export function extractFigures(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/gi)) out.push(m[1]!.replace(/,/g, ""));
  for (const m of text.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:%|percent)/gi)) out.push(`${m[1]!.replace(/,/g, "")}%`);
  return out;
}

/**
 * Number guard: a reply may only contain ₹ amounts / percentages that appeared in approved
 * sources during this turn (tool results or knowledge passages) or that the user said.
 * Stops the model from inventing commissions, discounts or rewards.
 */
export function unverifiedFigures(reply: string, sources: string[]): string[] {
  const allowed = new Set(sources.flatMap(extractFigures));
  return extractFigures(reply).filter((f) => !allowed.has(f));
}

export interface TurnResult {
  reply: string;
  toolTrace: { name: string; args: Record<string, unknown>; result: string }[];
  guarded: boolean;
}

export async function runAgentTurn(opts: {
  agentKey: string;
  llm: LlmProvider;
  ctx: Omit<ToolContext, "agentKey">;
  userMessage: string;
  leadId?: string;
  history?: LlmMessage[];
  maxSteps?: number;
}): Promise<TurnResult> {
  const def = AGENTS[opts.agentKey];
  if (!def) throw new Error(`unknown agent ${opts.agentKey}`);
  const ctx: ToolContext = { ...opts.ctx, agentKey: def.key };
  const trace: TurnResult["toolTrace"] = [];

  if (ctx.store.killSwitch.global || ctx.store.killSwitch.agents.has(def.key)) {
    // Even when paused, honour an opt-out.
    if (opts.leadId && isOptOutMessage(opts.userMessage)) ctx.store.recordOptOut(opts.leadId, `message: ${opts.userMessage}`, def.key);
    return { reply: "", toolTrace: [], guarded: true };
  }

  // Deterministic opt-out: never depends on the model noticing it.
  if (opts.leadId && isOptOutMessage(opts.userMessage)) {
    const result = await runTool("record_opt_out", { lead_id: opts.leadId, evidence: `message: ${opts.userMessage}` }, ctx, ["record_opt_out"]);
    trace.push({ name: "record_opt_out", args: { lead_id: opts.leadId }, result });
    return { reply: "Sorry for the trouble — we won't contact you again. Thank you.", toolTrace: trace, guarded: false };
  }

  const core = ctx.kb.filter((e) => e.approved && e.authority < 5 && def.coreKb.includes(e.category));
  const hits = retrieve(ctx.kb, opts.userMessage).filter((h) => !core.includes(h));
  const knowledge = renderContext([...core, ...hits]);
  const lead = opts.leadId ? ctx.store.leads.get(opts.leadId) : undefined;
  const leadCard = lead
    ? `Lead: id=${lead.id}; name=${lead.ownerName ?? "?"}; PG=${lead.pgName ?? "?"}; locality=${lead.locality ?? "?"}; status=${lead.status}; language=${lead.language}; property_id=${lead.niwasnestPropertyId ?? "none"}`
    : "No lead record.";

  const messages: LlmMessage[] = [
    { role: "system", content: `${SHARED_RULES}\n\nYour role: ${def.name}. Goal: ${def.goal}\n\n${leadCard}\n\n## Approved knowledge\n${knowledge}` },
    ...(opts.history ?? []),
    { role: "user", content: opts.userMessage },
  ];
  const tools = toolSpecs(def.tools);
  const sources = [knowledge, opts.userMessage, ...(opts.history ?? []).map((m) => m.content)];

  for (let step = 0; step < (opts.maxSteps ?? 6); step++) {
    const turn = await opts.llm.complete(messages, tools);
    if (turn.toolCalls.length === 0) {
      const reply = (turn.text ?? "").trim();
      const bad = unverifiedFigures(reply, sources);
      if (bad.length) {
        ctx.store.log({ agentKey: def.key, action: "reply_guard", input: { reply, bad }, result: "blocked", detail: `unverified figures: ${bad.join(", ")}` });
        return { reply: SAFE_FALLBACK, toolTrace: trace, guarded: true };
      }
      return { reply, toolTrace: trace, guarded: false };
    }
    for (const call of turn.toolCalls) {
      const result = await runTool(call.name, call.args, ctx, def.tools);
      trace.push({ name: call.name, args: call.args, result });
      sources.push(result);
      messages.push({ role: "assistant", content: `[tool call] ${call.name}(${JSON.stringify(call.args)})` });
      messages.push({ role: "tool", toolName: call.name, content: result });
    }
  }
  ctx.store.log({ agentKey: def.key, action: "turn", input: opts.userMessage, result: "failed", detail: "too many tool steps" });
  return { reply: SAFE_FALLBACK, toolTrace: trace, guarded: true };
}
