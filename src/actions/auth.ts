import { eq, sql } from "drizzle-orm";
import { barbers, db, settings } from "@/db";
import {
  attemptStore,
  AuthError,
  checkSecret,
  clearAdminCookie,
  clearBarberCookie,
  clearShopCookie,
  getAuthSettings,
  getClientIp,
  hasValidAdminSession,
  hasValidBarberSession,
  hasValidShopSession,
  hashSecret,
  requireShop,
  setAdminCookie,
  setBarberCookie,
  setShopCookie,
} from "@/lib/auth";
import { changePinInput, changeShopCodeInput, loginAdminInput, unlockInput } from "@/lib/auth-core";
import { barberLoginInput } from "@/lib/schemas";
import { beginAttempt, recordSuccess } from "@/lib/rate-limit";

export type ActionResult = { ok: true } | { ok: false; error: string };

const MSG = {
  wrongCode: "কোড ভুল হয়েছে, আবার চেষ্টা করুন",
  wrongPin: "পিন ভুল হয়েছে",
  blocked: "অনেকবার ভুল হয়েছে। ১৫ মিনিট পরে আবার চেষ্টা করুন",
  needLogin: "এডমিন হিসেবে আবার লগইন করুন",
  wrongCurrentPin: "বর্তমান পিন ভুল",
  badNewPin: "নতুন পিন ৪–৮ সংখ্যার হতে হবে",
  badNewCode: "দোকানের কোড ৪–৮ সংখ্যার হতে হবে",
  wrongBarberPassword: "পাসওয়ার্ড ভুল হয়েছে",
  noBarberPassword: "এই নাপিতের পাসওয়ার্ড এখনো সেট করা হয়নি, এডমিনকে বলুন",
  generic: "কিছু একটা ভুল হয়েছে, আবার চেষ্টা করুন",
} as const;

const fail = (error: string): ActionResult => ({ ok: false, error });

// Never log error messages or stacks: DB errors can echo query parameters.
const logFailure = (action: string, e: unknown) =>
  console.error(`${action} failed:`, e instanceof Error ? e.name : "unknown error");

/** FR-1: unlock this device with the shop code. */
export async function unlockShop(input: unknown): Promise<ActionResult> {
  try {
    const ip = await getClientIp();
    if (!ip) return fail(MSG.generic); // no trusted client address: refuse rather than share a bucket
    if (!(await beginAttempt(attemptStore, ip, "shop")).allowed) return fail(MSG.blocked);

    const parsed = unlockInput.safeParse(input);
    const s = await getAuthSettings();
    // Always run bcrypt, even for bad input, so timing does not leak anything.
    const match = await checkSecret(parsed.success ? parsed.data.code : "", s?.shopCodeHash);
    if (!parsed.success || !s || !match) return fail(MSG.wrongCode);

    await recordSuccess(attemptStore, ip, "shop");
    await setShopCookie(s.shopCodeVersion);
    return { ok: true };
  } catch (e) {
    logFailure("unlockShop", e);
    return fail(MSG.generic);
  }
}

/** FR-2: admin login. A successful login also unlocks this device for the barber screens. */
export async function loginAdmin(input: unknown): Promise<ActionResult> {
  try {
    const ip = await getClientIp();
    if (!ip) return fail(MSG.generic);
    if (!(await beginAttempt(attemptStore, ip, "admin")).allowed) return fail(MSG.blocked);

    const parsed = loginAdminInput.safeParse(input);
    const s = await getAuthSettings();
    const match = await checkSecret(parsed.success ? parsed.data.pin : "", s?.adminPinHash);
    if (!parsed.success || !s || !match) return fail(MSG.wrongPin);

    await recordSuccess(attemptStore, ip, "admin");
    await setAdminCookie(s.adminPinHash);
    await setShopCookie(s.shopCodeVersion);
    return { ok: true };
  } catch (e) {
    logFailure("loginAdmin", e);
    return fail(MSG.generic);
  }
}

/** Ends the admin session only; the device stays unlocked for barbers. */
export async function logoutAdmin(): Promise<ActionResult> {
  try {
    await clearAdminCookie();
    return { ok: true };
  } catch (e) {
    logFailure("logoutAdmin", e);
    return fail(MSG.generic);
  }
}

