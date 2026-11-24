import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { barbers, categories, payouts, saleItems, sales, services } from "../db/schema";
import { byService, liveSales } from "../lib/reports";
import { saleInput } from "../lib/schemas";
import { DomainError } from "./errors";
import { addPayout, barberBalances, deletePayout, listPayouts } from "./payouts";
import { periodTotals } from "./reports";
import { createSale, getSale, listSales, todayStats, voidSaleByAdmin, voidSaleByBarber } from "./sales";
import { createTestDb, type TestDb } from "./test-db";

// Edge cases from the PRD (§6 business rules, §12 acceptance criteria) that the other server tests
// do not pin down. A failure here is a real defect: log it in docs/BUGS.md, do not bend the test.

const NOW = new Date("2026-03-10T06:00:00Z"); // 12:00 Dhaka
const DAY = { from: "2026-03-01", to: "2026-03-31" };
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const HOUR = 3_600_000;

let t: TestDb;
let A: number; // 50 %
let ZERO: number; // 0 %
let FULL: number; // 100 %
let CUT: number; // ৳150
let WASH: number; // ৳50
let n = 0;
const key = () => `edge-${++n}-${"x".repeat(8)}`;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.delete(payouts);
  await t.db.delete(sales);
  await t.db.delete(services);
  await t.db.delete(categories);
  await t.db.delete(barbers);
  const [a, z, f] = await t.db
    .insert(barbers)
    .values([
      { name: "এ", commissionPct: 50 },
      { name: "শূন্য", commissionPct: 0 },
      { name: "পূর্ণ", commissionPct: 100 },
    ])
    .returning();
  [A, ZERO, FULL] = [a.id, z.id, f.id];
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

const sell = (barberId: number, items: { serviceId: number; qty: number }[], now = NOW, backdated?: Date) =>
  createSale(
    t.db,
    { barberId, items, paymentMethod: "CASH", idempotencyKey: key() },
    { now, at: backdated, enteredByAdmin: !!backdated },
  );

const msg = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(DomainError);
  return (e as DomainError).message;
};

describe("commission through createSale (BR-1, BR-2, AC 4)", () => {
  it("a 75 sale at 50% stores 38/37", async () => {
    const [cat] = await t.db.select().from(categories);
    const [{ id }] = await t.db.insert(services).values({ categoryId: cat.id, name: "৭৫", price: 75 }).returning();
    const s = await sell(A, [{ serviceId: id, qty: 1 }]);
    expect([s.barberShare, s.ownerShare]).toEqual([38, 37]);
  });

  it("0% commission: the barber share is 0 and the owner keeps the total", async () => {
    const s = await sell(ZERO, [{ serviceId: CUT, qty: 1 }]);
    expect([s.barberShare, s.ownerShare, s.commissionPctSnapshot]).toEqual([0, 150, 0]);
  });

  it("100% commission: the owner share is 0", async () => {
    const s = await sell(FULL, [{ serviceId: CUT, qty: 3 }]);
    expect([s.barberShare, s.ownerShare, s.commissionPctSnapshot]).toEqual([450, 0, 100]);
  });

  it("after a commission change only NEW sales use the new %, old ones keep theirs", async () => {
    const before = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    await t.db.update(barbers).set({ commissionPct: 60 }).where(eq(barbers.id, A));
    const after = await sell(A, [{ serviceId: CUT, qty: 1 }], at(MIN));
    expect([before.commissionPctSnapshot, before.barberShare]).toEqual([50, 75]);
    expect([after.commissionPctSnapshot, after.barberShare, after.ownerShare]).toEqual([60, 90, 60]);
    expect((await getSale(t.db, before.id))?.barberShare).toBe(75);
    const bal = (await barberBalances(t.db)).find((r) => r.barberId === A);
    expect(bal?.earned).toBe(75 + 90);
  });
});

