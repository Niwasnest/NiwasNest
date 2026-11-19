// Follow-up cadence. Configurable; default Day 0 / 1 / 3 / 7 as in the spec.
import { TERMINAL_STATUSES } from "./pipeline";
import type { Channel, Lead, LeadStatus } from "./types";

export interface CadenceStep {
  dayOffset: number;
  channel: Channel;
  templateKey: string;
}

export interface Cadence {
  key: string;
  /** cadence runs only while the lead is in one of these statuses */
  activeStatuses: LeadStatus[];
  steps: CadenceStep[];
}

export const OWNER_ACQUISITION_CADENCE: Cadence = {
  key: "owner_acquisition_v1",
  activeStatuses: ["contacted", "no_answer", "interested", "follow_up", "demo_requested"],
  steps: [
    { dayOffset: 0, channel: "whatsapp", templateKey: "owner_intro" },
    { dayOffset: 1, channel: "whatsapp", templateKey: "owner_followup_1" },
    { dayOffset: 3, channel: "call", templateKey: "owner_followup_call" },
    { dayOffset: 7, channel: "whatsapp", templateKey: "owner_final_followup" },
  ],
};

export const ONBOARDING_NUDGE_CADENCE: Cadence = {
  key: "onboarding_nudge_v1",
  activeStatuses: ["onboarding_sent", "onboarding_started", "details_pending"],
  steps: [
    { dayOffset: 1, channel: "whatsapp", templateKey: "onboarding_reminder_1" },
    { dayOffset: 3, channel: "whatsapp", templateKey: "onboarding_reminder_missing_items" },
    { dayOffset: 5, channel: "call", templateKey: "onboarding_help_call" },
  ],
};

export interface ScheduledFollowUp {
  leadId: string;
  cadenceKey: string;
  stepIndex: number;
  dueAt: Date;
  channel: Channel;
  templateKey: string;
}

/** Next step due for a lead, or null if the cadence is finished or must stop. */
export function nextFollowUp(lead: Lead, cadence: Cadence, startedAt: Date, completedSteps: number): ScheduledFollowUp | null {
  if (lead.optedOut || TERMINAL_STATUSES.has(lead.status)) return null;
  if (!cadence.activeStatuses.includes(lead.status)) return null;
  const step = cadence.steps[completedSteps];
  if (!step) return null;
  return {
    leadId: lead.id,
    cadenceKey: cadence.key,
    stepIndex: completedSteps,
    dueAt: new Date(startedAt.getTime() + step.dayOffset * 86_400_000),
    channel: step.channel,
    templateKey: step.templateKey,
  };
}
