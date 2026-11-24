import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseInput, runAction } from "./action";
import { DomainError } from "./errors";

describe("runAction", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it("wraps a successful result", async () => {
    expect(await runAction(async () => 42)).toEqual({ ok: true, data: 42 });
  });

  it("returns a DomainError message to the user as-is", async () => {
    const r = await runAction(async () => {
      throw new DomainError("এই নামে একজন নাপিত আগে থেকেই আছে");
    });
    expect(r).toEqual({ ok: false, error: "এই নামে একজন নাপিত আগে থেকেই আছে" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps an auth failure (by error name) to a Bangla message", async () => {
    const e = new Error("UNAUTHORIZED");
    e.name = "AuthError";
    const r = await runAction(async () => {
      throw e;
    });
    expect(r).toEqual({ ok: false, error: "আবার এডমিন পিন দিয়ে ঢুকুন" });
  });

  it("hides unexpected errors behind a generic message and logs only the error name", async () => {
    const r = await runAction(async () => {
      throw new Error("connection to ep-secret-host.neon.tech failed: password=hunter2");
    });
    expect(r).toEqual({ ok: false, error: "কিছু একটা ভুল হয়েছে, আবার চেষ্টা করুন" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("hunter2");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("neon.tech");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("survives a thrown non-Error value", async () => {
    const r = await runAction(async () => {
      throw "boom";
    });
    expect(r.ok).toBe(false);
  });
});

describe("parseInput", () => {
  const schema = z.strictObject({ name: z.string().trim().min(1, "নাম লিখুন") });

  it("returns the parsed (trimmed) value", () => {
    expect(parseInput(schema, { name: " রহিম " })).toEqual({ name: "রহিম" });
  });

  it("throws a DomainError carrying the first Bangla message", () => {
    expect(() => parseInput(schema, { name: " " })).toThrow(DomainError);
    expect(() => parseInput(schema, { name: " " })).toThrow("নাম লিখুন");
  });

  it("uses a generic Bangla message for a wrong shape (no English zod text leaks)", () => {
    expect(() => parseInput(schema, null)).toThrow("ভুল তথ্য পাঠানো হয়েছে");
    expect(() => parseInput(schema, { name: "x", extra: 1 })).toThrow(DomainError);
  });
});
