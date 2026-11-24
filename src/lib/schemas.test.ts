import { describe, expect, it } from "vitest";
import {
  adminVoidInput,
  barberInput,
  barberPatch,
  barberVoidInput,
  categoryInput,
  categoryPatch,
  idSchema,
  pastSaleInput,
  saleInput,
  salesQuery,
  serviceInput,
  servicePatch,
  settingsPatch,
} from "./schemas";

const msg = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? "" : (r.error?.issues[0]?.message ?? "");

describe("barber schemas", () => {
  it("accepts a valid barber and trims the name", () => {
    expect(barberInput.parse({ name: "  রহিম ", commissionPct: 50, password: "barber123" })).toEqual({
      name: "রহিম",
      commissionPct: 50,
      password: "barber123",
    });
  });
  it("rejects an empty name with a Bangla message", () => {
    expect(msg(barberInput.safeParse({ name: "  ", commissionPct: 50, password: "barber123" }))).toBe("নাম লিখুন");
  });
  it.each([-1, 101, 50.5, "50", null])("rejects commission %j", (v) => {
    expect(barberInput.safeParse({ name: "রহিম", commissionPct: v, password: "barber123" }).success).toBe(false);
  });
  it("gives the commission range message", () => {
    expect(msg(barberInput.safeParse({ name: "রহিম", commissionPct: 101, password: "barber123" }))).toBe("কমিশন ০ থেকে ১০০-এর মধ্যে হতে হবে");
  });
  it.each(["ab1c", "noDigitsHere", "123456", "", "   "])("rejects a weak password %j", (password) => {
    expect(barberInput.safeParse({ name: "রহিম", commissionPct: 50, password }).success).toBe(false);
  });
  it("accepts a password with letters and digits, 6+ chars", () => {
    expect(barberInput.safeParse({ name: "রহিম", commissionPct: 50, password: "abc123" }).success).toBe(true);
  });
  it("patch's optional password follows the same strength rule", () => {
    expect(barberPatch.safeParse({ password: "weak" }).success).toBe(false);
    expect(barberPatch.safeParse({ password: "strongpass1" }).success).toBe(true);
    expect(barberPatch.safeParse({}).success).toBe(true);
  });
  it("patch is partial but strict: unknown fields such as id or createdAt are rejected", () => {
    expect(barberPatch.safeParse({ active: false }).success).toBe(true);
    expect(barberPatch.safeParse({ id: 5 }).success).toBe(false);
    expect(barberPatch.safeParse({ createdAt: "2020-01-01" }).success).toBe(false);
  });
});

describe("category and service schemas", () => {
  it("requires a category name", () => {
    expect(msg(categoryInput.safeParse({ name: "" }))).toBe("ক্যাটাগরির নাম লিখুন");
    expect(categoryPatch.safeParse({ name: " " }).success).toBe(false);
  });
  it("requires a positive whole-taka price", () => {
    expect(serviceInput.safeParse({ categoryId: 1, name: "কাটিং", price: 150 }).success).toBe(true);
    for (const price of [0, -5, 12.5, "150", 1_000_001]) {
      expect(serviceInput.safeParse({ categoryId: 1, name: "কাটিং", price }).success).toBe(false);
    }
    expect(msg(serviceInput.safeParse({ categoryId: 1, name: "কাটিং", price: 0 }))).toBe("দাম ০-এর বেশি পূর্ণসংখ্যা হতে হবে");
  });
  it("requires a service name", () => {
    expect(msg(serviceInput.safeParse({ categoryId: 1, name: "", price: 100 }))).toBe("সার্ভিসের নাম লিখুন");
  });
  it("service patch is strict", () => {
    expect(servicePatch.safeParse({ price: 200 }).success).toBe(true);
    expect(servicePatch.safeParse({ id: 2 }).success).toBe(false);
  });
});

describe("settings patch", () => {
  it("accepts the five public settings", () => {
    const p = { shopName: "সেলুন", shopAddress: "ঢাকা", shopPhone: "০১৭", receiptFooter: "ধন্যবাদ", paperWidth: "58" };
    expect(settingsPatch.safeParse(p).success).toBe(true);
  });
  it("never accepts secret or internal keys", () => {
    for (const k of ["adminPinHash", "shopCodeHash", "shopCodeVersion", "adminPin"]) {
      expect(settingsPatch.safeParse({ [k]: "x" }).success).toBe(false);
    }
  });
  it("rejects an empty shop name and an unknown paper width", () => {
    expect(msg(settingsPatch.safeParse({ shopName: " " }))).toBe("দোকানের নাম লিখুন");
    expect(settingsPatch.safeParse({ paperWidth: "100" }).success).toBe(false);
  });
});

const KEY = "0b7f3c1e-1111-4222-8333-944455556666";
const goodSale = { barberId: 1, items: [{ serviceId: 2, qty: 1 }], paymentMethod: "CASH", idempotencyKey: KEY };

