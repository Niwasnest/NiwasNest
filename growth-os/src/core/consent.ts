// Consent gate. Every outbound contact passes through canContact() inside the channel
// adapter — a prompt cannot bypass it. Defaults follow TRAI commercial-communication
// practice (09:00–21:00 IST) and are deliberately conservative. Have counsel confirm.
import type { Channel, ContactAttempt, ContactConsent, Lead } from "./types";

export interface ConsentConfig {
  quietStartHourIst: number; // no outbound before this hour
  quietEndHourIst: number; // no outbound at/after this hour
  maxAttemptsPerDay: number;
  maxAttemptsPerWeek: number;
  /** Channels that require explicit, evidenced consent before first outbound contact. */
  consentRequired: Channel[];
}

export const DEFAULT_CONSENT_CONFIG: ConsentConfig = {
  quietStartHourIst: 9,
  quietEndHourIst: 21,
  maxAttemptsPerDay: 1,
  maxAttemptsPerWeek: 3,
  // Automated calls and business-initiated WhatsApp need opt-in. Email to public
  // institutional addresses is allowed with unsubscribe; field visits are in person.
  consentRequired: ["call", "whatsapp", "sms"],
};

export interface ContactContext {
  lead: Lead;
  channel: Channel;
  now: Date;
  consents: ContactConsent[];
  attempts: ContactAttempt[];
  /** true if the number is on the DND/NCPR register (from provider scrub) */
  onDndRegister?: boolean;
  /** true when replying inside a conversation the person started (e.g. WhatsApp 24h window) */
  isReplyToInbound?: boolean;
  config?: ConsentConfig;
}

export type ContactDecision = { allowed: true } | { allowed: false; reason: string };

export function istHour(d: Date): number {
  // IST = UTC+5:30, no DST
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + 330;
  return Math.floor((minutes % 1440) / 60);
}

export function hasConsent(lead: Lead, channel: Channel, consents: ContactConsent[]): boolean {
  // Most recent record for this person+channel wins (a later withdrawal overrides an earlier opt-in).
  const relevant = consents
    .filter((c) => c.channel === channel && ((lead.phoneE164 && c.phoneE164 === lead.phoneE164) || (lead.email && c.email === lead.email)))
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  return relevant[0]?.granted === true;
}

export function canContact(ctx: ContactContext): ContactDecision {
  const cfg = ctx.config ?? DEFAULT_CONSENT_CONFIG;
  const { lead, channel, now } = ctx;

  if (lead.optedOut || lead.status === "do_not_contact") return { allowed: false, reason: "lead opted out / do not contact" };

  // A withdrawn consent on this channel always blocks, even for replies.
  const withdrawn = ctx.consents
    .filter((c) => c.channel === channel && ((lead.phoneE164 && c.phoneE164 === lead.phoneE164) || (lead.email && c.email === lead.email)))
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0];
  if (withdrawn && !withdrawn.granted) return { allowed: false, reason: `consent withdrawn for ${channel}` };

  if (channel === "field_visit") return { allowed: true };

  if (channel === "call" || channel === "sms" || channel === "whatsapp") {
    if (!lead.phoneE164) return { allowed: false, reason: "no valid phone number" };
  }
  if (channel === "email" && !lead.email) return { allowed: false, reason: "no email address" };

  if (ctx.isReplyToInbound && (channel === "whatsapp" || channel === "web_chat")) return { allowed: true };

  const consented = hasConsent(lead, channel, ctx.consents);
  if (cfg.consentRequired.includes(channel) && !consented) {
    return { allowed: false, reason: `no recorded opt-in for ${channel}` };
  }
  if ((channel === "call" || channel === "sms") && ctx.onDndRegister && !consented) {
    return { allowed: false, reason: "number is on DND register without explicit consent" };
  }

  const hour = istHour(now);
  if (channel !== "email" && (hour < cfg.quietStartHourIst || hour >= cfg.quietEndHourIst)) {
    return { allowed: false, reason: `outside permitted hours (${cfg.quietStartHourIst}:00–${cfg.quietEndHourIst}:00 IST)` };
  }

  const dayMs = 86_400_000;
  const outbound = ctx.attempts.filter((a) => a.leadId === lead.id && a.channel !== "field_visit");
  const today = outbound.filter((a) => now.getTime() - a.at.getTime() < dayMs).length;
  const week = outbound.filter((a) => now.getTime() - a.at.getTime() < 7 * dayMs).length;
  if (today >= cfg.maxAttemptsPerDay) return { allowed: false, reason: "daily contact limit reached for this lead" };
  if (week >= cfg.maxAttemptsPerWeek) return { allowed: false, reason: "weekly contact limit reached for this lead" };

  return { allowed: true };
}

const OPT_OUT_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bdon'?t (call|message|contact)\b/i,
  /\bdo not (call|message|contact)\b/i,
  /\bnot interested,? (don'?t|do not)\b/i,
  /\bremove (me|my number)\b/i,
  /vaddu.*(call|phone)/i, // Telugu (romanised): "call vaddu"
  /(call|phone).*vaddu/i,
  /beda.*(call|phone)/i, // Kannada (romanised): "call beda"
  /(call|phone).*beda/i,
  /mat (karo|karna).*(call|phone)/i, // Hindi (romanised)
  /(call|phone).*mat (karo|karna)/i,
];

/** Detects an explicit opt-out in any supported language (romanised). Errs on the side of stopping. */
export function isOptOutMessage(text: string): boolean {
  return OPT_OUT_PATTERNS.some((p) => p.test(text));
}
