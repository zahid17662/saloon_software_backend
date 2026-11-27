import { describe, expect, it } from "vitest";
import { guardRoute, safeNext } from "./route-guard";

const none = { hasShop: false, hasAdmin: false };

describe("guardRoute", () => {
  it("sends a device with no cookie from the staff screens to /unlock", () => {
    for (const pathname of ["/pos", "/barber-login/3", "/barber/3", "/receipt/9"]) {
      expect(guardRoute({ pathname, search: "", ...none }), pathname).toEqual({ redirect: "/unlock" });
    }
  });

  it("leaves the public website open", () => {
    expect(guardRoute({ pathname: "/", search: "", ...none })).toBeNull();
    expect(guardRoute({ pathname: "/images/hero.jpg", search: "", ...none })).toBeNull();
    expect(guardRoute({ pathname: "/posters", search: "", ...none })).toBeNull();
  });

  it("lets an unlocked device or an admin through", () => {
    expect(guardRoute({ pathname: "/pos", search: "", hasShop: true, hasAdmin: false })).toBeNull();
    expect(guardRoute({ pathname: "/pos", search: "", hasShop: false, hasAdmin: true })).toBeNull();
  });

  it("always allows /unlock", () => {
    expect(guardRoute({ pathname: "/unlock", search: "", ...none })).toBeNull();
    expect(guardRoute({ pathname: "/unlock", search: "", hasShop: true, hasAdmin: true })).toBeNull();
  });

  it("always allows /admin/login, even with no cookies", () => {
    expect(guardRoute({ pathname: "/admin/login", search: "", ...none })).toBeNull();
  });

  it("redirects /admin/* without an admin cookie to login, keeping the target", () => {
    expect(guardRoute({ pathname: "/admin", search: "", ...none })).toEqual({
      redirect: "/admin/login?next=%2Fadmin",
    });
    expect(guardRoute({ pathname: "/admin/reports", search: "?range=7d", ...none })).toEqual({
      redirect: "/admin/login?next=%2Fadmin%2Freports%3Frange%3D7d",
    });
  });

  it("lets an admin cookie through /admin/*", () => {
    expect(guardRoute({ pathname: "/admin/sales", search: "", hasShop: false, hasAdmin: true })).toBeNull();
  });

  it("does not treat /adminx as an admin path", () => {
    expect(guardRoute({ pathname: "/adminx", search: "", ...none })).toBeNull();
  });
});

describe("safeNext", () => {
  it("accepts admin paths", () => {
    expect(safeNext("/admin")).toBe("/admin");
    expect(safeNext("/admin/reports?range=7d")).toBe("/admin/reports?range=7d");
  });

  it.each([
    [null],
    [""],
    ["//evil.com"],
    ["//admin"],
    ["https://evil.com/admin"],
    ["/adminx"],
    ["/admin/login"],
    ["/admin\\evil"],
    ["/admin/a\nb"],
    ["javascript:alert(1)"],
    ["/barber/1"],
  ])("falls back to /admin for %j", (v) => {
    expect(safeNext(v as string | null)).toBe("/admin");
  });
});
