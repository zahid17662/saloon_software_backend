import "server-only";
import { cookies, headers } from "next/headers";
import bcrypt from "bcryptjs";
import { and, count, eq, gt, inArray, lt, or } from "drizzle-orm";
import { barbers, db, loginAttempts, settings } from "@/db";
import {
  adminPinFingerprint,
  barberPasswordFingerprint,
  clearCookieOptions,
  cookieName,
  createAdminCookie,
  createBarberCookie,
  createShopCookie,
  sessionCookieOptions,
  verifyAdminCookie,
  verifyBarberCookie,
  verifyShopCookie,
} from "./auth-core";
import { normalizeIp, type AttemptStore } from "./rate-limit";

// Server-side auth glue (PRD §5.1). The authoritative check lives here and is called from every
// Server Action; proxy.ts only does convenience redirects (FR-4).

export const BCRYPT_COST = 12;
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor() {
    super("UNAUTHORIZED");
    this.name = "AuthError";
  }
}

const isSecure = () => process.env.NODE_ENV === "production";
// Passing "" makes auth-core throw a clear (non-secret) "SESSION_SECRET must be set" error.
const getSecret = () => process.env.SESSION_SECRET ?? "";

const cookieOptions = (maxAge: number) => sessionCookieOptions(isSecure(), maxAge);

// ---------- client IP ----------

/**
 * The rate-limit key for this request: the client IPv4, or the IPv6 /64 network.
 *
 * In production the forwarding headers are only trusted on Vercel (which overwrites x-real-ip and
 * x-forwarded-for itself) or when TRUST_PROXY_HEADERS=1 is set for another proxy you control.
 * With no trusted address this returns null and the caller must refuse the attempt, rather than
 * pooling every visitor into one shared bucket that any customer on the shop Wi-Fi could exhaust.
 */
export async function getClientIp(): Promise<string | null> {
  const production = process.env.NODE_ENV === "production";
  const trusted = process.env.VERCEL === "1" || process.env.TRUST_PROXY_HEADERS === "1";
  if (production && !trusted) {
    console.error("getClientIp: no trusted proxy headers (set TRUST_PROXY_HEADERS=1 behind your own proxy)");
    return null;
  }
  const h = await headers();
  const raw = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0] ?? "";
  const ip = normalizeIp(raw);
  if (ip) return ip;
  if (production) {
    console.error("getClientIp: request has no valid client IP header");
    return null;
  }
  return "local"; // dev only: `next dev` sends no proxy headers
}

// ---------- rate-limit store (login_attempts) ----------

export const attemptStore: AttemptStore = {
  async insert(ip, kind, at) {
    const [row] = await db
      .insert(loginAttempts)
      .values({ ip, kind, createdAt: at })
      .returning({ id: loginAttempts.id });
    return row.id;
  },
  async countSince(ip, kind, since) {
    const [row] = await db
      .select({ n: count() })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.kind, kind), gt(loginAttempts.createdAt, since)));
    return row.n;
  },
  async countKindSince(kind, since) {
    const [row] = await db
      .select({ n: count() })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.kind, kind), gt(loginAttempts.createdAt, since)));
    return row.n;
  },
  async remove(id) {
    await db.delete(loginAttempts).where(eq(loginAttempts.id, id));
  },
  async clear(ip, kind) {
    // Also prunes anything older than a day, so the table can't grow without bound.
    const cutoff = new Date(Date.now() - ATTEMPT_RETENTION_MS);
    await db
      .delete(loginAttempts)
      .where(or(and(eq(loginAttempts.ip, ip), eq(loginAttempts.kind, kind)), lt(loginAttempts.createdAt, cutoff)));
  },
};

// ---------- settings ----------

export interface AuthSettings {
  adminPinHash: string;
  shopCodeHash: string;
  shopCodeVersion: number;
}

/** null when the DB has not been seeded. */
export async function getAuthSettings(): Promise<AuthSettings | null> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, ["adminPinHash", "shopCodeHash", "shopCodeVersion"]));
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const adminPinHash = m.get("adminPinHash");
  const shopCodeHash = m.get("shopCodeHash");
  const shopCodeVersion = Number(m.get("shopCodeVersion"));
  if (!adminPinHash || !shopCodeHash || !Number.isInteger(shopCodeVersion) || shopCodeVersion < 1) return null;
  return { adminPinHash, shopCodeHash, shopCodeVersion };
}

// ---------- bcrypt ----------

