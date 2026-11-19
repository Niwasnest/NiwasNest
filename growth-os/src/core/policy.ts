// Commercial policy engine. The ONLY way an agent may learn a commission, fee or offer.
// If no approved, currently-effective record exists, the answer is "unknown" and the
// agent must say it will confirm — it must never fall back to historical numbers.

export type PolicyScope = { kind: "property"; propertyId: string } | { kind: "default" };

export interface CommercialPolicy {
  id: string;
  scope: PolicyScope;
  /** e.g. "first_month_commission" */
  type: "first_month_commission" | "listing_fee" | "service_charge";
  /** percent of first month's rent, or a flat INR amount — exactly one is set */
  percent?: number;
  flatInr?: number;
  appliesToMonths: "first_month_only" | "every_month";
  /** Approved, owner-facing wording the agents must use verbatim. */
  approvedWording: string;
  status: "draft" | "pending_approval" | "approved" | "retired";
  approvedBy?: string;
  approvedAt?: Date;
  effectiveFrom: Date;
  effectiveTo?: Date;
  /** Historical proposals are stored for reference and NEVER returned to agents. */
  isHistorical?: boolean;
}

export type PolicyAnswer =
  | { known: true; policy: CommercialPolicy; source: "property_agreement" | "default_policy" }
  | { known: false; reason: string; safeReply: string };

export const UNKNOWN_POLICY_REPLY =
  "Let me confirm the exact terms for your property with our team and get back to you — I don't want to quote you anything that isn't confirmed.";

function isActive(p: CommercialPolicy, at: Date): boolean {
  return (
    p.status === "approved" &&
    !p.isHistorical &&
    !!p.approvedBy &&
    p.effectiveFrom.getTime() <= at.getTime() &&
    (!p.effectiveTo || p.effectiveTo.getTime() > at.getTime())
  );
}

export function getCommercialPolicy(
  policies: CommercialPolicy[],
  type: CommercialPolicy["type"],
  propertyId: string | undefined,
  at: Date = new Date(),
): PolicyAnswer {
  const active = policies.filter((p) => p.type === type && isActive(p, at));
  if (propertyId) {
    const prop = active.filter((p) => p.scope.kind === "property" && p.scope.propertyId === propertyId);
    if (prop.length > 1) return { known: false, reason: "conflicting property agreements", safeReply: UNKNOWN_POLICY_REPLY };
    if (prop[0]) return { known: true, policy: prop[0], source: "property_agreement" };
  }
  const def = active.filter((p) => p.scope.kind === "default");
  if (def.length > 1) return { known: false, reason: "conflicting default policies", safeReply: UNKNOWN_POLICY_REPLY };
  if (def[0]) return { known: true, policy: def[0], source: "default_policy" };
  return { known: false, reason: "no approved policy on record", safeReply: UNKNOWN_POLICY_REPLY };
}

/** Owner-facing illustration. Uses only the approved record; never rounds in our favour. */
export function illustrateCommission(policy: CommercialPolicy, monthlyRentInr: number): string {
  if (policy.percent != null) {
    const fee = Math.floor((monthlyRentInr * policy.percent) / 100);
    const when = policy.appliesToMonths === "first_month_only" ? "one time, on the first month only" : "every month";
    return `For a bed at ₹${monthlyRentInr.toLocaleString("en-IN")}/month, the fee would be ₹${fee.toLocaleString("en-IN")} (${policy.percent}%), ${when}.`;
  }
  if (policy.flatInr != null) {
    return `The fee is a flat ₹${policy.flatInr.toLocaleString("en-IN")}${policy.appliesToMonths === "first_month_only" ? ", one time" : " per month"}.`;
  }
  return policy.approvedWording;
}

export interface Offer {
  id: string;
  name: string;
  audience: "pg_owner" | "student" | "institution" | "influencer" | "all";
  startsAt: Date;
  endsAt: Date;
  eligibility: string;
  reward: string;
  budgetInr: number;
  maxRedemptions: number;
  redemptions: number;
  trackingCode: string;
  terms: string;
  status: "draft" | "pending_approval" | "approved" | "rejected" | "ended";
  approvedBy?: string;
}

/** Offers an agent may mention right now. Unapproved, expired or exhausted offers are invisible. */
export function getActiveOffers(offers: Offer[], audience: Offer["audience"], at: Date = new Date()): Offer[] {
  return offers.filter(
    (o) =>
      o.status === "approved" &&
      !!o.approvedBy &&
      (o.audience === audience || o.audience === "all") &&
      o.startsAt <= at &&
      o.endsAt > at &&
      o.redemptions < o.maxRedemptions,
  );
}
