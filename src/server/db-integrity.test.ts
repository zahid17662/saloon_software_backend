// Database audit tests (run on PGlite = a throwaway in-memory Postgres with the real migrations;
// nothing here can reach Neon or `main`). Covers: concurrent idempotency, transaction rollback,
// CHECK constraints, SQL reports vs the src/lib/reports.ts oracle on random data, and EXPLAIN.
//
// Limit worth knowing: PGlite is a single connection, so concurrent requests interleave at
// statement boundaries but never run on two backends at once. That is enough to hit the
// check-then-insert window and the unique-index fallback, but it cannot prove behaviour under
// real parallel connections (Neon). See docs/BUGS.md.

import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { barbers, categories, payouts, saleItems, sales, services } from "../db/schema";
import { barberBalance, byPeriod, liveSales } from "../lib/reports";
import { dhakaDayStart } from "../lib/time";
import type { Payout, Sale } from "../lib/types";
import { addPayout, barberBalances } from "./payouts";
import { periodTotals, periodTotalsSql } from "./reports";
import { createSale, voidSaleByAdmin } from "./sales";
import { createTestDb, type TestDb } from "./test-db";

let t: TestDb;
let A: number;
let B: number;
let C: number;
let SVC: { id: number; price: number }[];

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function reset() {
  await t.db.delete(payouts);
  await t.db.delete(sales); // sale_items cascade
  await t.db.delete(services);
  await t.db.delete(categories);
  await t.db.delete(barbers);
  const bs = await t.db
    .insert(barbers)
    .values([
      { name: "এ", commissionPct: 50 },
      { name: "বি", commissionPct: 33 },
      { name: "সি", commissionPct: 70 },
    ])
    .returning();
  [A, B, C] = bs.map((b) => b.id);
  const [cat] = await t.db.insert(categories).values({ name: "চুল" }).returning();
  SVC = await t.db
    .insert(services)
    .values([
      { categoryId: cat.id, name: "কাটিং", price: 150 },
      { categoryId: cat.id, name: "ওয়াশ", price: 50 },
      { categoryId: cat.id, name: "ফেসিয়াল", price: 125 },
      { categoryId: cat.id, name: "শেভ", price: 40 },
    ])
    .returning({ id: services.id, price: services.price });
}
beforeEach(reset);

/** Every message in an error's cause chain, so a wrapped driver error can be matched by name. */
function errorText(e: unknown): string {
  const parts: string[] = [];
  for (let cur: unknown = e, d = 0; cur && d < 5; d++) {
    const o = cur as { message?: string; constraint?: string; cause?: unknown };
    parts.push(String(o.message ?? ""), String(o.constraint ?? ""));
    cur = o.cause;
  }
  return parts.join(" | ");
}
async function rejection(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return errorText(e);
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

// ---------- 1. idempotency under concurrency ----------

describe("1. idempotency: the same request 5 times at once", () => {
  const input = () => ({
    barberId: A,
    items: [{ serviceId: SVC[0].id, qty: 2 }],
    paymentMethod: "CASH" as const,
    idempotencyKey: "concurrent-key-0001",
  });

  it("creates exactly one sale and one set of items, and every caller gets that sale", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => createSale(t.db, input())));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.every((r) => r.total === 300)).toBe(true);
    expect(await t.db.select().from(sales)).toHaveLength(1);
    expect(await t.db.select().from(saleItems)).toHaveLength(1);
  });

  it("holds for 20 different keys, each fired 5 times, all interleaved", async () => {
    const calls = Array.from({ length: 20 }, (_, k) =>
      Array.from({ length: 5 }, () => createSale(t.db, { ...input(), idempotencyKey: `burst-key-${k}-xxxxxx` })),
    ).flat();
    const results = await Promise.all(calls);
    expect(new Set(results.map((r) => r.id)).size).toBe(20);
    expect(await t.db.select().from(sales)).toHaveLength(20);
    expect(await t.db.select().from(saleItems)).toHaveLength(20);
  });

  it("the database itself refuses a second row with the same key (index, not just app code)", async () => {
    await createSale(t.db, input());
    const msg = await rejection(
      t.db.insert(sales).values({
        idempotencyKey: "concurrent-key-0001",
        barberId: A,
        total: 100,
        barberShare: 50,
        ownerShare: 50,
        commissionPctSnapshot: 50,
      }),
    );
    expect(msg).toContain("sales_idempotency_uq");
  });
});

