// zod schemas for every Server Action input (CLAUDE.md: validate all input with zod).
// Messages are Bangla because they are shown to the user as-is. Objects are strict: unknown keys
// (id, createdAt, secret setting names, ...) are rejected instead of silently ignored.

import { z } from "zod";

const M = {
  barberName: "নাম লিখুন",
  barberPassword: "পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে এবং অক্ষর ও সংখ্যা দুটোই থাকতে হবে",
  pct: "কমিশন ০ থেকে ১০০-এর মধ্যে হতে হবে",
  categoryName: "ক্যাটাগরির নাম লিখুন",
  serviceName: "সার্ভিসের নাম লিখুন",
  price: "দাম ০-এর বেশি পূর্ণসংখ্যা হতে হবে",
  shopName: "দোকানের নাম লিখুন",
  id: "ভুল তথ্য পাঠানো হয়েছে",
  tooLong: "লেখাটি অনেক বড়",
} as const;

export const MAX_PRICE = 1_000_000;

export const idSchema = z.number({ error: M.id }).int(M.id).positive(M.id);

const sortOrder = z.number({ error: M.id }).int(M.id).min(0, M.id).max(10_000, M.id);

const requiredName = (msg: string, max = 60) =>
  z.string({ error: msg }).trim().min(1, msg).max(max, M.tooLong);

const commissionPct = z.number({ error: M.pct }).int(M.pct).min(0, M.pct).max(100, M.pct);
const price = z.number({ error: M.price }).int(M.price).positive(M.price).max(MAX_PRICE, M.price);

// ---------- barbers ----------
// Letters + digits, 6-72 chars (72 is bcrypt's effective max input length).
const barberPassword = z
  .string({ error: M.barberPassword })
  .trim()
  .regex(/^(?=.*[A-Za-z])(?=.*\d).{6,72}$/, M.barberPassword);

export const barberInput = z.strictObject({
  name: requiredName(M.barberName),
  commissionPct,
  password: barberPassword,
});
export const barberPatch = z
  .strictObject({
    name: requiredName(M.barberName),
    commissionPct,
    sortOrder,
    active: z.boolean({ error: M.id }),
    password: barberPassword,
  })
  .partial();

// Login only checks whatever password is already stored - never re-enforce the strength rule here.
export const barberLoginInput = z.strictObject({
  barberId: idSchema,
  password: z.string({ error: M.id }).trim().min(1, M.id).max(72, M.tooLong),
});

// ---------- categories ----------
export const categoryInput = z.strictObject({ name: requiredName(M.categoryName) });
export const categoryPatch = z
  .strictObject({
    name: requiredName(M.categoryName),
    sortOrder,
    active: z.boolean({ error: M.id }),
  })
  .partial();

// ---------- services ----------
export const serviceInput = z.strictObject({
  categoryId: idSchema,
  name: requiredName(M.serviceName, 80),
  price,
});
export const servicePatch = z
  .strictObject({
    categoryId: idSchema,
    name: requiredName(M.serviceName, 80),
    price,
    sortOrder,
    active: z.boolean({ error: M.id }),
  })
  .partial();

// ---------- settings (public ones only; PIN / shop-code hashes go through the auth actions) ----------
export const settingsPatch = z
  .strictObject({
    shopName: requiredName(M.shopName, 80),
    shopAddress: z.string({ error: M.id }).trim().max(200, M.tooLong),
    shopPhone: z.string({ error: M.id }).trim().max(40, M.tooLong),
    receiptFooter: z.string({ error: M.id }).trim().max(200, M.tooLong),
    paperWidth: z.enum(["58", "80", "A4"], { error: M.id }),
  })
  .partial();

// ---------- sales ----------
const SALE_MSG = {
  noItems: "কোনো সার্ভিস বাছাই করা হয়নি",
  dupItem: "একই সার্ভিস দুইবার দেওয়া যাবে না",
  reason: "বাতিলের কারণ লিখুন",
  badDate: "তারিখ সঠিক নয়",
  badRange: "তারিখের সীমা সঠিক নয়",
} as const;

