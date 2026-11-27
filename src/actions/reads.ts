// Read endpoints for the frontend's server-rendered pages (what used to be direct database reads in
// the Next.js app). Each one does its own auth, exactly like the old page guards (page-auth.ts):
// no valid session -> the API says where to redirect, the frontend just follows it.
// Anything that is not an AuthError (for example a database outage) is thrown, so it surfaces as a
// 500 and the frontend's error page, never as a fake "logged out".

import { eq } from "drizzle-orm";
import { barbers, db } from "@/db";
import { AuthError, getAuthenticatedBarberId, hasValidAdminSession, requireAdmin, requireBarberSelf, requireShop } from "@/lib/auth";
import { todayKey } from "@/lib/time";
import { exportBackup } from "@/server/backup";
import { getCatalog, type Catalog } from "@/server/catalog";
import { barberSalesToday, getSale, todayStats } from "@/server/sales";
import type { Sale } from "@/lib/types";
import { publicShopName } from "./shop-name";

export type ReadResult<T> =
  | { status: "ok"; data: T }
  | { status: "redirect"; to: string }
  | { status: "notFound" }
  | { status: "unauthorized" };

const ok = <T>(data: T): ReadResult<T> => ({ status: "ok", data });
const redirectTo = (to: string): ReadResult<never> => ({ status: "redirect", to });

async function guard(check: () => Promise<void>, to: string): Promise<ReadResult<never> | null> {
  try {
    await check();
    return null;
  } catch (e) {
    if (e instanceof AuthError) return redirectTo(to);
    throw e;
  }
}

/** Layout catalog: null for visitors without a shop/admin session (the /unlock page). */
export async function readCatalog(): Promise<Catalog | null> {
  try {
    await requireShop();
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  return getCatalog(db);
}

export async function readHome(): Promise<ReadResult<Awaited<ReturnType<typeof todayStats>>>> {
  return (await guard(requireShop, "/unlock")) ?? ok(await todayStats(db));
}

export async function readBarber(barberId: number): Promise<ReadResult<Sale[]>> {
  const noShop = await guard(requireShop, "/unlock");
  if (noShop) return noShop;
  const noBarber = await guard(() => requireBarberSelf(barberId), `/barber-login/${barberId}`);
  if (noBarber) return noBarber;
  return ok(await barberSalesToday(db, barberId));
}

export async function readBarberLogin(barberId: number): Promise<ReadResult<{ id: number; name: string }>> {
  const noShop = await guard(requireShop, "/unlock");
  if (noShop) return noShop;
  const [barber] = await db
    .select({ id: barbers.id, name: barbers.name, active: barbers.active })
    .from(barbers)
    .where(eq(barbers.id, barberId));
  if (!barber?.active) return { status: "notFound" };
  return ok({ id: barber.id, name: barber.name });
}

export async function readReceipt(saleId: number): Promise<ReadResult<Sale | null>> {
  const noShop = await guard(requireShop, "/unlock");
  if (noShop) return noShop;
  const sale = await getSale(db, saleId);
  if (!sale) {
    if ((await hasValidAdminSession()) || (await getAuthenticatedBarberId()) !== null) return ok(null);
    return redirectTo("/pos");
  }
  const noBarber = await guard(() => requireBarberSelf(sale.barberId), `/barber-login/${sale.barberId}`);
  if (noBarber) return noBarber;
  return ok(sale);
}

/** Public: the shop name for the unlock and admin-login pages. */
export async function readShopName(): Promise<string> {
  return publicShopName();
}

/** Public: active barbers for the website's optional "pick a barber" field — name only, no auth. */
export async function readActiveBarbers(): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: barbers.id, name: barbers.name })
    .from(barbers)
    .where(eq(barbers.active, true))
    .orderBy(barbers.sortOrder, barbers.id);
}

/** Owner backup download. `unauthorized` (not a redirect) because the frontend serves it as a file. */
export async function readBackup(): Promise<ReadResult<{ filename: string; json: string }>> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) return { status: "unauthorized" };
    throw e;
  }
  const data = await exportBackup(db);
  return ok({ filename: `salon-backup-${todayKey()}.json`, json: JSON.stringify(data, null, 2) });
}
