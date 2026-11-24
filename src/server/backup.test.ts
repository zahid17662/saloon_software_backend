import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { barbers, categories, payouts, sales, services, settings } from "../db/schema";
import { exportBackup } from "./backup";
import { addPayout } from "./payouts";
import { createSale } from "./sales";
import { createTestDb, type TestDb } from "./test-db";

const NOW = new Date("2026-03-10T06:00:00Z");
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("exportBackup", () => {
  it("contains every table, and never the PIN or shop-code hashes", async () => {
    await t.db.delete(payouts);
    await t.db.delete(sales);
    await t.db.delete(services);
    await t.db.delete(categories);
    await t.db.delete(barbers);
    await t.db.delete(settings);
    await t.db.insert(settings).values([
      { key: "shopName", value: "দোকান" },
      { key: "adminPinHash", value: "SECRET-HASH-1" },
      { key: "shopCodeHash", value: "SECRET-HASH-2" },
    ]);
    const [b] = await t.db.insert(barbers).values({ name: "এ", commissionPct: 50 }).returning();
    const [c] = await t.db.insert(categories).values({ name: "চুল" }).returning();
    const [s] = await t.db.insert(services).values({ categoryId: c.id, name: "কাটিং", price: 250 }).returning();
    await createSale(
      t.db,
      { barberId: b.id, items: [{ serviceId: s.id, qty: 1 }], paymentMethod: "CASH", idempotencyKey: "backup-test-0001" },
      { now: NOW },
    );
    await addPayout(t.db, { barberId: b.id, amount: 100, date: "2026-03-10", note: "" }, NOW);

    const data = await exportBackup(t.db, NOW);
    expect(data.exportedAt).toBe(NOW.toISOString());
    expect(data.settings.shopName).toBe("দোকান");
    expect([data.barbers.length, data.categories.length, data.services.length]).toEqual([1, 1, 1]);
    expect([data.sales.length, data.saleItems.length, data.payouts.length]).toEqual([1, 1, 1]);
    expect(data.sales[0]).toMatchObject({ total: 250, barberShare: 125, ownerShare: 125 });
    expect(JSON.stringify(data)).not.toContain("SECRET-HASH");
  });
});