describe("a service price change after a sale (BR-3, AC 3)", () => {
  it("old receipts, the sales list and every report keep the old price; new sales use the new one", async () => {
    const old = await sell(A, [{ serviceId: CUT, qty: 2 }]); // 300
    await t.db.update(services).set({ price: 200 }).where(eq(services.id, CUT));

    const receipt = await getSale(t.db, old.id);
    expect(receipt?.total).toBe(300);
    expect(receipt?.items[0]).toMatchObject({ priceSnapshot: 150, qty: 2 });

    const listed = await listSales(t.db, DAY);
    expect(listed[0].total).toBe(300);
    expect(listed[0].items[0].priceSnapshot).toBe(150);

    const day = await periodTotals(t.db, { ...DAY, mode: "day" });
    expect(day).toEqual([
      { period: "2026-03-10", barberId: A, count: 1, services: 2, total: 300, barberShare: 150, ownerShare: 150 },
    ]);
    expect(byService(liveSales(listed))).toEqual([{ name: "কাটিং", qty: 2, revenue: 300 }]);

    const fresh = await sell(A, [{ serviceId: CUT, qty: 1 }], at(MIN));
    expect(fresh.total).toBe(200);
    expect(fresh.items[0].priceSnapshot).toBe(200);
    // the report now has both, each at its own price: 2 x 150 + 1 x 200
    const both = byService(liveSales(await listSales(t.db, DAY)));
    expect(both).toEqual([{ name: "কাটিং", qty: 3, revenue: 500 }]);
  });

  it("a rename leaves the old sale's name alone", async () => {
    const old = await sell(A, [{ serviceId: WASH, qty: 1 }]);
    await t.db.update(services).set({ name: "নতুন নাম" }).where(eq(services.id, WASH));
    expect((await getSale(t.db, old.id))?.items[0].nameSnapshot).toBe("ওয়াশ");
  });
});

describe("inactive and deleted things in old sales", () => {
  it("deactivating a service keeps the old sale readable, listed and counted in reports and balance", async () => {
    const old = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    await t.db.update(services).set({ active: false }).where(eq(services.id, CUT));
    expect((await getSale(t.db, old.id))?.items[0].nameSnapshot).toBe("কাটিং");
    expect(await listSales(t.db, DAY)).toHaveLength(1);
    expect((await periodTotals(t.db, { ...DAY, mode: "day" }))[0].total).toBe(150);
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)?.earned).toBe(75);
    // ...but it cannot be sold any more
    expect(await msg(sell(A, [{ serviceId: CUT, qty: 1 }], at(MIN)))).toBe("কোনো সার্ভিস আর পাওয়া যাচ্ছে না");
  });

  it("a service that has been sold cannot be hard-deleted (the database refuses), so history stays intact", async () => {
    const old = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    await expect(t.db.delete(services).where(eq(services.id, CUT))).rejects.toThrow();
    expect((await getSale(t.db, old.id))?.items).toHaveLength(1);
    expect(await t.db.select().from(saleItems)).toHaveLength(1);
  });

  it("deactivating a barber keeps their old sales and earnings; they cannot make new sales", async () => {
    await sell(A, [{ serviceId: CUT, qty: 1 }]);
    await t.db.update(barbers).set({ active: false }).where(eq(barbers.id, A));
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)).toMatchObject({ earned: 75, salesCount: 1 });
    expect(await listSales(t.db, DAY)).toHaveLength(1);
    expect(await msg(sell(A, [{ serviceId: CUT, qty: 1 }], at(MIN)))).toBe("নাপিত পাওয়া যায়নি");
  });
});

