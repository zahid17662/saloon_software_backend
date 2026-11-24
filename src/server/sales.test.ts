import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { barbers, categories, saleItems, sales, services } from "../db/schema";
import { DomainError } from "./errors";
import {
  barberSalesToday,
  createSale,
  getSale,
  listSales,
  todayStats,
  voidSaleByAdmin,
  voidSaleByBarber,
} from "./sales";
import { createTestDb, type TestDb } from "./test-db";

// "now" = 2026-03-10 12:00 Dhaka = 06:00 UTC
const NOW = new Date("2026-03-10T06:00:00Z");
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);

let t: TestDb;
let A: number; // 50 %
let B: number; // 33 %
let CUT: number; // ৳150
let WASH: number; // ৳50
let ODD: number; // ৳125
let n = 0;
const key = () => `key-${++n}-${"x".repeat(8)}`;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.delete(sales); // sale_items cascade
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
  const svc = await t.db
    .insert(services)
    .values([
      { categoryId: c.id, name: "কাটিং", price: 150 },
      { categoryId: c.id, name: "ওয়াশ", price: 50 },
      { categoryId: c.id, name: "ফেসিয়াল", price: 125 },
    ])
    .returning();
  [CUT, WASH, ODD] = svc.map((s) => s.id);
});

const mk = (barberId: number, items: { serviceId: number; qty: number }[], over: Partial<{ idempotencyKey: string }> = {}) => ({
  barberId,
  items,
  paymentMethod: "CASH" as const,
  idempotencyKey: key(),
  ...over,
});

const domainMsg = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  return (e as DomainError).message;
};

describe("createSale: the server decides every number", () => {
  it("computes total and split from DB prices and snapshots name, price and commission", async () => {
    const s = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 2 }, { serviceId: WASH, qty: 1 }]), { now: NOW });
    expect(s.total).toBe(350);
    expect(s.barberShare).toBe(175);
    expect(s.ownerShare).toBe(175);
    expect(s.commissionPctSnapshot).toBe(50);
    expect(s.enteredByAdmin).toBe(false);
    expect(s.createdAt).toBe(NOW.toISOString());
    expect(s.voidedAt).toBeNull();
    expect(s.items).toEqual([
      { serviceId: CUT, nameSnapshot: "কাটিং", priceSnapshot: 150, qty: 2 },
      { serviceId: WASH, nameSnapshot: "ওয়াশ", priceSnapshot: 50, qty: 1 },
    ]);
  });

  it("rounds half-up and the two shares always add up (BR-1)", async () => {
    const s = await createSale(t.db, mk(B, [{ serviceId: ODD, qty: 1 }]), { now: NOW }); // 125 × 33% = 41.25
    expect(s.barberShare).toBe(41);
    expect(s.ownerShare).toBe(84);
    const half = await createSale(t.db, mk(A, [{ serviceId: WASH, qty: 1 }, { serviceId: ODD, qty: 1 }]), { now: NOW });
    expect(half.total).toBe(175); // 175 × 50% = 87.5 → 88
    expect(half.barberShare).toBe(88);
    expect(half.barberShare + half.ownerShare).toBe(half.total);
  });

  it("later price and commission changes never touch an old sale (BR-2, BR-3)", async () => {
    const s = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW });
    await t.db.update(services).set({ price: 999, name: "নতুন নাম" }).where(eq(services.id, CUT));
    await t.db.update(barbers).set({ commissionPct: 10 }).where(eq(barbers.id, A));
    const again = await getSale(t.db, s.id);
    expect(again?.total).toBe(150);
    expect(again?.commissionPctSnapshot).toBe(50);
    expect(again?.items[0]).toMatchObject({ nameSnapshot: "কাটিং", priceSnapshot: 150 });
  });

  it("rejects an inactive or unknown barber, and an inactive or unknown service", async () => {
    await t.db.update(barbers).set({ active: false }).where(eq(barbers.id, B));
    expect(await domainMsg(createSale(t.db, mk(B, [{ serviceId: CUT, qty: 1 }])))).toBe("নাপিত পাওয়া যায়নি");
    expect(await domainMsg(createSale(t.db, mk(9999, [{ serviceId: CUT, qty: 1 }])))).toBe("নাপিত পাওয়া যায়নি");
    await t.db.update(services).set({ active: false }).where(eq(services.id, WASH));
    expect(await domainMsg(createSale(t.db, mk(A, [{ serviceId: WASH, qty: 1 }])))).toBe("কোনো সার্ভিস আর পাওয়া যাচ্ছে না");
    expect(await domainMsg(createSale(t.db, mk(A, [{ serviceId: 9999, qty: 1 }])))).toBe("কোনো সার্ভিস আর পাওয়া যাচ্ছে না");
  });

  it("a failed sale leaves no partial rows (all or nothing)", async () => {
    await expect(createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }, { serviceId: 9999, qty: 1 }]))).rejects.toBeInstanceOf(DomainError);
    expect(await t.db.select().from(sales)).toHaveLength(0);
    expect(await t.db.select().from(saleItems)).toHaveLength(0);
  });
});

