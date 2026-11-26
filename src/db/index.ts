import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

// Neon's serverless driver talks WebSocket; Node has no global WebSocket constructor for it, so
// hand it the `ws` package. (On Vercel's edge/serverless runtimes this was built in.)
neonConfig.webSocketConstructor = ws;

// Pooled Neon connection over WebSocket (supports interactive transactions).
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });
export * from "./schema";
