import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit's config loader doesn't populate import.meta.dirname, so derive it from import.meta.url.
const dirname = path.dirname(fileURLToPath(import.meta.url));

// drizzle-kit doesn't load Next's .env.local on its own. Resolved from this file's own location
// (not cwd) since this is invoked as `drizzle-kit --config Server/drizzle.config.ts` from the repo
// root; the real .env.local lives in Client/, next to the Next.js app that reads it at runtime.
config({ path: path.resolve(dirname, "../Client/.env.local") });

export default defineConfig({
  dialect: "postgresql",
  // Relative to cwd (always the repo root: `drizzle-kit --config Server/drizzle.config.ts` is only
  // ever invoked from there via package.json scripts) — drizzle-kit path-joins "out" onto cwd
  // internally rather than using path.resolve, so an absolute path here would double up incorrectly.
  schema: "Server/src/db/schema.ts",
  out: "Server/src/db/migrations",
  dbCredentials: {
    // Direct (non-pooler) connection for migrations; fall back to DATABASE_URL.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
});
