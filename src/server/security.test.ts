// Attacker-style tests. They call the real API actions and the backup read directly (no UI) with
// forged, stale, expired and missing cookies, against an in-memory Postgres (PGlite), never Neon.
// Only two seams are faked: the request context (cookie jar + request headers, which the HTTP layer
// fills in production) and "@/db" (pointed at PGlite). All auth, rate-limit and validation code is
// the production code. The frontend-side checks (page guards, CSP headers, bundle secrets) live in
// Client/src/frontend-security.test.ts.
//
// `it.fails(...)` marks a KNOWN, logged gap: the test states the secure behaviour, passes while the
// gap exists and turns red the day it is fixed (then change it to a normal `it`). See docs/BUGS.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: null as any,
  jar: new Map<string, string>(),
  lastSet: new Map<string, Record<string, unknown>>(),
  headers: {} as Record<string, string>,
}));

vi.mock("@/lib/request-context", () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      state.lastSet.set(name, opts);
      if (value === "") state.jar.delete(name);
      else state.jar.set(name, value);
    },
  }),
  headers: async () => new Headers(state.headers),
}));
vi.mock("@/db", async () => {
  const schema = await import("../db/schema");
  return {
    ...schema,
    get db() {
      return state.db;
    },
  };
});

import { readBackup, readBarber, readBarberLogin, readCatalog, readHome, readReceipt } from "../actions/reads";
import * as authActions from "../actions/auth";
import * as catalogActions from "../actions/catalog";
import * as payoutActions from "../actions/payouts";
import * as saleActions from "../actions/sales";
import {
  adminPinFingerprint,
  barberPasswordFingerprint,
  createAdminCookie,
  createBarberCookie,
  createShopCookie,
  SHOP_COOKIE_TTL_S,
  signCookie,
} from "@/lib/auth-core";
import { toCsv } from "@/lib/reports";
import { DEMO_BARBER_PASSWORD } from "@/lib/seed";
import { shiftDays, todayKey } from "@/lib/time";
import { MSG as ACTION_MSG } from "@/server/action";
import { barbers, categories, loginAttempts, payouts, saleItems, sales, services, settings } from "../db/schema";
import { seedDb } from "../db/seed-core";
import { createTestDb, type TestDb } from "./test-db";

const SECRET = "unit-test-secret-unit-test-secret-0123456789";
const PIN = "4321";
const CODE = "9876";
const NEED_LOGIN = "এডমিন হিসেবে আবার লগইন করুন";

let t: TestDb;
let ids: { barberA: number; barberB: number; cat: number; svc: number };
let keyN = 0;
const key = () => `sec-key-${++keyN}-xxxxxxxx`;

async function resetDb() {
  await t.db.delete(loginAttempts);
  await t.db.delete(payouts);
  await t.db.delete(sales);
  await t.db.delete(services);
  await t.db.delete(categories);
  await t.db.delete(barbers);
  await t.db.delete(settings);
  await seedDb(t.db, { pin: PIN, shopCode: CODE, bcryptCost: 4 });
  const bs = await t.db.select().from(barbers).orderBy(barbers.id);
  const [cat] = await t.db.select().from(categories).orderBy(categories.id);
  const [svc] = await t.db.select().from(services).orderBy(services.id);
  ids = { barberA: bs[0].id, barberB: bs[1].id, cat: cat.id, svc: svc.id };
}

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET;
  t = await createTestDb();
  state.db = t.db;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  state.jar.clear();
  state.lastSet.clear();
  state.headers = { "x-forwarded-for": "203.0.113.7" };
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------- cookie helpers ----------

async function adminHash() {
  const [r] = await t.db.select().from(settings).where(eq(settings.key, "adminPinHash"));
  return r.value;
}
async function validShop(version = 1) {
  return createShopCookie(version, SECRET).value;
}
async function validAdmin() {
  return createAdminCookie(adminPinFingerprint(await adminHash(), SECRET), SECRET).value;
}
async function barberHash(barberId: number) {
  const [r] = await t.db.select().from(barbers).where(eq(barbers.id, barberId));
  return r.passwordHash as string;
}
async function validBarber(barberId: number) {
  return createBarberCookie(barberId, barberPasswordFingerprint(await barberHash(barberId), SECRET), SECRET).value;
}
const setJar = (c: { shop?: string; admin?: string; barber?: string }) => {
  state.jar.clear();
  if (c.shop !== undefined) state.jar.set("salon_shop", c.shop);
  if (c.admin !== undefined) state.jar.set("salon_admin", c.admin);
  if (c.barber !== undefined) state.jar.set("salon_barber", c.barber);
};
/** Flip one character of the signature part. */
const flipSig = (v: string) => v.slice(0, -2) + (v.at(-2) === "A" ? "B" : "A") + v.at(-1);
/** Replace the payload (extend exp) but keep the original signature. */
const swapPayload = (v: string, patch: object) => {
  const [p, sig] = v.split(".");
  const body = { ...JSON.parse(Buffer.from(p, "base64url").toString()), ...patch };
  return `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${sig}`;
};

