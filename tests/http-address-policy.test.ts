import { describe, expect, it } from "vitest";
import {
  isBlockedAddress,
  normalizeAllowedHosts,
  parseRequestUrl,
} from "../src/infrastructure/http/address-policy.js";
import { HttpClientError, type HttpClientErrorCode } from "../src/infrastructure/http/errors.js";

describe("isBlockedAddress — IPv4", () => {
  // First, an inner and the last address of every blocked range.
  it.each([
    ["0.0.0.0/8", ["0.0.0.0", "0.1.2.3", "0.255.255.255"]],
    ["10.0.0.0/8", ["10.0.0.0", "10.20.30.40", "10.255.255.255"]],
    ["100.64.0.0/10", ["100.64.0.0", "100.100.1.1", "100.127.255.255"]],
    ["127.0.0.0/8", ["127.0.0.0", "127.0.0.1", "127.255.255.255"]],
    ["169.254.0.0/16", ["169.254.0.0", "169.254.169.254", "169.254.255.255"]],
    ["172.16.0.0/12", ["172.16.0.0", "172.20.1.1", "172.31.255.255"]],
    ["192.0.0.0/24", ["192.0.0.0", "192.0.0.8", "192.0.0.255"]],
    ["192.0.2.0/24", ["192.0.2.0", "192.0.2.10", "192.0.2.255"]],
    ["192.88.99.0/24", ["192.88.99.0", "192.88.99.1", "192.88.99.255"]],
    ["192.168.0.0/16", ["192.168.0.0", "192.168.1.1", "192.168.255.255"]],
    ["198.18.0.0/15", ["198.18.0.0", "198.18.200.1", "198.19.255.255"]],
    ["198.51.100.0/24", ["198.51.100.0", "198.51.100.7", "198.51.100.255"]],
    ["203.0.113.0/24", ["203.0.113.0", "203.0.113.9", "203.0.113.255"]],
    ["224.0.0.0/4 multicast", ["224.0.0.0", "239.1.2.3", "239.255.255.255"]],
    ["240.0.0.0/4 reserved + broadcast", ["240.0.0.0", "250.1.1.1", "255.255.255.255"]],
  ])("blocks %s", (_range, addresses) => {
    for (const address of addresses) expect(isBlockedAddress(address), address).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("allows public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("isBlockedAddress — IPv6", () => {
  it.each([
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback (hex)", "::ffff:7f00:1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["IPv4-mapped public (mapped form is blocked as a whole)", "::ffff:8.8.8.8"],
    ["IPv4-compatible (deprecated)", "::127.0.0.1"],
    ["NAT64 64:ff9b::/96", "64:ff9b::808:808"],
    ["NAT64 local-use 64:ff9b:1::/48", "64:ff9b:1::1"],
    ["discard 100::/64", "100::1"],
    ["IETF assignments 2001::/23 (Teredo)", "2001:0:4136:e378::1"],
    ["IETF assignments 2001::/23 (benchmarking)", "2001:2::1"],
    ["IETF assignments 2001::/23 (ORCHIDv2)", "2001:20::1"],
    ["documentation 2001:db8::/32", "2001:db8::1"],
    ["documentation 2001:db8::/32 (last)", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["6to4 2002::/16", "2002:c0a8:101::1"],
    ["documentation 3fff::/20", "3fff::1"],
    ["unique local fc00::/7 (fc)", "fc00::1"],
    ["unique local fc00::/7 (fd)", "fd12:3456:789a::1"],
    ["link-local fe80::/10", "fe80::1"],
    ["link-local fe80::/10 (upper case)", "FE80::ABCD"],
    ["link-local fe80::/10 (last block)", "febf::1"],
    ["site-local (deprecated) fec0::/10", "fec0::1"],
    ["multicast ff00::/8", "ff02::1"],
    ["outside 2000::/3", "4000::1"],
    ["with zone index", "fe80::1%eth0"],
  ])("blocks %s: %s", (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["2001:4860:4860::8888", "2a00:1450:4001:82a::200e", "2606:4700::1111", "2001:200::1"])(
    "allows global unicast %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("isBlockedAddress — not an address", () => {
  it.each(["", "localhost", "example.org", "1.2.3", "256.1.1.1", "1.2.3.4 ", "[::1]"])(
    "fails closed for %j",
    (value) => {
      expect(isBlockedAddress(value)).toBe(true);
    },
  );
});

describe("normalizeAllowedHosts", () => {
  it("lowercases exact hostnames", () => {
    expect([...normalizeAllowedHosts(["Example.ORG", "api.example.org"])]).toEqual([
      "example.org",
      "api.example.org",
    ]);
  });

  it.each([
    "",
    "*.example.org",
    "example.org:8443",
    "https://example.org",
    "example.org/path",
    "127.0.0.1",
    "[::1]",
    "::1",
    "user@example.org",
    "exa mple.org",
  ])("rejects %j", (host) => {
    expect(() => normalizeAllowedHosts([host])).toThrow(TypeError);
  });

  it("rejects an empty allowlist", () => {
    expect(() => normalizeAllowedHosts([])).toThrow(TypeError);
  });
});

function errorOf(fn: () => unknown): HttpClientError {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpClientError);
    return error as HttpClientError;
  }
  throw new Error("expected an HttpClientError");
}

function codeOf(fn: () => unknown): HttpClientErrorCode {
  return errorOf(fn).code;
}

describe("parseRequestUrl", () => {
  const allowed = normalizeAllowedHosts(["example.org", "localhost"]);

  it("accepts an allowlisted https URL, keeps the query and drops the fragment", () => {
    const url = parseRequestUrl("https://EXAMPLE.org/a/b?x=1&y=2#frag", allowed);
    expect(url.href).toBe("https://example.org/a/b?x=1&y=2");
  });

  it("treats the explicit default port as the default port", () => {
    expect(parseRequestUrl("https://example.org:443/", allowed).href).toBe("https://example.org/");
  });

  it("resolves a relative URL against a base", () => {
    const base = new URL("https://example.org/list/page?p=1");
    expect(parseRequestUrl("../detail/7", allowed, base).href).toBe("https://example.org/detail/7");
    expect(parseRequestUrl("//example.org/x", allowed, base).href).toBe("https://example.org/x");
  });

  it.each([
    ["not a URL", "not a url"],
    ["http scheme", "http://example.org/"],
    ["ftp scheme", "ftp://example.org/"],
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["credentials", "https://user:pass@example.org/"],
    ["username only", "https://user@example.org/"],
    ["userinfo trick", "https://example.org@evil.example/"],
    ["non-default port", "https://example.org:8443/"],
    ["port 80 on https", "https://example.org:80/"],
    ["IPv4 literal", "https://127.0.0.1/"],
    ["IPv4 literal (public)", "https://8.8.8.8/"],
    ["IPv4 shorthand (hex)", "https://0x7f.1/"],
    ["IPv4 as integer", "https://2130706433/"],
    ["IPv6 literal", "https://[::1]/"],
    ["IPv6 mapped literal", "https://[::ffff:127.0.0.1]/"],
  ])("rejects %s as invalid_url", (_label, input) => {
    expect(codeOf(() => parseRequestUrl(input, allowed))).toBe("invalid_url");
  });

  it.each([
    ["other host", "https://evil.example/"],
    ["subdomain of an allowed host", "https://api.example.org/"],
    ["suffix lookalike", "https://example.org.evil.example/"],
    ["trailing dot (not an exact match)", "https://example.org./"],
    ["backslash authority", "https:\\\\evil.example\\path"],
  ])("rejects %s as host_not_allowed", (_label, input) => {
    expect(codeOf(() => parseRequestUrl(input, allowed))).toBe("host_not_allowed");
  });

  it("does not put the URL or its query into the error message", () => {
    // errorOf throws when nothing is thrown, so this cannot pass vacuously.
    const error = errorOf(() => parseRequestUrl("https://evil.example/path?token=s3cr3t", allowed));
    expect(error.code).toBe("host_not_allowed");
    expect(error.message).not.toContain("s3cr3t");
    expect(error.message).not.toContain("/path");
    expect(error.host).toBe("evil.example");
  });
});
