// HTTP layer. One RPC endpoint, `POST /rpc/:name`, plus `GET /health`.
//
// Only the frontend may call it: every /rpc request must carry `Authorization: Bearer <API_KEY>`
// (constant-time compare). The visitor's cookies and client IP ride inside the JSON envelope, which
// is why the key matters: without it anyone could claim to be any client IP and dodge the login
// rate limit. Cookies the auth code wants to set come back in `setCookies` for the frontend to apply.

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { runWithRequest } from "@/lib/request-context";
import { BadArgs, registry } from "./registry";

const envelope = z.object({
  args: z.array(z.unknown()).max(8).default([]),
  cookies: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
});

/** Constant-time string comparison that also hides the length of the expected key. */
export function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given || expected.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const padded = Buffer.alloc(Math.max(a.length, b.length));
  const padded2 = Buffer.alloc(padded.length);
  a.copy(padded);
  b.copy(padded2);
  return timingSafeEqual(padded, padded2) && a.length === b.length;
}

// Only these forwarded headers are meaningful to the auth code (client IP); drop everything else.
const FORWARDED_HEADERS = new Set(["x-real-ip", "x-forwarded-for"]);

export function createApp(apiKey: string = process.env.API_KEY ?? "") {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store" }));

  app.post("/rpc/:name", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "too large" }, 413) }), async (c) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!keyMatches(bearer, apiKey)) return c.json({ error: "unauthorized" }, 401);

    const name = c.req.param("name");
    const handler = Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (!handler) return c.json({ error: "not found" }, 404);

    const raw = await c.req.json().catch(() => null);
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return c.json({ error: "bad request" }, 400);

    const headers = Object.fromEntries(
      Object.entries(parsed.data.headers).filter(([k]) => FORWARDED_HEADERS.has(k.toLowerCase())),
    );

    try {
      const { value, setCookies } = await runWithRequest({ cookies: parsed.data.cookies, headers }, () =>
        handler(...parsed.data.args),
      );
      // JSON cannot carry `undefined`; the frontend treats a missing result as null.
      return c.json({ result: value ?? null, setCookies }, 200, { "cache-control": "no-store" });
    } catch (e) {
      if (e instanceof BadArgs) return c.json({ error: "bad request" }, 400);
      // Only the error NAME: messages can carry hostnames or credentials.
      console.error(`rpc ${name} failed:`, e instanceof Error ? e.name : "non-Error thrown");
      return c.json({ error: "server error" }, 500);
    }
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