/** Every way an attacker can present an admin cookie that must NOT work. */
async function badAdminCookies(): Promise<[string, { shop?: string; admin?: string }][]> {
  const good = await validAdmin();
  const pv = adminPinFingerprint(await adminHash(), SECRET);
  const longAgo = Date.now() - 9 * 3600 * 1000;
  return [
    ["no cookies", {}],
    ["valid SHOP cookie only", { shop: await validShop() }],
    ["shop cookie placed in the admin slot", { admin: await validShop() }],
    ["expired admin cookie", { admin: createAdminCookie(pv, SECRET, longAgo).value }],
    ["admin payload tampered (exp extended), old signature", { admin: swapPayload(good, { exp: 4_000_000_000 }) }],
    ["admin payload tampered (other pv), old signature", { admin: swapPayload(good, { pv: "x".repeat(22) }) }],
    ["admin signature bit-flipped", { admin: flipSig(good) }],
    ["admin signed with a different secret", { admin: createAdminCookie(pv, "another-secret-another-secret-0123456789").value }],
    ["admin cookie with a wrong PIN fingerprint, correctly signed", { admin: createAdminCookie("wrong-fingerprint-0000000", SECRET).value }],
    ["admin cookie signed as kind 'shop'", { admin: signCookie("shop", { pv, exp: 4_000_000_000 }, SECRET) }],
    ["empty string", { admin: "" }],
    ["garbage", { admin: "not-a-cookie" }],
    ["JSON instead of a token", { admin: JSON.stringify({ pv, exp: 4_000_000_000 }) }],
    ["5000-char value", { admin: "A".repeat(5000) }],
    ["three parts", { admin: `${good}.extra` }],
  ];
}

const refused = (r: { ok: boolean; error?: string }) =>
  r.ok === false && (r.error === ACTION_MSG.unauthorized || r.error === NEED_LOGIN);

// ---------- valid inputs for every action (so a refusal is about auth, not bad input) ----------

type AnyResult = { ok: boolean; error?: string };
interface ActionCase {
  name: string;
  call: () => Promise<AnyResult>;
}
const saleFields = () => ({ barberId: ids.barberA, items: [{ serviceId: ids.svc, qty: 1 }], paymentMethod: "CASH" as const, idempotencyKey: key() });

async function mkPayout() {
  const [p] = await t.db.insert(payouts).values({ barberId: ids.barberA, amount: 10 }).returning();
  return p.id;
}
async function mkSale() {
  const [s] = await t.db
    .insert(sales)
    .values({ idempotencyKey: key(), barberId: ids.barberA, total: 100, barberShare: 50, ownerShare: 50, commissionPctSnapshot: 50 })
    .returning();
  await t.db.insert(saleItems).values({ saleId: s.id, serviceId: ids.svc, nameSnapshot: "x", priceSnapshot: 100, qty: 1 });
  return s.id;
}

