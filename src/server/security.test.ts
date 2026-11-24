// Attacker-style tests. They call the real Server Actions and the backup route handler directly (no
// UI) with forged, stale, expired and missing cookies, against an in-memory Postgres (PGlite), never
// Neon. Only three framework seams are faked: next/headers (cookie jar + request headers),
// next/cache (revalidatePath) and "@/db" (pointed at PGlite). All auth, rate-limit and validation
// code is the production code.
//
// `it.fails(...)` marks a KNOWN, logged gap: the test states the secure behaviour, passes while the
// gap exists and turns red the day it is fixed (then change it to a normal `it`). See docs/BUGS.md.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: null as any,
  jar: new Map<string, string>(),
  lastSet: new Map<string, Record<string, unknown>>(),
  headers: {} as Record<string, string>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
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

import { GET as backupGET } from "../../../Client/src/app/admin/backup/route";
import * as authActions from "../../../Client/src/app/actions/auth";
import * as catalogActions from "../../../Client/src/app/actions/catalog";
import * as payoutActions from "../../../Client/src/app/actions/payouts";
import * as saleActions from "../../../Client/src/app/actions/sales";
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

  it("the backup route: 401 for no cookie, shop cookie, tampered or expired admin cookie", async () => {
    for (const [label, jar] of await badAdminCookies()) {
      setJar(jar);
      const res = await backupGET();
      expect(res.status, label).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("Unauthorized");
    }
  });

  it("the backup route with a real admin cookie: 200, attachment, no-store, and NO secrets inside", async () => {
    setJar({ admin: await validAdmin() });
    const res = await backupGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="salon-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).not.toMatch(/adminPinHash|shopCodeHash|shopCodeVersion/);
    expect(body).not.toMatch(/\$2[aby]\$\d\d\$/); // no bcrypt hash anywhere
    expect(body).not.toContain(await adminHash());
    expect(body).not.toContain(SECRET);
  });
});

describe("1b. barber actions need a valid shop (or admin) cookie", () => {
  it("refused with no cookie, a tampered/expired/forged shop cookie, or a stale-version cookie", async () => {
    const good = await validShop();
    const bad: [string, { shop?: string; admin?: string }][] = [
      ["no cookies", {}],
      ["expired shop cookie", { shop: createShopCookie(1, SECRET, Date.now() - (SHOP_COOKIE_TTL_S + 60) * 1000).value }],
      ["payload tampered (version 99)", { shop: swapPayload(good, { v: 99 }) }],
      ["signature flipped", { shop: flipSig(good) }],
      ["wrong secret", { shop: createShopCookie(1, "another-secret-another-secret-0123456789").value }],
      ["admin-kind cookie in the shop slot", { shop: await validAdmin() }],
      ["shop cookie for a future version", { shop: await validShop(2) }],
      ["garbage", { shop: "x.y" }],
    ];
    for (const [label, jar] of bad) {
      for (const c of shopCases()) {
        setJar(jar);
        const r = await c.call();
        expect(r.ok, `${c.name} [${label}]`).toBe(false);
        expect(r.error, `${c.name} [${label}]`).toBe(ACTION_MSG.unauthorized);
      }
    }
    expect((await t.db.select().from(sales)).filter((s) => s.voidedAt)).toEqual([]);
  });

  it("a shop cookie ALONE is no longer enough for createSale/voidMySale - that barber's own password session is required too (closes BUGS.md S-002)", async () => {
    setJar({ shop: await validShop() });
    for (const c of shopCases()) expect(refused(await c.call()), c.name).toBe(true);
  });

  it("positive control: shop cookie + that barber's own session works for createSale and voidMySale; an admin cookie also works", async () => {
    setJar({ shop: await validShop(), barber: await validBarber(ids.barberA) });
    for (const c of shopCases()) expect(await c.call(), c.name).toMatchObject({ ok: true });
    setJar({ admin: await validAdmin() });
    expect(await saleActions.createSale(saleFields())).toMatchObject({ ok: true });
  });

  it("a shop-cookie device is NOT an admin: every admin action refuses it (device != owner)", async () => {
    setJar({ shop: await validShop() });
    for (const c of adminCases()) expect(refused(await c.call()), c.name).toBe(true);
  });
});