/** Changing the PIN signs out every other admin session (the cookie carries a PIN fingerprint). */
export async function changeAdminPin(input: unknown): Promise<ActionResult> {
  try {
    if (!(await hasValidAdminSession())) return fail(MSG.needLogin);

    const parsed = changePinInput.safeParse(input);
    if (!parsed.success) return fail(MSG.badNewPin);

    // The current PIN is a guessable secret too, so it shares the admin login limiter.
    const ip = await getClientIp();
    if (!ip) return fail(MSG.generic);
    if (!(await beginAttempt(attemptStore, ip, "admin")).allowed) return fail(MSG.blocked);

    const s = await getAuthSettings();
    if (!s || !(await checkSecret(parsed.data.current, s.adminPinHash))) return fail(MSG.wrongCurrentPin);

    const newHash = await hashSecret(parsed.data.next);
    await db.update(settings).set({ value: newHash }).where(eq(settings.key, "adminPinHash"));
    await recordSuccess(attemptStore, ip, "admin");
    await setAdminCookie(newHash); // keep this session alive with the new fingerprint
    return { ok: true };
  } catch (e) {
    logFailure("changeAdminPin", e);
    return fail(MSG.generic);
  }
}

/** FR-21: bumps shopCodeVersion in the same transaction, which logs out every other device. */
export async function changeShopCode(input: unknown): Promise<ActionResult> {
  try {
    if (!(await hasValidAdminSession())) return fail(MSG.needLogin);

    const parsed = changeShopCodeInput.safeParse(input);
    if (!parsed.success) return fail(MSG.badNewCode);

    const newHash = await hashSecret(parsed.data.next);
    const version = await db.transaction(async (tx) => {
      await tx.update(settings).set({ value: newHash }).where(eq(settings.key, "shopCodeHash"));
      const [row] = await tx
        .update(settings)
        .set({ value: sql`((${settings.value})::int + 1)::text` })
        .where(eq(settings.key, "shopCodeVersion"))
        .returning({ value: settings.value });
      return Number(row.value);
    });
    await setShopCookie(version); // keep this (admin) device unlocked
    return { ok: true };
  } catch (e) {
    logFailure("changeShopCode", e);
    return fail(MSG.generic);
  }
}

/** Used by the barber screens to notice a stale device (e.g. after the shop code changed). */
export async function checkShopSession(): Promise<{ valid: boolean }> {
  // No catch on purpose: a database outage must reach the caller as a failure, not as "logged out".
  const valid = (await hasValidShopSession()) || (await hasValidAdminSession());
  if (!valid) await clearShopCookie();
  return { valid };
}

/** A barber logging in to their own screen. The device must already be shop-unlocked. */
export async function barberLogin(input: unknown): Promise<ActionResult> {
  try {
    await requireShop();

    const ip = await getClientIp();
    if (!ip) return fail(MSG.generic);
    if (!(await beginAttempt(attemptStore, ip, "barber")).allowed) return fail(MSG.blocked);

    const parsed = barberLoginInput.safeParse(input);
    if (!parsed.success) return fail(MSG.wrongBarberPassword);

    const [barber] = await db.select().from(barbers).where(eq(barbers.id, parsed.data.barberId));
    if (!barber?.active) return fail(MSG.wrongBarberPassword);
    if (!barber.passwordHash) return fail(MSG.noBarberPassword);

    const match = await checkSecret(parsed.data.password, barber.passwordHash);
    if (!match) return fail(MSG.wrongBarberPassword);

    await recordSuccess(attemptStore, ip, "barber");
    await setBarberCookie(barber.id, barber.passwordHash);
    return { ok: true };
  } catch (e) {
    if (e instanceof AuthError) return fail(MSG.wrongCode); // device itself is not shop-unlocked
    logFailure("barberLogin", e);
    return fail(MSG.generic);
  }
}

/** Ends just this barber's own session; the shop device stays unlocked for the next person. */
export async function barberLogout(): Promise<ActionResult> {
  try {
    await clearBarberCookie();
    return { ok: true };
  } catch (e) {
    logFailure("barberLogout", e);
    return fail(MSG.generic);
  }
}

/** Used by the barber screen to notice its own session going stale (password changed, deactivated). */
export async function checkBarberSession(barberId: number): Promise<{ valid: boolean }> {
  return { valid: await hasValidBarberSession(barberId) }; // an outage throws: see checkShopSession
}
