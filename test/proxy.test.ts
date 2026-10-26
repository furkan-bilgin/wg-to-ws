import { describe, expect, test } from "bun:test";
import { forwardedClientIp, normalizeIp } from "../src/shared";

describe("forwardedClientIp", () => {
  test("uses the last hop appended by the proxy", () => {
    expect(forwardedClientIp("1.2.3.4, 5.6.7.8")).toBe("5.6.7.8");
  });

  test("ignores a spoofed first hop", () => {
    expect(forwardedClientIp("127.0.0.1, 203.0.113.9")).toBe("203.0.113.9");
  });

  test("normalizes IPv6 and mapped addresses", () => {
    expect(forwardedClientIp("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(forwardedClientIp("[2001:db8::1]")).toBe("2001:db8::1");
  });

  test("rejects absent, empty, and malformed values", () => {
    expect(forwardedClientIp(null)).toBeNull();
    expect(forwardedClientIp("")).toBeNull();
    expect(forwardedClientIp("not-an-ip")).toBeNull();
    expect(forwardedClientIp("1.2.3.4,")).toBeNull();
    expect(forwardedClientIp("1.2.3.4, unknown")).toBeNull();
    expect(forwardedClientIp("1.2.3.4" + " ".repeat(1100))).toBeNull();
  });

  test("normalizeIp stays compatible", () => {
    expect(normalizeIp(" ::FFFF:10.0.0.1 ")).toBe("10.0.0.1");
  });
});
