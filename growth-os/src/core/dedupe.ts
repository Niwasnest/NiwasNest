// Duplicate detection by normalised phone, address and business identity.
import { normalizeIndianPhone } from "./phone";
import type { Lead } from "./types";

export interface DuplicateMatch {
  leadId: string;
  reason: "phone" | "email" | "address_and_name" | "location_and_name";
  score: number; // 0..1
}

const STOP = new Set(["pg", "paying", "guest", "guests", "hostel", "for", "men", "women", "ladies", "gents", "boys", "girls", "the", "co", "living", "coliving", "stay", "stays", "residency", "home", "homes", "luxury"]);

export function normalizeName(s: string | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(" ");
}

export function normalizeAddress(s: string | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\b(bengaluru|bangalore|karnataka|india)\b/g, " ")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\b(cross|crs)\b/g, "cross")
    .replace(/\b(main|mn)\b/g, "main")
    .replace(/\b(road|rd)\b/g, "road")
    .replace(/\b(layout|lyt)\b/g, "layout")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}

export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type Candidate = Pick<Lead, "phoneE164" | "email" | "address" | "pgName" | "lat" | "lng">;

export function findDuplicates(candidate: Candidate, existing: Lead[]): DuplicateMatch[] {
  const phone = normalizeIndianPhone(candidate.phoneE164);
  const email = candidate.email?.trim().toLowerCase();
  const addr = normalizeAddress(candidate.address);
  const name = normalizeName(candidate.pgName);
  const out: DuplicateMatch[] = [];

  for (const l of existing) {
    if (phone && normalizeIndianPhone(l.phoneE164) === phone) {
      out.push({ leadId: l.id, reason: "phone", score: 1 });
      continue;
    }
    if (email && l.email?.trim().toLowerCase() === email) {
      out.push({ leadId: l.id, reason: "email", score: 0.95 });
      continue;
    }
    const nameSim = name ? jaccard(name, normalizeName(l.pgName)) : 0;
    if (
      candidate.lat != null && candidate.lng != null && l.lat != null && l.lng != null &&
      haversineMeters(candidate.lat, candidate.lng, l.lat, l.lng) <= 75 && nameSim >= 0.5
    ) {
      out.push({ leadId: l.id, reason: "location_and_name", score: 0.6 + 0.4 * nameSim });
      continue;
    }
    const addrSim = addr ? jaccard(addr, normalizeAddress(l.address)) : 0;
    if (addrSim >= 0.6 && nameSim >= 0.5) {
      out.push({ leadId: l.id, reason: "address_and_name", score: (addrSim + nameSim) / 2 });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
