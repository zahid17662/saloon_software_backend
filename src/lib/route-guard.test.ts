import { describe, expect, it } from "vitest";
import { guardRoute, safeNext } from "./route-guard";

const none = { hasAdmin: false };

describe("guardRoute", () => {
  it("allows barber panel routes directly without a shop cookie", () => {
    expect(guardRoute({ pathname: "/", search: "", ...none })).toBeNull();
    expect(guardRoute({ pathname: "/barber-login/3", search: "", ...none })).toBeNull();
    expect(guardRoute({ pathname: "/barber/3", search: "", ...none })).toBeNull();
    expect(guardRoute({ pathname: "/receipt/9", search: "", ...none })).toBeNull();
  });

  it("redirects /unlock to /", () => {
    expect(guardRoute({ pathname: "/unlock", search: "", ...none })).toEqual({ redirect: "/" });
    expect(guardRoute({ pathname: "/unlock", search: "", hasAdmin: true })).toEqual({ redirect: "/" });
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
    expect(guardRoute({ pathname: "/admin/sales", search: "", hasAdmin: true })).toBeNull();
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
