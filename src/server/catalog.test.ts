import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { barbers, categories, sales, services, settings } from "../db/schema";
import {
  addBarber,
  addCategory,
  addService,
  getCatalog,
  updateBarber,
  updateCategory,
  updateService,
  updateSettings,
} from "./catalog";
import { DomainError } from "./errors";
import { createTestDb, type TestDb } from "./test-db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  // Fresh tables for every test (children first).
  await t.db.delete(sales);
  await t.db.delete(services);
  await t.db.delete(categories);
  await t.db.delete(barbers);
  await t.db.delete(settings);
});

const reject = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  return (e as DomainError).message;
};

describe("getCatalog", () => {
  it("returns everything in sort order, with ISO dates", async () => {
    await t.db.insert(categories).values([
      { name: "বি", sortOrder: 1 },
      { name: "এ", sortOrder: 0 },
    ]);
    const cats = await t.db.select().from(categories);
    const a = cats.find((c) => c.name === "এ")!;
    await t.db.insert(services).values([
      { categoryId: a.id, name: "দুই", price: 200, sortOrder: 1 },
      { categoryId: a.id, name: "এক", price: 100, sortOrder: 0 },
    ]);
    await t.db.insert(barbers).values([
      { name: "দ্বিতীয়", commissionPct: 40, sortOrder: 1 },
      { name: "প্রথম", commissionPct: 50, sortOrder: 0 },
    ]);

    const c = await getCatalog(t.db);
    expect(c.categories.map((x) => x.name)).toEqual(["এ", "বি"]);
    expect(c.services.map((x) => x.name)).toEqual(["এক", "দুই"]);
    expect(c.barbers.map((x) => x.name)).toEqual(["প্রথম", "দ্বিতীয়"]);
    expect(c.barbers[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("includes inactive rows (the admin needs them) but never leaks secret settings", async () => {
    await t.db.insert(barbers).values({ name: "বন্ধ", commissionPct: 50, active: false });
    await t.db.insert(settings).values([
      { key: "shopName", value: "আমার সেলুন" },
      { key: "paperWidth", value: "58" },
      { key: "adminPinHash", value: "$2b$12$secret-admin" },
      { key: "shopCodeHash", value: "$2b$12$secret-shop" },
      { key: "shopCodeVersion", value: "7" },
    ]);
    const c = await getCatalog(t.db);
    expect(c.barbers).toHaveLength(1);
    expect(c.settings.shopName).toBe("আমার সেলুন");
    expect(c.settings.paperWidth).toBe("58");
    const json = JSON.stringify(c);
    expect(json).not.toContain("secret-admin");
    expect(json).not.toContain("secret-shop");
    expect(Object.keys(c.settings).sort()).toEqual(
      ["paperWidth", "receiptFooter", "shopAddress", "shopName", "shopPhone"].sort(),
    );
  });

  it("falls back to safe defaults when settings are missing", async () => {
    const c = await getCatalog(t.db);
    expect(c.settings.paperWidth).toBe("80");
    expect(c.settings.shopName).toBe("");
  });
});

describe("barbers", () => {
  it("adds a barber with the next sort order", async () => {
    await addBarber(t.db, { name: "রহিম", commissionPct: 50, password: "barber123" });
    const b = await addBarber(t.db, { name: "করিম", commissionPct: 40, password: "barber123" });
    expect(b.name).toBe("করিম");
    expect(b.commissionPct).toBe(40);
    expect(b.sortOrder).toBe(1);
    expect(b.active).toBe(true);
  });

  it("rejects a duplicate name among active barbers, but allows it when the other is inactive", async () => {
    const first = await addBarber(t.db, { name: "রহিম", commissionPct: 50, password: "barber123" });
    expect(await reject(addBarber(t.db, { name: "রহিম", commissionPct: 50, password: "barber123" }))).toBe(
      "এই নামে একজন নাপিত আগে থেকেই আছে",
    );
    await updateBarber(t.db, first.id, { active: false });
    await expect(addBarber(t.db, { name: "রহিম", commissionPct: 50, password: "barber123" })).resolves.toBeTruthy();
  });

  it("updates commission and name", async () => {
    const b = await addBarber(t.db, { name: "রহিম", commissionPct: 50, password: "barber123" });
    const u = await updateBarber(t.db, b.id, { commissionPct: 60, name: " রহিম মিয়া " });
    expect(u.commissionPct).toBe(60);
    expect(u.name).toBe("রহিম মিয়া");
  });

  it("refuses to reactivate a barber into a name clash and reports a missing barber", async () => {
    const a = await addBarber(t.db, { name: "রহিম", commissionPct: 50, password: "barber123" });
    await updateBarber(t.db, a.id, { active: false });
    await addBarber(t.db, { name: "রহিম", commissionPct: 50, password: "barber123" });
    expect(await reject(updateBarber(t.db, a.id, { active: true }))).toBe("এই নামে একজন নাপিত আগে থেকেই আছে");
    expect(await reject(updateBarber(t.db, 9999, { name: "x" }))).toBe("নাপিত পাওয়া যায়নি");
  });
});

describe("categories and services", () => {
  it("adds and renames categories, and reports a missing one", async () => {
    const c = await addCategory(t.db, { name: "চুল" });
    expect(c.sortOrder).toBe(0);
    const u = await updateCategory(t.db, c.id, { name: "চুল কাটা", active: false });
    expect(u).toMatchObject({ name: "চুল কাটা", active: false });
    expect(await reject(updateCategory(t.db, 9999, { name: "x" }))).toBe("ক্যাটাগরি পাওয়া যায়নি");
  });

  it("adds services inside a category with increasing sort order", async () => {
    const c = await addCategory(t.db, { name: "চুল" });
    const s1 = await addService(t.db, { categoryId: c.id, name: "কাটিং", price: 150 });
    const s2 = await addService(t.db, { categoryId: c.id, name: "ওয়াশ", price: 50 });
    expect([s1.sortOrder, s2.sortOrder]).toEqual([0, 1]);
    expect(s1.price).toBe(150);
  });

  it("rejects a service for a category that does not exist", async () => {
    expect(await reject(addService(t.db, { categoryId: 4242, name: "কাটিং", price: 150 }))).toBe(
      "ক্যাটাগরি পাওয়া যায়নি",
    );
  });

  it("updates a price and reports a missing service", async () => {
    const c = await addCategory(t.db, { name: "চুল" });
    const s = await addService(t.db, { categoryId: c.id, name: "কাটিং", price: 150 });
    const u = await updateService(t.db, s.id, { price: 180 });
    expect(u.price).toBe(180);
    expect(await reject(updateService(t.db, 9999, { price: 1 }))).toBe("সার্ভিস পাওয়া যায়নি");
  });

  it("refuses to move a service into a category that does not exist", async () => {
    const c = await addCategory(t.db, { name: "চুল" });
    const s = await addService(t.db, { categoryId: c.id, name: "কাটিং", price: 150 });
    expect(await reject(updateService(t.db, s.id, { categoryId: 9999 }))).toBe("ক্যাটাগরি পাওয়া যায়নি");
  });
});

describe("settings", () => {
  it("upserts only the keys given and leaves the others, and never touches the hashes", async () => {
    await t.db.insert(settings).values([
      { key: "shopName", value: "পুরনো" },
      { key: "shopPhone", value: "০১" },
      { key: "adminPinHash", value: "keep-me" },
    ]);
    const s = await updateSettings(t.db, { shopName: "নতুন", receiptFooter: "ধন্যবাদ" });
    expect(s).toMatchObject({ shopName: "নতুন", shopPhone: "০১", receiptFooter: "ধন্যবাদ" });
    const rows = await t.db.select().from(settings);
    expect(rows.find((r) => r.key === "adminPinHash")?.value).toBe("keep-me");
  });
});
