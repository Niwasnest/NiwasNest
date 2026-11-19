import { describe, expect, it } from "vitest";
import { normalizeIndianPhone } from "../src/core/phone";
import { findDuplicates } from "../src/core/dedupe";
import { canTransition, isOnboarded } from "../src/core/pipeline";
import { canContact, isOptOutMessage } from "../src/core/consent";
import { getActiveOffers, getCommercialPolicy, illustrateCommission, type CommercialPolicy, type Offer } from "../src/core/policy";
import { bookingReferralEligibility, DEFAULT_REFERRAL_RULES, ownerReferralEligibility, referralFraudSignals, type Booking, type Referrer } from "../src/core/referrals";
import { gate } from "../src/core/permissions";
import { nextFollowUp, OWNER_ACQUISITION_CADENCE } from "../src/core/followups";
import type { Lead } from "../src/core/types";

const mkLead = (o: Partial<Lead> = {}): Lead => ({
  id: "L1", kind: "pg_owner", city: "Bengaluru", source: "field_visit", language: "te",
  status: "contacted", optedOut: false, createdAt: new Date("2026-11-01"), phoneE164: "+919848012345", ...o,
});
// 11:00 IST
const NOON = new Date("2026-11-19T05:30:00Z");

describe("phone normalisation", () => {
  it.each([["98480 12345"], ["+91-98480-12345"], ["098480 12345"], ["919848012345"], ["0091 9848012345"]])("%s", (raw) => {
    expect(normalizeIndianPhone(raw)).toBe("+919848012345");
  });
  it("rejects numbers that cannot be Indian mobiles", () => {
    expect(normalizeIndianPhone("2345 6789")).toBeNull(); // landline without STD code
    expect(normalizeIndianPhone("1234567890")).toBeNull();
    expect(normalizeIndianPhone("12345")).toBeNull();
  });
});

describe("duplicate detection", () => {
  const existing = [mkLead({ id: "A", pgName: "Sri Sai PG for Men", address: "12, 3rd Cross, BTM Layout 2nd Stage, Bangalore", phoneE164: "+919999999999", lat: 12.9166, lng: 77.6101 })];
  it("matches on phone in any format", () => {
    expect(findDuplicates({ phoneE164: "99999 99999" }, existing)[0]?.reason).toBe("phone");
  });
  it("matches same PG at same spot with different spelling", () => {
    expect(findDuplicates({ pgName: "Sri Sai Gents PG", lat: 12.9167, lng: 77.6102 }, existing)[0]?.reason).toBe("location_and_name");
  });
  it("matches by address + name", () => {
    expect(findDuplicates({ pgName: "Sri Sai Boys PG", address: "12 3rd crs BTM layout 2nd stage Bengaluru" }, existing)[0]?.reason).toBe("address_and_name");
  });
  it("does not match a different PG on the same road", () => {
    expect(findDuplicates({ pgName: "Green Nest Ladies PG", address: "40, 3rd Cross, BTM Layout 2nd Stage" }, existing)).toHaveLength(0);
  });
});

describe("pipeline", () => {
  it("agents can never mark a PG approved or live", () => {
    expect(canTransition("verification_pending", "approved", "agent").ok).toBe(false);
    expect(canTransition("approved", "live", "human").ok).toBe(false);
    expect(canTransition("approved", "live", "main_app_sync").ok).toBe(true);
  });
  it("interested is not onboarded", () => {
    expect(isOnboarded("interested")).toBe(false);
    expect(isOnboarded("verification_pending")).toBe(false);
    expect(isOnboarded("live")).toBe(true);
  });
  it("do-not-contact cannot be reopened by anyone", () => {
    expect(canTransition("do_not_contact", "interested", "agent").ok).toBe(false);
    expect(canTransition("do_not_contact", "live", "main_app_sync").ok).toBe(false);
  });
});

