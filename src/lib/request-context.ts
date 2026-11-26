// Per-request context for the API. The frontend (Next.js on Vercel) forwards the visitor's cookies
// and a few trusted headers inside the RPC envelope; the auth code reads them here, and any cookie
// it wants to set is collected and returned to the frontend, which applies it on the visitor's
// browser. This replaces next/headers, so the backend has no Next.js dependency.

import { AsyncLocalStorage } from "node:async_hooks";

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
  domain?: string;
}

export interface CookieToSet {
  name: string;
  value: string;
  options: CookieOptions;
}

interface RequestContext {
  jar: Map<string, string>;
  headers: Headers;
  setCookies: CookieToSet[];
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequest<T>(
  input: { cookies: Record<string, string>; headers: Record<string, string> },
  fn: () => Promise<T>,
): Promise<{ value: T; setCookies: CookieToSet[] }> {
  const ctx: RequestContext = {
    jar: new Map(Object.entries(input.cookies)),
    headers: new Headers(input.headers),
    setCookies: [],
  };
  return storage.run(ctx, async () => ({ value: await fn(), setCookies: ctx.setCookies }));
}

function current(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("no request context: call this inside runWithRequest");
  return ctx;
}

/** Same shape as next/headers `cookies()`, so the auth code reads naturally. */
export async function cookies() {
  const ctx = current();
  return {
    get: (name: string) => (ctx.jar.has(name) ? { name, value: ctx.jar.get(name)! } : undefined),
    set: (name: string, value: string, options: CookieOptions = {}) => {
      if (value === "") ctx.jar.delete(name);
      else ctx.jar.set(name, value);
      ctx.setCookies.push({ name, value, options });
    },
  };
}

/** Same shape as next/headers `headers()`. */
export async function headers(): Promise<Headers> {
  return current().headers;
}