// FR-8: the client sends only WHICH services and how many. Prices, totals and shares are strict-
// rejected here and always recomputed on the server from the stored catalog.
const saleLine = z.strictObject({
  serviceId: idSchema,
  qty: z.number({ error: M.id }).int(M.id).min(1, M.id).max(20, M.id),
});

const saleBase = z.strictObject({
  barberId: idSchema,
  items: z.array(saleLine, { error: SALE_MSG.noItems }).min(1, SALE_MSG.noItems).max(30, M.id),
  paymentMethod: z.enum(["CASH", "BKASH", "NAGAD", "OTHER"], { error: M.id }),
  idempotencyKey: z.string({ error: M.id }).trim().min(8, M.id).max(64, M.id),
});

const noDuplicateServices = (v: { items: { serviceId: number }[] }) =>
  new Set(v.items.map((i) => i.serviceId)).size === v.items.length;

export const saleInput = saleBase.refine(noDuplicateServices, { message: SALE_MSG.dupItem, path: ["items"] });

// FR-22: the admin picks a Dhaka date and time. enteredByAdmin and the timestamp are set by the
// server (never accepted from the client); the date limits are enforced by resolveBackdate.
export const pastSaleInput = saleBase
  .extend({
    date: z.string({ error: M.id }).regex(/^\d{4}-\d{2}-\d{2}$/, SALE_MSG.badDate),
    time: z.string({ error: M.id }).regex(/^\d{2}:\d{2}$/, SALE_MSG.badDate),
  })
  .refine(noDuplicateServices, { message: SALE_MSG.dupItem, path: ["items"] });

const voidReason = z.string({ error: SALE_MSG.reason }).trim().min(1, SALE_MSG.reason).max(200, M.tooLong);

export const barberVoidInput = z.strictObject({ saleId: idSchema, barberId: idSchema, reason: voidReason });
export const adminVoidInput = z.strictObject({ saleId: idSchema, reason: voidReason });

const dateKey = z
  .string({ error: SALE_MSG.badDate })
  .regex(/^\d{4}-\d{2}-\d{2}$/, SALE_MSG.badDate)
  .refine((k) => !Number.isNaN(Date.parse(`${k}T00:00:00Z`)) && new Date(`${k}T00:00:00Z`).toISOString().startsWith(k), SALE_MSG.badDate);

// ---------- payouts (FR-18, BR-7) ----------

const PAYOUT_MSG = {
  amount: "টাকার পরিমাণ সঠিক নয়",
} as const;

export const payoutInput = z.strictObject({
  barberId: idSchema,
  amount: z
    .number({ error: PAYOUT_MSG.amount })
    .int(PAYOUT_MSG.amount)
    .min(1, PAYOUT_MSG.amount)
    .max(10_000_000, "টাকার পরিমাণ অনেক বেশি"),
  date: dateKey,
  note: z.string({ error: M.id }).trim().max(200, M.tooLong).default(""),
});
export const payoutDeleteInput = z.strictObject({ id: idSchema });

export type PayoutInput = z.infer<typeof payoutInput>;

export const salesQuery = z
  .strictObject({
    from: dateKey,
    to: dateKey,
    barberId: idSchema.optional(),
    status: z.enum(["all", "live", "void"], { error: M.id }).optional(),
  })
  .refine((q) => q.from <= q.to && Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`) <= 366 * 86_400_000, {
    message: SALE_MSG.badRange,
    path: ["to"],
  });

export type SaleInput = z.infer<typeof saleInput>;
export type PastSaleInput = z.infer<typeof pastSaleInput>;
export type SalesQuery = z.infer<typeof salesQuery>;
export type BarberInput = z.infer<typeof barberInput>;
export type BarberPatch = z.infer<typeof barberPatch>;
export type CategoryInput = z.infer<typeof categoryInput>;
export type CategoryPatch = z.infer<typeof categoryPatch>;
export type ServiceInput = z.infer<typeof serviceInput>;
export type ServicePatch = z.infer<typeof servicePatch>;
export type SettingsPatch = z.infer<typeof settingsPatch>;