describe("consent gate", () => {
  const consent = { phoneE164: "+919848012345", channel: "call" as const, granted: true, evidence: "field form", capturedAt: new Date("2026-11-10") };
  it("blocks automated calls without recorded opt-in", () => {
    expect(canContact({ lead: mkLead(), channel: "call", now: NOON, consents: [], attempts: [] })).toMatchObject({ allowed: false });
  });
  it("allows with opt-in inside hours", () => {
    expect(canContact({ lead: mkLead(), channel: "call", now: NOON, consents: [consent], attempts: [] }).allowed).toBe(true);
  });
  it("blocks outside 9am–9pm IST", () => {
    const late = new Date("2026-11-19T16:00:00Z"); // 21:30 IST
    expect(canContact({ lead: mkLead(), channel: "call", now: late, consents: [consent], attempts: [] })).toMatchObject({ allowed: false });
  });
  it("later withdrawal beats earlier opt-in, even for replies", () => {
    const withdrawn = { ...consent, channel: "whatsapp" as const, granted: false, capturedAt: new Date("2026-11-15") };
    const optin = { ...consent, channel: "whatsapp" as const };
    expect(canContact({ lead: mkLead(), channel: "whatsapp", now: NOON, consents: [optin, withdrawn], attempts: [], isReplyToInbound: true }).allowed).toBe(false);
  });
  it("enforces frequency caps", () => {
    const attempts = [{ leadId: "L1", channel: "call" as const, at: new Date(NOON.getTime() - 3600_000) }];
    expect(canContact({ lead: mkLead(), channel: "call", now: NOON, consents: [consent], attempts })).toMatchObject({ allowed: false });
  });
  it("opted-out leads are never contacted", () => {
    expect(canContact({ lead: mkLead({ optedOut: true }), channel: "field_visit", now: NOON, consents: [], attempts: [] }).allowed).toBe(false);
  });
  it("detects opt-outs in English, Telugu, Kannada, Hindi", () => {
    for (const t of ["STOP", "please don't call me again", "inka call vaddu", "phone beda", "call mat karo"]) expect(isOptOutMessage(t)).toBe(true);
    for (const t of ["call me tomorrow", "send details", "ok interested"]) expect(isOptOutMessage(t)).toBe(false);
  });
});

describe("commercial policy engine", () => {
  const base: Omit<CommercialPolicy, "id" | "scope"> = {
    type: "first_month_commission", percent: 20, appliesToMonths: "first_month_only",
    approvedWording: "20% of the first month's rent, one time.", status: "approved", approvedBy: "founder",
    effectiveFrom: new Date("2026-01-01"),
  };
  it("never answers from historical or unapproved records", () => {
    const policies: CommercialPolicy[] = [
      { ...base, id: "h", scope: { kind: "default" }, percent: 30, isHistorical: true },
      { ...base, id: "d", scope: { kind: "default" }, status: "draft" },
    ];
    expect(getCommercialPolicy(policies, "first_month_commission", "P1").known).toBe(false);
  });
  it("property agreement beats default", () => {
    const policies: CommercialPolicy[] = [
      { ...base, id: "d", scope: { kind: "default" } },
      { ...base, id: "p", scope: { kind: "property", propertyId: "P1" }, percent: 12, approvedWording: "12% first month" },
    ];
    const a = getCommercialPolicy(policies, "first_month_commission", "P1");
    expect(a.known && a.policy.id).toBe("p");
    const b = getCommercialPolicy(policies, "first_month_commission", "P2");
    expect(b.known && b.policy.id).toBe("d");
  });
  it("refuses to choose between conflicting approved defaults", () => {
    const policies: CommercialPolicy[] = [{ ...base, id: "a", scope: { kind: "default" } }, { ...base, id: "b", scope: { kind: "default" }, percent: 15 }];
    expect(getCommercialPolicy(policies, "first_month_commission", undefined).known).toBe(false);
  });
  it("illustrates without rounding up", () => {
    expect(illustrateCommission({ ...base, id: "x", scope: { kind: "default" } }, 8999)).toContain("₹1,799");
  });
  it("hides expired, unapproved or exhausted offers", () => {
    const o: Offer = { id: "o", name: "First 100 owners", audience: "pg_owner", startsAt: new Date("2026-11-01"), endsAt: new Date("2026-12-31"), eligibility: "", reward: "", budgetInr: 1, maxRedemptions: 100, redemptions: 0, trackingCode: "F100", terms: "", status: "approved", approvedBy: "founder" };
    expect(getActiveOffers([o], "pg_owner", NOON)).toHaveLength(1);
    expect(getActiveOffers([{ ...o, redemptions: 100 }], "pg_owner", NOON)).toHaveLength(0);
    expect(getActiveOffers([{ ...o, status: "pending_approval" }], "pg_owner", NOON)).toHaveLength(0);
    expect(getActiveOffers([o], "student", NOON)).toHaveLength(0);
  });
});

