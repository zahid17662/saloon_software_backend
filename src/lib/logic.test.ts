import { describe, expect, it } from "vitest";
import { bnDigits, nameInitial, parseIntInput, receiptNo, splitAmount, taka } from "./money";
import { dhakaDateKey, dhakaDateToIso, presetRange, shiftDays } from "./time";
import { barberBalance, byBarber, byPeriod, byService, liveSales, summarize, toCsv } from "./reports";
import { createSeed } from "./seed";
import type { Payout, Sale } from "./types";

function sale(p: Partial<Sale> & { id: number; total: number }): Sale {
  const pct = p.commissionPctSnapshot ?? 50;
  const { barberShare, ownerShare } = splitAmount(p.total, pct);
  return {
    idempotencyKey: `k${p.id}`,
    barberId: 1,
    barberShare,
    ownerShare,
    commissionPctSnapshot: pct,
    paymentMethod: "CASH",
    createdAt: "2026-11-23T06:00:00.000Z",
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    enteredByAdmin: false,
    items: [{ serviceId: 1, nameSnapshot: "Hair Cutting", priceSnapshot: p.total, qty: 1 }],
    ...p,
  };
}

describe("splitAmount (BR-1)", () => {
  it("splits 50/50", () => {
    expect(splitAmount(150, 50)).toEqual({ barberShare: 75, ownerShare: 75 });
    expect(splitAmount(250, 50)).toEqual({ barberShare: 125, ownerShare: 125 });
  });
  it("rounds half-up and shares always sum to total (AC 2)", () => {
    expect(splitAmount(50, 45)).toEqual({ barberShare: 23, ownerShare: 27 });
    for (const total of [1, 7, 99, 155, 1801]) {
      for (const pct of [0, 33, 45, 50, 67, 100]) {
        const r = splitAmount(total, pct);
        expect(r.barberShare + r.ownerShare).toBe(total);
      }
    }
  });
});

describe("formatting", () => {
  it("uses Bangla digits with Indian grouping", () => {
    expect(bnDigits(2026)).toBe("২০২৬");
    expect(taka(125000)).toBe("৳১,২৫,০০০");
    expect(taka(-500)).toBe("-৳৫০০");
    expect(receiptNo(123)).toBe("R-০০০১২৩");
  });
  it("parses Bangla and English digits", () => {
    expect(parseIntInput("১৫০")).toBe(150);
    expect(parseIntInput(" 200 ")).toBe(200);
    expect(parseIntInput("12a")).toBeNull();
    expect(parseIntInput("")).toBeNull();
  });
});

describe("Dhaka time (BR-5, AC 7)", () => {
  it("23:50 Dhaka on the 30th stays on the 30th", () => {
    // 23:50 +06:00 == 17:50Z the same day
    expect(dhakaDateKey("2026-11-30T17:50:00.000Z")).toBe("2026-11-30");
  });
  it("00:30 Dhaka belongs to the new day even though UTC is still the previous day", () => {
    expect(dhakaDateKey("2026-11-30T18:30:00.000Z")).toBe("2026-12-01");
  });
  it("presets", () => {
    const now = new Date("2026-11-23T20:00:00.000Z"); // 02:00 on the 24th in Dhaka
    expect(presetRange("today", now)).toEqual({ from: "2026-11-24", to: "2026-11-24" });
    expect(presetRange("yesterday", now)).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(presetRange("month", now)).toEqual({ from: "2026-11-01", to: "2026-11-24" });
    expect(shiftDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("date key round-trips through dhakaDateToIso", () => {
    expect(dhakaDateKey(dhakaDateToIso("2026-11-05"))).toBe("2026-11-05");
  });
});

describe("reports", () => {
  const barbers = createSeed("2026-01-01T00:00:00.000Z").barbers;
  const sales: Sale[] = [
    sale({ id: 1, total: 250, barberId: 1 }),
    sale({ id: 2, total: 150, barberId: 2, createdAt: "2026-11-22T10:00:00.000Z" }),
    sale({ id: 3, total: 600, barberId: 1, voidedAt: "2026-11-23T07:00:00.000Z", voidedBy: "ADMIN", voidReason: "x" }),
    sale({ id: 4, total: 50, barberId: 1, commissionPctSnapshot: 45 }),
  ];

  it("excludes voided sales everywhere (BR-4, AC 6)", () => {
    const live = liveSales(sales);
    expect(live.map((s) => s.id)).toEqual([1, 2, 4]);
    expect(summarize(live)).toEqual({ count: 3, services: 3, total: 450, barberShare: 223, ownerShare: 227 });
  });

  it("filters by Dhaka day", () => {
    const today = liveSales(sales, { from: "2026-11-23", to: "2026-11-23" });
    expect(today.map((s) => s.id)).toEqual([1, 4]);
  });

  it("groups per barber including idle active barbers", () => {
    const rows = byBarber(liveSales(sales), barbers);
    expect(rows.map((r) => [r.barberName, r.total])).toEqual([
      ["নাপিত ১", 300],
      ["নাপিত ২", 150],
      ["নাপিত ৩", 0],
    ]);
  });

  it("groups by day newest first", () => {
    const rows = byPeriod(liveSales(sales), barbers, "day");
    expect(rows.map((r) => [r.period, r.barberId, r.total])).toEqual([
      ["2026-11-23", 1, 300],
      ["2026-11-22", 2, 150],
    ]);
    expect(byPeriod(liveSales(sales), barbers, "month")).toHaveLength(2);
  });

  it("groups by service using price snapshots", () => {
    expect(byService(liveSales(sales))).toEqual([{ name: "Hair Cutting", qty: 3, revenue: 450 }]);
  });

  it("payout balance and advance (AC 8)", () => {
    const big = [sale({ id: 9, total: 6000 })]; // barber earns 3000
    const payouts: Payout[] = [
      { id: 1, barberId: 1, amount: 2000, note: "", paidAt: "", createdAt: "" },
    ];
    expect(barberBalance(1, big, payouts)).toEqual({ earned: 3000, paid: 2000, balance: 1000 });
    payouts.push({ id: 2, barberId: 1, amount: 1500, note: "", paidAt: "", createdAt: "" });
    expect(barberBalance(1, big, payouts).balance).toBe(-500);
  });

  it("CSV has a BOM and escapes commas/quotes", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'say "hi"']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"x,y","say ""hi"""');
  });
});

describe("seed (PRD §7)", () => {
  it("has 25 services across 5 categories and 3 barbers at 50%", () => {
    const db = createSeed();
    expect(db.services).toHaveLength(25);
    expect(db.categories).toHaveLength(5);
    expect(db.barbers.map((b) => b.commissionPct)).toEqual([50, 50, 50]);
    expect(db.services.find((s) => s.name === "Hydra Facial (full)")?.price).toBe(1800);
  });
});

describe("nameInitial (avatar letter)", () => {
  it("never returns a lone Bangla vowel sign", () => {
    expect(nameInitial("রবি")).toBe("বি"); // not just the vowel sign ি
    expect(nameInitial("  করিম ")).toBe("ম");
    expect(nameInitial("নাপিত ১")).toBe("১");
    expect(nameInitial("")).toBe("");
  });
});