// =====================================================================================
// 2. Cookie replay / revocation
// =====================================================================================

describe("2. replay and revocation", () => {
  it("after the shop code changes, the old shop cookie is dead (shopCodeVersion)", async () => {
    const oldShop = await validShop(1);
    const barberCookie = await validBarber(ids.barberA);
    setJar({ shop: oldShop, barber: barberCookie });
    expect(await saleActions.createSale(saleFields())).toMatchObject({ ok: true });

    setJar({ admin: await validAdmin() });
    expect(await authActions.changeShopCode({ next: "7777" })).toEqual({ ok: true });

    // another device still holds the old shop cookie AND a still-cryptographically-valid barber
    // cookie - the shop revocation must win over both.
    setJar({ shop: oldShop, barber: barberCookie });
    const r = await saleActions.createSale(saleFields());
    expect(r).toMatchObject({ ok: false, error: ACTION_MSG.unauthorized });
    expect(await authActions.checkShopSession()).toEqual({ valid: false });
    expect(state.jar.has("salon_shop")).toBe(false); // and the stale cookie is cleared
  });

  it("the new shop code works and the old code no longer unlocks", async () => {
    setJar({ admin: await validAdmin() });
    await authActions.changeShopCode({ next: "7777" });
    setJar({});
    expect(await authActions.unlockShop({ code: CODE })).toMatchObject({ ok: false });
    expect(await authActions.unlockShop({ code: "7777" })).toEqual({ ok: true });
  });

  it("after the admin PIN changes, an admin cookie from before is dead", async () => {
    const stolen = await validAdmin();
    setJar({ admin: stolen });
    expect(await authActions.changeAdminPin({ current: PIN, next: "5555" })).toEqual({ ok: true });
    setJar({ admin: stolen });
    expect(refused(await catalogActions.addBarber({ name: "X", commissionPct: 50 }))).toBe(true);
    expect(refused(await authActions.changeShopCode({ next: "8888" }))).toBe(true);
  });

  it("changeAdminPin needs the CURRENT pin, even with a valid admin cookie", async () => {
    setJar({ admin: await validAdmin() });
    const r = await authActions.changeAdminPin({ current: "0001", next: "5555" });
    expect(r).toEqual({ ok: false, error: "বর্তমান পিন ভুল" });
    expect(await authActions.loginAdmin({ pin: PIN })).toEqual({ ok: true }); // unchanged
  });

  // KNOWN GAP (logged in docs/BUGS.md): sessions are stateless HMAC cookies.
  it.fails("an admin cookie copied before logout must stop working after logout", async () => {
    const copied = await validAdmin();
    setJar({ admin: copied });
    await authActions.logoutAdmin();
    expect(state.jar.has("salon_admin")).toBe(false); // the browser's copy is cleared...
    setJar({ admin: copied }); // ...but an attacker replays the copy they took earlier
    expect(refused(await catalogActions.addBarber({ name: "Replay", commissionPct: 50 }))).toBe(true);
  });

  it("login sets hardened cookies in production: __Host- prefix, httpOnly, secure, SameSite=Lax, path /", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    state.headers = { "x-real-ip": "203.0.113.50" };
    expect(await authActions.loginAdmin({ pin: PIN })).toEqual({ ok: true });
    for (const [name, maxAge] of [["__Host-salon_admin", 8 * 3600], ["__Host-salon_shop", SHOP_COOKIE_TTL_S]] as const) {
      expect(state.lastSet.get(name), name).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge });
      expect(state.lastSet.get(name)).not.toHaveProperty("domain"); // __Host- forbids Domain
    }
  });

  it("a logout clears with matching attributes (so a __Host- cookie really disappears in production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await authActions.logoutAdmin();
    expect(state.lastSet.get("__Host-salon_admin")).toMatchObject({ secure: true, httpOnly: true, path: "/", maxAge: 0 });
  });
});

// =====================================================================================
// 3. Rate limit
// =====================================================================================

