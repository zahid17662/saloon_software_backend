// Login rate limit (PRD FR-3): 5 failures per 15 minutes per (client network, kind), plus a global
// cap per kind so an attacker spreading guesses over many IPs still cannot brute-force a 4-digit
// code. Pure logic over an injected store, so it can be unit-tested without a DB.
//
// Each attempt is recorded BEFORE the password is checked, then counted. That makes parallel
// guesses safe: N concurrent requests cannot all slip under the limit.

import { isIP } from "node:net";

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
/** Across all IPs, per kind. 10,000 four-digit codes / 50 per 15 min is about 50 hours of guessing. */
export const GLOBAL_MAX_ATTEMPTS = 50;

export type AttemptKind = "shop" | "admin" | "barber" | "appointment";

export interface AttemptStore {
  insert(ip: string, kind: AttemptKind, at: Date): Promise<number>;
  countSince(ip: string, kind: AttemptKind, since: Date): Promise<number>;
  countKindSince(kind: AttemptKind, since: Date): Promise<number>;
  remove(id: number): Promise<void>;
  clear(ip: string, kind: AttemptKind): Promise<void>;
}

export type AttemptResult = { allowed: true } | { allowed: false };

/**
 * Record an attempt and decide if it may proceed. An allowed attempt stays recorded (it counts as a
 * failure unless recordSuccess clears it). A blocked attempt is removed again, so a lockout never
 * extends itself.
 */
export async function beginAttempt(
  store: AttemptStore,
  ip: string,
  kind: AttemptKind,
  now: Date = new Date(),
): Promise<AttemptResult> {
  const id = await store.insert(ip, kind, now);
  const since = new Date(now.getTime() - WINDOW_MS);

  const perIp = await store.countSince(ip, kind, since);
  if (perIp > MAX_FAILURES) {
    await store.remove(id);
    return { allowed: false };
  }

  const global = await store.countKindSince(kind, since);
  if (global > GLOBAL_MAX_ATTEMPTS) {
    await store.remove(id);
    return { allowed: false };
  }

  return { allowed: true };
}

/** A correct PIN/code clears this IP's failures for that kind. */
export async function recordSuccess(store: AttemptStore, ip: string, kind: AttemptKind): Promise<void> {
  await store.clear(ip, kind);
}

/**
 * Turns a raw client address into the rate-limit key. IPv4 stays as is. IPv6 collapses to its /64
 * network, because one subscriber or VPS usually owns a whole /64 and could otherwise rotate
 * through 2^64 addresses. Returns null for anything that is not a valid IP.
 */
export function normalizeIp(raw: string): string | null {
  const ip = raw.trim().split("%")[0]; // drop an IPv6 zone id such as fe80::1%eth0
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return null;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];

  let groups: string[];
  if (ip.includes("::")) {
    const [head, tail] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    groups = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return null; // e.g. an embedded IPv4 tail: fail closed

  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16));
  if (prefix.some((n) => Number.isNaN(n))) return null;
  return `${prefix.map((n) => n.toString(16)).join(":")}::/64`;
}
