// Founder login: scrypt password hash + HMAC-signed session cookie + per-session CSRF token.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const a = Buffer.from(scryptSync(password, salt, 32).toString("hex"));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Session {
  user: string;
  csrf: string;
  exp: number; // epoch ms
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString();
const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function createSessionToken(user: string, secret: string, ttlMs = 12 * 3600_000, now = Date.now()): { token: string; session: Session } {
  const session: Session = { user, csrf: randomBytes(16).toString("base64url"), exp: now + ttlMs };
  const data = b64(JSON.stringify(session));
  return { token: `${data}.${sign(data, secret)}`, session };
}

export function readSessionToken(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = sign(data, secret);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const s = JSON.parse(unb64(data)) as Session;
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}

/** Simple in-memory login throttle: 5 failures per 15 minutes per key (IP). */
export class LoginThrottle {
  private fails = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 15 * 60_000) {}
  blocked(key: string, now = Date.now()): boolean {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, list);
    return list.length >= this.max;
  }
  fail(key: string, now = Date.now()) {
    this.fails.set(key, [...(this.fails.get(key) ?? []), now]);
  }
  reset(key: string) {
    this.fails.delete(key);
  }
}