describe("3. login rate limit", () => {
  const attempts = () => t.db.select().from(loginAttempts);

  it("6 wrong admin PINs -> the 6th is blocked, and then even the CORRECT pin is blocked", async () => {
    const out: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await authActions.loginAdmin({ pin: "0000" });
      out.push(r.ok ? "ok" : r.error);
    }
    expect(out.slice(0, 5).every((e) => e === "পিন ভুল হয়েছে")).toBe(true);
    expect(out[5]).toContain("অনেকবার ভুল হয়েছে");
    expect(await authActions.loginAdmin({ pin: PIN })).toMatchObject({ ok: false, error: expect.stringContaining("অনেকবার") });
    expect(state.jar.has("salon_admin")).toBe(false);
  });

  it("a block does not extend itself: blocked tries are not recorded", async () => {
    for (let i = 0; i < 12; i++) await authActions.loginAdmin({ pin: "0000" });
    expect((await attempts()).length).toBe(5);
  });

  it("6 wrong SHOP codes are blocked too; the two kinds have separate budgets", async () => {
    for (let i = 0; i < 6; i++) await authActions.unlockShop({ code: "0000" });
    expect(await authActions.unlockShop({ code: CODE })).toMatchObject({ ok: false, error: expect.stringContaining("অনেকবার") });
    expect(await authActions.loginAdmin({ pin: PIN })).toEqual({ ok: true }); // admin budget untouched
  });

  it("changeAdminPin shares the limiter: guessing the current PIN from a stolen session is limited", async () => {
    setJar({ admin: await validAdmin() });
    for (let i = 0; i < 6; i++) await authActions.changeAdminPin({ current: "0000", next: "5555" });
    setJar({ admin: await validAdmin() });
    expect(await authActions.changeAdminPin({ current: PIN, next: "5555" })).toMatchObject({ ok: false, error: expect.stringContaining("অনেকবার") });
  });

  it("production WITHOUT TRUST_PROXY_HEADERS: changing X-Forwarded-For / X-Real-IP cannot bypass it (fails closed)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const results: AnyResult[] = [];
    for (let i = 0; i < 12; i++) {
      state.headers = i % 2 ? { "x-forwarded-for": `198.51.100.${i}` } : { "x-real-ip": `198.51.100.${i}`, "x-forwarded-for": `192.0.2.${i}` };
      results.push(await authActions.loginAdmin({ pin: i === 11 ? PIN : "0000" })); // last one is the CORRECT pin
    }
    spy.mockRestore();
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(state.jar.size).toBe(0); // no cookie issued, not even for the correct PIN
    expect((await attempts()).length).toBe(0); // nothing was keyed by a spoofable header
  });

  it("production WITHOUT a trusted proxy also refuses the shop-code unlock (no shared bucket either)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await authActions.unlockShop({ code: CODE })).toMatchObject({ ok: false });
    spy.mockRestore();
  });

  it("behind a trusted proxy that sets X-Real-IP, a spoofed X-Forwarded-For does not give fresh attempts", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    const out: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      state.headers = { "x-real-ip": "203.0.113.77", "x-forwarded-for": `198.51.100.${i}` };
      out.push(((await authActions.loginAdmin({ pin: "0000" })) as AnyResult).error?.includes("অনেকবার") ?? false);
    }
    expect(out).toEqual([false, false, false, false, false, true, true, true]);
  });

  it("garbage or malformed client-IP headers are not accepted as a key (production, trusted proxy)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of ["", "not-an-ip", "999.1.1.1", "1.2.3.4.5", "' OR 1=1 --", "a".repeat(500)]) {
      state.headers = { "x-real-ip": bad };
      expect(await authActions.loginAdmin({ pin: "0000" }), bad).toMatchObject({ ok: false });
    }
    spy.mockRestore();
    expect((await attempts()).length).toBe(0);
  });

  it("IPv6: rotating inside one /64 shares one bucket; IPv4-mapped IPv6 equals the IPv4 address", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    const outcomes: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      state.headers = { "x-forwarded-for": `2001:db8:1:2:${i}::${i + 1}` };
      outcomes.push(((await authActions.loginAdmin({ pin: "0000" })) as AnyResult).error?.includes("অনেকবার") ?? false);
    }
    expect(outcomes.slice(5)).toEqual([true, true]);
    await t.db.delete(loginAttempts);
    state.headers = { "x-forwarded-for": "::ffff:198.51.100.9" };
    await authActions.loginAdmin({ pin: "0000" });
    expect((await attempts())[0].ip).toBe("198.51.100.9");
  });

  // Documents a design trade-off (logged in docs/BUGS.md): the cap is across ALL IPs per kind.
  it("global cap: after 50 attempts spread over many IPs, a fresh IP is blocked even with the right PIN", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    for (let i = 0; i < 50; i++) {
      state.headers = { "x-forwarded-for": `198.51.100.${i + 1}` };
      await authActions.loginAdmin({ pin: "0000" });
    }
    state.headers = { "x-forwarded-for": "203.0.113.200" };
    expect(await authActions.loginAdmin({ pin: PIN })).toMatchObject({ ok: false, error: expect.stringContaining("অনেকবার") });
  });
});