let dummyHash: Promise<string> | undefined;

/**
 * bcrypt compare that does the same work whether or not a hash exists, so response time does not
 * reveal whether the DB is seeded.
 */
export async function checkSecret(plain: string, hash: string | undefined): Promise<boolean> {
  const h = hash ?? (await (dummyHash ??= bcrypt.hash("not-a-real-secret", BCRYPT_COST)));
  const ok = await bcrypt.compare(plain, h);
  return hash !== undefined && ok;
}

export const hashSecret = (plain: string) => bcrypt.hash(plain, BCRYPT_COST);

// ---------- cookies ----------

export async function setShopCookie(version: number): Promise<void> {
  const c = createShopCookie(version, getSecret());
  (await cookies()).set(cookieName("shop", isSecure()), c.value, cookieOptions(c.maxAge));
}

export async function setAdminCookie(adminPinHash: string): Promise<void> {
  const c = createAdminCookie(adminPinFingerprint(adminPinHash, getSecret()), getSecret());
  (await cookies()).set(cookieName("admin", isSecure()), c.value, cookieOptions(c.maxAge));
}

export async function setBarberCookie(barberId: number, passwordHash: string): Promise<void> {
  const c = createBarberCookie(barberId, barberPasswordFingerprint(passwordHash, getSecret()), getSecret());
  (await cookies()).set(cookieName("barber", isSecure()), c.value, cookieOptions(c.maxAge));
}

// Clear with the same attributes the cookie was set with: a bare `.delete()` has no Secure flag, and
// browsers ignore that for a `__Host-` cookie, so logout would silently fail in production.
export async function clearAdminCookie(): Promise<void> {
  (await cookies()).set(cookieName("admin", isSecure()), "", clearCookieOptions(isSecure()));
}

export async function clearShopCookie(): Promise<void> {
  (await cookies()).set(cookieName("shop", isSecure()), "", clearCookieOptions(isSecure()));
}

export async function clearBarberCookie(): Promise<void> {
  (await cookies()).set(cookieName("barber", isSecure()), "", clearCookieOptions(isSecure()));
}

// ---------- session checks (signature + expiry + DB version) ----------

export async function hasValidShopSession(): Promise<boolean> {
  const jar = await cookies();
  const payload = verifyShopCookie(jar.get(cookieName("shop", isSecure()))?.value, getSecret());
  if (!payload) return false;
  const s = await getAuthSettings();
  return s !== null && payload.v === s.shopCodeVersion;
}

export async function hasValidAdminSession(): Promise<boolean> {
  const jar = await cookies();
  const payload = verifyAdminCookie(jar.get(cookieName("admin", isSecure()))?.value, getSecret());
  if (!payload) return false;
  const s = await getAuthSettings();
  return s !== null && payload.pv === adminPinFingerprint(s.adminPinHash, getSecret());
}

/** Call at the top of every barber-facing Server Action. An admin session also counts. */
export async function requireShop(): Promise<void> {
  if (!(await hasValidShopSession()) && !(await hasValidAdminSession())) throw new AuthError();
}

/** Call at the top of every admin-only Server Action. */
export async function requireAdmin(): Promise<void> {
  if (!(await hasValidAdminSession())) throw new AuthError();
}

/** Is this device currently logged in as this specific, still-active barber? */
export async function hasValidBarberSession(barberId: number): Promise<boolean> {
  const jar = await cookies();
  const payload = verifyBarberCookie(jar.get(cookieName("barber", isSecure()))?.value, getSecret());
  if (!payload || payload.barberId !== barberId) return false;
  const [barber] = await db.select().from(barbers).where(eq(barbers.id, barberId));
  if (!barber?.active || !barber.passwordHash) return false;
  return payload.bv === barberPasswordFingerprint(barber.passwordHash, getSecret());
}

/**
 * Call at the top of every Server Action that acts AS a specific barber (creating or voiding their
 * own sale), instead of the blanket `requireShop()`. The device must hold BOTH a valid shop session
 * AND that specific barber's own password session - so rotating the shop code still revokes every
 * barber session on that device too, same as it already revokes the shop cookie itself. An admin
 * session bypasses both checks, same as every other barber-facing check.
 */
export async function requireBarberSelf(barberId: number): Promise<void> {
  if (await hasValidAdminSession()) return;
  if (!(await hasValidShopSession())) throw new AuthError();
  if (!(await hasValidBarberSession(barberId))) throw new AuthError();
}
