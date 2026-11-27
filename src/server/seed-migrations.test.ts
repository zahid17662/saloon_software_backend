// Item 6: migrations apply cleanly on an EMPTY database and match schema.ts, and the seed can be
// run any number of times (even at once) without duplicates or overwriting a changed PIN.
// Runs on PGlite; the seed function is the same one `npm run db:seed` runs against Neon.

import { count, eq, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDb } from "../db/seed-core";
import * as schema from "../db/schema";
import { barbers, categories, services, settings } from "../db/schema";
import { createTestDb, type TestDb } from "./test-db";

const OPTS = { pin: "4321", shopCode: "9876", bcryptCost: 4 } as const; // cost 4 only to keep tests fast

describe("migrations on an empty database", () => {
  const folder = path.join(process.cwd(), "src/db/migrations");

  it("apply cleanly from nothing, and applying them again is a no-op", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: folder });
    await migrate(db, { migrationsFolder: folder });
    const r = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect((r.rows[0] as { n: number }).n).toBe(6); // 0000, 0001, 0002, 0003, 0004, 0005: none applied twice
    await client.close();
  });

  it("produce exactly the tables, indexes and constraints that schema.ts declares", async () => {
    const t = await createTestDb();
    const tables = Object.values(schema).filter((v) => is(v, PgTable)) as unknown as PgTable[];
    expect(tables.length).toBe(9);
    for (const tbl of tables) {
      const cfg = getTableConfig(tbl);
      const idx = await t.db.execute(sql`select indexname from pg_indexes where schemaname = 'public' and tablename = ${cfg.name}`);
      const have = new Set((idx.rows as { indexname: string }[]).map((r) => r.indexname));
      for (const i of cfg.indexes) expect(have, `${cfg.name}.${i.config.name}`).toContain(i.config.name);
      const chk = await t.db.execute(sql`select conname from pg_constraint where conrelid = ${`public.${cfg.name}`}::regclass and contype = 'c'`);
      const haveChk = new Set((chk.rows as { conname: string }[]).map((r) => r.conname));
      for (const c of cfg.checks) expect(haveChk, `${cfg.name}.${c.name}`).toContain(c.name);
    }
    await t.close();
  });
});

describe("seed idempotency", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  const counts = async () => ({
    categories: (await t.db.select({ n: count() }).from(categories))[0].n,
    services: (await t.db.select({ n: count() }).from(services))[0].n,
    barbers: (await t.db.select({ n: count() }).from(barbers))[0].n,
    settings: (await t.db.select({ n: count() }).from(settings))[0].n,
  });

  it("first run fills an empty database; the second run inserts nothing", async () => {
    const first = await seedDb(t.db, OPTS);
    expect(first.categories).toBeGreaterThan(0);
    expect(first.services).toBe(25);
    expect(first.barbers).toBe(3);
    expect(first.settings).toBe(8);
    const after1 = await counts();
    const second = await seedDb(t.db, OPTS);
    expect(second).toEqual({ categories: 0, services: 0, barbers: 0, settings: 0 });
    expect(await counts()).toEqual(after1);
  });

  it("stores bcrypt hashes, never the plain PIN or shop code", async () => {
    const rows = await t.db.select().from(settings);
    const get = (k: string) => rows.find((r) => r.key === k)!.value;
    expect(get("adminPinHash")).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare(OPTS.pin, get("adminPinHash"))).toBe(true);
    expect(await bcrypt.compare(OPTS.shopCode, get("shopCodeHash"))).toBe(true);
    expect(rows.some((r) => r.value === OPTS.pin || r.value === OPTS.shopCode)).toBe(false);
  });

  it("re-running with a different PIN does NOT overwrite a PIN the owner already set", async () => {
    await seedDb(t.db, { ...OPTS, pin: "1111" });
    const [row] = await t.db.select().from(settings).where(eq(settings.key, "adminPinHash"));
    expect(await bcrypt.compare(OPTS.pin, row.value)).toBe(true);
  });

  it("two seeds started at the same time still leave exactly one copy of everything", async () => {
    const fresh = await createTestDb();
    await Promise.all([seedDb(fresh.db, OPTS), seedDb(fresh.db, OPTS), seedDb(fresh.db, OPTS)]);
    const n = async (tbl: typeof categories | typeof services | typeof barbers) => (await fresh.db.select({ n: count() }).from(tbl))[0].n;
    expect(await n(services)).toBe(25);
    expect(await n(barbers)).toBe(3);
    expect(await n(categories)).toBe((await t.db.select({ n: count() }).from(categories))[0].n);
    await fresh.close();
  });
});
