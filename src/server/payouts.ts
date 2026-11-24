// Payouts: money the owner hands to a barber (FR-18). Balance = live-sale barber shares - payouts
// (BR-7); a negative balance is an advance. Voided sales never count (BR-4). A payout can be
// deleted for 24 hours only (BR-6); the window is checked inside the DELETE, so it cannot race.

import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { barbers, payouts, sales } from "../db/schema";
import { PAYOUT_DELETE_WINDOW_MS } from "../lib/sale-rules";
import type { PayoutInput } from "../lib/schemas";
import { dhakaDateToIso, todayKey } from "../lib/time";
import type { Payout } from "../lib/types";
import type { Db } from "./db-types";
import { DomainError } from "./errors";

const MSG = {
  noBarber: "নাপিত পাওয়া যায়নি",
  future: "ভবিষ্যতের তারিখ দেওয়া যাবে না",
  duplicate: "এই পেমেন্ট এইমাত্র সেভ হয়েছে",
  noPayout: "পেমেন্ট পাওয়া যায়নি",
  windowOver: "২৪ ঘণ্টা পার হওয়া পেমেন্ট মোছা যাবে না",
} as const;

const DUPLICATE_WINDOW_MS = 30_000;
const PAYOUT_LOCK_NS = 7001; // namespace for pg_advisory_xact_lock(ns, barberId)

type Row = typeof payouts.$inferSelect;
const toPayout = (r: Row): Payout => ({
  id: r.id,
  barberId: r.barberId,
  amount: r.amount,
  note: r.note,
  paidAt: r.paidAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

export interface BarberBalance {
  barberId: number;
  earned: number;
  paid: number;
  balance: number; // negative = advance
  salesCount: number; // live sales, all time
}

export async function addPayout(db: Db, input: PayoutInput, now: Date = new Date()): Promise<Payout> {
  if (input.date > todayKey(now)) throw new DomainError(MSG.future);
  // The check-then-insert below has no unique constraint to fall back on, so it runs in one
  // transaction that first takes a per-barber advisory lock: concurrent taps for the same barber
  // queue up, and the second one sees the first one's committed row.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PAYOUT_LOCK_NS}, ${input.barberId})`);
    const [barber] = await tx.select({ id: barbers.id }).from(barbers).where(eq(barbers.id, input.barberId));
    if (!barber) throw new DomainError(MSG.noBarber); // inactive barbers can still be paid what they earned
    // A double tap or a retry on a slow network must not record the same payment twice.
    const recent = new Date(now.getTime() - DUPLICATE_WINDOW_MS);
    const [twin] = await tx
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(
          eq(payouts.barberId, input.barberId),
          eq(payouts.amount, input.amount),
          eq(payouts.note, input.note),
          gte(payouts.createdAt, recent),
        ),
      )
      .limit(1);
    if (twin) throw new DomainError(MSG.duplicate);
    // A payout is stamped at noon Dhaka of its day, but never in the future (today, before noon).
    const noon = new Date(dhakaDateToIso(input.date));
    const paidAt = noon > now ? now : noon;
    const [row] = await tx
      .insert(payouts)
      .values({
        barberId: input.barberId,
        amount: input.amount,
        note: input.note,
        paidAt,
        createdAt: now,
      })
      .returning();
    return toPayout(row);
  });
}

export async function listPayouts(db: Db): Promise<Payout[]> {
  const rows = await db.select().from(payouts).orderBy(desc(payouts.paidAt), desc(payouts.id));
  return rows.map(toPayout);
}

/** One row per barber (active or not), computed in SQL so it stays exact for any history length. */
export async function barberBalances(db: Db): Promise<BarberBalance[]> {
  const earned = await db
    .select({
      barberId: sales.barberId,
      earned: sql<string>`coalesce(sum(${sales.barberShare}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(sales)
    .where(isNull(sales.voidedAt))
    .groupBy(sales.barberId);
  const paid = await db
    .select({ barberId: payouts.barberId, paid: sql<string>`coalesce(sum(${payouts.amount}), 0)` })
    .from(payouts)
    .groupBy(payouts.barberId);
  const all = await db.select({ id: barbers.id }).from(barbers).orderBy(asc(barbers.sortOrder), asc(barbers.id));
  const e = new Map(earned.map((r) => [r.barberId, r]));
  const p = new Map(paid.map((r) => [r.barberId, Number(r.paid)]));
  return all.map(({ id }) => {
    const earnedN = Number(e.get(id)?.earned ?? 0);
    const paidN = p.get(id) ?? 0;
    return { barberId: id, earned: earnedN, paid: paidN, balance: earnedN - paidN, salesCount: Number(e.get(id)?.count ?? 0) };
  });
}

export async function deletePayout(db: Db, id: number, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - PAYOUT_DELETE_WINDOW_MS);
  const gone = await db
    .delete(payouts)
    .where(and(eq(payouts.id, id), gte(payouts.createdAt, cutoff)))
    .returning({ id: payouts.id });
  if (gone.length > 0) return;
  const [still] = await db.select({ id: payouts.id }).from(payouts).where(eq(payouts.id, id));
  throw new DomainError(still ? MSG.windowOver : MSG.noPayout);
}
