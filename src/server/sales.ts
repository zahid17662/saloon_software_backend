// Sales: create, read, void, list. Plain functions over a Drizzle handle with the clock passed in,
// so the same code runs against Neon in production and PGlite in tests. Auth, zod and revalidation
// live in src/app/actions/sales.ts.
//
// Rules enforced here (docs/PRD.md §6): FR-8 the server recomputes every price and the split,
// FR-9 an idempotency key makes a double tap safe, BR-2/BR-3 name, price and commission are
// snapshotted, BR-5 days are Asia/Dhaka, BR-4 voided sales are excluded from totals.

import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { barbers, categories, saleItems, sales, services } from "../db/schema";
import { splitAmount } from "../lib/money";
import { BARBER_VOID_WINDOW_MS } from "../lib/sale-rules";
import type { SaleInput, SalesQuery } from "../lib/schemas";
import { dhakaDayStart, shiftDays, todayKey } from "../lib/time";
import type { Sale } from "../lib/types";
import type { Db } from "./db-types";
import { DomainError } from "./errors";

const MSG = {
  noBarber: "নাপিত পাওয়া যায়নি",
  noService: "কোনো সার্ভিস আর পাওয়া যাচ্ছে না",
  noSale: "বিক্রি পাওয়া যায়নি",
  windowOver: "১০ মিনিট পার হয়ে গেছে — এডমিনকে বলুন",
  adminOnly: "এই এন্ট্রি শুধু এডমিন বাতিল করতে পারবে",
  keyOther: "এই এন্ট্রি আগেই অন্য নাপিতের নামে সেভ হয়েছে",
} as const;

type SaleRow = typeof sales.$inferSelect;
type ItemRow = typeof saleItems.$inferSelect;

const toSale = (r: SaleRow, items: ItemRow[]): Sale => ({
  id: r.id,
  idempotencyKey: r.idempotencyKey,
  barberId: r.barberId,
  total: r.total,
  barberShare: r.barberShare,
  ownerShare: r.ownerShare,
  commissionPctSnapshot: r.commissionPctSnapshot,
  paymentMethod: r.paymentMethod,
  createdAt: r.createdAt.toISOString(),
  voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
  voidedBy: r.voidedBy,
  voidReason: r.voidReason,
  enteredByAdmin: r.enteredByAdmin,
  items: items.map((i) => ({
    serviceId: i.serviceId,
    nameSnapshot: i.nameSnapshot,
    priceSnapshot: i.priceSnapshot,
    qty: i.qty,
  })),
});

/** Attach the line items to a batch of sale rows with one extra query (not one per sale). */
const ITEM_CHUNK = 5000;

async function withItems(db: Db, rows: SaleRow[]): Promise<Sale[]> {
  if (rows.length === 0) return [];
  // Chunked so a long date range can never exceed the Postgres limit of 65535 bind parameters.
  const items: ItemRow[] = [];
  for (let i = 0; i < rows.length; i += ITEM_CHUNK) {
    const ids = rows.slice(i, i + ITEM_CHUNK).map((r) => r.id);
    items.push(...(await db.select().from(saleItems).where(inArray(saleItems.saleId, ids)).orderBy(saleItems.id)));
  }
  const bySale = new Map<number, ItemRow[]>();
  for (const i of items) bySale.set(i.saleId, [...(bySale.get(i.saleId) ?? []), i]);
  return rows.map((r) => toSale(r, bySale.get(r.id) ?? []));
}

export async function getSale(db: Db, id: number): Promise<Sale | null> {
  const rows = await db.select().from(sales).where(eq(sales.id, id));
  return (await withItems(db, rows))[0] ?? null;
}

async function findByKey(db: Db, idempotencyKey: string): Promise<Sale | null> {
  const rows = await db.select().from(sales).where(eq(sales.idempotencyKey, idempotencyKey));
  return (await withItems(db, rows))[0] ?? null;
}

