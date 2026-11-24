// Full data backup for the owner (Settings, "ব্যাকআপ ডাউনলোড"). Public shop settings only: the PIN,
// shop-code and barber-password hashes are never exported.

import { asc } from "drizzle-orm";
import { barbers, categories, payouts, saleItems, sales, services } from "../db/schema";
import type { Db } from "./db-types";
import { getSettings } from "./catalog";

export async function exportBackup(db: Db, now: Date = new Date()) {
  const [shop, cats, svcs, bars, saleRows, items, pays] = await Promise.all([
    getSettings(db),
    db.select().from(categories).orderBy(asc(categories.id)),
    db.select().from(services).orderBy(asc(services.id)),
    db
      .select({
        id: barbers.id,
        name: barbers.name,
        commissionPct: barbers.commissionPct,
        sortOrder: barbers.sortOrder,
        active: barbers.active,
        createdAt: barbers.createdAt,
      })
      .from(barbers)
      .orderBy(asc(barbers.id)),
    db.select().from(sales).orderBy(asc(sales.id)),
    db.select().from(saleItems).orderBy(asc(saleItems.id)),
    db.select().from(payouts).orderBy(asc(payouts.id)),
  ]);
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
