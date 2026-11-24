// Shared plumbing for Server Actions: one result shape, one error mapper, one zod helper.
// Deliberately free of Next.js and "server-only" imports so it can be unit-tested; the auth check
// itself (requireShop / requireAdmin) stays visible at the top of each action.

import type { z } from "zod";
import { GENERIC_ERR } from "../lib/messages";
import { DomainError } from "./errors";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export const MSG = {
  generic: GENERIC_ERR,
  unauthorized: "আবার এডমিন পিন দিয়ে ঢুকুন",
  badInput: "ভুল তথ্য পাঠানো হয়েছে",
} as const;

const BANGLA = /[ঀ-৿]/;

/**
 * Runs an action body and converts every failure into `{ ok: false, error }`.
 * - DomainError: its Bangla message is shown to the user.
 * - AuthError (matched by name; the class lives in a server-only module): "log in again".
 * - Anything else is a bug or an outage: log only the error NAME (messages can carry hostnames or
 *   credentials) and show the generic message.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.message };
    if (e instanceof Error && e.name === "AuthError") return { ok: false, error: MSG.unauthorized };
    console.error("action failed:", e instanceof Error ? e.name : "non-Error thrown");
    return { ok: false, error: MSG.generic };
  }
}

/**
 * Validates untrusted input. The first issue's message is used only when it is Bangla (our own
 * schema messages); zod's built-in English messages are replaced by a generic Bangla one.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0]?.message ?? "";
  throw new DomainError(BANGLA.test(first) ? first : MSG.badInput);
}