describe("referral eligibility", () => {
  const rules = { ...DEFAULT_REFERRAL_RULES, approved: true };
  const now = new Date("2026-11-30");
  const booking: Booking = { id: "B1", propertyId: "P1", tenantUserId: "T1", status: "checked_in", checkedInAt: new Date("2026-11-10"), referralCode: "R1" };
  const ref: Referrer = { code: "R1", userId: "U1", introducedPropertyId: "P1" };

  it("pays ₹300 after check-in", () => {
    expect(bookingReferralEligibility(booking, ref, rules, new Set(), now)).toEqual({ eligible: true, amountInr: 300, rule: "booking_referral@spec-2026-11" });
  });
  it("blocks while rules are unapproved", () => {
    expect(bookingReferralEligibility(booking, ref, DEFAULT_REFERRAL_RULES, new Set(), now).eligible).toBe(false);
  });
  it("cancelled, not-checked-in, self-referral and double-pay are rejected", () => {
    expect(bookingReferralEligibility({ ...booking, status: "cancelled" }, ref, rules, new Set(), now).eligible).toBe(false);
    expect(bookingReferralEligibility({ ...booking, status: "confirmed", checkedInAt: undefined }, ref, rules, new Set(), now).eligible).toBe(false);
    expect(bookingReferralEligibility({ ...booking, tenantUserId: "U1" }, ref, rules, new Set(), now).eligible).toBe(false);
    expect(bookingReferralEligibility(booking, ref, rules, new Set(["B1"]), now).eligible).toBe(false);
  });
  it("holds the reward for the post-check-in period", () => {
    expect(bookingReferralEligibility(booking, ref, rules, new Set(), new Date("2026-11-12")).eligible).toBe(false);
  });
  it("owner referral: only that property, first 10 bookings, ₹5,000 cap", () => {
    expect(ownerReferralEligibility({ ...booking, propertyId: "P2" }, ref, rules, [], 0, now).eligible).toBe(false);
    expect(ownerReferralEligibility(booking, ref, rules, [], 0, now)).toMatchObject({ eligible: true, amountInr: 500 });
    const ten = Array.from({ length: 10 }, (_, i) => `X${i}`);
    expect(ownerReferralEligibility(booking, ref, rules, ten, 5000, now).eligible).toBe(false);
    expect(ownerReferralEligibility(booking, ref, rules, ten.slice(0, 9), 4800, now)).toMatchObject({ eligible: true, amountInr: 200 });
  });
  it("flags velocity and repeat tenants for review", () => {
    const many: Booking[] = Array.from({ length: 5 }, (_, i) => ({ ...booking, id: `b${i}`, tenantUserId: `t${i}`, tenantPhoneE164: "+919000000000", checkedInAt: new Date(now.getTime() - 3600_000) }));
    const codes = referralFraudSignals(ref, many, now).map((s) => s.code);
    expect(codes).toContain("velocity");
    expect(codes).toContain("repeat_tenant_phone");
  });
});

describe("permission gate", () => {
  const ks = { global: false, agents: new Set<string>() };
  it("kill switch stops everything", () => {
    expect(gate({ action: "draft_email", agentKey: "a", killSwitch: { global: true, agents: new Set() }, usedToday: 0 }).decision).toBe("deny");
    expect(gate({ action: "draft_email", agentKey: "a", killSwitch: { global: false, agents: new Set(["a"]) }, usedToday: 0 }).decision).toBe("deny");
  });
  it("money and commission need the founder", () => {
    for (const action of ["change_commission", "publish_offer", "spend_money", "create_reward_commitment"] as const) {
      expect(gate({ action, agentKey: "a", killSwitch: ks, usedToday: 0 })).toEqual({ decision: "needs_approval", approverRole: "founder" });
    }
    expect(gate({ action: "process_payout", agentKey: "a", killSwitch: ks, usedToday: 0 })).toMatchObject({ approverRole: "finance" });
  });
  it("listing approval and agreements are human-only, even with an approval", () => {
    expect(gate({ action: "approve_listing", agentKey: "a", killSwitch: ks, usedToday: 0, approvalId: "x", approvalStatus: "approved" }).decision).toBe("deny");
    expect(gate({ action: "sign_agreement", agentKey: "a", killSwitch: ks, usedToday: 0 }).decision).toBe("deny");
  });
  it("daily limits apply to calls", () => {
    expect(gate({ action: "make_sales_call", agentKey: "a", killSwitch: ks, usedToday: 60 }).decision).toBe("deny");
  });
});

describe("follow-up cadence", () => {
  it("runs Day 0/1/3/7 and stops on opt-out or live", () => {
    const start = new Date("2026-11-01T05:00:00Z");
    const s3 = nextFollowUp(mkLead(), OWNER_ACQUISITION_CADENCE, start, 2);
    expect(s3?.dueAt.toISOString()).toBe("2026-11-04T05:00:00.000Z");
    expect(nextFollowUp(mkLead(), OWNER_ACQUISITION_CADENCE, start, 4)).toBeNull();
    expect(nextFollowUp(mkLead({ optedOut: true }), OWNER_ACQUISITION_CADENCE, start, 0)).toBeNull();
    expect(nextFollowUp(mkLead({ status: "live" }), OWNER_ACQUISITION_CADENCE, start, 0)).toBeNull();
  });
});
