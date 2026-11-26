// The HTTP layer: only the frontend (holding API_KEY) may call it, unknown actions are refused, the
// envelope is validated, and cookies the action sets come back for the frontend to apply.
// Uses logoutAdmin, the one action that needs no database.

import { describe, expect, it } from "vitest";
import { createApp, keyMatches } from "./app";

const KEY = "k".repeat(40);
const app = createApp(KEY);

const call = (name: string, body: unknown, key: string | null = KEY) =>
  app.request(`/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("keyMatches", () => {
  it("accepts only the exact key", () => {
    expect(keyMatches(KEY, KEY)).toBe(true);
    expect(keyMatches(KEY + "x", KEY)).toBe(false);
    expect(keyMatches(KEY.slice(0, -1), KEY)).toBe(false);
    expect(keyMatches("", KEY)).toBe(false);
    expect(keyMatches(undefined, KEY)).toBe(false);
  });

  it("never matches when the server has no key configured", () => {
    expect(keyMatches("", "")).toBe(false);
    expect(keyMatches("anything", "")).toBe(false);
  });
});

describe("GET /health", () => {
  it("answers without a key and without touching the database", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /rpc/:name", () => {
  it("401 without a key, with a wrong key, and when the server has no key", async () => {
    expect((await call("auth.logoutAdmin", {}, null)).status).toBe(401);
    expect((await call("auth.logoutAdmin", {}, "wrong-key")).status).toBe(401);
    const keyless = createApp("");
    const res = await keyless.request("/rpc/auth.logoutAdmin", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("404 for an action that is not in the registry (including prototype names)", async () => {
    expect((await call("auth.nope", {})).status).toBe(404);
    expect((await call("constructor", {})).status).toBe(404);
    expect((await call("__proto__", {})).status).toBe(404);
  });

  it("400 for a malformed envelope", async () => {
    expect((await call("auth.logoutAdmin", "not json")).status).toBe(400);
    expect((await call("auth.logoutAdmin", { args: "x" })).status).toBe(400);
    expect((await call("auth.logoutAdmin", { cookies: { a: 1 } })).status).toBe(400);
  });

  it("400 for a bad id argument on an id-taking action", async () => {
    expect((await call("read.barber", { args: ["1; drop table sales"] })).status).toBe(400);
    expect((await call("read.barber", { args: [-1] })).status).toBe(400);
    expect((await call("read.barber", { args: [] })).status).toBe(400);
  });

  it("413 for a body over the size limit", async () => {
    const res = await call("auth.logoutAdmin", { args: ["x".repeat(300_000)] });
    expect(res.status).toBe(413);
  });

  it("returns the result and the cookies the action cleared, uncached", async () => {
    process.env.SESSION_SECRET = "unit-test-secret-unit-test-secret-0123456789";
    const res = await call("auth.logoutAdmin", { args: [], cookies: { salon_admin: "x" }, headers: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { result: unknown; setCookies: { name: string; value: string; options: Record<string, unknown> }[] };
    expect(body.result).toEqual({ ok: true });
    expect(body.setCookies).toHaveLength(1);
    expect(body.setCookies[0]).toMatchObject({ value: "", options: { httpOnly: true, path: "/", maxAge: 0 } });
  });
});