/** Postgres unique_violation, whether the driver throws it directly or wrapped (Drizzle's `cause`). */
function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth++) {
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

export interface CreateSaleOptions {
  /** The current time (injectable for tests). */
  now?: Date;
  /** FR-22: the instant to store instead of `now`. Callers must validate it with resolveBackdate. */
  at?: Date;
  /** FR-22: flag the sale as entered by the admin. Never taken from client input. */
  enteredByAdmin?: boolean;
}

export async function createSale(db: Db, input: SaleInput, opts: CreateSaleOptions = {}): Promise<Sale> {
  const now = opts.now ?? new Date();

  // FR-9: a repeated key returns the sale that already exists.
  const existing = await findByKey(db, input.idempotencyKey);
  if (existing) {
    // A key only ever belongs to one barber's sale; anything else is a client bug, not a replay.
    if (existing.barberId !== input.barberId) throw new DomainError(MSG.keyOther);
    return existing;
  }

  try {
    return await db.transaction(async (tx) => {
      const [barber] = await tx
        .select()
        .from(barbers)
        .where(and(eq(barbers.id, input.barberId), eq(barbers.active, true)));
      if (!barber) throw new DomainError(MSG.noBarber);

      // FR-8: prices come from the stored services, never from the request.
      const ids = input.items.map((i) => i.serviceId);
      // A service in a hidden category is not for sale either (the UI hides it; this covers stale tabs).
      const found = await tx
        .select({ svc: services })
        .from(services)
        .innerJoin(categories, eq(categories.id, services.categoryId))
        .where(and(inArray(services.id, ids), eq(services.active, true), eq(categories.active, true)));
      const byId = new Map(found.map((r) => [r.svc.id, r.svc]));
      const lines = input.items.map((i) => {
        const svc = byId.get(i.serviceId);
        if (!svc) throw new DomainError(MSG.noService);
        return { serviceId: svc.id, nameSnapshot: svc.name, priceSnapshot: svc.price, qty: i.qty };
      });

      const total = lines.reduce((n, l) => n + l.priceSnapshot * l.qty, 0);
      const { barberShare, ownerShare } = splitAmount(total, barber.commissionPct);

      const [row] = await tx
        .insert(sales)
        .values({
          idempotencyKey: input.idempotencyKey,
          barberId: barber.id,
          total,
          barberShare,
          ownerShare,
          commissionPctSnapshot: barber.commissionPct,
          paymentMethod: input.paymentMethod,
          createdAt: opts.at ?? now,
          enteredByAdmin: opts.enteredByAdmin ?? false,
        })
        .returning();
      const items = await tx
        .insert(saleItems)
        .values(lines.map((l) => ({ ...l, saleId: row.id })))
        .returning();
      return toSale(row, items.sort((a, b) => a.id - b.id));
    });
  } catch (e) {
    // Two taps raced past the check above and the unique index stopped the second: return the winner.
    if (isUniqueViolation(e)) {
      const winner = await findByKey(db, input.idempotencyKey);
      if (winner) return winner;
    }
    throw e;
  }
}

// ---------- void ----------

/**
 * Atomic: the checks live in the UPDATE's WHERE clause, so two simultaneous requests cannot both
 * pass. If it changed nothing we look at the row only to choose the right message.
 */
export async function voidSaleByBarber(
  db: Db,
  input: { saleId: number; barberId: number; reason: string },
  now: Date = new Date(),
): Promise<Sale> {
  const cutoff = new Date(now.getTime() - BARBER_VOID_WINDOW_MS);
  const [row] = await db
    .update(sales)
    .set({ voidedAt: now, voidedBy: "BARBER", voidReason: input.reason })
    .where(
      and(
        eq(sales.id, input.saleId),
        eq(sales.barberId, input.barberId),
        isNull(sales.voidedAt),
        eq(sales.enteredByAdmin, false),
        gte(sales.createdAt, cutoff),
      ),
    )
    .returning();
  if (row) return (await withItems(db, [row]))[0];

  const cur = await getSale(db, input.saleId);
  // Another barber's sale is reported as missing so ids of other people's sales are not confirmed.
  if (!cur || cur.barberId !== input.barberId) throw new DomainError(MSG.noSale);
  if (cur.voidedAt) return cur;
  if (cur.enteredByAdmin) throw new DomainError(MSG.adminOnly);
  throw new DomainError(MSG.windowOver);
}

export async function voidSaleByAdmin(
  db: Db,
  input: { saleId: number; reason: string },
  now: Date = new Date(),
): Promise<Sale> {
  const [row] = await db
    .update(sales)
    .set({ voidedAt: now, voidedBy: "ADMIN", voidReason: input.reason })
    .where(and(eq(sales.id, input.saleId), isNull(sales.voidedAt)))
    .returning();
  if (row) return (await withItems(db, [row]))[0];
  const cur = await getSale(db, input.saleId);
  if (!cur) throw new DomainError(MSG.noSale);
  return cur;
}

// ---------- lists and totals ----------

/** [start of `from`, start of the day after `to`) in Dhaka time, both bounds inclusive by day. */
const dayWindow = (from: string, to: string) => ({
  start: dhakaDayStart(from),
  end: dhakaDayStart(shiftDays(to, 1)),
});

export async function listSales(db: Db, q: SalesQuery): Promise<Sale[]> {
  const { start, end } = dayWindow(q.from, q.to);
  const rows = await db
    .select()
    .from(sales)
    .where(
      and(
        gte(sales.createdAt, start),
        lt(sales.createdAt, end),
        q.barberId ? eq(sales.barberId, q.barberId) : undefined,
        q.status === "live" ? isNull(sales.voidedAt) : undefined,
        q.status === "void" ? sql`${sales.voidedAt} is not null` : undefined,
      ),
    )
    .orderBy(desc(sales.id));
  return withItems(db, rows);
}

/** Today's live sales per barber (voided excluded, BR-4). Barbers with none are simply absent. */
export async function todayStats(
  db: Db,
  now: Date = new Date(),
): Promise<{ barberId: number; count: number; barberShare: number }[]> {
  const today = todayKey(now);
  const { start, end } = dayWindow(today, today);
  return db
    .select({
      barberId: sales.barberId,
      count: sql<number>`count(*)`.mapWith(Number),
      barberShare: sql<number>`coalesce(sum(${sales.barberShare}), 0)`.mapWith(Number),
    })
    .from(sales)
    .where(and(gte(sales.createdAt, start), lt(sales.createdAt, end), isNull(sales.voidedAt)))
    .groupBy(sales.barberId);
}

/** One barber's entries for today, voided ones included (the barber screen shows them struck out). */
export async function barberSalesToday(db: Db, barberId: number, now: Date = new Date()): Promise<Sale[]> {
  const today = todayKey(now);
  const { start, end } = dayWindow(today, today);
  const rows = await db
    .select()
    .from(sales)
    .where(and(eq(sales.barberId, barberId), gte(sales.createdAt, start), lt(sales.createdAt, end)))
    .orderBy(desc(sales.id));
  return withItems(db, rows);
}
