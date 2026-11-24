// Catalog (categories, services, barbers) and public shop settings.
// Plain functions over a Drizzle handle: no Next.js imports, so they run the same against Neon in
// production and PGlite in tests. Auth + zod + revalidation live in src/app/actions/catalog.ts.

import bcrypt from "bcryptjs";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { barbers, categories, services, settings } from "../db/schema";
import type { Barber, Category, PaperWidth, Service, Settings } from "../lib/types";
import type { BarberInput, BarberPatch, CategoryInput, CategoryPatch, ServiceInput, ServicePatch, SettingsPatch } from "../lib/schemas";
import type { Db } from "./db-types";
import { DomainError } from "./errors";

const MSG = {
  barberMissing: "নাপিত পাওয়া যায়নি",
  barberDuplicate: "এই নামে একজন নাপিত আগে থেকেই আছে",
  categoryMissing: "ক্যাটাগরি পাওয়া যায়নি",
  serviceMissing: "সার্ভিস পাওয়া যায়নি",
} as const;

// The only settings keys that may be read or written here. The hashes and shopCodeVersion live in
// the same table but are owned by src/app/actions/auth.ts and must never reach the client.
const PUBLIC_SETTING_KEYS = ["shopName", "shopAddress", "shopPhone", "receiptFooter", "paperWidth"] as const;

// Bcrypt cost for barber passwords. Matches src/lib/auth.ts's BCRYPT_COST for admin/shop secrets;
// hashed directly with bcryptjs here (not via auth.ts) so this pure DB layer stays free of
// auth.ts's next/headers dependency - same reasoning as src/db/seed-core.ts.
const BARBER_BCRYPT_COST = 12;

const toBarber = (r: typeof barbers.$inferSelect): Barber => ({
  id: r.id,
  name: r.name,
  commissionPct: r.commissionPct,
  sortOrder: r.sortOrder,
  active: r.active,
  hasPassword: r.passwordHash !== null,
  createdAt: r.createdAt.toISOString(),
});

const toCategory = (r: typeof categories.$inferSelect): Category => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sortOrder,
  active: r.active,
});

const toService = (r: typeof services.$inferSelect): Service => ({
  id: r.id,
  categoryId: r.categoryId,
  name: r.name,
  price: r.price,
  sortOrder: r.sortOrder,
  active: r.active,
});

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const width = map.get("paperWidth");
  const paperWidth: PaperWidth = width === "58" || width === "A4" ? width : "80";
  return {
    shopName: map.get("shopName") ?? "",
    shopAddress: map.get("shopAddress") ?? "",
    shopPhone: map.get("shopPhone") ?? "",
    receiptFooter: map.get("receiptFooter") ?? "",
    paperWidth,
  };
}

export interface Catalog {
  categories: Category[];
  services: Service[];
  barbers: Barber[];
  settings: Settings;
}

/** Everything the barber screen and the admin catalog pages need. Includes inactive rows. */
export async function getCatalog(db: Db): Promise<Catalog> {
  const [cats, svcs, bars, st] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id)),
    db.select().from(services).orderBy(asc(services.sortOrder), asc(services.id)),
    db.select().from(barbers).orderBy(asc(barbers.sortOrder), asc(barbers.id)),
    getSettings(db),
  ]);
  return { categories: cats.map(toCategory), services: svcs.map(toService), barbers: bars.map(toBarber), settings: st };
}

// ---------- barbers ----------

async function assertBarberNameFree(db: Db, name: string, selfId?: number) {
  const clash = await db
    .select({ id: barbers.id })
    .from(barbers)
    .where(and(eq(barbers.active, true), eq(barbers.name, name), selfId ? ne(barbers.id, selfId) : undefined))
    .limit(1);
  if (clash.length > 0) throw new DomainError(MSG.barberDuplicate);
}

export async function addBarber(db: Db, input: BarberInput): Promise<Barber> {
  await assertBarberNameFree(db, input.name);
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${barbers.sortOrder}) + 1, 0)`.mapWith(Number) })
    .from(barbers);
  const passwordHash = await bcrypt.hash(input.password, BARBER_BCRYPT_COST);
  const [row] = await db
    .insert(barbers)
    .values({ name: input.name, commissionPct: input.commissionPct, sortOrder: next, passwordHash })
    .returning();
  return toBarber(row);
}

export async function updateBarber(db: Db, id: number, rawPatch: BarberPatch): Promise<Barber> {
  // zod already trims on the action path; trim again so a direct caller cannot store padded names.
  const { password, ...rest } = rawPatch;
  const patch = rest.name === undefined ? rest : { ...rest, name: rest.name.trim() };
  const [cur] = await db.select().from(barbers).where(eq(barbers.id, id));
  if (!cur) throw new DomainError(MSG.barberMissing);
  const nextName = patch.name ?? cur.name;
  const nextActive = patch.active ?? cur.active;
  if (nextActive) await assertBarberNameFree(db, nextName, id);
  const passwordHash = password === undefined ? undefined : await bcrypt.hash(password, BARBER_BCRYPT_COST);
  const fullPatch = passwordHash === undefined ? patch : { ...patch, passwordHash };
  if (Object.keys(fullPatch).length === 0) return toBarber(cur);
  const [row] = await db.update(barbers).set(fullPatch).where(eq(barbers.id, id)).returning();
  return toBarber(row);
}

// ---------- categories ----------

export async function addCategory(db: Db, input: CategoryInput): Promise<Category> {
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${categories.sortOrder}) + 1, 0)`.mapWith(Number) })
    .from(categories);
  const [row] = await db.insert(categories).values({ name: input.name, sortOrder: next }).returning();
  return toCategory(row);
}

export async function updateCategory(db: Db, id: number, patch: CategoryPatch): Promise<Category> {
  if (Object.keys(patch).length === 0) {
    const [cur] = await db.select().from(categories).where(eq(categories.id, id));
    if (!cur) throw new DomainError(MSG.categoryMissing);
    return toCategory(cur);
  }
  const [row] = await db.update(categories).set(patch).where(eq(categories.id, id)).returning();
  if (!row) throw new DomainError(MSG.categoryMissing);
  return toCategory(row);
}

// ---------- services ----------

async function assertCategoryExists(db: Db, categoryId: number) {
  const [c] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
  if (!c) throw new DomainError(MSG.categoryMissing);
}

export async function addService(db: Db, input: ServiceInput): Promise<Service> {
  await assertCategoryExists(db, input.categoryId);
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${services.sortOrder}) + 1, 0)`.mapWith(Number) })
    .from(services)
    .where(eq(services.categoryId, input.categoryId));
  const [row] = await db
    .insert(services)
    .values({ categoryId: input.categoryId, name: input.name, price: input.price, sortOrder: next })
    .returning();
  return toService(row);
}

export async function updateService(db: Db, id: number, patch: ServicePatch): Promise<Service> {
  const [cur] = await db.select().from(services).where(eq(services.id, id));
  if (!cur) throw new DomainError(MSG.serviceMissing);
  if (patch.categoryId !== undefined) await assertCategoryExists(db, patch.categoryId);
  if (Object.keys(patch).length === 0) return toService(cur);
  const [row] = await db.update(services).set(patch).where(eq(services.id, id)).returning();
  return toService(row);
}

// ---------- settings ----------

export async function updateSettings(db: Db, patch: SettingsPatch): Promise<Settings> {
  const entries = PUBLIC_SETTING_KEYS.flatMap((key) => (patch[key] === undefined ? [] : [{ key, value: patch[key] as string }]));
  if (entries.length > 0) {
    await db
      .insert(settings)
      .values(entries)
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });
  }
  return getSettings(db);
}
