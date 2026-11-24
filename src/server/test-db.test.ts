import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { barbers } from "../db/schema";
import { createTestDb, type TestDb } from "./test-db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("test database (PGlite running the real migrations)", () => {
  it("does Asia/Dhaka day math: 18:30 UTC is already the next day in Dhaka", async () => {
    const r = await t.db.execute(
      sql`select to_char(date_trunc('day', ${"2026-01-14T18:30:00Z"}::timestamptz at time zone 'Asia/Dhaka'), 'YYYY-MM-DD') as d`,
    );
    expect((r.rows[0] as { d: string }).d).toBe("2026-01-15");
  });

  it("has the schema, including the CHECK constraints from migration 0001", async () => {
    await t.db.insert(barbers).values({ name: "টেস্ট", commissionPct: 50 });
    await expect(t.db.insert(barbers).values({ name: "খারাপ", commissionPct: 101 })).rejects.toThrow();
    const cols = await t.db.execute(
      sql`select column_name from information_schema.columns where table_name = 'sales' and column_name = 'entered_by_admin'`,
    );
    expect(cols.rows).toHaveLength(1);
  });
});
