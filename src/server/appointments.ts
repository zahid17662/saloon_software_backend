// Appointments: online booking requests from the public site (not part of the v1 PRD scope, added
// as a customer-facing extra). A visitor picks a service, a time and optionally a barber; the shop
// confirms or cancels from the admin screen. Messages here are English (the public site is English);
// the admin-only status change keeps its own Bangla message, like the rest of the admin surface.
//
// Mirrors the sales.ts idempotency pattern: a repeated key returns the row that already exists
// instead of creating a duplicate (a double tap or a slow-network retry on the booking form).

import { asc, eq } from "drizzle-orm";
import { appointments, barbers } from "../db/schema";
import type { AppointmentCreateInput } from "../lib/schemas";
import { dhakaDateTimeToIso } from "../lib/time";
import type { Appointment, AppointmentStatus } from "../lib/types";
import type { Db } from "./db-types";
import { DomainError } from "./errors";

const MSG = {
  past: "Please choose a time in the future",
  tooFar: "Please choose a date within the next 60 days",
  noBarber: "That barber is not available right now",
  notFound: "অ্যাপয়েন্টমেন্ট পাওয়া যায়নি",
} as const;

const MAX_DAYS_AHEAD = 60;

type Row = typeof appointments.$inferSelect;

const toAppointment = (r: Row): Appointment => ({
  id: r.id,
  customerName: r.customerName,
  customerPhone: r.customerPhone,
  serviceName: r.serviceName,
  barberId: r.barberId,
  barberName: r.barberNameSnapshot,
  requestedAt: r.requestedAt.toISOString(),
  note: r.note,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});

async function findByKey(db: Db, idempotencyKey: string): Promise<Appointment | null> {
  const [row] = await db.select().from(appointments).where(eq(appointments.idempotencyKey, idempotencyKey));
  return row ? toAppointment(row) : null;
}

/** Postgres unique_violation, whether the driver throws it directly or wrapped (Drizzle's `cause`). */
function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth++) {
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

export async function createAppointment(db: Db, input: AppointmentCreateInput, now: Date = new Date()): Promise<Appointment> {
  const requestedAt = new Date(dhakaDateTimeToIso(input.date, input.time));
  if (requestedAt.getTime() <= now.getTime()) throw new DomainError(MSG.past);
  if (requestedAt.getTime() - now.getTime() > MAX_DAYS_AHEAD * 86_400_000) throw new DomainError(MSG.tooFar);

  const existing = await findByKey(db, input.idempotencyKey);
  if (existing) return existing;

  let barberName: string | null = null;
  if (input.barberId !== null) {
    const [b] = await db.select({ name: barbers.name, active: barbers.active }).from(barbers).where(eq(barbers.id, input.barberId));
    if (!b?.active) throw new DomainError(MSG.noBarber);
    barberName = b.name;
  }

  try {
    const [row] = await db
      .insert(appointments)
      .values({
        idempotencyKey: input.idempotencyKey,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        serviceName: input.serviceName,
        barberId: input.barberId,
        barberNameSnapshot: barberName,
        requestedAt,
        note: input.note,
        createdAt: now,
      })
      .returning();
    return toAppointment(row);
  } catch (e) {
    // Two taps raced past the check above and the unique index stopped the second: return the winner.
    if (isUniqueViolation(e)) {
      const winner = await findByKey(db, input.idempotencyKey);
      if (winner) return winner;
    }
    throw e;
  }
}

/** Soonest appointment first; the admin triages what's coming up. Capped so the list can't grow unbounded. */
export async function listAppointments(db: Db): Promise<Appointment[]> {
  const rows = await db.select().from(appointments).orderBy(asc(appointments.requestedAt)).limit(300);
  return rows.map(toAppointment);
}

export async function setAppointmentStatus(db: Db, id: number, status: AppointmentStatus, now: Date = new Date()): Promise<Appointment> {
  const [row] = await db.update(appointments).set({ status, respondedAt: now }).where(eq(appointments.id, id)).returning();
  if (!row) throw new DomainError(MSG.notFound);
  return toAppointment(row);
}
