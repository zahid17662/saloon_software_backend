import { describe, expect, it } from "vitest";
import { BARBER_VOID_WINDOW_MS, canBarberVoid, canDeletePayout, PAYOUT_DELETE_WINDOW_MS } from "./sale-rules";

const T0 = Date.parse("2026-03-10T06:00:00Z");
const sale = (over: Partial<{ createdAt: string; voidedAt: string | null; enteredByAdmin: boolean }> = {}) => ({
  createdAt: new Date(T0).toISOString(),
  voidedAt: null as string | null,
  enteredByAdmin: false,
  ...over,
});

describe("canBarberVoid (BR: barber may void their own sale within 10 minutes)", () => {
  it("window is 10 minutes", () => expect(BARBER_VOID_WINDOW_MS).toBe(600_000));

  it("allows right after the sale and exactly at 10:00", () => {
    expect(canBarberVoid(sale(), T0)).toBe(true);
    expect(canBarberVoid(sale(), T0 + BARBER_VOID_WINDOW_MS)).toBe(true);
  });

  it("refuses 1 ms after the window", () => {
    expect(canBarberVoid(sale(), T0 + BARBER_VOID_WINDOW_MS + 1)).toBe(false);
  });

  it("refuses an already voided sale", () => {
    expect(canBarberVoid(sale({ voidedAt: new Date(T0).toISOString() }), T0)).toBe(false);
  });

  it("never lets a barber void an admin-entered (back-dated) sale, even if it was just entered", () => {
    expect(canBarberVoid(sale({ enteredByAdmin: true }), T0)).toBe(false);
  });

  it("treats a sale dated in the future of 'now' (clock skew) as still voidable", () => {
    expect(canBarberVoid(sale(), T0 - 5_000)).toBe(true);
  });
});

describe("canDeletePayout (24 hours)", () => {
  it("allows within 24 h and refuses after", () => {
    const p = { createdAt: new Date(T0).toISOString() };
    expect(canDeletePayout(p, T0 + PAYOUT_DELETE_WINDOW_MS)).toBe(true);
    expect(canDeletePayout(p, T0 + PAYOUT_DELETE_WINDOW_MS + 1)).toBe(false);
  });
});
