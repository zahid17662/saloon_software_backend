import { describe, expect, it } from "vitest";
import { BACKDATE_MAX_DAYS, resolveBackdate } from "./backdate";
import { dhakaDateKey, dhakaDayStart, shiftDays } from "./time";

// "now" = 2026-03-10 12:00 in Dhaka = 06:00 UTC.
const NOW = new Date("2026-03-10T06:00:00Z");

const ok = (date: string, time: string, now = NOW) => {
  const r = resolveBackdate(date, time, now);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.at;
};
const err = (date: string, time: string, now = NOW) => {
  const r = resolveBackdate(date, time, now);
  if (r.ok) throw new Error("expected an error");
  return r.error;
};

describe("back-date limits (FR-22)", () => {
  it("the window is 60 days", () => expect(BACKDATE_MAX_DAYS).toBe(60));

  it("accepts earlier today", () => {
    expect(ok("2026-03-10", "09:30").toISOString()).toBe("2026-03-10T03:30:00.000Z");
  });

  it("accepts exactly now (not in the future)", () => {
    expect(ok("2026-03-10", "12:00").toISOString()).toBe(NOW.toISOString());
  });

  it("rejects one minute in the future, with a Bangla message", () => {
    expect(err("2026-03-10", "12:01")).toBe("ভবিষ্যতের তারিখ বা সময় দেওয়া যাবে না");
  });

  it("rejects tomorrow", () => {
    expect(err("2026-03-11", "00:00")).toBe("ভবিষ্যতের তারিখ বা সময় দেওয়া যাবে না");
  });

  it("accepts the first minute of the oldest allowed day (today − 60 days)", () => {
    const oldest = shiftDays("2026-03-10", -60); // 2026-01-09
    expect(oldest).toBe("2026-01-09");
    expect(ok(oldest, "00:00").toISOString()).toBe("2026-01-08T18:00:00.000Z");
  });

  it("rejects the last minute of the day before that (today − 61 days)", () => {
    expect(err("2026-01-08", "23:59")).toBe("৬০ দিনের বেশি পুরনো তারিখ দেওয়া যাবে না");
  });

  it("uses the DHAKA day, not the UTC day, for 'today' and the 60-day edge", () => {
    // 2026-03-10 19:00 UTC is already 2026-03-11 01:00 in Dhaka.
    const late = new Date("2026-03-10T19:00:00Z");
    expect(ok("2026-03-11", "00:30", late).toISOString()).toBe("2026-03-10T18:30:00.000Z");
    expect(err("2026-03-11", "01:30", late)).toBe("ভবিষ্যতের তারিখ বা সময় দেওয়া যাবে না");
    // Dhaka-today is now the 11th, so the oldest allowed day moved to Jan 10 and Jan 9 is too old.
    expect(ok("2026-01-10", "00:00", late)).toBeInstanceOf(Date);
    expect(err("2026-01-09", "12:00", late)).toBe("৬০ দিনের বেশি পুরনো তারিখ দেওয়া যাবে না");
  });

  it.each([
    ["2026-02-30", "10:00"], // not a real day
    ["2026-13-01", "10:00"],
    ["26-03-01", "10:00"],
    ["2026-03-01", "24:00"],
    ["2026-03-01", "10:60"],
    ["2026-03-01", "9:5"],
    ["", ""],
  ])("rejects malformed input %s %s", (d, t) => {
    expect(err(d, t)).toBe("তারিখ ও সময় সঠিক নয়");
  });
});

describe("Dhaka-day bucketing of a back-dated instant", () => {
  // The chosen Dhaka date must be the day the sale lands on, for every minute of the day,
  // including the two edges that straddle UTC midnight.
  it.each([
    ["2026-02-01", "00:00"],
    ["2026-02-01", "05:59"],
    ["2026-02-01", "06:00"],
    ["2026-02-01", "12:00"],
    ["2026-02-01", "17:59"],
    ["2026-02-01", "18:00"],
    ["2026-02-01", "23:59"],
    ["2026-03-01", "00:00"], // month boundary
    ["2026-02-28", "23:59"],
  ])("%s %s lands on the chosen Dhaka day", (date, time) => {
    expect(dhakaDateKey(ok(date, time))).toBe(date);
  });

  it("00:00 Dhaka is 18:00 UTC of the previous day (the trap a UTC grouping falls into)", () => {
    const at = ok("2026-02-01", "00:00");
    expect(at.toISOString()).toBe("2026-01-31T18:00:00.000Z");
    expect(at.toISOString().slice(0, 10)).not.toBe("2026-02-01"); // UTC day differs
    expect(dhakaDateKey(at)).toBe("2026-02-01");
  });

  it("dhakaDayStart gives the exact UTC instant a Dhaka day begins", () => {
    expect(dhakaDayStart("2026-02-01").toISOString()).toBe("2026-01-31T18:00:00.000Z");
    expect(dhakaDayStart(shiftDays("2026-02-01", 1)).getTime() - dhakaDayStart("2026-02-01").getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });
});
