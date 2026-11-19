// npm run export:dashboard → JSON for the claude.ai dashboard page (snapshot + approvals).
import { buildDailyPlan, campaignRoi } from "../planning/daily-plan";
import { STATUS_LABELS } from "../core/pipeline";
import { openStore } from "./_db";

const { db, store } = await openStore();
const plan = buildDailyPlan(store);
const leadCard = (l: { id: string; pgName?: string; ownerName?: string; locality?: string; status: keyof typeof STATUS_LABELS; vacantBeds?: number; phoneE164?: string }) => ({
  id: l.id, name: l.pgName ?? l.ownerName ?? "Lead", locality: l.locality ?? "", status: STATUS_LABELS[l.status], vacantBeds: l.vacantBeds ?? null, phone: l.phoneE164 ?? null,
});
const leads = [...store.leads.values()];
const bySource = new Map<string, number>();
for (const l of leads) bySource.set(l.source.split(":")[0]!, (bySource.get(l.source.split(":")[0]!) ?? 0) + 1);
const snapshot = {
  generatedAt: new Date().toISOString(),
  funnel: plan.funnel,
  callList: plan.callList.map((c) => ({ ...leadCard(c.lead), why: c.why })),
  onboarding: plan.onboardingToChase.map(leadCard),
  notContactable: plan.blockedFromContact.length,
  fieldVisitTargets: leads.filter((l) => !l.optedOut && ["new_lead", "not_contacted"].includes(l.status)).slice(0, 40).map(leadCard),
  roi: campaignRoi(store),
  areas: plan.localityGaps,
  sources: [...bySource.entries()].map(([source, count]) => ({ source, count })),
  killSwitch: store.killSwitch.global,
};
const approvals = store.approvals.map((a) => ({
  id: a.id, summary: a.summary, action: a.action, agent: a.agentKey, approverRole: a.approverRole,
  createdAt: a.createdAt.toISOString(), status: a.status, decidedBy: a.decidedBy ?? null,
}));
console.log(JSON.stringify({ snapshot, approvals }));
await db.close?.();
