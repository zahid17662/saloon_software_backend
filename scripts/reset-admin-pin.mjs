// `npm run admin:reset-pin`: developer-only recovery when the owner forgot the admin PIN.
// Run it yourself against the database you mean to change:
//   DIRECT_URL=<direct string>  NEW_ADMIN_PIN=<4-8 digits>  npm run admin:reset-pin
// It writes a bcrypt hash to settings.adminPinHash (the same as the Settings screen does) and prints
// only the Neon endpoint id, never the connection string or the PIN. Existing admin sessions stop
// working because the session cookie is tied to the PIN hash.

import { Pool } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const pin = process.env.NEW_ADMIN_PIN ?? "";
if (!url) throw new Error("Set DIRECT_URL (or DATABASE_URL) in this shell.");
if (!/^\d{4,8}$/.test(pin)) throw new Error("Set NEW_ADMIN_PIN to 4 to 8 digits.");

const endpoint = new URL(url).hostname.split(".")[0].replace(/-pooler$/, "");
console.log(`Target Neon endpoint: ${endpoint} (check it is the database you mean to change)`);

const pool = new Pool({ connectionString: url });
try {
  const hash = await bcrypt.hash(pin, 12);
  const r = await pool.query("update settings set value = $1 where key = 'adminPinHash'", [hash]);
  if (r.rowCount !== 1) throw new Error("No adminPinHash row found: has this database been seeded?");
  console.log("Admin PIN updated.");
} finally {
  await pool.end();
}
