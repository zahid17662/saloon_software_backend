import { afterEach, describe, expect, it } from "vitest";
import { dhakaDateKey, dhakaDayStart, dhakaMonthKey, inRange, presetRange, shiftDays, todayKey } from "./time";

// BR-5 (docs/PRD.md §6) and acceptance criterion 7 (§12): days and months are Asia/Dhaka (UTC+6).
// Dhaka midnight = 18:00 UTC of the previous day.

describe("Dhaka day boundary", () => {
  it("23:59 Dhaka is still the old day, 00:01 Dhaka is the new day", () => {
    expect(dhakaDateKey("2026-03-10T17:59:00Z")).toBe("2026-03-10"); // 23:59 Dhaka
    expect(dhakaDateKey("2026-03-10T18:00:00Z")).toBe("2026-03-11"); // 00:00 Dhaka
    expect(dhakaDateKey("2026-03-10T18:01:00Z")).toBe("2026-03-11"); // 00:01 Dhaka
  });

  it("the last millisecond of a Dhaka day belongs to that day", () => {
    expect(dhakaDateKey("2026-03-10T17:59:59.999Z")).toBe("2026-03-10");
    expect(dhakaDateKey("2026-03-10T18:00:00.000Z")).toBe("2026-03-11");
  });

  it("works for Date objects as well as ISO strings", () => {
    expect(dhakaDateKey(new Date("2026-03-10T17:59:00Z"))).toBe("2026-03-10");
    expect(dhakaDateKey(new Date("2026-03-10T18:01:00Z"))).toBe("2026-03-11");
  });

  it("the UTC date and the Dhaka date differ for the 6 hours before UTC midnight", () => {
    // 20:00 UTC on the 10th is 02:00 on the 11th in Dhaka.
    expect(new Date("2026-03-10T20:00:00Z").toISOString().slice(0, 10)).toBe("2026-03-10");
    expect(dhakaDateKey("2026-03-10T20:00:00Z")).toBe("2026-03-11");
  });
});

describe("Dhaka month and year change", () => {
  it("23:59 on the last day of a month stays in that month; 00:01 is the next month", () => {
    expect(dhakaMonthKey("2026-03-31T17:59:00Z")).toBe("2026-03"); // Mar 31 23:59 Dhaka
    expect(dhakaMonthKey("2026-03-31T18:01:00Z")).toBe("2026-04"); // Apr 1 00:01 Dhaka
    expect(dhakaDateKey("2026-03-31T18:01:00Z")).toBe("2026-04-01");
  });

  it("a sale at 20:00 UTC on the last UTC day of a month is already the next month in Dhaka", () => {
    expect(new Date("2026-03-31T20:00:00Z").toISOString().slice(0, 7)).toBe("2026-03");
    expect(dhakaMonthKey("2026-03-31T20:00:00Z")).toBe("2026-04");
  });

  it("year change", () => {
    expect(dhakaDateKey("2026-12-31T17:59:00Z")).toBe("2026-12-31");
    expect(dhakaDateKey("2026-12-31T18:01:00Z")).toBe("2027-01-01");
    expect(dhakaMonthKey("2026-12-31T18:01:00Z")).toBe("2027-01");
  });

  it("leap day: 2028-02-29 exists, 2026 has no Feb 29", () => {
    expect(dhakaDateKey("2028-02-28T18:30:00Z")).toBe("2028-02-29");
    expect(dhakaDateKey("2028-02-29T18:30:00Z")).toBe("2028-03-01");
    expect(dhakaDateKey("2026-02-28T18:30:00Z")).toBe("2026-03-01");
    expect(shiftDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("dhakaDayStart and inRange", () => {
  it("a day starts at 18:00 UTC of the day before and lasts exactly 24 hours (no DST)", () => {
    expect(dhakaDayStart("2026-03-11").toISOString()).toBe("2026-03-10T18:00:00.000Z");
    expect(dhakaDayStart("2026-03-12").getTime() - dhakaDayStart("2026-03-11").getTime()).toBe(86_400_000);
    // Across a month and a year edge too.
    expect(dhakaDayStart("2027-01-01").getTime() - dhakaDayStart("2026-12-31").getTime()).toBe(86_400_000);
  });

  it("inRange includes both end days and excludes the neighbours, by Dhaka day", () => {
    const range = { from: "2026-03-10", to: "2026-03-11" };
    expect(inRange("2026-03-09T17:59:00Z", range)).toBe(false); // Mar 9 23:59 Dhaka
    expect(inRange("2026-03-09T18:00:00Z", range)).toBe(true); // Mar 10 00:00 Dhaka
    expect(inRange("2026-03-11T17:59:00Z", range)).toBe(true); // Mar 11 23:59 Dhaka
    expect(inRange("2026-03-11T18:00:00Z", range)).toBe(false); // Mar 12 00:00 Dhaka
  });
});

describe("presets at the Dhaka midnight", () => {
  it("'today' flips at 18:00 UTC, not at 00:00 UTC", () => {
    expect(presetRange("today", new Date("2026-03-10T17:59:00Z"))).toEqual({ from: "2026-03-10", to: "2026-03-10" });
    expect(presetRange("today", new Date("2026-03-10T18:00:00Z"))).toEqual({ from: "2026-03-11", to: "2026-03-11" });
  });

  it("'yesterday' and 'this month' follow the Dhaka date on the first of a month", () => {
    const now = new Date("2026-03-31T18:30:00Z"); // Apr 1 00:30 Dhaka
    expect(presetRange("yesterday", now)).toEqual({ from: "2026-03-31", to: "2026-03-31" });
    expect(presetRange("month", now)).toEqual({ from: "2026-04-01", to: "2026-04-01" });
  });
});

describe("'today' does not depend on the server's own timezone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  // 20:00 UTC on Mar 10 = 02:00 Mar 11 in Dhaka, whatever the host clock zone is.
  const instant = new Date("2026-03-10T20:00:00Z");

  it.each(["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Dhaka"])("server TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(todayKey(instant)).toBe("2026-03-11");
    expect(dhakaDateKey(instant)).toBe("2026-03-11");
    expect(dhakaMonthKey("2026-03-31T20:00:00Z")).toBe("2026-04");
    expect(dhakaDayStart("2026-03-11").toISOString()).toBe("2026-03-10T18:00:00.000Z");
    expect(presetRange("today", instant)).toEqual({ from: "2026-03-11", to: "2026-03-11" });
  });
});
