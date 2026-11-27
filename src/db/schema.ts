import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Mirrors docs/PRD.md §8. Money is whole taka (integer); timestamps are timestamptz.

const tz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const paymentMethod = pgEnum("payment_method", [
  "CASH",
  "BKASH",
  "NAGAD",
  "OTHER",
]);
export const voidedBy = pgEnum("voided_by", ["BARBER", "ADMIN"]);
export const appointmentStatus = pgEnum("appointment_status", [
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "DONE",
]);

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const services = pgTable(
  "services",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    name: text("name").notNull(),
    price: integer("price").notNull(), // whole taka
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    index("services_category_idx").on(t.categoryId),
    check("price_positive", sql`${t.price} > 0`),
  ],
);

export const barbers = pgTable(
  "barbers",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    commissionPct: integer("commission_pct").notNull().default(50),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    passwordHash: text("password_hash"), // bcrypt; null until admin sets one
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [check("pct_range", sql`${t.commissionPct} between 0 and 100`)],
);

export const sales = pgTable(
  "sales",
  {
    id: serial("id").primaryKey(), // also the receipt number
    idempotencyKey: text("idempotency_key").notNull(),
    barberId: integer("barber_id")
      .notNull()
      .references(() => barbers.id),
    total: integer("total").notNull(),
    barberShare: integer("barber_share").notNull(),
    ownerShare: integer("owner_share").notNull(),
    commissionPctSnapshot: integer("commission_pct_snapshot").notNull(),
    paymentMethod: paymentMethod("payment_method").notNull().default("CASH"),
    createdAt: tz("created_at").notNull().defaultNow(),
    voidedAt: tz("voided_at"),
    voidedBy: voidedBy("voided_by"),
    voidReason: text("void_reason"),
    enteredByAdmin: boolean("entered_by_admin").notNull().default(false), // FR-22 back-dated entry
  },
  (t) => [
    uniqueIndex("sales_idempotency_uq").on(t.idempotencyKey),
    index("sales_created_idx").on(t.createdAt),
    index("sales_barber_created_idx").on(t.barberId, t.createdAt),
    check("shares_sum", sql`${t.barberShare} + ${t.ownerShare} = ${t.total}`),
    check("total_positive", sql`${t.total} > 0`),
    check("shares_nonneg", sql`${t.barberShare} >= 0 and ${t.ownerShare} >= 0`),
    check("pct_snapshot_range", sql`${t.commissionPctSnapshot} between 0 and 100`),
    // voided_at and voided_by are set together; a reason only exists on a voided sale.
    check(
      "void_consistent",
      sql`(${t.voidedAt} is null) = (${t.voidedBy} is null) and (${t.voidedAt} is not null or ${t.voidReason} is null)`,
    ),
  ],
);

export const saleItems = pgTable(
  "sale_items",
  {
    id: serial("id").primaryKey(),
    saleId: integer("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id),
    nameSnapshot: text("name_snapshot").notNull(),
    priceSnapshot: integer("price_snapshot").notNull(),
    qty: integer("qty").notNull(),
  },
  (t) => [
    index("sale_items_sale_idx").on(t.saleId),
    index("sale_items_service_idx").on(t.serviceId),
    check("qty_range", sql`${t.qty} between 1 and 20`),
    check("price_snapshot_positive", sql`${t.priceSnapshot} > 0`),
  ],
);

export const payouts = pgTable(
  "payouts",
  {
    id: serial("id").primaryKey(),
    barberId: integer("barber_id")
      .notNull()
      .references(() => barbers.id),
    amount: integer("amount").notNull(),
    note: text("note").notNull().default(""),
    paidAt: tz("paid_at").notNull().defaultNow(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("payouts_barber_idx").on(t.barberId),
    check("amount_positive", sql`${t.amount} > 0`),
  ],
);

// shopName, shopAddress, shopPhone, receiptFooter, paperWidth,
// adminPinHash, shopCodeHash, shopCodeVersion
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: serial("id").primaryKey(),
    ip: text("ip").notNull(),
    kind: text("kind").notNull(), // "admin" | "shop" | "barber" | "appointment"
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [index("login_attempts_lookup_idx").on(t.ip, t.kind, t.createdAt)],
);

// A customer's online booking request from the public site. serviceName is a text snapshot (the
// public price list is static, not the services table above); barberNameSnapshot likewise, so a
// later rename or removal never changes what the shop already promised the customer.
export const appointments = pgTable(
  "appointments",
  {
    id: serial("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    serviceName: text("service_name").notNull(),
    barberId: integer("barber_id").references(() => barbers.id, { onDelete: "set null" }),
    barberNameSnapshot: text("barber_name_snapshot"), // null = no preference
    requestedAt: tz("requested_at").notNull(),
    note: text("note").notNull().default(""),
    status: appointmentStatus("status").notNull().default("PENDING"),
    createdAt: tz("created_at").notNull().defaultNow(),
    respondedAt: tz("responded_at"),
  },
  (t) => [
    uniqueIndex("appointments_idempotency_uq").on(t.idempotencyKey),
    index("appointments_requested_idx").on(t.requestedAt),
    index("appointments_status_idx").on(t.status),
    index("appointments_barber_idx").on(t.barberId),
  ],
);
