import { describe, expect, it } from "vitest";
import {
  GLOBAL_MAX_ATTEMPTS,
  MAX_FAILURES,
  WINDOW_MS,
  beginAttempt,
  normalizeIp,
  recordSuccess,
  type AttemptStore,
} from "./rate-limit";

class FakeStore implements AttemptStore {
  rows: { id: number; ip: string; kind: string; at: Date }[] = [];
  private seq = 0;

  async insert(ip: string, kind: string, at: Date) {
    await Promise.resolve(); // yield, so parallel callers interleave like real I/O
    const id = ++this.seq;
    this.rows.push({ id, ip, kind, at });
    return id;
  }
  async countSince(ip: string, kind: string, since: Date) {
    await Promise.resolve();
    return this.rows.filter((r) => r.ip === ip && r.kind === kind && r.at > since).length;
  }
  async countKindSince(kind: string, since: Date) {
    await Promise.resolve();
    return this.rows.filter((r) => r.kind === kind && r.at > since).length;
  }
  async remove(id: number) {
    await Promise.resolve();
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  async clear(ip: string, kind: string) {
    await Promise.resolve();
    this.rows = this.rows.filter((r) => !(r.ip === ip && r.kind === kind));
  }
}

const T0 = new Date("2026-01-15T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("rate limit constants", () => {
  it("is 5 failures per 15 minutes", () => {
    expect(MAX_FAILURES).toBe(5);
    expect(WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe("beginAttempt", () => {
  it("allows 5 failed attempts and blocks the 6th", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 5; i++) {
      const r = await beginAttempt(store, "1.1.1.1", "shop", at(i * 1000));
      expect(r.allowed).toBe(true);
    }
    const sixth = await beginAttempt(store, "1.1.1.1", "shop", at(6000));
    expect(sixth.allowed).toBe(false);
  });

  it("does not store blocked attempts, so a lockout never extends itself", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 5; i++) await beginAttempt(store, "1.1.1.1", "shop", at(i));
    for (let i = 0; i < 20; i++) {
      expect((await beginAttempt(store, "1.1.1.1", "shop", at(10 * 60 * 1000 + i))).allowed).toBe(false);
    }
    expect(store.rows).toHaveLength(5);
    // 15 minutes after the first failure the window has moved on.
    const later = await beginAttempt(store, "1.1.1.1", "shop", at(WINDOW_MS + 10));
    expect(later.allowed).toBe(true);
  });

  it("treats exactly 15 minutes as outside the window", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 5; i++) await beginAttempt(store, "1.1.1.1", "shop", T0);
    expect((await beginAttempt(store, "1.1.1.1", "shop", at(WINDOW_MS - 1))).allowed).toBe(false);
    expect((await beginAttempt(store, "1.1.1.1", "shop", at(WINDOW_MS))).allowed).toBe(true);
  });

  it("limits each IP separately", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 6; i++) await beginAttempt(store, "1.1.1.1", "shop", at(i));
    expect((await beginAttempt(store, "1.1.1.1", "shop", at(10))).allowed).toBe(false);
    expect((await beginAttempt(store, "2.2.2.2", "shop", at(10))).allowed).toBe(true);
  });

  it("limits each kind separately", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 6; i++) await beginAttempt(store, "1.1.1.1", "shop", at(i));
    expect((await beginAttempt(store, "1.1.1.1", "admin", at(10))).allowed).toBe(true);
  });

  it("cannot be beaten by parallel guesses", async () => {
    const store = new FakeStore();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => beginAttempt(store, "9.9.9.9", "admin", T0)),
    );
    expect(results.filter((r) => r.allowed).length).toBeLessThanOrEqual(MAX_FAILURES);
    expect(store.rows.length).toBeLessThanOrEqual(MAX_FAILURES);
  });
});

describe("global per-kind cap (many IPs cannot brute-force a 4-digit code)", () => {
  it("blocks once too many attempts arrive in the window, whatever the IP", async () => {
    const store = new FakeStore();
    for (let i = 0; i < GLOBAL_MAX_ATTEMPTS; i++) {
      expect((await beginAttempt(store, `10.0.0.${i}`, "admin", at(i))).allowed).toBe(true);
    }
    expect((await beginAttempt(store, "10.9.9.9", "admin", at(1000))).allowed).toBe(false);
    expect(store.rows).toHaveLength(GLOBAL_MAX_ATTEMPTS); // the blocked attempt is not stored
  });

  it("does not affect the other kind", async () => {
    const store = new FakeStore();
    for (let i = 0; i < GLOBAL_MAX_ATTEMPTS + 1; i++) await beginAttempt(store, `10.0.0.${i}`, "admin", at(i));
    expect((await beginAttempt(store, "10.9.9.9", "shop", at(1000))).allowed).toBe(true);
  });

  it("recovers once the window has passed", async () => {
    const store = new FakeStore();
    for (let i = 0; i < GLOBAL_MAX_ATTEMPTS + 1; i++) await beginAttempt(store, `10.0.0.${i}`, "admin", T0);
    expect((await beginAttempt(store, "10.9.9.9", "admin", at(WINDOW_MS))).allowed).toBe(true);
  });
});

describe("normalizeIp", () => {
  it("keeps IPv4 addresses as they are", () => {
    expect(normalizeIp("203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIp(" 203.0.113.5 ")).toBe("203.0.113.5");
  });

  it("maps an IPv4-mapped IPv6 address to the IPv4 address", () => {
    expect(normalizeIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
  });

  it("collapses every address in the same IPv6 /64 into one key", () => {
    const a = normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const b = normalizeIp("2001:0db8:0001:0002::1");
    const c = normalizeIp("2001:DB8:1:2:ffff:ffff:ffff:ffff");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("gives different /64 networks different keys", () => {
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(normalizeIp("2001:db8:1:2::1"));
  });

  it("handles compressed and zone-id forms", () => {
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it.each(["", "unknown", "1.2.3", "999.1.1.1", "1.2.3.4.5", "2001:db8::1::2", "gggg::1", "'; drop table x;--"])(
    "returns null for %j",
    (v) => {
      expect(normalizeIp(v)).toBeNull();
    },
  );
});

describe("recordSuccess", () => {
  it("clears the failures for that IP and kind only", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 4; i++) await beginAttempt(store, "1.1.1.1", "shop", at(i));
    await beginAttempt(store, "1.1.1.1", "admin", at(5));
    await beginAttempt(store, "2.2.2.2", "shop", at(6));

    await recordSuccess(store, "1.1.1.1", "shop");

    expect(store.rows.filter((r) => r.ip === "1.1.1.1" && r.kind === "shop")).toHaveLength(0);
    expect(store.rows.filter((r) => r.ip === "1.1.1.1" && r.kind === "admin")).toHaveLength(1);
    expect(store.rows.filter((r) => r.ip === "2.2.2.2")).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      expect((await beginAttempt(store, "1.1.1.1", "shop", at(100 + i))).allowed).toBe(true);
    }
  });
});
