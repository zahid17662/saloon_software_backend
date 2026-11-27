// The seed logic, separate from the Neon connection in seed.ts so tests can run it on PGlite.
// Idempotent: each table is filled only if it is empty, settings use ON CONFLICT DO NOTHING, and
// everything runs in one transaction that holds an advisory lock, so two seeds started at once
// (a retried deploy hook) cannot both see "empty" and insert duplicates.

import bcrypt from "bcryptjs";
import { count, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { DEMO_BARBER_PASSWORD, INITIAL_SHOP_CODE_VERSION, createSeed } from "../lib/seed";
import { barbers, categories, services, settings } from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = PgDatabase<any, any>;

const SEED_LOCK = 7002;

export interface SeedOptions {
  pin: string;
  shopCode: string;
  /** Starting password of every seeded barber. Defaults to the dev-only demo password. */
  barberPassword?: string;
  bcryptCost?: number;
}

export interface SeedResult {
  categories: number;
  services: number;
  barbers: number;
  settings: number;
}

export async function seedDb(db: AnyDb, opts: SeedOptions): Promise<SeedResult> {
  const data = createSeed();
  const cost = opts.bcryptCost ?? 12;
  const [adminPinHash, shopCodeHash, barberPasswordHash] = await Promise.all([
    bcrypt.hash(opts.pin, cost),
    bcrypt.hash(opts.shopCode, cost),
    bcrypt.hash(opts.barberPassword ?? DEMO_BARBER_PASSWORD, cost),
  ]);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK})`);
    const out: SeedResult = { categories: 0, services: 0, barbers: 0, settings: 0 };

    const [{ n: catCount }] = await tx.select({ n: count() }).from(categories);
    if (catCount === 0) {
      for (const c of data.categories) {
        await tx.insert(categories).values({ name: c.name, sortOrder: c.sortOrder, active: c.active });
        out.categories++;
      }
    }

    const [{ n: svcCount }] = await tx.select({ n: count() }).from(services);
    if (svcCount === 0) {
      const catRows = await tx.select().from(categories);
      const idByName = new Map(catRows.map((r) => [r.name, r.id]));
      const seedCatName = new Map(data.categories.map((c) => [c.id, c.name]));
      const rows = data.services.map((s) => {
        const categoryId = idByName.get(seedCatName.get(s.categoryId) ?? "");
        if (categoryId === undefined) throw new Error(`Category missing for service "${s.name}"`);
        return { categoryId, name: s.name, price: s.price, sortOrder: s.sortOrder, active: s.active };
      });
      await tx.insert(services).values(rows);
      out.services = rows.length;
    }

    const [{ n: barberCount }] = await tx.select({ n: count() }).from(barbers);
    if (barberCount === 0) {
      const rows = data.barbers.map((b) => ({
        name: b.name,
        commissionPct: b.commissionPct,
        sortOrder: b.sortOrder,
        active: b.active,
        passwordHash: barberPasswordHash,
      }));
      await tx.insert(barbers).values(rows);
      out.barbers = rows.length;
    }

    const s = data.settings;
    const inserted = await tx
      .insert(settings)
      .values([
        { key: "shopName", value: s.shopName },
        { key: "shopAddress", value: s.shopAddress },
        { key: "shopPhone", value: s.shopPhone },
        { key: "receiptFooter", value: s.receiptFooter },
        { key: "paperWidth", value: s.paperWidth },
        { key: "adminPinHash", value: adminPinHash },
        { key: "shopCodeHash", value: shopCodeHash },
        { key: "shopCodeVersion", value: String(INITIAL_SHOP_CODE_VERSION) },
      ])
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });
    out.settings = inserted.length;

    return out;
  });
}
