import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADMIN_COOKIE_TTL_S,
  BARBER_COOKIE_TTL_S,
  SHOP_COOKIE_TTL_S,
  adminPinFingerprint,
  barberPasswordFingerprint,
  changePinInput,
  clearCookieOptions,
  codeSchema,
  cookieName,
  createAdminCookie,
  createBarberCookie,
  createShopCookie,
  sessionCookieOptions,
  signCookie,
  verifyAdminCookie,
  verifyBarberCookie,
  verifyShopCookie,
} from "./auth-core";

const SECRET = "test-secret-0123456789-abcdefghijklmnop"; // throwaway, tests only
const OTHER_SECRET = "another-secret-0123456789-abcdefghijkl";
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const b64 = (s: string) => Buffer.from(s).toString("base64url");
/** Hand-build a correctly signed cookie so we can feed it odd payloads. */
function forge(kind: "shop" | "admin" | "barber", rawPayload: string, secret = SECRET) {
  const p = b64(rawPayload);
  const sig = createHmac("sha256", secret).update(`${kind}.${p}`).digest("base64url");
  return `${p}.${sig}`;
}

describe("cookie sign / verify", () => {
  it("round-trips a shop cookie", () => {
    const { value } = createShopCookie(3, SECRET, NOW);
    expect(verifyShopCookie(value, SECRET, NOW)).toEqual({
      v: 3,
      exp: Math.floor(NOW / 1000) + SHOP_COOKIE_TTL_S,
    });
  });

  it("round-trips an admin cookie", () => {
    const { value } = createAdminCookie("fp123", SECRET, NOW);
    expect(verifyAdminCookie(value, SECRET, NOW)).toEqual({
      pv: "fp123",
      exp: Math.floor(NOW / 1000) + ADMIN_COOKIE_TTL_S,
    });
  });

  it("uses 180 days for the shop cookie and 8 hours for the admin cookie", () => {
    expect(SHOP_COOKIE_TTL_S).toBe(180 * 24 * 60 * 60);
    expect(ADMIN_COOKIE_TTL_S).toBe(8 * 60 * 60);
    expect(createShopCookie(1, SECRET, NOW).maxAge).toBe(SHOP_COOKIE_TTL_S);
    expect(createAdminCookie("x", SECRET, NOW).maxAge).toBe(ADMIN_COOKIE_TTL_S);
  });

  it("round-trips a barber cookie", () => {
    const { value } = createBarberCookie(7, "fp456", SECRET, NOW);
    expect(verifyBarberCookie(value, SECRET, NOW)).toEqual({
      barberId: 7,
      bv: "fp456",
      exp: Math.floor(NOW / 1000) + BARBER_COOKIE_TTL_S,
    });
  });

  it("uses a short 12-hour TTL for the barber cookie (shared-device threat model)", () => {
    expect(BARBER_COOKIE_TTL_S).toBe(12 * 60 * 60);
    expect(createBarberCookie(1, "x", SECRET, NOW).maxAge).toBe(BARBER_COOKIE_TTL_S);
  });
});

