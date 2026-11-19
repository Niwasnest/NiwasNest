// Agent permission matrix (master spec Part 15), enforced in code — never in the prompt.

export type PermissionLevel =
  | { level: "auto" }
  | { level: "auto_within_limits"; dailyLimit: number }
  | { level: "needs_approval"; approverRole: "founder" | "admin" | "finance" }
  | { level: "human_only" };

export const ACTION_PERMISSIONS = {
  find_public_leads: { level: "auto_within_limits", dailyLimit: 200 },
  draft_script: { level: "auto" },
  draft_campaign: { level: "auto" },
  draft_email: { level: "auto" },
  generate_creative: { level: "auto" },
  update_crm: { level: "auto" },
  schedule_followup: { level: "auto" },
  send_routine_message: { level: "auto_within_limits", dailyLimit: 150 },
  make_sales_call: { level: "auto_within_limits", dailyLimit: 60 },
  send_email: { level: "needs_approval", approverRole: "founder" }, // until reply/bounce rates are known
  create_lead_in_main_app: { level: "needs_approval", approverRole: "admin" },
  publish_offer: { level: "needs_approval", approverRole: "founder" },
  create_reward_commitment: { level: "needs_approval", approverRole: "founder" },
  change_commission: { level: "needs_approval", approverRole: "founder" },
  publish_major_campaign: { level: "needs_approval", approverRole: "founder" },
  spend_money: { level: "needs_approval", approverRole: "founder" },
  process_payout: { level: "needs_approval", approverRole: "finance" },
  approve_listing: { level: "human_only" },
  sign_agreement: { level: "human_only" },
  access_identity_documents: { level: "human_only" },
  delete_customer_record: { level: "human_only" },
} as const satisfies Record<string, PermissionLevel>;

export type AgentAction = keyof typeof ACTION_PERMISSIONS;

export interface GateInput {
  action: AgentAction;
  agentKey: string;
  killSwitch: { global: boolean; agents: Set<string> };
  usedToday: number;
  approvalId?: string;
  approvalStatus?: "pending" | "approved" | "rejected";
}

export type GateDecision =
  | { decision: "allow" }
  | { decision: "needs_approval"; approverRole: string }
  | { decision: "deny"; reason: string };

export function gate(input: GateInput): GateDecision {
  if (input.killSwitch.global) return { decision: "deny", reason: "global kill switch is on" };
  if (input.killSwitch.agents.has(input.agentKey)) return { decision: "deny", reason: `agent ${input.agentKey} is paused` };
  const p: PermissionLevel = ACTION_PERMISSIONS[input.action];
  switch (p.level) {
    case "auto":
      return { decision: "allow" };
    case "auto_within_limits":
      return input.usedToday < p.dailyLimit
        ? { decision: "allow" }
        : { decision: "deny", reason: `daily limit ${p.dailyLimit} reached for ${input.action}` };
    case "needs_approval":
      if (input.approvalStatus === "approved" && input.approvalId) return { decision: "allow" };
      if (input.approvalStatus === "rejected") return { decision: "deny", reason: "approval was rejected" };
      return { decision: "needs_approval", approverRole: p.approverRole };
    case "human_only":
      return { decision: "deny", reason: `${input.action} can only be done by an authorised person in the main app` };
  }
}