// ---------- 2. transactions ----------

describe("2. transactions: a failing sale item leaves nothing behind", () => {
  it("qty 21 passes the sale insert but fails the item insert: no sale row, no item rows", async () => {
    const bad = { barberId: A, items: [{ serviceId: SVC[0].id, qty: 21 }], paymentMethod: "CASH" as const, idempotencyKey: "rollback-key-0001" };
    expect(await rejection(createSale(t.db, bad))).toContain("qty_range");
    expect(await t.db.select().from(sales)).toHaveLength(0);
    expect(await t.db.select().from(saleItems)).toHaveLength(0);
  });

  it("the second line failing rolls back the first line too", async () => {
    const bad = {
      barberId: A,
      items: [
        { serviceId: SVC[0].id, qty: 1 },
        { serviceId: SVC[1].id, qty: 0 },
      ],
      paymentMethod: "CASH" as const,
      idempotencyKey: "rollback-key-0002",
    };
    expect(await rejection(createSale(t.db, bad))).toContain("qty_range");
    expect(await t.db.select().from(sales)).toHaveLength(0);
    expect(await t.db.select().from(saleItems)).toHaveLength(0);
  });

  it("a rolled-back attempt does not burn the key: the same key can be used by a good retry", async () => {
    const key = "rollback-key-0003";
    await rejection(createSale(t.db, { barberId: A, items: [{ serviceId: SVC[0].id, qty: 99 }], paymentMethod: "CASH", idempotencyKey: key }));
    const ok = await createSale(t.db, { barberId: A, items: [{ serviceId: SVC[0].id, qty: 1 }], paymentMethod: "CASH", idempotencyKey: key });
    expect(ok.total).toBe(150);
    expect(await t.db.select().from(sales)).toHaveLength(1);
  });

  it("a hand-written transaction that throws after the sale insert rolls back (driver sanity)", async () => {
    await rejection(
      t.db.transaction(async (tx) => {
        await tx.insert(sales).values({ idempotencyKey: "tx-sanity-00001", barberId: A, total: 100, barberShare: 50, ownerShare: 50, commissionPctSnapshot: 50 });
        throw new Error("boom");
      }),
    );
    expect(await t.db.select().from(sales)).toHaveLength(0);
  });
});

// ---------- 3. CHECK constraints ----------

