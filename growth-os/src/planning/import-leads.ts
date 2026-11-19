// Imports PG-owner leads from a spreadsheet (CSV) with duplicate detection and consent capture.
import { normalizeIndianPhone } from "../core/phone";
import type { Lead } from "../core/types";
import type { GrowthStore } from "../store/memory";

export interface ImportReport {
  created: Lead[];
  skippedDuplicates: { row: number; name: string; existingId: string; reason: string }[];
  possibleDuplicates: { row: number; leadId: string; name: string; matches: string[] }[];
  invalid: { row: number; reason: string }[];
  consentsRecorded: number;
}

const yes = (v?: string) => /^(y|yes|true|1|haan|avunu|houdu)$/i.test((v ?? "").trim());
const num = (v?: string) => (v && /^\d+$/.test(v.trim()) ? Number(v) : undefined);
const LANGS = new Set(["te", "en", "kn", "hi"]);
const TYPES = new Set(["male", "female", "co_living", "other"]);

export function importLeads(store: GrowthStore, rows: Record<string, string>[], actor: string, now = new Date()): ImportReport {
  const rep: ImportReport = { created: [], skippedDuplicates: [], possibleDuplicates: [], invalid: [], consentsRecorded: 0 };
  rows.forEach((r, idx) => {
    const row = idx + 2; // header is row 1
    const name = r.pg_name || r.owner_name || "";
    const phone = normalizeIndianPhone(r.phone);
    if (!name) return rep.invalid.push({ row, reason: "pg_name or owner_name is required" });
    if (r.phone && !phone) return rep.invalid.push({ row, reason: `"${r.phone}" is not a valid Indian mobile number` });
    if (!phone && !r.address) return rep.invalid.push({ row, reason: "need a phone or an address" });
    const lang = (r.language || "te").toLowerCase();
    const ptype = (r.property_type || "").toLowerCase().replace(/[- ]/g, "_");
    const { lead, duplicates, created } = store.createLead(
      {
        kind: "pg_owner", ownerName: r.owner_name || undefined, pgName: r.pg_name || undefined, phoneE164: phone ?? undefined,
        email: r.email || undefined, address: r.address || undefined, locality: r.locality || undefined, city: r.city || "Bengaluru",
        lat: r.lat ? Number(r.lat) : undefined, lng: r.lng ? Number(r.lng) : undefined,
        propertyType: TYPES.has(ptype) ? (ptype as Lead["propertyType"]) : undefined,
        totalBeds: num(r.total_beds), vacantBeds: num(r.vacant_beds), rentMin: num(r.rent_min), rentMax: num(r.rent_max),
        source: r.source || "csv_import", trackingCode: r.tracking_code || undefined,
        language: (LANGS.has(lang) ? lang : "te") as Lead["language"], notes: r.notes || undefined,
      },
      actor,
    );
    if (!created) {
      rep.skippedDuplicates.push({ row, name, existingId: lead.id, reason: duplicates[0]?.reason ?? "duplicate" });
      return;
    }
    rep.created.push(lead);
    if (duplicates.length) rep.possibleDuplicates.push({ row, leadId: lead.id, name, matches: duplicates.map((d) => `${d.leadId} (${d.reason})`) });
    // Consent is recorded only with evidence (who/when/how it was given). No evidence → no consent.
    const evidence = r.consent_evidence?.trim();
    if (evidence && phone) {
      for (const [col, channel] of [["consent_call", "call"], ["consent_whatsapp", "whatsapp"]] as const) {
        if (yes(r[col])) {
          store.addConsent({ phoneE164: phone, channel, granted: true, evidence: `${evidence} (import row ${row})`, capturedAt: now });
          rep.consentsRecorded++;
        }
      }
    }
  });
  return rep;
}
