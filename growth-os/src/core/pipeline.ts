// The one sales pipeline every agent follows.
// A PG counts as onboarded only when it is verified and LIVE in the main app.
import type { LeadStatus } from "./types";

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new_lead: "New Lead",
  not_contacted: "Not Contacted",
  contacted: "Contacted",
  no_answer: "No Answer",
  interested: "Interested",
  follow_up: "Follow-up",
  demo_requested: "Demo Requested",
  onboarding_sent: "Onboarding Sent",
  onboarding_started: "Onboarding Started",
  details_pending: "Details Pending",
  verification_pending: "Verification Pending",
  approved: "Approved",
  live: "Live",
  not_interested: "Not Interested",
  do_not_contact: "Do Not Contact",
  lost: "Lost",
};

/** Statuses only the main app (admin verification) may set — agents can never set them. */
export const SYSTEM_ONLY_STATUSES: ReadonlySet<LeadStatus> = new Set(["approved", "live"]);

export const TERMINAL_STATUSES: ReadonlySet<LeadStatus> = new Set(["do_not_contact", "lost", "live"]);

const EARLY: LeadStatus[] = ["new_lead", "not_contacted", "contacted", "no_answer", "interested", "follow_up", "demo_requested"];
const ALWAYS: LeadStatus[] = ["not_interested", "do_not_contact", "lost"];

const TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new_lead: ["not_contacted", "contacted", "no_answer", "interested", ...ALWAYS],
  not_contacted: ["contacted", "no_answer", "interested", ...ALWAYS],
  contacted: ["interested", "follow_up", "demo_requested", "no_answer", "onboarding_sent", ...ALWAYS],
  no_answer: ["contacted", "no_answer", "interested", "follow_up", ...ALWAYS],
  interested: ["follow_up", "demo_requested", "onboarding_sent", ...ALWAYS],
  follow_up: ["contacted", "interested", "demo_requested", "onboarding_sent", "no_answer", ...ALWAYS],
  demo_requested: ["follow_up", "interested", "onboarding_sent", ...ALWAYS],
  onboarding_sent: ["onboarding_started", "follow_up", ...ALWAYS],
  onboarding_started: ["details_pending", "verification_pending", "follow_up", ...ALWAYS],
  details_pending: ["onboarding_started", "verification_pending", "follow_up", ...ALWAYS],
  verification_pending: ["approved", "details_pending", ...ALWAYS],
  approved: ["live", "details_pending"],
  live: ["details_pending"], // e.g. admin hid the listing for corrections
  not_interested: ["follow_up", "interested", "do_not_contact", "lost"],
  do_not_contact: [], // only a fresh, evidenced opt-in (handled by consent module) can reopen
  lost: ["new_lead"],
};

export type TransitionActor = "agent" | "human" | "main_app_sync";

export function canTransition(from: LeadStatus, to: LeadStatus, actor: TransitionActor): { ok: boolean; reason?: string } {
  if (from === to) return { ok: true };
  if (SYSTEM_ONLY_STATUSES.has(to) && actor !== "main_app_sync") {
    return { ok: false, reason: `"${STATUS_LABELS[to]}" can only come from admin verification in the main app` };
  }
  // The main app is the source of truth for onboarding progress; allow it to move any non-DNC lead forward.
  if (actor === "main_app_sync" && from !== "do_not_contact") return { ok: true };
  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `cannot move from "${STATUS_LABELS[from]}" to "${STATUS_LABELS[to]}"` };
  }
  return { ok: true };
}

export function isOnboarded(status: LeadStatus): boolean {
  return status === "live";
}

export function isEarlyStage(status: LeadStatus): boolean {
  return EARLY.includes(status);
}