describe("3. CHECK constraints reject bad rows", () => {
  const sale = (over: Partial<typeof sales.$inferInsert> = {}) => ({
    idempotencyKey: `chk-${Math.random().toString(36).slice(2)}-xxxx`,
    barberId: A,
    total: 100,
    barberShare: 50,
    ownerShare: 50,
    commissionPctSnapshot: 50,
    ...over,
  });
  const item = (saleId: number, over: Partial<typeof saleItems.$inferInsert> = {}) => ({
    saleId,
    serviceId: SVC[0].id,
    nameSnapshot: "x",
    priceSnapshot: 100,
    qty: 1,
    ...over,
  });
  const goodSaleId = async () => (await t.db.insert(sales).values(sale()).returning())[0].id;

  it("accepts a valid row of each kind (so the rejections below are about the rule, not the setup)", async () => {
    const id = await goodSaleId();
    await t.db.insert(saleItems).values(item(id));
    await t.db.insert(payouts).values({ barberId: A, amount: 1 });
  });

  it.each([
    ["shares_sum", { total: 100, barberShare: 60, ownerShare: 50 }],
    ["shares_sum", { total: 100, barberShare: 40, ownerShare: 50 }],
    ["total_positive", { total: 0, barberShare: 0, ownerShare: 0 }],
    ["shares_nonneg", { total: -10, barberShare: -5, ownerShare: -5 }], // negative total implies a negative share
    ["shares_nonneg", { total: 100, barberShare: 120, ownerShare: -20 }],
    ["pct_snapshot_range", { commissionPctSnapshot: 101 }],
    ["pct_snapshot_range", { commissionPctSnapshot: -1 }],
    ["void_consistent", { voidedAt: new Date() }], // voided_at without voided_by
    ["void_consistent", { voidedBy: "ADMIN" as const }], // voided_by without voided_at
    ["void_consistent", { voidReason: "x" }], // a reason on a live sale
  ] as const)("sales: %s rejects %j", async (name, over) => {
    expect(await rejection(t.db.insert(sales).values(sale(over)))).toContain(name);
  });

  it.each([
    ["qty_range", { qty: 0 }],
    ["qty_range", { qty: 21 }],
    ["qty_range", { qty: -1 }],
    ["price_snapshot_positive", { priceSnapshot: 0 }],
    ["price_snapshot_positive", { priceSnapshot: -5 }],
  ] as const)("sale_items: %s rejects %j", async (name, over) => {
    const id = await goodSaleId();
    expect(await rejection(t.db.insert(saleItems).values(item(id, over)))).toContain(name);
  });

  it("services: price_positive rejects 0 and negative", async () => {
    const [cat] = await t.db.select().from(categories);
    for (const price of [0, -1]) {
      expect(await rejection(t.db.insert(services).values({ categoryId: cat.id, name: "z", price }))).toContain("price_positive");
    }
  });

  it("payouts: amount_positive rejects 0 and negative", async () => {
    for (const amount of [0, -100]) {
      expect(await rejection(t.db.insert(payouts).values({ barberId: A, amount }))).toContain("amount_positive");
    }
  });

  it("barbers: pct_range rejects 101 and -1; the boundaries 0 and 100 are allowed", async () => {
    for (const commissionPct of [101, -1]) {
      expect(await rejection(t.db.insert(barbers).values({ name: "z", commissionPct }))).toContain("pct_range");
    }
    await t.db.insert(barbers).values([{ name: "zero", commissionPct: 0 }, { name: "full", commissionPct: 100 }]);
  });

  it("an UPDATE cannot sneak a bad value past the constraint either", async () => {
    const id = await goodSaleId();
    expect(await rejection(t.db.update(sales).set({ barberShare: 99 }).where(sql`id = ${id}`))).toContain("shares_sum");
  });

  it("foreign keys: a sale for a barber that does not exist is rejected", async () => {
    expect(await rejection(t.db.insert(sales).values(sale({ barberId: 999999 })))).toContain("sales_barber_id_barbers_id_fk");
  });
});

// ---------- 4. SQL reports == oracle, on random data ----------

