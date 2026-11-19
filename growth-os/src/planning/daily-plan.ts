// Founder's morning brief + funnel metrics + campaign ROI.
// Optimises for verified LIVE PGs and completed bookings — not calls or messages.
import { canContact } from "../core/consent";
import { STATUS_LABELS } from "../core/pipeline";
import type { Lead, LeadStatus } from "../core/types";
import type { GrowthStore } from "../store/memory";

export interface FunnelCounts {
  leads: number;
  contacted: number;
  interested: number;
  onboardingSent: number;
  onboardingStarted: number;
  verificationPending: number;
  live: number;
  doNotContact: number;
}

const REACHED: LeadStatus[] = ["contacted", "interested", "follow_up", "demo_requested", "onboarding_sent", "onboarding_started", "details_pending", "verification_pending", "approved", "live", "not_interested"];
const INTERESTED: LeadStatus[] = ["interested", "follow_up", "demo_requested", "onboarding_sent", "onboarding_started", "details_pending", "verification_pending", "approved", "live"];
const SENT: LeadStatus[] = ["onboarding_sent", "onboarding_started", "details_pending", "verification_pending", "approved", "live"];
const STARTED: LeadStatus[] = ["onboarding_started", "details_pending", "verification_pending", "approved", "live"];

export function funnel(leads: Lead[]): FunnelCounts {
  const n = (set: LeadStatus[]) => leads.filter((l) => set.includes(l.status)).length;
  return {
    leads: leads.length,
    contacted: n(REACHED),
    interested: n(INTERESTED),
    onboardingSent: n(SENT),
    onboardingStarted: n(STARTED),
    verificationPending: n(["verification_pending"]),
    live: n(["live"]),
    doNotContact: n(["do_not_contact"]),
  };
}

export interface CampaignRoi {
  trackingCode: string;
  spendInr: number;
  leads: number;
  live: number;
  costPerLeadInr: number | null;
  costPerLivePgInr: number | null;
}

export function campaignRoi(store: GrowthStore): CampaignRoi[] {
  const codes = new Set<string>();
  for (const e of store.expenses) if (e.trackingCode) codes.add(e.trackingCode);
  for (const l of store.leads.values()) if (l.trackingCode) codes.add(l.trackingCode);
  return [...codes]
    .map((code) => {
      const spend = store.expenses.filter((e) => e.trackingCode === code).reduce((s, e) => s + e.amountInr, 0);
      const leads = [...store.leads.values()].filter((l) => l.trackingCode === code);
      const live = leads.filter((l) => l.status === "live").length;
      return {
        trackingCode: code,
        spendInr: spend,
        leads: leads.length,
        live,
        costPerLeadInr: leads.length ? Math.round(spend / leads.length) : null,
        costPerLivePgInr: live ? Math.round(spend / live) : null,
      };
    })
    .sort((a, b) => (a.costPerLivePgInr ?? Infinity) - (b.costPerLivePgInr ?? Infinity));
}

function score(l: Lead): number {
  // Closest to LIVE first, then interest, then vacant beds (more vacancy = more motivated owner).
  const stage: Partial<Record<LeadStatus, number>> = { details_pending: 60, onboarding_started: 55, onboarding_sent: 50, demo_requested: 45, interested: 40, follow_up: 30, no_answer: 10, new_lead: 5, not_contacted: 5, contacted: 20 };
  return (stage[l.status] ?? 0) + (l.interestLevel ?? 0) * 3 + Math.min(l.vacantBeds ?? 0, 20);
}

export interface DailyPlan {
  date: string;
  funnel: FunnelCounts;
  callList: { lead: Lead; why: string }[];
  blockedFromContact: { lead: Lead; reason: string }[];
  onboardingToChase: Lead[];
  pendingApprovals: number;
  bestCampaign?: CampaignRoi;
  localityGaps: { locality: string; leads: number; live: number }[];
}

export function buildDailyPlan(store: GrowthStore, now = new Date(), callCap = 30): DailyPlan {
  const leads = [...store.leads.values()].filter((l) => l.kind === "pg_owner");
  const due = leads.filter((l) => !l.optedOut && !["live", "approved", "verification_pending", "lost", "do_not_contact", "not_interested"].includes(l.status) && (!l.nextFollowUpAt || l.nextFollowUpAt <= now));
  const callList: DailyPlan["callList"] = [];
  const blocked: DailyPlan["blockedFromContact"] = [];
  for (const l of due.sort((a, b) => score(b) - score(a))) {
    // Plan against 10:00 IST so the list is for "today's calling window".
    const callTime = new Date(now);
    callTime.setUTCHours(4, 30, 0, 0);
    const d = canContact({ lead: l, channel: "call", now: callTime, consents: store.consents, attempts: store.attempts });
    if (!d.allowed) blocked.push({ lead: l, reason: d.reason });
    else if (callList.length < callCap) callList.push({ lead: l, why: `${STATUS_LABELS[l.status]}${l.vacantBeds ? `, ${l.vacantBeds} vacant beds` : ""}` });
  }
  const byLocality = new Map<string, { leads: number; live: number }>();
  for (const l of leads) {
    const k = l.locality ?? "Unknown";
    const v = byLocality.get(k) ?? { leads: 0, live: 0 };
    v.leads++;
    if (l.status === "live") v.live++;
    byLocality.set(k, v);
  }
  return {
    date: now.toISOString().slice(0, 10),
    funnel: funnel(leads),
    callList,
    blockedFromContact: blocked,
    onboardingToChase: leads.filter((l) => ["onboarding_sent", "onboarding_started", "details_pending"].includes(l.status)),
    pendingApprovals: store.approvals.filter((a) => a.status === "pending").length,
    bestCampaign: campaignRoi(store).find((c) => c.live > 0),
    localityGaps: [...byLocality.entries()].map(([locality, v]) => ({ locality, ...v })).sort((a, b) => b.leads - b.live - (a.leads - a.live)).slice(0, 5),
  };
}

export function renderBrief(p: DailyPlan): string {
  const f = p.funnel;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const lines = [
    `NiwasNest morning brief — ${p.date}`,
    ``,
    `FUNNEL (PG owners): ${f.leads} leads → ${f.contacted} reached → ${f.interested} interested → ${f.onboardingSent} link sent → ${f.onboardingStarted} started → ${f.verificationPending} awaiting verification → ${f.live} LIVE`,
    `Lead→Live conversion: ${pct(f.live, f.leads)}   Interested→Live: ${pct(f.live, f.interested)}`,
    ``,
    `TODAY'S CALL LIST (${p.callList.length}):`,
    ...p.callList.map((c, i) => `  ${i + 1}. ${c.lead.pgName ?? c.lead.ownerName ?? c.lead.id} (${c.lead.locality ?? "?"}) — ${c.why}`),
    ``,
    `FINISH ONBOARDING (${p.onboardingToChase.length}): ${p.onboardingToChase.map((l) => l.pgName ?? l.id).join(", ") || "none"}`,
    `NOT CONTACTABLE TODAY: ${p.blockedFromContact.length} (no consent / limits / opted out)`,
    `PENDING YOUR APPROVAL: ${p.pendingApprovals}`,
    p.bestCampaign ? `BEST CAMPAIGN: ${p.bestCampaign.trackingCode} — ₹${p.bestCampaign.costPerLivePgInr} per live PG` : `BEST CAMPAIGN: no campaign has produced a live PG yet`,
    ``,
    `LOCALITY GAPS (leads not yet live): ${p.localityGaps.map((g) => `${g.locality} ${g.leads - g.live}`).join(" · ")}`,
  ];
  return lines.join("\n");
}
