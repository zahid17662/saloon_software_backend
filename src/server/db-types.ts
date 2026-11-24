import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "../db/schema";

/**
 * The database handle the server functions accept. Production passes the Neon `db`, tests pass a
 * PGlite one; both are Drizzle Postgres databases (and transactions are too), so the same code
 * runs against either. The query-result type differs per driver, hence `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;