/** Small deterministic PRNG so a failure is reproducible from its seed. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const RANGE_FROM = "2026-01-01";
const RANGE_TO = "2026-03-31";

describe("4. SQL reports equal the reports.ts oracle (500 random sales, 3 months, voids)", () => {
  it.each([1, 2, 3])("seed %i", async (seed) => {
    const rnd = mulberry32(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const startMs = dhakaDayStart(RANGE_FROM).getTime();
    const endMs = dhakaDayStart("2026-04-01").getTime();
    const barberIds = [A, B, C];

    const model: Sale[] = []; // what the app returned, kept in memory as the oracle's input
    for (let n = 0; n < 500; n++) {
      // 25 % of sales are placed within a minute of a Dhaka midnight, the bucket-edge danger zone.
      let at: number;
      if (rnd() < 0.25) {
        const dayIdx = Math.floor(rnd() * 90) + 1;
        at = startMs + dayIdx * 86_400_000 + Math.floor((rnd() - 0.5) * 120_000);
      } else {
        at = startMs + Math.floor(rnd() * (endMs - startMs - 1));
      }
      at = Math.min(Math.max(at, startMs), endMs - 1);
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({
        serviceId: pick(SVC).id,
        qty: 1 + Math.floor(rnd() * 4),
      }));
      let s = await createSale(
        t.db,
        { barberId: pick(barberIds), items: lines, paymentMethod: pick(["CASH", "BKASH", "NAGAD", "OTHER"] as const), idempotencyKey: `prop-${seed}-${n}-xxxxxxxx` },
        { now: new Date(endMs), at: new Date(at), enteredByAdmin: true },
      );
      if (rnd() < 0.15) s = await voidSaleByAdmin(t.db, { saleId: s.id, reason: "ভুল" }, new Date(endMs));
      model.push(s);
    }
    expect(model.filter((s) => s.voidedAt).length).toBeGreaterThan(30); // the dataset really has voids

    const oracleRows = (mode: "day" | "month", from: string, to: string) =>
      byPeriod(
        liveSales(model).filter((s) => {
          const ms = Date.parse(s.createdAt);
          return ms >= dhakaDayStart(from).getTime() && ms < dhakaDayStart(to).getTime() + 86_400_000;
        }),
        [],
        mode,
      )
        .map(({ period, barberId, count, services: n, total, barberShare, ownerShare }) => ({ period, barberId, count, services: n, total, barberShare, ownerShare }))
        .sort((a, z) => (a.period === z.period ? a.barberId - z.barberId : a.period < z.period ? 1 : -1));

    for (const mode of ["day", "month"] as const) {
      expect(await periodTotals(t.db, { from: RANGE_FROM, to: RANGE_TO, mode })).toEqual(oracleRows(mode, RANGE_FROM, RANGE_TO));
    }
    // A sub-range that starts and ends mid-month (boundary days included both sides).
    expect(await periodTotals(t.db, { from: "2026-02-10", to: "2026-03-05", mode: "day" })).toEqual(oracleRows("day", "2026-02-10", "2026-03-05"));

    // Cross-check: the grand total is the sum of live sale totals, and shares always add up.
    const all = await periodTotals(t.db, { from: RANGE_FROM, to: RANGE_TO, mode: "month" });
    const live = liveSales(model);
    expect(all.reduce((n, r) => n + r.total, 0)).toBe(live.reduce((n, s) => n + s.total, 0));
    expect(all.every((r) => r.barberShare + r.ownerShare === r.total)).toBe(true);

    // Balances: random payouts, SQL barberBalances vs the oracle barberBalance.
    const pays: Payout[] = [];
    for (let k = 0; k < 40; k++) {
      const amount = 1 + Math.floor(rnd() * 500);
      const barberId = pick(barberIds);
      const [row] = await t.db.insert(payouts).values({ barberId, amount, paidAt: new Date(startMs + k * 86_400_000) }).returning();
      pays.push({ id: row.id, barberId, amount, note: "", paidAt: row.paidAt.toISOString(), createdAt: row.createdAt.toISOString() });
    }
    const sqlBal = await barberBalances(t.db);
    for (const id of barberIds) {
      const o = barberBalance(id, model, pays);
      const got = sqlBal.find((b) => b.barberId === id)!;
      expect({ earned: got.earned, paid: got.paid, balance: got.balance }).toEqual(o);
      expect(got.salesCount).toBe(live.filter((s) => s.barberId === id).length);
    }
  }, 120_000);
});

// ---------- 7. payout double tap ----------

describe("7. addPayout: a double tap records one payout", () => {
  it("5 identical requests at once create exactly 1 payout row", async () => {
    const input = { barberId: A, amount: 500, note: "advance", date: "2026-03-10" };
    const now = new Date("2026-03-10T08:00:00Z");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => addPayout(t.db, input, now)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await t.db.select().from(payouts)).toHaveLength(1);
  });
});

// ---------- 5. indexes for the report queries ----------

type RawClient = { query(q: string, p?: unknown[]): Promise<{ rows: Record<string, string>[] }> };
const raw = () => (t.db as unknown as { $client: RawClient }).$client;

/** EXPLAIN a drizzle query builder; Dates are bound as ISO strings so PGlite can plan it. */
async function explain(qb: { toSQL(): { sql: string; params: unknown[] } }): Promise<string> {
  const { sql: text, params } = qb.toSQL();
  const res = await raw().query(`explain ${text}`, params.map((p) => (p instanceof Date ? p.toISOString() : p)));
  return res.rows.map((r) => r["QUERY PLAN"]).join("\n");
}
async function explainSql(stmt: ReturnType<typeof periodTotalsSql>): Promise<string> {
  const res = await t.db.execute(sql`explain ${stmt}`);
  return (res.rows as Record<string, string>[]).map((r) => r["QUERY PLAN"]).join("\n");
}

