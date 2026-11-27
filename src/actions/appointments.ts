// Appointment API actions. createAppointment is the ONE public, unauthenticated write in this API
// (called from the public website's booking form) — it is rate-limited per IP instead of requiring
// a session. list is readable by any unlocked shop device (barber or admin); updateStatus stays
// admin-only, since only the admin triages bookings.

import { db } from "@/db";
import { attemptStore, getClientIp, requireAdmin, requireShop } from "@/lib/auth";
import { beginAttempt } from "@/lib/rate-limit";
import { appointmentCreateInput, appointmentStatusPatch } from "@/lib/schemas";
import type { Appointment } from "@/lib/types";
import { parseInput, parseInputRaw, runAction, type ActionResult } from "@/server/action";
import * as appointments from "@/server/appointments";
import { DomainError } from "@/server/errors";

const MSG = {
  tooMany: "Too many requests from this network right now. Please try again a bit later.",
  noIp: "Something went wrong. Please try again.",
} as const;

export async function createAppointment(input: unknown): Promise<ActionResult<Appointment>> {
  return runAction(async () => {
    const ip = await getClientIp();
    if (!ip) throw new DomainError(MSG.noIp);
    // Never recordSuccess here: unlike a login, every legitimate booking is a "success", so clearing
    // the counter on success would defeat the throttle entirely.
    if (!(await beginAttempt(attemptStore, ip, "appointment")).allowed) throw new DomainError(MSG.tooMany);

    const parsed = parseInputRaw(appointmentCreateInput, input);
    return appointments.createAppointment(db, parsed);
  });
}

export async function listAppointments(): Promise<ActionResult<Appointment[]>> {
  return runAction(async () => {
    await requireShop();
    return appointments.listAppointments(db);
  });
}

export async function updateAppointmentStatus(input: unknown): Promise<ActionResult<Appointment>> {
  return runAction(async () => {
    await requireAdmin();
    const parsed = parseInput(appointmentStatusPatch, input);
    return appointments.setAppointmentStatus(db, parsed.id, parsed.status);
  });
}