describe("createSale: idempotency (FR-9)", () => {
  it("the same key returns the existing sale and creates nothing new", async () => {
    const input = mk(A, [{ serviceId: CUT, qty: 1 }]);
    const first = await createSale(t.db, input, { now: NOW });
    const second = await createSale(t.db, input, { now: min(5) });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(await t.db.select().from(sales)).toHaveLength(1);
    expect(await t.db.select().from(saleItems)).toHaveLength(1);
  });

  it("a double tap fired concurrently still makes exactly one sale", async () => {
    const input = mk(A, [{ serviceId: CUT, qty: 1 }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => createSale(t.db, input, { now: NOW })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await t.db.select().from(sales)).toHaveLength(1);
    expect(await t.db.select().from(saleItems)).toHaveLength(1);
  });

  it("a retry with the same key but a different cart returns the ORIGINAL sale", async () => {
    const key1 = key();
    const first = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }], { idempotencyKey: key1 }), { now: NOW });
    const retry = await createSale(t.db, mk(A, [{ serviceId: WASH, qty: 5 }], { idempotencyKey: key1 }), { now: NOW });
    expect(retry.id).toBe(first.id);
    expect(retry.total).toBe(150);
  });

  it("the same key for a DIFFERENT barber is refused, not replayed", async () => {
    const key1 = key();
    await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }], { idempotencyKey: key1 }), { now: NOW });
    const msg = await domainMsg(createSale(t.db, mk(B, [{ serviceId: CUT, qty: 1 }], { idempotencyKey: key1 }), { now: NOW }));
    expect(msg).toBe("এই এন্ট্রি আগেই অন্য নাপিতের নামে সেভ হয়েছে");
    expect(await t.db.select().from(sales)).toHaveLength(1);
  });
});

describe("createSale: hidden categories", () => {
  it("refuses a service whose category was switched off, even if the service itself is active", async () => {
    await t.db.update(categories).set({ active: false });
    const msg = await domainMsg(createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW }));
    expect(msg).toBe("কোনো সার্ভিস আর পাওয়া যাচ্ছে না");
    expect(await t.db.select().from(sales)).toHaveLength(0);
  });
});

describe("createSale: back-dated entry by the admin (FR-22)", () => {
  it("stores the given instant and flags it entered_by_admin", async () => {
    const at = new Date("2026-03-01T08:30:00Z");
    const s = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW, at, enteredByAdmin: true });
    expect(s.createdAt).toBe(at.toISOString());
    expect(s.enteredByAdmin).toBe(true);
    const [row] = await t.db.select().from(sales).where(eq(sales.id, s.id));
    expect(row.enteredByAdmin).toBe(true);
    expect(row.createdAt.toISOString()).toBe(at.toISOString());
  });
});

