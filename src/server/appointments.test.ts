import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appointments, barbers } from "../db/schema";
import type { AppointmentCreateInput } from "../lib/schemas";
import { createAppointment, listAppointments, setAppointmentStatus } from "./appointments";
import { DomainError } from "./errors";
import { createTestDb, type TestDb } from "./test-db";

const NOW = new Date("2026-03-10T06:00:00Z"); // 12:00 Dhaka
let t: TestDb;
let A: number;
let n = 0;

const base = (): AppointmentCreateInput => ({
  serviceName: "Hair Cutting",
  barberId: null,
  customerName: "Karim",
  customerPhone: "01711112222",
  date: "2026-03-11",
  time: "14:00",
  preferredTimeText: null,
  note: "",
  idempotencyKey: `apt-${++n}-${"x".repeat(8)}`,
});

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.delete(appointments);
  await t.db.delete(barbers);
  const [a] = await t.db.insert(barbers).values({ name: "এ", commissionPct: 50 }).returning();
  A = a.id;
});

describe("createAppointment", () => {
  it("stores the Dhaka-local date+time as the right UTC instant", async () => {
    const appt = await createAppointment(t.db, base(), NOW);
    expect(appt.requestedAt).toBe("2026-03-11T08:00:00.000Z"); // 14:00 Dhaka = 08:00 UTC
    expect(appt.status).toBe("PENDING");
    expect(appt.barberId).toBeNull();
    expect(appt.barberName).toBeNull();
  });

  it("rejects a time that is not in the future", async () => {
    const e = await createAppointment(t.db, { ...base(), date: "2026-03-10", time: "11:00" }, NOW).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
  });

  it("rejects a date too far ahead", async () => {
    const e = await createAppointment(t.db, { ...base(), date: "2026-06-01" }, NOW).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
  });

  it("snapshots the barber's name when one is chosen, and rejects an inactive barber", async () => {
    const appt = await createAppointment(t.db, { ...base(), barberId: A }, NOW);
    expect(appt.barberName).toBe("এ");

    await t.db.update(barbers).set({ active: false }).where(eq(barbers.id, A));
    const e = await createAppointment(t.db, { ...base(), barberId: A }, NOW).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
  });

  it("a repeated idempotency key returns the same appointment instead of creating a second one", async () => {
    const input = base();
    const first = await createAppointment(t.db, input, NOW);
    const second = await createAppointment(t.db, input, NOW);
    expect(second.id).toBe(first.id);
    expect((await listAppointments(t.db)).length).toBe(1);
  });
});

describe("setAppointmentStatus", () => {
  it("updates the status and throws for a missing id", async () => {
    const appt = await createAppointment(t.db, base(), NOW);
    const confirmed = await setAppointmentStatus(t.db, appt.id, "CONFIRMED", NOW);
    expect(confirmed.status).toBe("CONFIRMED");

    const e = await setAppointmentStatus(t.db, 999_999, "CONFIRMED", NOW).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
  });
});
