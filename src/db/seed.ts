/**
 * Idempotent seed: `npm run db:seed`. The logic lives in seed-core.ts (also run by the tests);
 * this file only connects to Neon and reads the environment.
 *
 * - Reuses the data in src/lib/seed.ts (categories, 25 services, 3 barbers, settings).
 * - Admin PIN and shop code are stored as bcrypt hashes, never plaintext.
 * - Each table is seeded only if it is empty; settings use ON CONFLICT DO NOTHING.
 *   Re-running creates no duplicates and never overwrites a PIN/shop code that was changed later.
 * - Everything runs in one transaction under an advisory lock, so concurrent runs are safe too.
 *
 * Env: DIRECT_URL (or DATABASE_URL). Optional: SEED_ADMIN_PIN, SEED_SHOP_CODE, SEED_BARBER_PASSWORD.
 *      SEED_ENV=production requires all three to be set explicitly (no demo fallback).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { DEMO_ADMIN_PIN, DEMO_SHOP_CODE } from "../lib/seed";
import { seedDb } from "./seed-core";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved from this file's own location (not cwd). Local development only: Server/.env, then the
// Client/.env.local if present.
config({ path: path.resolve(dirname, "../../.env") });
config({ path: path.resolve(dirname, "../../../Client/.env.local") });

function endpointId(url: string): string {
  // Only the Neon endpoint id (ep-xxxx), never credentials, so it can be compared to the console.
  const host = new URL(url).hostname;
  return host.split(".")[0].replace(/-pooler$/, "");
}

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL is not set");

  const isProd = process.env.SEED_ENV === "production";
  const pin = process.env.SEED_ADMIN_PIN ?? (isProd ? undefined : DEMO_ADMIN_PIN);
  const shopCode = process.env.SEED_SHOP_CODE ?? (isProd ? undefined : DEMO_SHOP_CODE);
  const barberPassword = process.env.SEED_BARBER_PASSWORD;
  if (!pin || !shopCode || (isProd && !barberPassword)) {
    console.error("SEED_ENV=production requires SEED_ADMIN_PIN, SEED_SHOP_CODE and SEED_BARBER_PASSWORD");
    process.exit(1);
  }
  // Same rule as the "new barber" form, so the seeded password is never weaker than a typed one.
  if (barberPassword && !/^(?=.*[A-Za-z])(?=.*\d).{6,72}$/.test(barberPassword)) {
    console.error("SEED_BARBER_PASSWORD needs 6 or more characters with both letters and digits");
    process.exit(1);
  }

  console.log(`Seeding Neon endpoint: ${endpointId(url)}`);

  const pool = new Pool({ connectionString: url });
  try {
    const result = await seedDb(drizzle(pool), { pin, shopCode, barberPassword });
    console.log("Inserted this run:", result);
    console.log("(0 means that table was already seeded; nothing was changed.)");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // Name only: a driver error message can echo connection details.
  console.error("Seed failed:", err instanceof Error ? err.name : "unknown error");
  process.exit(1);
});
