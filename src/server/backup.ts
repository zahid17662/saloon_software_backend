// Full data backup for the owner (Settings, "ব্যাকআপ ডাউনলোড"). Public shop settings only: the PIN,
// shop-code and barber-password hashes are never exported.

import { asc } from "drizzle-orm";
import { barbers, categories, payouts, saleItems, sales, services } from "../db/schema";
import type { Db } from "./db-types";
import { getSettings } from "./catalog";

export async function exportBackup(db: Db, now: Date = new Date()) {
  // One read-only snapshot: a sale saved during the backup is either fully in it or not at all.
  return db.transaction((tx) => readAll(tx as unknown as Db, now), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function readAll(db: Db, now: Date) {
  // Sequential on purpose: one transaction is one connection.
  const shop = await getSettings(db);
  const cats = await db.select().from(categories).orderBy(asc(categories.id));
  const svcs = await db.select().from(services).orderBy(asc(services.id));
  const bars = await db
      .select({
        id: barbers.id,
        name: barbers.name,
        commissionPct: barbers.commissionPct,
        sortOrder: barbers.sortOrder,
        active: barbers.active,
        createdAt: barbers.createdAt,
      })
    .from(barbers)
    .orderBy(asc(barbers.id));
  const saleRows = await db.select().from(sales).orderBy(asc(sales.id));
  const items = await db.select().from(saleItems).orderBy(asc(saleItems.id));
  const pays = await db.select().from(payouts).orderBy(asc(payouts.id));
  return {
    exportedAt: now.toISOString(),
    settings: shop,
    categories: cats,
    services: svcs,
    barbers: bars,
    sales: saleRows,
    saleItems: items,
    payouts: pays,
  };
}
