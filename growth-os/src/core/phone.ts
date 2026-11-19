// Indian phone normalisation. Every lead is keyed on E.164 so duplicates are caught
// regardless of how the number was typed ("098480 12345", "+91-98480-12345", "9848012345").

export function normalizeIndianPhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // Indian mobile numbers start with 6–9. Note: a landline written with STD code ("080 2345 6789")
  // is indistinguishable from a 0-prefixed mobile; the voice provider's number lookup settles it.
  if (!/^[6-9]/.test(digits)) return null;
  return `+91${digits}`;
}

export function maskPhone(e164: string): string {
  return e164.length > 6 ? `${e164.slice(0, 5)}*****${e164.slice(-3)}` : "*****";
}