describe("voidSaleByBarber: own sale, 10 minutes", () => {
  const make = (over?: { now?: Date; at?: Date; enteredByAdmin?: boolean }) =>
    createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW, ...over });

  it("voids within 10 minutes and records who and why", async () => {
    const s = await make();
    const v = await voidSaleByBarber(t.db, { saleId: s.id, barberId: A, reason: "ভুল সার্ভিস" }, min(10));
    expect(v.voidedBy).toBe("BARBER");
    expect(v.voidReason).toBe("ভুল সার্ভিস");
    expect(v.voidedAt).toBe(min(10).toISOString());
  });

  it("refuses after 10 minutes with the Bangla message, and the sale stays live", async () => {
    const s = await make();
    const msg = await domainMsg(voidSaleByBarber(t.db, { saleId: s.id, barberId: A, reason: "x" }, new Date(min(10).getTime() + 1)));
    expect(msg).toBe("১০ মিনিট পার হয়ে গেছে — এডমিনকে বলুন");
    expect((await getSale(t.db, s.id))?.voidedAt).toBeNull();
  });

  it("refuses another barber's sale (reported as not found, not as forbidden)", async () => {
    const s = await make();
    expect(await domainMsg(voidSaleByBarber(t.db, { saleId: s.id, barberId: B, reason: "x" }, min(1)))).toBe("বিক্রি পাওয়া যায়নি");
    expect((await getSale(t.db, s.id))?.voidedAt).toBeNull();
  });

  it("refuses an admin-entered sale even seconds after it was entered", async () => {
    const s = await make({ enteredByAdmin: true });
    expect(await domainMsg(voidSaleByBarber(t.db, { saleId: s.id, barberId: A, reason: "x" }, min(1)))).toBe(
      "এই এন্ট্রি শুধু এডমিন বাতিল করতে পারবে",
    );
  });

  it("a second void is a no-op that keeps the first reason", async () => {
    const s = await make();
    await voidSaleByBarber(t.db, { saleId: s.id, barberId: A, reason: "প্রথম" }, min(1));
    const again = await voidSaleByBarber(t.db, { saleId: s.id, barberId: A, reason: "দ্বিতীয়" }, min(2));
    expect(again.voidReason).toBe("প্রথম");
    expect(again.voidedAt).toBe(min(1).toISOString());
  });

  it("unknown sale", async () => {
    expect(await domainMsg(voidSaleByBarber(t.db, { saleId: 9999, barberId: A, reason: "x" }, NOW))).toBe("বিক্রি পাওয়া যায়নি");
  });
});

describe("voidSaleByAdmin: anything, any time, with a reason", () => {
  it("voids an old sale and a back-dated one", async () => {
    const old = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW });
    const past = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW, at: new Date("2026-02-01T00:00:00Z"), enteredByAdmin: true });
    const late = new Date(NOW.getTime() + 30 * 86_400_000);
    for (const s of [old, past]) {
      const v = await voidSaleByAdmin(t.db, { saleId: s.id, reason: "ভুল এন্ট্রি" }, late);
      expect(v.voidedBy).toBe("ADMIN");
      expect(v.voidReason).toBe("ভুল এন্ট্রি");
    }
  });

  it("unknown sale", async () => {
    expect(await domainMsg(voidSaleByAdmin(t.db, { saleId: 9999, reason: "x" }, NOW))).toBe("বিক্রি পাওয়া যায়নি");
  });
});