/** Admin-only actions. Built lazily because ids and helper rows are created per test. */
const adminCases = (): ActionCase[] => [
  { name: "addBarber", call: () => catalogActions.addBarber({ name: "New", commissionPct: 40, password: "barber123" }) },
  { name: "updateBarber", call: () => catalogActions.updateBarber(ids.barberA, { name: "Renamed" }) },
  { name: "addCategory", call: () => catalogActions.addCategory({ name: "NewCat" }) },
  { name: "updateCategory", call: () => catalogActions.updateCategory(ids.cat, { name: "Renamed" }) },
  { name: "addService", call: () => catalogActions.addService({ categoryId: ids.cat, name: "NewSvc", price: 100 }) },
  { name: "updateService", call: () => catalogActions.updateService(ids.svc, { price: 321 }) },
  { name: "updateSettings", call: () => catalogActions.updateSettings({ shopName: "Hijacked" }) },
  { name: "listSales", call: () => saleActions.listSales({ from: "2026-01-01", to: "2026-12-31" }) },
  { name: "adminVoidSale", call: async () => saleActions.adminVoidSale({ saleId: await mkSale(), reason: "r" }) },
  {
    name: "addPastSale",
    call: () => saleActions.addPastSale({ ...saleFields(), date: shiftDays(todayKey(), -1), time: "10:00" }),
  },
  { name: "getPayoutsView", call: () => payoutActions.getPayoutsView() },
  { name: "addPayout", call: () => payoutActions.addPayout({ barberId: ids.barberA, amount: 100, date: todayKey(), note: "" }) },
  { name: "deletePayout", call: async () => payoutActions.deletePayout({ id: await mkPayout() }) },
  { name: "changeAdminPin", call: () => authActions.changeAdminPin({ current: PIN, next: "5555" }) },
  { name: "changeShopCode", call: () => authActions.changeShopCode({ next: "7777" }) },
];
const shopCases = (): ActionCase[] => [
  { name: "createSale", call: () => saleActions.createSale(saleFields()) },
  { name: "voidMySale", call: async () => saleActions.voidMySale({ saleId: await mkSale(), barberId: ids.barberA, reason: "oops" }) },
];

/** A snapshot of everything an attacker could change, to prove a refused call changed nothing. */
async function dbFingerprint() {
  return JSON.stringify({
    barbers: await t.db.select().from(barbers).orderBy(barbers.id),
    categories: await t.db.select().from(categories).orderBy(categories.id),
    services: await t.db.select().from(services).orderBy(services.id),
    settings: await t.db.select().from(settings).orderBy(settings.key),
    sales: await t.db.select().from(sales).orderBy(sales.id),
    payouts: await t.db.select().from(payouts).orderBy(payouts.id),
  });
}

// =====================================================================================
// 1. Every admin action refuses bad cookies; every barber action needs at least a shop cookie
// =====================================================================================

describe("1. admin actions refuse every forged, stale or missing cookie", () => {
  it("each of the admin-only actions x each bad cookie is refused and changes nothing", async () => {
    const before = JSON.parse(await dbFingerprint());
    const failures: string[] = [];
    for (const [label, jar] of await badAdminCookies()) {
      for (const c of adminCases()) {
        setJar(jar);
        const r = await c.call();
        if (!refused(r)) failures.push(`${c.name} with [${label}] -> ${JSON.stringify(r).slice(0, 80)}`);
      }
    }
    expect(failures).toEqual([]);
    // Helper rows (mkSale / mkPayout) are created by the test itself, so compare only what an
    // action could have changed: the catalog, the settings, and any void or admin-entered sale.
    const after = JSON.parse(await dbFingerprint());
    expect(after.barbers).toEqual(before.barbers);
    expect(after.categories).toEqual(before.categories);
    expect(after.services).toEqual(before.services);
    expect(after.settings).toEqual(before.settings);
    expect(after.sales.filter((s: { enteredByAdmin: boolean; voidedAt: unknown }) => s.enteredByAdmin || s.voidedAt)).toEqual([]);
  });

  it("positive control: the same calls succeed with a genuine admin cookie (so the refusals above mean something)", async () => {
    setJar({ admin: await validAdmin(), shop: await validShop() });
    for (const c of adminCases()) {
      if (c.name === "changeAdminPin" || c.name === "changeShopCode") continue; // run last, they rotate credentials
      const r = await c.call();
      expect(r, c.name).toMatchObject({ ok: true });
    }
    expect(await authActions.changeAdminPin({ current: PIN, next: "5555" })).toEqual({ ok: true });
    setJar({ admin: await validAdmin() });
    expect(await authActions.changeShopCode({ next: "7777" })).toEqual({ ok: true });
  });

  it("the backup read: unauthorized for no cookie, shop cookie, tampered or expired admin cookie", async () => {
    for (const [label, jar] of await badAdminCookies()) {
      setJar(jar);
      expect(await readBackup(), label).toEqual({ status: "unauthorized" });
    }
  });

  it("the backup read with a real admin cookie: a dated filename, and NO secrets inside", async () => {
    setJar({ admin: await validAdmin() });
    const res = await readBackup();
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.data.filename).toMatch(/^salon-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const body = res.data.json;
    expect(body).not.toMatch(/adminPinHash|shopCodeHash|shopCodeVersion/);
    expect(body).not.toMatch(/\$2[aby]\$\d\d\$/); // no bcrypt hash anywhere
    expect(body).not.toContain(await adminHash());
    expect(body).not.toContain(SECRET);
  });

  it("changing a barber's password invalidates their existing session cookie", async () => {
    const oldCookie = await validBarber(ids.barberA);
    setJar({ admin: await validAdmin() });
    expect(await catalogActions.updateBarber(ids.barberA, { password: "newpass123" })).toMatchObject({ ok: true });
    setJar({ shop: await validShop(), barber: oldCookie });
    expect(refused(await saleActions.createSale(saleFields()))).toBe(true);
  });

  it("barberLogin: wrong password, inactive barber, and no-password-set are all refused; correct password succeeds", async () => {
    setJar({ shop: await validShop() });
    expect(await authActions.barberLogin({ barberId: ids.barberA, password: "totally-wrong-1" })).toMatchObject({ ok: false });

    setJar({ admin: await validAdmin() });
    const [{ name: newName }] = await t.db.insert(barbers).values({ name: "No Password Yet", commissionPct: 50 }).returning({ name: barbers.name });
    const [noPwBarber] = await t.db.select().from(barbers).where(eq(barbers.name, newName));
    setJar({ shop: await validShop() });
    expect(await authActions.barberLogin({ barberId: noPwBarber.id, password: "anything123" })).toMatchObject({ ok: false });

    setJar({ admin: await validAdmin() });
    await catalogActions.updateBarber(ids.barberB, { active: false });
    setJar({ shop: await validShop() });
    expect(await authActions.barberLogin({ barberId: ids.barberB, password: DEMO_BARBER_PASSWORD })).toMatchObject({ ok: false });

    expect(await authActions.barberLogin({ barberId: ids.barberA, password: DEMO_BARBER_PASSWORD })).toMatchObject({ ok: true });
  });
});

