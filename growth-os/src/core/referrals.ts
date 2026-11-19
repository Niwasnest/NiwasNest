// Referral eligibility. Amounts come from an approved rule set (stored in the DB);
// DEFAULT_REFERRAL_RULES mirrors the master spec and is marked pending founder confirmation.
// Payouts are only ever *proposed* here — finance approval happens in the main app.

export interface ReferralRules {
  version: string;
  approved: boolean;
  bookingReferralInr: number; // per eligible completed booking after check-in
  ownerReferralPerBookingInr: number;
  ownerReferralMaxBookings: number;
  ownerReferralCapInr: number; // per onboarded property
  minDaysAfterCheckIn: number; // fraud buffer before a reward becomes payable
}

export const DEFAULT_REFERRAL_RULES: ReferralRules = {
  version: "spec-2026-11",
  approved: false, // founder must confirm these match what the main app pays today
  bookingReferralInr: 300,
  ownerReferralPerBookingInr: 500,
  ownerReferralMaxBookings: 10,
  ownerReferralCapInr: 5000,
  minDaysAfterCheckIn: 7,
};

export interface Booking {
  id: string;
  propertyId: string;
  tenantUserId: string;
  tenantPhoneE164?: string;
  status: "pending" | "confirmed" | "checked_in" | "cancelled" | "refunded" | "no_show";
  checkedInAt?: Date;
  referralCode?: string;
}

export interface Referrer {
  code: string;
  userId: string;
  phoneE164?: string;
  /** For PG-owner referrals: the property this referrer introduced. */
  introducedPropertyId?: string;
  suspended?: boolean;
}

export type Eligibility = { eligible: true; amountInr: number; rule: string } | { eligible: false; reason: string };

function baseChecks(b: Booking, r: Referrer, rules: ReferralRules, now: Date): string | null {
  if (!rules.approved) return "referral rules not yet approved by founder";
  if (r.suspended) return "referrer suspended";
  if (b.status === "cancelled" || b.status === "refunded" || b.status === "no_show") return `booking ${b.status}`;
  if (b.status !== "checked_in" || !b.checkedInAt) return "tenant has not checked in";
  if (now.getTime() - b.checkedInAt.getTime() < rules.minDaysAfterCheckIn * 86_400_000)
    return `within ${rules.minDaysAfterCheckIn}-day post-check-in hold`;
  if (r.userId === b.tenantUserId) return "self-referral";
  if (r.phoneE164 && b.tenantPhoneE164 && r.phoneE164 === b.tenantPhoneE164) return "self-referral (same phone)";
  return null;
}

export function bookingReferralEligibility(b: Booking, r: Referrer, rules: ReferralRules, alreadyRewardedBookingIds: Set<string>, now = new Date()): Eligibility {
  if (b.referralCode !== r.code) return { eligible: false, reason: "booking not attributed to this referral code" };
  if (alreadyRewardedBookingIds.has(b.id)) return { eligible: false, reason: "booking already rewarded" };
  const fail = baseChecks(b, r, rules, now);
  if (fail) return { eligible: false, reason: fail };
  return { eligible: true, amountInr: rules.bookingReferralInr, rule: `booking_referral@${rules.version}` };
}

/**
 * PG-owner referral: pays per eligible booking at the introduced property only, for the
 * first N eligible bookings, capped per property. `priorEligibleBookingIds` are bookings at
 * that property already counted toward this referral, in check-in order.
 */
export function ownerReferralEligibility(
  b: Booking,
  r: Referrer,
  rules: ReferralRules,
  priorEligibleBookingIds: string[],
  paidSoFarInr: number,
  now = new Date(),
): Eligibility {
  if (!r.introducedPropertyId) return { eligible: false, reason: "referrer did not introduce a property" };
  if (b.propertyId !== r.introducedPropertyId) return { eligible: false, reason: "booking is at a different property" };
  if (priorEligibleBookingIds.includes(b.id)) return { eligible: false, reason: "booking already counted" };
  const fail = baseChecks(b, r, rules, now);
  if (fail) return { eligible: false, reason: fail };
  if (priorEligibleBookingIds.length >= rules.ownerReferralMaxBookings)
    return { eligible: false, reason: `first ${rules.ownerReferralMaxBookings} bookings already rewarded` };
  const remaining = rules.ownerReferralCapInr - paidSoFarInr;
  if (remaining <= 0) return { eligible: false, reason: "per-property cap reached" };
  return { eligible: true, amountInr: Math.min(rules.ownerReferralPerBookingInr, remaining), rule: `owner_referral@${rules.version}` };
}

export interface FraudSignal {
  code: string;
  detail: string;
}

/** Simple, explainable fraud signals for the review queue (not automatic rejection). */
export function referralFraudSignals(referrer: Referrer, bookings: Booking[], now = new Date()): FraudSignal[] {
  const mine = bookings.filter((b) => b.referralCode === referrer.code);
  const signals: FraudSignal[] = [];
  const last24h = mine.filter((b) => b.checkedInAt && now.getTime() - b.checkedInAt.getTime() < 86_400_000);
  if (last24h.length >= 5) signals.push({ code: "velocity", detail: `${last24h.length} referred check-ins in 24h` });
  const cancelled = mine.filter((b) => b.status === "cancelled" || b.status === "refunded").length;
  if (mine.length >= 5 && cancelled / mine.length > 0.5) signals.push({ code: "high_cancel_rate", detail: `${cancelled}/${mine.length} cancelled or refunded` });
  const phones = mine.map((b) => b.tenantPhoneE164).filter(Boolean);
  if (new Set(phones).size < phones.length) signals.push({ code: "repeat_tenant_phone", detail: "same tenant phone on multiple referred bookings" });
  return signals;
}
