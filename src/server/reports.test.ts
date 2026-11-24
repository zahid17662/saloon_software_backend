import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { barbers, categories, sales, services } from "../db/schema";
import { byPeriod, liveSales } from "../lib/reports";
import type { Barber } from "../lib/types";
import { periodTotals } from "./reports";
import { createSale, listSales, voidSaleByAdmin } from "./sales";
import { createTestDb, type TestDb } from "./test-db";

const NOW = new Date("2026-04-05T06:00:00Z");
let t: TestDb;
let A: number;
let B: number;
let CUT: number;
let WASH: number;
let n = 0;
const key = () => `rk-${++n}-${"x".repeat(8)}`;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.delete(sales);
  await t.db.delete(services);
  await t.db.delete(categories);
  await t.db.delete(barbers);
  const [a, b] = await t.db
    .insert(barbers)
    .values([
      { name: "এ", commissionPct: 50 },
      { name: "বি", commissionPct: 33 },
    ])
    .returning();
  A = a.id;
  B = b.id;
  const [c] = await t.db.insert(categories).values({ name: "চুল" }).returning();
  const s = await t.db
    .insert(services)
    .values([
      { categoryId: c.id, name: "কাটিং", price: 150 },
      { categoryId: c.id, name: "ওয়াশ", price: 50 },
    ])
    .returning();
  [CUT, WASH] = s.map((x) => x.id);
});

const sell = (barberId: number, atIso: string, items: { serviceId: number; qty: number }[], admin = false) =>
  createSale(
    t.db,
    { barberId, items, paymentMethod: "CASH", idempotencyKey: key() },
    { now: NOW, at: new Date(atIso), enteredByAdmin: admin },
  );

/** The oracle (src/lib/reports.ts) result reshaped to the SQL row shape. */
async function oracle(mode: "day" | "month") {
  const all = await listSales(t.db, { from: "2026-01-01", to: "2026-12-31" });
  const bs: Barber[] = [];
  return byPeriod(liveSales(all), bs, mode)
    .map((r) => ({
      period: r.period,
      barberId: r.barberId,
      count: r.count,
      services: r.services,
      total: r.total,
      barberShare: r.barberShare,
      ownerShare: r.ownerShare,
    }))
    .sort((a, z) => (a.period === z.period ? a.barberId - z.barberId : a.period < z.period ? 1 : -1));
}

async function seedAwkwardData() {
  await sell(A, "2026-02-28T17:59:00Z", [{ serviceId: CUT, qty: 1 }]); // Feb 28 23:59 Dhaka
  await sell(A, "2026-02-28T18:00:00Z", [{ serviceId: CUT, qty: 2 }]); // Mar 1 00:00 Dhaka
  await sell(B, "2026-03-10T05:00:00Z", [{ serviceId: WASH, qty: 3 }, { serviceId: CUT, qty: 1 }]);
  await sell(A, "2026-03-10T05:30:00Z", [{ serviceId: WASH, qty: 1 }]);
  await sell(B, "2026-03-31T17:59:00Z", [{ serviceId: CUT, qty: 1 }]); // Mar 31 23:59 Dhaka
  await sell(B, "2026-03-31T18:00:00Z", [{ serviceId: CUT, qty: 1 }]); // Apr 1 00:00 Dhaka
  await sell(A, "2026-03-15T09:00:00Z", [{ serviceId: CUT, qty: 4 }], true); // admin-entered
  const gone = await sell(A, "2026-03-10T07:00:00Z", [{ serviceId: CUT, qty: 5 }]);
  await voidSaleByAdmin(t.db, { saleId: gone.id, reason: "ভুল" }, NOW);
}

describe("SQL period totals equal the reports.ts oracle (Asia/Dhaka, voided excluded)", () => {
  it.each(["day", "month"] as const)("grouped by %s", async (mode) => {
    await seedAwkwardData();
    const sqlRows = await periodTotals(t.db, { from: "2026-01-01", to: "2026-12-31", mode });
    expect(sqlRows).toEqual(await oracle(mode));
  });

  it("has the exact Dhaka-day buckets at the midnight edges", async () => {
    await seedAwkwardData();
    const days = (await periodTotals(t.db, { from: "2026-01-01", to: "2026-12-31", mode: "day" })).map((r) => r.period);
    expect(days).toContain("2026-02-28");
    expect(days).toContain("2026-03-01"); // 18:00 UTC on Feb 28 is Mar 1 in Dhaka
    expect(days).toContain("2026-03-31");
    expect(days).toContain("2026-04-01");
  });

  it("a voided sale contributes nothing", async () => {
    await seedAwkwardData();
    const day = await periodTotals(t.db, { from: "2026-03-10", to: "2026-03-10", mode: "day" });
    expect(day.reduce((s, r) => s + r.total, 0)).toBe(3 * 50 + 150 + 50); // the ৳750 voided sale is absent
  });

  it("limits to the requested Dhaka date range, inclusive", async () => {
    await seedAwkwardData();
    const r = await periodTotals(t.db, { from: "2026-03-01", to: "2026-03-01", mode: "day" });
    expect(r).toEqual([
      { period: "2026-03-01", barberId: A, count: 1, services: 2, total: 300, barberShare: 150, ownerShare: 150 },
    ]);
  });
});

describe("FR-22: a back-dated sale is counted on the chosen Dhaka day", () => {
  it("00:00 Dhaka on the 10th lands on the 10th, not the 9th", async () => {
    await sell(A, "2026-03-09T18:00:00Z", [{ serviceId: CUT, qty: 1 }], true); // 2026-03-10 00:00 Dhaka
    const rows = await periodTotals(t.db, { from: "2026-03-09", to: "2026-03-11", mode: "day" });
    expect(rows).toEqual([
      { period: "2026-03-10", barberId: A, count: 1, services: 1, total: 150, barberShare: 75, ownerShare: 75 },
    ]);
  });

  it("23:59 Dhaka on the 10th lands on the 10th, not the 11th", async () => {
    await sell(A, "2026-03-10T17:59:00Z", [{ serviceId: CUT, qty: 1 }], true);
    const rows = await periodTotals(t.db, { from: "2026-03-09", to: "2026-03-11", mode: "day" });
    expect(rows.map((r) => r.period)).toEqual(["2026-03-10"]);
  });

  it("is added to the same day's live sales and to the month total", async () => {
    await sell(A, "2026-03-10T05:00:00Z", [{ serviceId: WASH, qty: 1 }]); // live, ৳50
    await sell(A, "2026-03-10T03:00:00Z", [{ serviceId: CUT, qty: 1 }], true); // back-dated, ৳150
    const day = await periodTotals(t.db, { from: "2026-03-10", to: "2026-03-10", mode: "day" });
    expect(day).toEqual([
      { period: "2026-03-10", barberId: A, count: 2, services: 2, total: 200, barberShare: 100, ownerShare: 100 },
    ]);
    const month = await periodTotals(t.db, { from: "2026-03-01", to: "2026-03-31", mode: "month" });
    expect(month[0]).toMatchObject({ period: "2026-03", count: 2, total: 200 });
  });
});
