import { describe, expect, it } from "vitest";
import { payoutDeleteInput, payoutInput } from "./schemas";

// FR-20 and BR-7/BR-8 (docs/PRD.md): a payout is a positive whole number of taka.
// Nothing here limits a payout to the barber's balance: BR-7 says it may go negative (an advance).
const good = { barberId: 1, amount: 500, date: "2026-03-10", note: "সাপ্তাহিক" };
const msg = (r: ReturnType<typeof payoutInput.safeParse>) => r.error?.issues[0]?.message;

describe("payoutInput: amount", () => {
  it("accepts a normal whole-taka amount, 1, and the upper limit", () => {
    expect(payoutInput.safeParse(good).success).toBe(true);
    expect(payoutInput.safeParse({ ...good, amount: 1 }).success).toBe(true);
    expect(payoutInput.safeParse({ ...good, amount: 10_000_000 }).success).toBe(true);
  });

  it.each([0, -1, -500, 0.5, 12.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects amount %j", (amount) => {
    const r = payoutInput.safeParse({ ...good, amount });
    expect(r.success).toBe(false);
  });

  it("zero and negative amounts get the Bangla amount message", () => {
    expect(msg(payoutInput.safeParse({ ...good, amount: 0 }))).toBe("টাকার পরিমাণ সঠিক নয়");
    expect(msg(payoutInput.safeParse({ ...good, amount: -50 }))).toBe("টাকার পরিমাণ সঠিক নয়");
  });

  it.each(["500", null, undefined, true, [500]])("rejects a non-number amount %j", (amount) => {
    expect(payoutInput.safeParse({ ...good, amount }).success).toBe(false);
  });

  it("rejects an amount above the limit", () => {
    expect(payoutInput.safeParse({ ...good, amount: 10_000_001 }).success).toBe(false);
  });
});

describe("payoutInput: the other fields", () => {
  it("requires a real barber id", () => {
    for (const barberId of [0, -1, 1.5, "1", null]) {
      expect(payoutInput.safeParse({ ...good, barberId }).success).toBe(false);
    }
  });

  it("requires a real calendar date", () => {
    for (const date of ["2026-02-30", "2026-13-01", "10-03-2026", "2026-3-1", "", "today"]) {
      expect(payoutInput.safeParse({ ...good, date }).success).toBe(false);
    }
  });

  it("the note is optional (defaults to empty), trimmed, and limited to 200 characters", () => {
    expect(payoutInput.parse({ barberId: 1, amount: 5, date: "2026-03-10" }).note).toBe("");
    expect(payoutInput.parse({ ...good, note: "  অগ্রিম  " }).note).toBe("অগ্রিম");
    expect(payoutInput.safeParse({ ...good, note: "ক".repeat(200) }).success).toBe(true);
    expect(payoutInput.safeParse({ ...good, note: "ক".repeat(201) }).success).toBe(false);
  });

  it("rejects unknown keys (strict): a client cannot set createdAt or paidAt", () => {
    expect(payoutInput.safeParse({ ...good, createdAt: "2026-03-01T00:00:00Z" }).success).toBe(false);
    expect(payoutInput.safeParse({ ...good, paidAt: "2026-03-01T00:00:00Z" }).success).toBe(false);
    expect(payoutInput.safeParse({ ...good, id: 5 }).success).toBe(false);
  });
});

describe("payoutDeleteInput", () => {
  it("needs a positive integer id and nothing else", () => {
    expect(payoutDeleteInput.safeParse({ id: 3 }).success).toBe(true);
    for (const bad of [{ id: 0 }, { id: -1 }, { id: 1.5 }, { id: "3" }, {}, { id: 3, extra: 1 }]) {
      expect(payoutDeleteInput.safeParse(bad).success).toBe(false);
    }
  });
});
