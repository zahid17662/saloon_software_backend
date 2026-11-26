import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Playwright specs live in e2e/ and run with `npm run test:e2e`, not here.
export default defineConfig({
  resolve: {
    alias: [
      // Same "@/..." alias as tsconfig, so tests can import the actions themselves.
      { find: "@", replacement: path.resolve(process.cwd(), "src") },
    ],
  },
  // Every DB test file boots its own in-memory Postgres (PGlite) and runs the migrations; with
  // many files in parallel that can pass the 5 s default, so allow more before calling it a failure.
  test: { exclude: [...configDefaults.exclude, "e2e/**"], testTimeout: 30_000, hookTimeout: 30_000 },
});