describe("5. indexes: EXPLAIN on the report queries with realistic volume", () => {
  beforeAll(async () => {
    await reset();
    // ~20k sales (about 5 years of a busy shop) and ~40k items, loaded in bulk, then ANALYZE
    // so the planner works from real statistics instead of an empty table.
    await t.db.execute(sql`
      insert into sales (idempotency_key, barber_id, total, barber_share, owner_share, commission_pct_snapshot, created_at, voided_at, voided_by)
      select 'bulk-' || g, (array[${A}::int, ${B}::int, ${C}::int])[1 + g % 3], 200, 100, 100, 50,
             timestamptz '2022-01-01 00:00:00+06' + (g * interval '131 minutes'),
             case when g % 20 = 0 then now() end, case when g % 20 = 0 then 'ADMIN'::voided_by end
      from generate_series(1, 20000) g`);
    await t.db.execute(sql`
      insert into sale_items (sale_id, service_id, name_snapshot, price_snapshot, qty)
      select s.id, ${SVC[0].id}::int, 'x', 100, 1 + (s.id % 2) from sales s, generate_series(1, 2) k`);
    await t.db.execute(sql`analyze sales`);
    await t.db.execute(sql`analyze sale_items`);
    await t.db.execute(sql`analyze payouts`);
  }, 120_000);

  it("the dashboard day query (one Dhaka day) reads sales through a created_at index", async () => {
    const plan = await explainSql(periodTotalsSql({ from: "2025-06-10", to: "2025-06-10", mode: "day" }));
    expect(plan).toMatch(/sales_created_idx|sales_barber_created_idx/);
    expect(plan).not.toMatch(/Seq Scan on sales/);
  });

  it("a one-day report must not aggregate every sale item ever recorded", async () => {
    const plan = await explainSql(periodTotalsSql({ from: "2025-06-10", to: "2025-06-10", mode: "day" }));
    // Reaching items by sale_id (sale_items_sale_idx) is the sign the date filter was pushed down.
    expect(plan).toContain("sale_items_sale_idx");
    expect(plan).not.toMatch(/Seq Scan on sale_items/);
  });

  it("listSales / todayStats / barberSalesToday style filters use the date indexes", async () => {
    const lo = dhakaDayStart("2025-06-10");
    const hi = dhakaDayStart("2025-06-11");
    const day = await explain(t.db.select().from(sales).where(and(gte(sales.createdAt, lo), lt(sales.createdAt, hi), isNull(sales.voidedAt))));
    expect(day).toMatch(/Index Scan|Bitmap Index Scan/);
    expect(day).not.toMatch(/Seq Scan on sales/);
    const mine = await explain(t.db.select().from(sales).where(and(eq(sales.barberId, A), gte(sales.createdAt, lo), lt(sales.createdAt, hi))));
    expect(mine).toMatch(/sales_barber_created_idx|sales_created_idx/);
    expect(mine).not.toMatch(/Seq Scan on sales/);
  });

  it("every foreign key column has an index", async () => {
    const res = await t.db.execute(sql`
      select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f'
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indkey[0] = a.attnum)`);
    expect(res.rows).toEqual([]); // anything listed is an unindexed FK
  });
});