describe("cart limits", () => {
  const raw = (qty: number) => ({
    barberId: 1,
    items: [{ serviceId: 2, qty }],
    paymentMethod: "CASH",
    idempotencyKey: "limit-key-1",
  });

  it.each([1, 20])("quantity %i passes validation and is sold at that quantity", async (qty) => {
    expect(saleInput.safeParse(raw(qty)).success).toBe(true);
    const s = await sell(A, [{ serviceId: WASH, qty }]);
    expect(s.total).toBe(50 * qty);
    expect(s.items[0].qty).toBe(qty);
  });

  it.each([0, 21, -1])("quantity %i is refused by validation", (qty) => {
    expect(saleInput.safeParse(raw(qty)).success).toBe(false);
  });

  it("an empty cart is refused by validation with the Bangla message", () => {
    const r = saleInput.safeParse({ ...raw(1), items: [] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe("কোনো সার্ভিস বাছাই করা হয়নি");
  });

  it("an empty cart handed straight to createSale never creates a ৳0 sale", async () => {
    // Defence in depth: the server function itself must not trust that zod ran first.
    const outcome = await createSale(
      t.db,
      { barberId: A, items: [], paymentMethod: "CASH", idempotencyKey: key() },
      { now: NOW },
    ).then(
      (s) => ({ created: s }),
      (e: unknown) => ({ error: e }),
    );
    expect(await t.db.select().from(sales)).toHaveLength(0);
    expect("error" in outcome).toBe(true);
  });
});

describe("void windows (FR-11)", () => {
  it("a barber can void at 9:59 and cannot at 10:01", async () => {
    const early = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    const v = await voidSaleByBarber(t.db, { saleId: early.id, barberId: A, reason: "ভুল" }, at(9 * MIN + 59_000));
    expect(v.voidedBy).toBe("BARBER");

    const late = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    expect(
      await msg(voidSaleByBarber(t.db, { saleId: late.id, barberId: A, reason: "ভুল" }, at(10 * MIN + 1_000))),
    ).toBe("১০ মিনিট পার হয়ে গেছে — এডমিনকে বলুন");
    expect((await getSale(t.db, late.id))?.voidedAt).toBeNull();
  });

  it("the admin can still void that 10:01 sale, with a reason", async () => {
    const late = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    const v = await voidSaleByAdmin(t.db, { saleId: late.id, reason: "ভুল" }, at(10 * MIN + 1_000));
    expect([v.voidedBy, v.voidReason]).toEqual(["ADMIN", "ভুল"]);
  });

  it("a barber cannot void another barber's sale, and it stays live", async () => {
    const theirs = await sell(FULL, [{ serviceId: CUT, qty: 1 }]);
    expect(await msg(voidSaleByBarber(t.db, { saleId: theirs.id, barberId: A, reason: "x" }, at(MIN)))).toBe(
      "বিক্রি পাওয়া যায়নি",
    );
    expect((await getSale(t.db, theirs.id))?.voidedAt).toBeNull();
  });

  it("the admin voiding twice keeps the first void's time, reason and who", async () => {
    const s = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    await voidSaleByAdmin(t.db, { saleId: s.id, reason: "প্রথম" }, at(HOUR));
    const again = await voidSaleByAdmin(t.db, { saleId: s.id, reason: "দ্বিতীয়" }, at(2 * HOUR));
    expect([again.voidReason, again.voidedAt, again.voidedBy]).toEqual(["প্রথম", at(HOUR).toISOString(), "ADMIN"]);
  });

  it("a barber voiding a sale the admin already voided changes nothing", async () => {
    const s = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    await voidSaleByAdmin(t.db, { saleId: s.id, reason: "এডমিন" }, at(MIN));
    const again = await voidSaleByBarber(t.db, { saleId: s.id, barberId: A, reason: "নাপিত" }, at(2 * MIN));
    expect([again.voidedBy, again.voidReason]).toEqual(["ADMIN", "এডমিন"]);
  });
});

describe("a voided sale is excluded from every total (BR-4, AC 6)", () => {
  it("dashboard stats, period reports, the live list and the payout balance all drop it; the full list keeps it", async () => {
    await sell(A, [{ serviceId: CUT, qty: 1 }]); // 150 -> 75, stays
    const gone = await sell(A, [{ serviceId: CUT, qty: 4 }], at(MIN)); // 600 -> 300, voided
    await voidSaleByAdmin(t.db, { saleId: gone.id, reason: "ভুল" }, at(2 * MIN));

    expect((await todayStats(t.db, at(3 * MIN))).find((x) => x.barberId === A)).toEqual({
      barberId: A,
      count: 1,
      barberShare: 75,
    });
    expect((await periodTotals(t.db, { ...DAY, mode: "day" }))[0]).toMatchObject({
      count: 1,
      services: 1,
      total: 150,
      barberShare: 75,
    });
    expect((await periodTotals(t.db, { ...DAY, mode: "month" }))[0]).toMatchObject({ count: 1, total: 150 });
    expect(await listSales(t.db, { ...DAY, status: "live" })).toHaveLength(1);
    expect(await listSales(t.db, { ...DAY, status: "void" })).toHaveLength(1);
    expect(await listSales(t.db, { ...DAY, status: "all" })).toHaveLength(2);
    expect(byService(liveSales(await listSales(t.db, DAY)))).toEqual([{ name: "কাটিং", qty: 1, revenue: 150 }]);
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)).toMatchObject({
      earned: 75,
      paid: 0,
      balance: 75,
      salesCount: 1,
    });
  });

  it("voiding every sale leaves zero totals and an empty report, not an error", async () => {
    const s = await sell(A, [{ serviceId: CUT, qty: 1 }]);
    await voidSaleByAdmin(t.db, { saleId: s.id, reason: "x" }, at(MIN));
    expect(await periodTotals(t.db, { ...DAY, mode: "day" })).toEqual([]);
    expect(await todayStats(t.db, at(2 * MIN))).toEqual([]);
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)).toMatchObject({ earned: 0, salesCount: 0 });
  });

  it("a payout after a void is measured against the reduced balance", async () => {
    const a = await sell(A, [{ serviceId: CUT, qty: 2 }]); // 300 -> 150
    await sell(A, [{ serviceId: CUT, qty: 2 }], at(MIN)); // 300 -> 150
    await voidSaleByAdmin(t.db, { saleId: a.id, reason: "x" }, at(2 * MIN));
    await addPayout(t.db, { barberId: A, amount: 100, date: "2026-03-10", note: "" }, at(3 * MIN));
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)?.balance).toBe(50);
  });
});

