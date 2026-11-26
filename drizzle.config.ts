import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit's config loader doesn't populate import.meta.dirname, so derive it from import.meta.url.
const dirname = path.dirname(fileURLToPath(import.meta.url));

// Local development only: load Server/.env, then the old Client/.env.local of the dev meta-repo if
// present. On Render the variables come from the service environment and neither file exists.
config({ path: path.resolve(dirname, ".env") });
config({ path: path.resolve(dirname, "../Client/.env.local") });

export default defineConfig({
  dialect: "postgresql",
  // Relative to cwd: every script (`npm run db:migrate`) runs from the Server folder.
  schema: "src/db/schema.ts",
  out: "src/db/migrations",
  dbCredentials: {
    // Direct (non-pooler) connection for migrations; fall back to DATABASE_URL.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
});