// =====================================================================================
// 6. XSS sinks, CSV injection
// =====================================================================================

describe("shop-code lock: staff data needs an unlocked device", () => {
  const unlock = { status: "redirect", to: "/unlock" };

  it("a visitor with no or a forged shop cookie gets no names, earnings, catalog or receipts", async () => {
    const saleId = await mkSale();
    for (const shop of [undefined, "garbage", flipSig(await validShop())]) {
      setJar({ shop, barber: await validBarber(ids.barberA) });
      expect(await readCatalog()).toBeNull();
      expect(await readHome()).toEqual(unlock);
      expect(await readBarber(ids.barberA)).toEqual(unlock);
      expect(await readBarberLogin(ids.barberA)).toEqual(unlock);
      expect(await readReceipt(saleId)).toEqual(unlock);
      expect((await authActions.barberLogin({ barberId: ids.barberA, password: DEMO_BARBER_PASSWORD })).ok).toBe(false);
    }
  });

  it("an unlocked device reads them; a cookie from before a shop-code change does not", async () => {
    setJar({ shop: await validShop() });
    expect(await readCatalog()).not.toBeNull();
    expect((await readHome()).status).toBe("ok");
    expect((await readBarberLogin(ids.barberA)).status).toBe("ok");
    setJar({ shop: await validShop(99) });
    expect(await readCatalog()).toBeNull();
    expect(await readHome()).toEqual(unlock);
  });
});

describe("6. output safety", () => {
  it("no source file uses an HTML-injection sink (dangerouslySetInnerHTML, innerHTML, document.write, eval)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f)) {
          const src = readFileSync(p, "utf8");
          if (/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(src)) hits.push(path.relative(process.cwd(), p));
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });

  it("CSV export neutralises cells that start with = + - @ (formula injection)", () => {
    const evil = ['=HYPERLINK("http://evil.example","click")', "+1+1", "-2+3", "@SUM(1+1)", "\t=1+1", "\r=1+1"];
    const csv = toCsv(["name"], evil.map((e) => [e]));
    expect(csv).not.toMatch(/(^|\r\n)"?[=+\-@\t\r]/m);
  });

  it("CSV: numbers (including negative balances) and Bangla text pass through, quotes and newlines are escaped", () => {
    const csv = toCsv(["a", "b", "c"], [["চুল কাটা", -150, 'he said "hi", ok\nnext']]);
    expect(csv).toContain("চুল কাটা,-150,");
    expect(csv).toContain('"he said ""hi"", ok\nnext"');
    expect(csv.startsWith("﻿")).toBe(true);
  });
});