describe("payouts: advance and delete window (BR-7, FR-20, AC 8)", () => {
  it("acceptance criterion 8: earned 3000, paid 2000 -> 1000; another 1500 -> -500 (advance)", async () => {
    // 3000 earned at 50% = 6000 of sales: 2 x (20 x ৳150)
    for (let i = 0; i < 2; i++) await sell(A, [{ serviceId: CUT, qty: 20 }], at(i * MIN));
    await addPayout(t.db, { barberId: A, amount: 2000, date: "2026-03-10", note: "" }, at(5 * MIN));
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)).toMatchObject({
      earned: 3000,
      paid: 2000,
      balance: 1000,
    });
    await addPayout(t.db, { barberId: A, amount: 1500, date: "2026-03-10", note: "২" }, at(6 * MIN));
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)?.balance).toBe(-500);
  });

  it("a payout far larger than the balance is accepted (BR-7: it becomes an advance)", async () => {
    await addPayout(t.db, { barberId: A, amount: 5000, date: "2026-03-10", note: "অগ্রিম" }, NOW);
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)?.balance).toBe(-5000);
  });

  it("deleting a payout restores the balance", async () => {
    await sell(A, [{ serviceId: CUT, qty: 2 }]);
    const p = await addPayout(t.db, { barberId: A, amount: 100, date: "2026-03-10", note: "" }, NOW);
    await deletePayout(t.db, p.id, at(HOUR));
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)?.balance).toBe(150);
  });

  it("a payout can be deleted at 23h59 and not at 24h01", async () => {
    const p = await addPayout(t.db, { barberId: A, amount: 60, date: "2026-03-10", note: "ক" }, NOW);
    const q = await addPayout(t.db, { barberId: A, amount: 70, date: "2026-03-10", note: "খ" }, NOW);
    await deletePayout(t.db, p.id, at(23 * HOUR + 59 * MIN));
    expect(await msg(deletePayout(t.db, q.id, at(24 * HOUR + MIN)))).toBe("২৪ ঘণ্টা পার হওয়া পেমেন্ট মোছা যাবে না");
    expect((await listPayouts(t.db)).map((x) => x.id)).toEqual([q.id]);
  });

  it("the 24 hours count from when the payout was entered, not from its (older) date", async () => {
    const p = await addPayout(t.db, { barberId: A, amount: 60, date: "2026-03-01", note: "পুরনো তারিখ" }, NOW);
    await deletePayout(t.db, p.id, at(HOUR)); // dated 9 days ago, entered 1 h ago: still deletable
    expect(await listPayouts(t.db)).toHaveLength(0);
  });
});