// =====================================================================================
// 4. Hostile input
// =====================================================================================

describe("4. hostile input", () => {
  beforeEach(async () => {
    setJar({ admin: await validAdmin(), shop: await validShop() });
  });
  const salesCount = async () => (await t.db.select().from(sales)).length;
  const base = () => saleFields();

  it.each([
    ["qty negative", { qty: -1 }],
    ["qty zero", { qty: 0 }],
    ["qty decimal", { qty: 1.5 }],
    ["qty 21", { qty: 21 }],
    ["qty huge", { qty: 1e9 }],
    ["qty as a string", { qty: "2" }],
    ["qty NaN", { qty: NaN }],
    ["qty Infinity", { qty: Infinity }],
    ["qty null", { qty: null }],
    ["serviceId negative", { serviceId: -1 }],
    ["serviceId decimal", { serviceId: 1.5 }],
    ["serviceId beyond int4", { serviceId: 2 ** 31 }],
    ["serviceId beyond 2^53", { serviceId: 2 ** 60 }],
    ["serviceId as string", { serviceId: "1" }],
    ["serviceId that does not exist", { serviceId: 987654 }],
    ["a client-sent price", { price: 1 }],
    ["a client-sent total", { total: 1 }],
    ["__proto__ key", JSON.parse('{"__proto__":{"admin":true}}')],
  ])("createSale rejects a cart line with %s", async (_n, patch) => {
    const input = base();
    input.items = [{ ...input.items[0], ...(patch as object) }];
    const r = await saleActions.createSale(input);
    expect(r.ok).toBe(false);
    expect(await salesCount()).toBe(0);
  });

  it.each([
    ["extra top-level key total", { total: 1 }],
    ["extra key enteredByAdmin", { enteredByAdmin: true }],
    ["extra key createdAt", { createdAt: "2020-01-01T00:00:00Z" }],
    ["extra key barberShare", { barberShare: 150 }],
    ["barberId negative", { barberId: -3 }],
    ["barberId beyond int4", { barberId: 2 ** 40 }],
    ["payment method not in the enum", { paymentMethod: "CRYPTO" }],
    ["idempotency key 7 chars", { idempotencyKey: "short77" }],
    ["idempotency key 65 chars", { idempotencyKey: "k".repeat(65) }],
    ["31 cart lines", { items: Array.from({ length: 31 }, (_, i) => ({ serviceId: i + 1, qty: 1 })) }],
    ["empty cart", { items: [] }],
    ["the same service twice", { items: [{ serviceId: 1, qty: 1 }, { serviceId: 1, qty: 2 }] }],
    ["items is not an array", { items: { serviceId: 1, qty: 1 } }],
  ])("createSale rejects %s", async (_n, patch) => {
    const r = await saleActions.createSale({ ...base(), ...(patch as object) });
    expect(r.ok).toBe(false);
    expect(await salesCount()).toBe(0);
  });

  it("createSale with input that is not an object at all: null, array, string, number, undefined", async () => {
    for (const bad of [null, [], "x", 5, undefined, true]) expect((await saleActions.createSale(bad)).ok).toBe(false);
    expect(await salesCount()).toBe(0);
  });

  it("an SQL-looking idempotency key is stored as plain text and nothing breaks", async () => {
    const evil = "'); DROP TABLE sales; --";
    const r = await saleActions.createSale({ ...base(), idempotencyKey: evil });
    expect(r).toMatchObject({ ok: true });
    const rows = await t.db.select().from(sales);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(evil);
  });

  it("the server, not the client, sets the price: the stored service price is what is charged", async () => {
    const r = await saleActions.createSale(base());
    const [svc] = await t.db.select().from(services).where(eq(services.id, ids.svc));
    expect(r.ok && r.data.total).toBe(svc.price);
  });

  it.each([
    ["negative", -1],
    ["above 100", 101],
    ["decimal", 50.5],
    ["huge", 1e12],
    ["string", "50"],
    ["NaN", NaN],
    ["null", null],
  ])("addBarber rejects commissionPct %s", async (_n, commissionPct) => {
    const before = (await t.db.select().from(barbers)).length;
    expect((await catalogActions.addBarber({ name: "Ok", commissionPct, password: "barber123" })).ok).toBe(false);
    expect((await t.db.select().from(barbers)).length).toBe(before);
  });

  it("names: 60 chars is fine, 61 / 10,000 / whitespace-only / empty / non-string are refused", async () => {
    expect((await catalogActions.addBarber({ name: "a".repeat(60), commissionPct: 50, password: "barber123" })).ok).toBe(true);
    for (const name of ["a".repeat(61), "a".repeat(10_000), "   ", "", 5, null, ["x"], { toString: () => "x" }]) {
      expect((await catalogActions.addBarber({ name, commissionPct: 50, password: "barber123" })).ok, JSON.stringify(name)?.slice(0, 20)).toBe(false);
    }
    expect((await catalogActions.addService({ categoryId: ids.cat, name: "s".repeat(81), price: 10 })).ok).toBe(false);
  });

  it("a NUL byte in a name does not crash the action: a clean refusal or a clean store, never an unhandled error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await catalogActions.addBarber({ name: "bad\u0000name", commissionPct: 50, password: "barber123" });
    spy.mockRestore();
    expect(typeof r.ok).toBe("boolean");
    if (!r.ok) expect(r.error).toMatch(/[ঀ-৿]/); // a Bangla message, not a driver error
  });

  it("XSS strings in barber, category and service names are stored as inert text and returned unchanged", async () => {
    const payloads = ["<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "javascript:alert(1)", "<svg/onload=alert(1)>", "{{constructor.constructor('alert(1)')()}}"];
    for (const p of payloads) {
      expect(await catalogActions.addBarber({ name: p, commissionPct: 50, password: "barber123" })).toMatchObject({ ok: true, data: { name: p } });
      expect(await catalogActions.addCategory({ name: p })).toMatchObject({ ok: true, data: { name: p } });
      expect(await catalogActions.addService({ categoryId: ids.cat, name: p, price: 10 })).toMatchObject({ ok: true, data: { name: p } });
    }
  });

  it("SQL-looking names are stored literally and every table still works", async () => {
    for (const p of ["'; DROP TABLE barbers; --", "Robert'); DELETE FROM sales; --", "1 OR 1=1", '" OR ""="', "\\'; SELECT pg_sleep(5); --"]) {
      expect(await catalogActions.addBarber({ name: p, commissionPct: 50, password: "barber123" })).toMatchObject({ ok: true, data: { name: p } });
    }
    const rows = await t.db.select().from(barbers);
    expect(rows.length).toBe(3 + 5); // 3 seeded barbers + the 5 hostile names
    expect(rows.map((r) => r.name)).toContain("'; DROP TABLE barbers; --");
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["decimal", 99.5],
    ["above the maximum", 1_000_001],
    ["beyond int4", 2 ** 31],
    ["string", "100"],
    ["Infinity", Infinity],
  ])("addService rejects price %s", async (_n, price) => {
    expect((await catalogActions.addService({ categoryId: ids.cat, name: "S", price })).ok).toBe(false);
  });

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["decimal", 10.5],
    ["above the maximum", 10_000_001],
    ["string", "100"],
    ["NaN", NaN],
  ])("addPayout rejects amount %s", async (_n, amount) => {
    const r = await payoutActions.addPayout({ barberId: ids.barberA, amount, date: todayKey(), note: "" });
    expect(r.ok).toBe(false);
    expect(await t.db.select().from(payouts)).toHaveLength(0);
  });

  it("addPayout rejects an impossible date, a future date and a 201-char note", async () => {
    for (const date of ["2026-02-30", "9999-12-31", "2026/01/01", "not a date", shiftDays(todayKey(), 1)]) {
      expect((await payoutActions.addPayout({ barberId: ids.barberA, amount: 10, date, note: "" })).ok, date).toBe(false);
    }
    expect((await payoutActions.addPayout({ barberId: ids.barberA, amount: 10, date: todayKey(), note: "n".repeat(201) })).ok).toBe(false);
    expect(await t.db.select().from(payouts)).toHaveLength(0);
  });

  it("updateSettings can never touch the PIN hash, the shop code hash or the version (strict schema)", async () => {
    const before = await t.db.select().from(settings).orderBy(settings.key);
    for (const evil of [
      { adminPinHash: "$2a$12$attackerhashattackerhashattackerhashattackerhashattack" },
      { shopCodeHash: "x" },
      { shopCodeVersion: "1" },
      { shopName: "ok", adminPinHash: "x" },
      JSON.parse('{"__proto__":{"adminPinHash":"x"}}'),
      { "shopName ": "x" },
    ]) {
      expect((await catalogActions.updateSettings(evil)).ok, JSON.stringify(evil).slice(0, 40)).toBe(false);
    }
    expect(await t.db.select().from(settings).orderBy(settings.key)).toEqual(before);
    expect(await authActions.loginAdmin({ pin: PIN })).toEqual({ ok: true }); // PIN still works
  });

  it("listSales refuses a huge range, a reversed range and non-date strings", async () => {
    for (const q of [
      { from: "2000-01-01", to: "2026-12-31" },
      { from: "2026-12-31", to: "2026-01-01" },
      { from: "x", to: "y" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-01-01", to: "2026-01-02", barberId: "1 OR 1=1" },
      { from: "2026-01-01", to: "2026-01-02", status: "all'; --" },
    ]) {
      expect((await saleActions.listSales(q)).ok, JSON.stringify(q)).toBe(false);
    }
  });

  it("PIN / shop-code inputs: only 4-8 ASCII digits; Bangla digits, letters, SQL and huge strings are refused", async () => {
    setJar({});
    for (const code of ["123", "123456789", "abcd", "১২৩৪", "٤٣٢١", "12 34", "1234'; --", "9".repeat(5000), 1234, null, { code: 1 }]) {
      expect((await authActions.unlockShop({ code })).ok, String(code).slice(0, 12)).toBe(false);
    }
  });

  it("error messages never leak internals: a driver failure becomes a generic Bangla message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await catalogActions.addService({ categoryId: 987654, name: "S", price: 10 }); // FK violation inside the DB
    const logged = spy.mock.calls.flat().join(" ");
    spy.mockRestore();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/violates|constraint|insert into|services_|postgres|stack/i);
    expect(logged).not.toMatch(/insert into|violates|params/i); // server log has the error NAME only
  });
});

