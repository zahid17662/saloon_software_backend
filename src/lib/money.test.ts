import { describe, expect, it } from "vitest";
import { splitAmount } from "./money";

// BR-1 / BR-8 (docs/PRD.md §6) and acceptance criterion 2 (§12).
describe("splitAmount edge cases (BR-1)", () => {
  it("an odd total splits 38/37 at 50% and the shares add up", () => {
    expect(splitAmount(75, 50)).toEqual({ barberShare: 38, ownerShare: 37 });
  });

  it("rounds a .5 share half-up (never banker's rounding)", () => {
    expect(splitAmount(1, 50)).toEqual({ barberShare: 1, ownerShare: 0 }); // 0.5 -> 1
    expect(splitAmount(3, 50)).toEqual({ barberShare: 2, ownerShare: 1 }); // 1.5 -> 2
    expect(splitAmount(5, 50)).toEqual({ barberShare: 3, ownerShare: 2 }); // 2.5 -> 3 (banker's would give 2)
    expect(splitAmount(50, 45)).toEqual({ barberShare: 23, ownerShare: 27 }); // PRD acceptance criterion 2
  });

  it("0% commission: the owner keeps everything", () => {
    expect(splitAmount(250, 0)).toEqual({ barberShare: 0, ownerShare: 250 });
    expect(splitAmount(1, 0)).toEqual({ barberShare: 0, ownerShare: 1 });
  });

  it("100% commission: the barber keeps everything", () => {
    expect(splitAmount(250, 100)).toEqual({ barberShare: 250, ownerShare: 0 });
    expect(splitAmount(1, 100)).toEqual({ barberShare: 1, ownerShare: 0 });
  });

  it("a zero total splits into zero and zero", () => {
    expect(splitAmount(0, 50)).toEqual({ barberShare: 0, ownerShare: 0 });
  });

  it("the largest allowed cart (30 lines x ৳1,000,000 x 20) stays an exact integer split", () => {
    const total = 30 * 1_000_000 * 20;
    const r = splitAmount(total, 33);
    expect(Number.isInteger(r.barberShare)).toBe(true);
    expect(r.barberShare + r.ownerShare).toBe(total);
  });

  it("for every total 0..400 and every commission 0..100: integers, within range, exact sum", () => {
    for (let total = 0; total <= 400; total++) {
      for (let pct = 0; pct <= 100; pct++) {
        const { barberShare, ownerShare } = splitAmount(total, pct);
        expect(Number.isInteger(barberShare)).toBe(true);
        expect(Number.isInteger(ownerShare)).toBe(true);
        expect(barberShare).toBeGreaterThanOrEqual(0);
        expect(ownerShare).toBeGreaterThanOrEqual(0);
        expect(barberShare + ownerShare).toBe(total);
        // within half a taka of the exact value
        expect(Math.abs(barberShare - (total * pct) / 100)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it("a higher commission never pays the barber less (monotonic)", () => {
    for (const total of [1, 7, 75, 125, 999]) {
      let prev = -1;
      for (let pct = 0; pct <= 100; pct++) {
        const { barberShare } = splitAmount(total, pct);
        expect(barberShare).toBeGreaterThanOrEqual(prev);
        prev = barberShare;
      }
    }
  });
});