describe("listSales groups by the Dhaka day (BR-5)", () => {
  // Four sales straddling the Dhaka midnight (18:00 UTC) on 2026-03-10.
  const stamps = {
    lastMinuteOf9th: "2026-03-09T17:59:00Z", // Mar 9, 23:59 Dhaka
    firstMinuteOf10th: "2026-03-09T18:00:00Z", // Mar 10, 00:00 Dhaka
    lastMinuteOf10th: "2026-03-10T17:59:00Z", // Mar 10, 23:59 Dhaka
    firstMinuteOf11th: "2026-03-10T18:00:00Z", // Mar 11, 00:00 Dhaka
  };
  const ids: Record<string, number> = {};
  beforeEach(async () => {
    for (const [name, iso] of Object.entries(stamps)) {
      const s = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: new Date("2026-03-12T00:00:00Z"), at: new Date(iso), enteredByAdmin: true });
      ids[name] = s.id;
    }
  });

  it("a single Dhaka day includes exactly its own 24 hours", async () => {
    const r = await listSales(t.db, { from: "2026-03-10", to: "2026-03-10" });
    expect(r.map((x) => x.id).sort()).toEqual([ids.firstMinuteOf10th, ids.lastMinuteOf10th].sort());
  });

  it("a multi-day range is inclusive on both ends", async () => {
    const r = await listSales(t.db, { from: "2026-03-09", to: "2026-03-11" });
    expect(r).toHaveLength(4);
  });

  it("newest first, with items and the admin-entered flag", async () => {
    const r = await listSales(t.db, { from: "2026-03-09", to: "2026-03-11" });
    expect(r.map((x) => x.id)).toEqual([...r.map((x) => x.id)].sort((a, b) => b - a));
    expect(r[0].items).toHaveLength(1);
    expect(r.every((x) => x.enteredByAdmin)).toBe(true);
  });

  it("filters by barber and by status", async () => {
    await voidSaleByAdmin(t.db, { saleId: ids.lastMinuteOf10th, reason: "x" }, NOW);
    const other = await createSale(t.db, mk(B, [{ serviceId: WASH, qty: 1 }]), { now: new Date("2026-03-12T00:00:00Z"), at: new Date("2026-03-10T05:00:00Z") });
    const day = { from: "2026-03-10", to: "2026-03-10" };
    expect((await listSales(t.db, { ...day, barberId: B })).map((x) => x.id)).toEqual([other.id]);
    expect((await listSales(t.db, { ...day, status: "void" })).map((x) => x.id)).toEqual([ids.lastMinuteOf10th]);
    expect(await listSales(t.db, { ...day, status: "live" })).toHaveLength(2);
    expect(await listSales(t.db, { ...day, status: "all" })).toHaveLength(3);
  });
});

describe("todayStats and barberSalesToday: today in Dhaka, voided excluded from totals", () => {
  it("counts only today's live sales per barber with the barber's share", async () => {
    await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW }); // 75
    await createSale(t.db, mk(A, [{ serviceId: WASH, qty: 1 }]), { now: NOW }); // 25
    const gone = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW });
    await voidSaleByAdmin(t.db, { saleId: gone.id, reason: "x" }, NOW);
    await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW, at: new Date("2026-03-09T05:00:00Z"), enteredByAdmin: true }); // yesterday
    await createSale(t.db, mk(B, [{ serviceId: ODD, qty: 1 }]), { now: NOW }); // 41

    const stats = await todayStats(t.db, NOW);
    expect(stats.find((x) => x.barberId === A)).toEqual({ barberId: A, count: 2, barberShare: 100 });
    expect(stats.find((x) => x.barberId === B)).toEqual({ barberId: B, count: 1, barberShare: 41 });
  });

  it("a back-dated sale dated today counts today; at 00:30 Dhaka 'today' is already the new day", async () => {
    const late = new Date("2026-03-10T18:30:00Z"); // Mar 11 00:30 Dhaka
    await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW }); // Mar 10 noon Dhaka
    expect((await todayStats(t.db, late)).find((x) => x.barberId === A)).toBeUndefined();
    await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: late, at: new Date("2026-03-10T18:10:00Z"), enteredByAdmin: true });
    expect((await todayStats(t.db, late)).find((x) => x.barberId === A)?.count).toBe(1);
  });

  it("barberSalesToday lists that barber's day including voided ones, newest first", async () => {
    const a1 = await createSale(t.db, mk(A, [{ serviceId: CUT, qty: 1 }]), { now: NOW });
    const a2 = await createSale(t.db, mk(A, [{ serviceId: WASH, qty: 1 }]), { now: min(5) });
    await createSale(t.db, mk(B, [{ serviceId: WASH, qty: 1 }]), { now: NOW });
    await voidSaleByBarber(t.db, { saleId: a1.id, barberId: A, reason: "x" }, min(6));
    const mine = await barberSalesToday(t.db, A, min(7));
    expect(mine.map((x) => x.id)).toEqual([a2.id, a1.id]);
    expect(mine[1].voidedAt).not.toBeNull();
  });
});

describe("getSale", () => {
  it("returns null for a missing sale", async () => {
    expect(await getSale(t.db, 424242)).toBeNull();
  });
});