describe("saleInput (FR-8: no prices accepted from the client)", () => {
  it("accepts a valid sale", () => expect(saleInput.safeParse(goodSale).success).toBe(true));

  it("REJECTS a client-supplied price, total or share (strict)", () => {
    for (const extra of [{ price: 1 }, { total: 1 }, { barberShare: 99 }]) {
      expect(saleInput.safeParse({ ...goodSale, ...extra }).success).toBe(false);
    }
    expect(saleInput.safeParse({ ...goodSale, items: [{ serviceId: 2, qty: 1, price: 1 }] }).success).toBe(false);
  });

  it.each([0, 21, -1, 1.5, "2", null])("rejects quantity %j", (qty) => {
    expect(saleInput.safeParse({ ...goodSale, items: [{ serviceId: 2, qty }] }).success).toBe(false);
  });

  it("accepts quantity 1 and 20", () => {
    for (const qty of [1, 20]) {
      expect(saleInput.safeParse({ ...goodSale, items: [{ serviceId: 2, qty }] }).success).toBe(true);
    }
  });

  it("needs at least one line, at most 30, and no duplicate service", () => {
    expect(saleInput.safeParse({ ...goodSale, items: [] }).error?.issues[0].message).toBe("কোনো সার্ভিস বাছাই করা হয়নি");
    const many = Array.from({ length: 31 }, (_, i) => ({ serviceId: i + 1, qty: 1 }));
    expect(saleInput.safeParse({ ...goodSale, items: many }).success).toBe(false);
    const dup = [{ serviceId: 2, qty: 1 }, { serviceId: 2, qty: 3 }];
    expect(saleInput.safeParse({ ...goodSale, items: dup }).error?.issues[0].message).toBe("একই সার্ভিস দুইবার দেওয়া যাবে না");
  });

  it("only the four payment methods", () => {
    for (const m of ["CASH", "BKASH", "NAGAD", "OTHER"]) {
      expect(saleInput.safeParse({ ...goodSale, paymentMethod: m }).success).toBe(true);
    }
    for (const m of ["card", "cash", "", null]) {
      expect(saleInput.safeParse({ ...goodSale, paymentMethod: m }).success).toBe(false);
    }
  });

  it("idempotency key is 8–64 characters", () => {
    for (const k of ["short", "x".repeat(65), "", null]) {
      expect(saleInput.safeParse({ ...goodSale, idempotencyKey: k }).success).toBe(false);
    }
    expect(saleInput.safeParse({ ...goodSale, idempotencyKey: "abcd1234" }).success).toBe(true);
  });
});

describe("pastSaleInput (FR-22)", () => {
  const past = { ...goodSale, date: "2026-03-01", time: "14:30" };
  it("accepts a sale with a date and time", () => expect(pastSaleInput.safeParse(past).success).toBe(true));
  it("requires both date and time", () => {
    expect(pastSaleInput.safeParse(goodSale).success).toBe(false);
    expect(pastSaleInput.safeParse({ ...past, time: undefined }).success).toBe(false);
  });
  it("cannot smuggle enteredByAdmin or createdAt from the client", () => {
    expect(pastSaleInput.safeParse({ ...past, enteredByAdmin: true }).success).toBe(false);
    expect(pastSaleInput.safeParse({ ...past, createdAt: "2026-03-01T00:00:00Z" }).success).toBe(false);
  });
});

describe("void inputs", () => {
  it("barber void needs the sale, the barber and a reason (trimmed)", () => {
    expect(barberVoidInput.parse({ saleId: 3, barberId: 1, reason: "  ভুল  " })).toEqual({ saleId: 3, barberId: 1, reason: "ভুল" });
    expect(barberVoidInput.safeParse({ saleId: 3, barberId: 1, reason: "  " }).error?.issues[0].message).toBe("বাতিলের কারণ লিখুন");
    expect(barberVoidInput.safeParse({ saleId: 3, reason: "x" }).success).toBe(false);
  });
  it("admin void needs a reason and rejects a barberId", () => {
    expect(adminVoidInput.safeParse({ saleId: 3, reason: "ভুল" }).success).toBe(true);
    expect(adminVoidInput.safeParse({ saleId: 3, reason: "" }).success).toBe(false);
    expect(adminVoidInput.safeParse({ saleId: 3, reason: "x", barberId: 1 }).success).toBe(false);
  });
  it("reason is capped at 200 characters", () => {
    expect(adminVoidInput.safeParse({ saleId: 3, reason: "ক".repeat(201) }).success).toBe(false);
  });
});

describe("salesQuery", () => {
  it("accepts a range with optional filters", () => {
    expect(salesQuery.safeParse({ from: "2026-03-01", to: "2026-03-10" }).success).toBe(true);
    expect(salesQuery.safeParse({ from: "2026-03-01", to: "2026-03-10", barberId: 2, status: "void" }).success).toBe(true);
  });
  it("rejects bad dates, reversed ranges and ranges over a year", () => {
    expect(salesQuery.safeParse({ from: "2026-02-30", to: "2026-03-10" }).success).toBe(false);
    expect(salesQuery.safeParse({ from: "2026-03-10", to: "2026-03-01" }).success).toBe(false);
    expect(salesQuery.safeParse({ from: "2024-01-01", to: "2026-03-01" }).success).toBe(false);
    expect(salesQuery.safeParse({ from: "2026-03-01", to: "2026-03-10", status: "x" }).success).toBe(false);
  });
});

describe("idSchema", () => {
  it("accepts positive integers only", () => {
    expect(idSchema.safeParse(3).success).toBe(true);
    for (const v of [0, -1, 1.5, "1", NaN, null]) expect(idSchema.safeParse(v).success).toBe(false);
  });
});
