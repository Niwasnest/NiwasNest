// Shared domain types for every Growth OS agent. One vocabulary, one CRM.

export const LEAD_STATUSES = [
  "new_lead",
  "not_contacted",
  "contacted",
  "no_answer",
  "interested",
  "follow_up",
  "demo_requested",
  "onboarding_sent",
  "onboarding_started",
  "details_pending",
  "verification_pending",
  "approved",
  "live",
  "not_interested",
  "do_not_contact",
  "lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type LeadKind =
  | "pg_owner"
  | "student"
  | "institution"
  | "corporate_hr"
  | "influencer"
  | "partner";

export type Channel = "call" | "whatsapp" | "sms" | "email" | "web_chat" | "field_visit";
export type Language = "te" | "en" | "kn" | "hi";

export interface Lead {
  id: string;
  kind: LeadKind;
  ownerName?: string;
  pgName?: string;
  phoneE164?: string;
  email?: string;
  address?: string;
  locality?: string;
  city: string;
  lat?: number;
  lng?: number;
  propertyType?: "male" | "female" | "co_living" | "other";
  totalBeds?: number;
  vacantBeds?: number;
  rentMin?: number;
  rentMax?: number;
  source: string; // e.g. field_visit, referral:<code>, inbound_whatsapp, qr:<tracking_code>
  trackingCode?: string;
  assignedAgent?: string;
  assignedUserId?: string;
  language: Language;
  status: LeadStatus;
  interestLevel?: 1 | 2 | 3 | 4 | 5;
  lastContactAt?: Date;
  nextFollowUpAt?: Date;
  optedOut: boolean;
  /** id of the property in the main NiwasNest app once one exists */
  niwasnestPropertyId?: string;
  notes?: string;
  createdAt: Date;
}

export interface ContactConsent {
  phoneE164?: string;
  email?: string;
  channel: Channel;
  granted: boolean;
  /** where the consent was captured (inbound whatsapp, signed form, call recording id…) */
  evidence: string;
  capturedAt: Date;
}

export interface ContactAttempt {
  leadId: string;
  channel: Channel;
  at: Date;
  outcome?: string;
}