// =====================================================================================
// 5. Authorization between barbers, receipts
// =====================================================================================

describe("5. barber A vs barber B", () => {
  it("A cannot void B's sale while logged in as A (reported as 'not found', not as 'forbidden')", async () => {
    setJar({ shop: await validShop(), barber: await validBarber(ids.barberB) });
    const sale = await saleActions.createSale({ ...saleFields(), barberId: ids.barberB });
    expect(sale.ok).toBe(true);
    const id = sale.ok ? sale.data.id : 0;
    setJar({ shop: await validShop(), barber: await validBarber(ids.barberA) });
    const r = await saleActions.voidMySale({ saleId: id, barberId: ids.barberA, reason: "steal" });
    expect(r).toMatchObject({ ok: false, error: "বিক্রি পাওয়া যায়নি" });
    expect((await t.db.select().from(sales).where(eq(sales.id, id)))[0].voidedAt).toBeNull();
  });

  it("A cannot void a sale that does not exist, and a barber cannot void an admin-entered sale", async () => {
    setJar({ shop: await validShop(), admin: await validAdmin() });
    expect((await saleActions.voidMySale({ saleId: 99999, barberId: ids.barberA, reason: "x" })).ok).toBe(false);
    const past = await saleActions.addPastSale({ ...saleFields(), date: shiftDays(todayKey(), -1), time: "10:00" });
    expect(past.ok).toBe(true);
    setJar({ shop: await validShop(), barber: await validBarber(ids.barberA) });
    const r = await saleActions.voidMySale({ saleId: past.ok ? past.data.id : 0, barberId: ids.barberA, reason: "x" });
    expect(r.ok).toBe(false);
  });

  // BUGS.md S-002, now CLOSED: a shop device alone (without barber B's own password session) can
  // no longer create or void a sale as barber B - this is the fix the per-barber login feature adds.
  it("S-002 FIXED: a shop device WITHOUT barber B's password session cannot create or void a sale as B", async () => {
    setJar({ shop: await validShop() }); // device-level only, no barber session for anyone
    expect(refused(await saleActions.createSale({ ...saleFields(), barberId: ids.barberB }))).toBe(true);

    // Even a sale legitimately created by B (with B's own session) cannot be voided by a device
    // that only holds A's session, or no barber session at all.
    setJar({ shop: await validShop(), barber: await validBarber(ids.barberB) });
    const sale = await saleActions.createSale({ ...saleFields(), barberId: ids.barberB });
    expect(sale.ok).toBe(true);
    const id = sale.ok ? sale.data.id : 0;

    setJar({ shop: await validShop(), barber: await validBarber(ids.barberA) });
    expect(refused(await saleActions.voidMySale({ saleId: id, barberId: ids.barberB, reason: "x" }))).toBe(true);
    setJar({ shop: await validShop() });
    expect(refused(await saleActions.voidMySale({ saleId: id, barberId: ids.barberB, reason: "x" }))).toBe(true);

    expect((await t.db.select().from(sales).where(eq(sales.id, id)))[0].voidedAt).toBeNull();
  });

  it("with B's own password session, B can create and void their own fresh sale (within the window)", async () => {
    setJar({ shop: await validShop(), barber: await validBarber(ids.barberB) });
    const sale = await saleActions.createSale({ ...saleFields(), barberId: ids.barberB });
    const id = sale.ok ? sale.data.id : 0;
    const r = await saleActions.voidMySale({ saleId: id, barberId: ids.barberB, reason: "x" });
    expect(r.ok).toBe(true); // within 10 minutes only; the sale is marked BARBER-voided and shows in admin
  });

  it("an inactive barber's session is rejected even with the correct password hash", async () => {
    setJar({ admin: await validAdmin() });
    expect(await catalogActions.updateBarber(ids.barberA, { active: false })).toMatchObject({ ok: true });
    setJar({ shop: await validShop(), barber: await validBarber(ids.barberA) });
    expect(refused(await saleActions.createSale(saleFields()))).toBe(true);
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

  it("every page that shows barber or receipt data calls the shop/admin guard (receipt id in the URL is shop-gated)", () => {
    const root = path.join(process.cwd(), "../Client/src/app");
    const pages = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = path.join(dir, f);
        return statSync(p).isDirectory() ? pages(p) : f === "page.tsx" ? [p] : [];
      });
    const offenders: string[] = [];
    for (const p of pages(root)) {
      const rel = path.relative(root, p).replaceAll("\\", "/");
      const src = readFileSync(p, "utf8");
      if (rel === "unlock/page.tsx" || rel === "admin/login/page.tsx") continue;
      // The admin pages are data-free client shells (their data comes through admin-only actions,
      // proven in section 1). Any page that reads the database itself must call a guard.
      const readsData = /from "@server\/db"|from "@server\/server\//.test(src);
      const guarded = rel.startsWith("admin/")
        ? /ensureAdmin|requireAdmin/.test(src)
        : /ensureShop|requireShop|ensureBarberSelf|requireBarberSelf/.test(src);
      if (readsData && !guarded) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the customer receipt never shows the barber/owner split (FR-14)", () => {
    const src = readFileSync(path.join(process.cwd(), "../Client/src/components/receipt-view.tsx"), "utf8");
    expect(src).not.toMatch(/barberShare|ownerShare|commissionPct/);
  });
});

// =====================================================================================
// 6. XSS sinks, CSV injection
// =====================================================================================

describe("6. output safety", () => {
  it("no component or page uses an HTML-injection sink (dangerouslySetInnerHTML, innerHTML, document.write, eval)", () => {
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
    walk(path.join(process.cwd(), "../Client/src"));
    expect(hits).toEqual([]);
  });

  // KNOWN GAP (LOW): a cell starting with = + - @ (or tab / CR) is run as a formula by Excel.
  it.fails("CSV export neutralises cells that start with = + - @ (formula injection)", () => {
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

// =====================================================================================
// 7. Security headers and bundle secrets
// =====================================================================================

describe("7. headers and secrets", () => {
  async function loadHeaders(env: "production" | "development") {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", env);
    const cfg = (await import("../../../Client/next.config")).default;
    const rules = await cfg.headers!();
    const rule = rules.find((r) => r.source === "/:path*");
    return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
  }

  it("the header rule matches every path (source /:path*) and carries all the required headers", async () => {
    const h = await loadHeaders("production");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["strict-transport-security"]).toMatch(/max-age=\d{8,}/);
    expect(h["permissions-policy"]).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(h["content-security-policy"]).toBeTruthy();
  });

  it("production CSP: self only, no eval, no framing, no plugins, no foreign form targets, upgrades http", async () => {
    const csp = (await loadHeaders("production"))["content-security-policy"];
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "upgrade-insecure-requests", "connect-src 'self'"]) {
      expect(csp, d).toContain(d);
    }
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:\/\/|\*/); // no third-party origins or wildcards
    expect(csp).not.toMatch(/ws:|wss:/);
  });

  const staticDir = path.join(process.cwd(), "../Client/.next/static");
  it.skipIf(!existsSync(staticDir))("the built client bundle contains no env var names, connection strings or secret values", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(js|css|html|json|map|txt)$/.test(f)) files.push(p);
      }
    };
    walk(staticDir);
    expect(files.length).toBeGreaterThan(0);
    const blob = files.map((f) => readFileSync(f, "utf8")).join("\n");

    for (const needle of ["DATABASE_URL", "DIRECT_URL", "SESSION_SECRET", "SEED_ADMIN_PIN", "SEED_SHOP_CODE", "TRUST_PROXY_HEADERS", "neon.tech", "postgres://", "postgresql://", "adminPinHash", "shopCodeHash", "bcryptjs"]) {
      expect(blob.includes(needle), `client bundle contains "${needle}"`).toBe(false);
    }

    // The actual values from the local env files (never printed: only a boolean is asserted).
    const secrets: string[] = [];
    for (const f of [".env.local", ".env.test", ".env", ".env.production"]) {
      const p = path.join(process.cwd(), "../Client", f);
      if (!existsSync(p)) continue;
      const env = parseEnv(readFileSync(p));
      for (const [k, v] of Object.entries(env)) {
        if (/SECRET|PASSWORD|PIN|URL|KEY|TOKEN|CODE/i.test(k) && v.length >= 8) secrets.push(v);
        if (/URL/i.test(k)) {
          try {
            secrets.push(new URL(v).hostname); // the database host name
          } catch {}
        }
      }
    }
    for (const s of new Set(secrets)) expect(blob.includes(s), "a secret value from an .env file is in the client bundle").toBe(false);
  });
});