describe("tampering", () => {
  it("rejects a modified payload that keeps the old signature", () => {
    const { value } = createShopCookie(1, SECRET, NOW);
    const sig = value.split(".")[1];
    const evil = `${b64(JSON.stringify({ v: 99, exp: Math.floor(NOW / 1000) + 999999 }))}.${sig}`;
    expect(verifyShopCookie(evil, SECRET, NOW)).toBeNull();
  });

  it("rejects a modified signature", () => {
    const { value } = createShopCookie(1, SECRET, NOW);
    const last = value.slice(-1);
    const flipped = value.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(verifyShopCookie(flipped, SECRET, NOW)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const { value } = createShopCookie(1, OTHER_SECRET, NOW);
    expect(verifyShopCookie(value, SECRET, NOW)).toBeNull();
  });

  it("does not accept a shop cookie as an admin cookie, or the reverse", () => {
    const shop = createShopCookie(1, SECRET, NOW).value;
    const admin = createAdminCookie("fp", SECRET, NOW).value;
    expect(verifyAdminCookie(shop, SECRET, NOW)).toBeNull();
    expect(verifyShopCookie(admin, SECRET, NOW)).toBeNull();
  });

  it("does not accept a barber cookie as a shop or admin cookie, or the reverse", () => {
    const barber = createBarberCookie(1, "fp", SECRET, NOW).value;
    const shop = createShopCookie(1, SECRET, NOW).value;
    expect(verifyShopCookie(barber, SECRET, NOW)).toBeNull();
    expect(verifyAdminCookie(barber, SECRET, NOW)).toBeNull();
    expect(verifyBarberCookie(shop, SECRET, NOW)).toBeNull();
  });

  it("does not accept an admin payload signed under the shop kind", () => {
    const payload = JSON.stringify({ pv: "fp", exp: Math.floor(NOW / 1000) + 100 });
    const wrongKind = forge("shop", payload);
    expect(verifyAdminCookie(wrongKind, SECRET, NOW)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["no dot", "abcdef"],
    ["only a dot", "."],
    ["three parts", "a.b.c"],
    ["not base64", "!!!.???"],
    ["huge", "a".repeat(5000) + "." + "b".repeat(5000)],
  ])("returns null for malformed input: %s", (_n, v) => {
    expect(verifyShopCookie(v, SECRET, NOW)).toBeNull();
    expect(verifyAdminCookie(v, SECRET, NOW)).toBeNull();
  });

  it("returns null for a correctly signed non-JSON payload", () => {
    expect(verifyShopCookie(forge("shop", "not json"), SECRET, NOW)).toBeNull();
  });

  it("returns null for a correctly signed payload with the wrong shape", () => {
    const exp = Math.floor(NOW / 1000) + 100;
    expect(verifyShopCookie(forge("shop", JSON.stringify({ v: "1", exp })), SECRET, NOW)).toBeNull();
    expect(verifyShopCookie(forge("shop", JSON.stringify({ v: -1, exp })), SECRET, NOW)).toBeNull();
    expect(verifyShopCookie(forge("shop", JSON.stringify({ exp })), SECRET, NOW)).toBeNull();
    expect(verifyAdminCookie(forge("admin", JSON.stringify({ pv: "", exp })), SECRET, NOW)).toBeNull();
  });
});

describe("expiry", () => {
  it("is valid one second before exp and invalid at exp", () => {
    const { value } = createAdminCookie("fp", SECRET, NOW);
    const exp = Math.floor(NOW / 1000) + ADMIN_COOKIE_TTL_S;
    expect(verifyAdminCookie(value, SECRET, (exp - 1) * 1000)).not.toBeNull();
    expect(verifyAdminCookie(value, SECRET, exp * 1000)).toBeNull();
    expect(verifyAdminCookie(value, SECRET, (exp + 3600) * 1000)).toBeNull();
  });

  it("expires the admin cookie after 8 hours even though the shop cookie lasts longer", () => {
    const later = NOW + 9 * 60 * 60 * 1000;
    expect(verifyAdminCookie(createAdminCookie("fp", SECRET, NOW).value, SECRET, later)).toBeNull();
    expect(verifyShopCookie(createShopCookie(1, SECRET, NOW).value, SECRET, later)).not.toBeNull();
  });
});

describe("secret handling", () => {
  it("refuses to sign or verify with a short secret", () => {
    expect(() => signCookie("shop", { v: 1, exp: 1 }, "short")).toThrow();
    expect(() => verifyShopCookie("a.b", "short", NOW)).toThrow();
  });

  it("refuses an undefined or empty secret", () => {
    expect(() => verifyShopCookie("a.b", undefined as unknown as string, NOW)).toThrow();
    expect(() => verifyShopCookie("a.b", "", NOW)).toThrow();
  });
});

describe("adminPinFingerprint", () => {
  const HASH = "$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz0123456";
  it("is deterministic and never contains the hash", () => {
    const a = adminPinFingerprint(HASH, SECRET);
    expect(a).toBe(adminPinFingerprint(HASH, SECRET));
    expect(HASH.includes(a)).toBe(false);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
  it("changes when the hash or the secret changes", () => {
    const a = adminPinFingerprint(HASH, SECRET);
    expect(adminPinFingerprint(HASH + "x", SECRET)).not.toBe(a);
    expect(adminPinFingerprint(HASH, OTHER_SECRET)).not.toBe(a);
  });
});

describe("barberPasswordFingerprint", () => {
  const HASH = "$2b$12$zyxwvutsrqponmlkjihgfezyxwvutsrqponmlkjihgfedcba012345";
  it("is deterministic and never contains the hash", () => {
    const a = barberPasswordFingerprint(HASH, SECRET);
    expect(a).toBe(barberPasswordFingerprint(HASH, SECRET));
    expect(HASH.includes(a)).toBe(false);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
  it("changes when the hash or the secret changes - this is what invalidates old sessions on password change", () => {
    const a = barberPasswordFingerprint(HASH, SECRET);
    expect(barberPasswordFingerprint(HASH + "x", SECRET)).not.toBe(a);
    expect(barberPasswordFingerprint(HASH, OTHER_SECRET)).not.toBe(a);
  });
});

describe("cookieName", () => {
  it("adds the __Host- prefix only when secure", () => {
    expect(cookieName("shop", true)).toBe("__Host-salon_shop");
    expect(cookieName("admin", true)).toBe("__Host-salon_admin");
    expect(cookieName("barber", true)).toBe("__Host-salon_barber");
    expect(cookieName("shop", false)).toBe("salon_shop");
    expect(cookieName("admin", false)).toBe("salon_admin");
    expect(cookieName("barber", false)).toBe("salon_barber");
  });
});

describe("cookie options", () => {
  it("session cookies are httpOnly, SameSite=Lax, path=/ and Secure only when asked", () => {
    expect(sessionCookieOptions(true, 60)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60,
    });
    expect(sessionCookieOptions(false, 60).secure).toBe(false);
  });

  it("clearing a cookie uses the same attributes as setting it and expires it in the past", () => {
    // A __Host- cookie deleted without Secure is silently ignored by browsers, so logout would
    // do nothing in production. The delete must carry the same attributes as the set.
    for (const secure of [true, false]) {
      const set = sessionCookieOptions(secure, 123);
      const clear = clearCookieOptions(secure);
      expect(clear).toMatchObject({
        httpOnly: set.httpOnly,
        secure: set.secure,
        sameSite: set.sameSite,
        path: set.path,
        maxAge: 0,
      });
      expect(clear.expires.getTime()).toBe(0);
    }
  });
});

describe("input schemas", () => {
  it("accepts 4-8 digit codes and trims whitespace", () => {
    expect(codeSchema.parse("1234")).toBe("1234");
    expect(codeSchema.parse(" 12345678 ")).toBe("12345678");
  });
  it.each(["", "12", "123456789", "12ab", "12 34", "১২৩৪"])("rejects %j", (v) => {
    expect(codeSchema.safeParse(v).success).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(codeSchema.safeParse(1234).success).toBe(false);
    expect(codeSchema.safeParse(null).success).toBe(false);
  });
  it("validates the change-PIN input", () => {
    expect(changePinInput.safeParse({ current: "0000", next: "4321" }).success).toBe(true);
    expect(changePinInput.safeParse({ current: "0000", next: "12" }).success).toBe(false);
    expect(changePinInput.safeParse({ current: "0000" }).success).toBe(false);
  });
});
