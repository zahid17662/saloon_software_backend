import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { barbers, categories, payouts, sales, services } from "../db/schema";
import { DomainError } from "./errors";
import { addPayout, barberBalances, deletePayout, listPayouts } from "./payouts";
import { createSale, voidSaleByAdmin } from "./sales";
import { createTestDb, type TestDb } from "./test-db";

const NOW = new Date("2026-03-10T06:00:00Z"); // 12:00 Dhaka
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
let t: TestDb;
let A: number;
let B: number;
let CUT: number;
let n = 0;

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
  const [s] = await t.db.insert(services).values({ categoryId: c.id, name: "কাটিং", price: 250 }).returning();
  CUT = s.id;
});

const sell = (barberId: number, qty = 1) =>
  createSale(
    t.db,
    { barberId, items: [{ serviceId: CUT, qty }], paymentMethod: "CASH", idempotencyKey: `p-${++n}-${"x".repeat(8)}` },
    { now: NOW },
  );
const msg = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(DomainError);
  return (e as DomainError).message;
};

describe("barberBalances (BR-7)", () => {
  it("is live shares minus payouts, per barber, and ignores voided sales", async () => {
    await sell(A); // ৳250 -> 125
    const gone = await sell(A, 4); // ৳1000 -> 500, voided
    await voidSaleByAdmin(t.db, { saleId: gone.id, reason: "ভুল" }, NOW);
    await sell(B); // ৳250 at 33 % -> 82.5 rounds half up to 83
    await addPayout(t.db, { barberId: A, amount: 100, date: "2026-03-10", note: "" }, NOW);
    const bal = await barberBalances(t.db);
    expect(bal.find((r) => r.barberId === A)).toEqual({ barberId: A, earned: 125, paid: 100, balance: 25, salesCount: 1 });
    expect(bal.find((r) => r.barberId === B)).toMatchObject({ earned: 83, paid: 0, balance: 83 });
  });

  it("goes negative (an advance) when paid more than earned", async () => {
    await sell(A);
    await addPayout(t.db, { barberId: A, amount: 300, date: "2026-03-10", note: "অগ্রিম" }, NOW);
    expect((await barberBalances(t.db)).find((r) => r.barberId === A)?.balance).toBe(-175);
  });

  it("lists every barber, including one with no activity", async () => {
    expect((await barberBalances(t.db)).map((r) => r.barberId)).toEqual([A, B]);
  });
});

describe("addPayout", () => {
  it("stores the Dhaka date and refuses a future date and a missing barber", async () => {
    const p = await addPayout(t.db, { barberId: A, amount: 50, date: "2026-03-09", note: "সাপ্তাহিক" }, NOW);
    expect(p.paidAt).toBe("2026-03-09T06:00:00.000Z"); // 12:00 Dhaka that day
    expect(await msg(addPayout(t.db, { barberId: A, amount: 50, date: "2026-03-11", note: "" }, NOW))).toBe(
      "ভবিষ্যতের তারিখ দেওয়া যাবে না",
    );
    expect(await msg(addPayout(t.db, { barberId: 999999, amount: 50, date: "2026-03-10", note: "" }, NOW))).toBe(
      "নাপিত পাওয়া যায়নি",
    );
  });

  it("never stamps a payout in the future (today, before noon Dhaka)", async () => {
    const earlyMorning = new Date("2026-03-10T03:00:00Z"); // 09:00 Dhaka
    const p = await addPayout(t.db, { barberId: A, amount: 50, date: "2026-03-10", note: "" }, earlyMorning);
    expect(p.paidAt).toBe(earlyMorning.toISOString());
  });

  it("refuses the same payment twice within 30 seconds, but allows it later", async () => {
    const input = { barberId: A, amount: 500, date: "2026-03-10", note: "" };
    await addPayout(t.db, input, NOW);
    expect(await msg(addPayout(t.db, input, new Date(NOW.getTime() + 5_000)))).toBe("এই পেমেন্ট এইমাত্র সেভ হয়েছে");
    await addPayout(t.db, input, new Date(NOW.getTime() + 60_000));
    expect(await listPayouts(t.db)).toHaveLength(2);
  });

  it("pays an inactive barber", async () => {
    await t.db.update(barbers).set({ active: false }).where(eq(barbers.id, A));
    await addPayout(t.db, { barberId: A, amount: 10, date: "2026-03-10", note: "" }, NOW);
    expect(await listPayouts(t.db)).toHaveLength(1);
  });

  it("lists newest first", async () => {
    await addPayout(t.db, { barberId: A, amount: 10, date: "2026-03-08", note: "" }, NOW);
    await addPayout(t.db, { barberId: A, amount: 20, date: "2026-03-10", note: "" }, NOW);
    expect((await listPayouts(t.db)).map((p) => p.amount)).toEqual([20, 10]);
  });
});

describe("deletePayout (24 hours)", () => {
  it("deletes inside 24 h, refuses after, and reports an unknown id", async () => {
    const p = await addPayout(t.db, { barberId: A, amount: 50, date: "2026-03-10", note: "" }, NOW);
    await deletePayout(t.db, p.id, hours(23.9));
    expect(await listPayouts(t.db)).toHaveLength(0);

    const q = await addPayout(t.db, { barberId: A, amount: 70, date: "2026-03-10", note: "" }, NOW);
    expect(await msg(deletePayout(t.db, q.id, hours(24.1)))).toBe("২৪ ঘণ্টা পার হওয়া পেমেন্ট মোছা যাবে না");
    expect(await listPayouts(t.db)).toHaveLength(1);
    expect(await msg(deletePayout(t.db, 424242, NOW))).toBe("পেমেন্ট পাওয়া যায়নি");
  });

  it("is inclusive at exactly 24 h and refuses 1 ms later", async () => {
    const p = await addPayout(t.db, { barberId: A, amount: 30, date: "2026-03-10", note: "" }, NOW);
    expect(await msg(deletePayout(t.db, p.id, new Date(hours(24).getTime() + 1)))).toBe(
      "২৪ ঘণ্টা পার হওয়া পেমেন্ট মোছা যাবে না",
    );
    await deletePayout(t.db, p.id, hours(24));
    expect(await listPayouts(t.db)).toHaveLength(0);
  });
});
