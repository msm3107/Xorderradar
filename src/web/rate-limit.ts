import { isIP } from "node:net";

/**
 * The per-IP limit of „Wyślij mi link” (D-031). In memory, in the one web
 * process: a restart forgets it, which is acceptable because the limit that
 * protects a profile's mailbox (3 links per 24 hours) is counted in the
 * database. This one only slows down a single client trying many addresses;
 * it counts an IPv6 client by its /64 (rateLimitKey).
 */

export interface RateLimiterOptions {
  /** Requests allowed per key and window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Most keys remembered. When full, the key with the oldest window is
   * forgotten first: memory stays bounded whatever a flood of addresses
   * does; the cost is that such a flood can reset another key's count.
   */
  readonly maxEntries: number;
  /** A monotonic clock in milliseconds (tests). Default: performance.now(). */
  readonly now?: () => number;
}

export interface RateLimiter {
  /** Counts one request of `key`; false (not counted) when its window is full. */
  allow(key: string): boolean;
  /** Keys remembered now (tests). */
  readonly size: number;
}

/**
 * A fixed window per key, opened by its first request. The Map keeps
 * insertion order, and a key is re-inserted only when it opens a new window,
 * so the entries are ordered by window start: expired ones are always at the
 * front, and evicting the first entry evicts the oldest window.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => performance.now());
  const windows = new Map<string, { readonly start: number; count: number }>();
  return {
    allow(key) {
      const time = now();
      for (const [oldKey, entry] of windows) {
        if (time - entry.start < options.windowMs) break;
        windows.delete(oldKey);
      }
      const current = windows.get(key);
      if (current !== undefined) {
        if (current.count >= options.limit) return false;
        current.count += 1;
        return true;
      }
      while (windows.size >= options.maxEntries) {
        const oldest = windows.keys().next();
        if (oldest.done === true) break;
        windows.delete(oldest.value);
      }
      windows.set(key, { start: time, count: 1 });
      return true;
    },
    get size() {
      return windows.size;
    },
  };
}

/** Peer addresses of the reverse proxy on the same host (deploy/Caddyfile). */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The client address the per-IP limit counts (D-031). Behind the reverse
 * proxy on the same host the TCP peer is loopback for every request: then
 * the address is the last entry of X-Forwarded-For, the one the proxy
 * itself appended (Caddy replaces a client-sent header unless trusted
 * proxies are configured, docs/DEPLOY.md). A peer that is not loopback is a
 * direct client: its own header is ignored. Not an address (absent or
 * malformed header): the peer address, so all such requests share one count.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
): string {
  const socket = normalizeAddress(peer ?? "");
  if (!LOOPBACK.has(socket)) return socket;
  const header = typeof forwardedFor === "string" ? forwardedFor : forwardedFor?.at(-1);
  const last = header?.split(",").at(-1)?.trim() ?? "";
  return isIP(last) === 0 ? socket : normalizeAddress(last);
}

/** An IPv4-mapped IPv6 address as plain IPv4; IPv6 lower-cased. */
function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return mapped?.[1] ?? lower;
}

/**
 * The key the per-IP limit counts a client address under (D-031). IPv4: the
 * address. Native IPv6: its /64 prefix, the smallest block a provider hands
 * one customer — a client rotating the interface half of its addresses still
 * has one count (and one entry in the limiter's map). Every spelling of an
 * IPv6 address ("::" compression, leading zeros, case, a zone id) gives the
 * same key, and an IPv4-mapped one (::ffff:a.b.c.d in any spelling) is its
 * IPv4 address. Not an address (an absent peer): kept as it is.
 */
export function rateLimitKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  const [, , , , , mapped, high = 0, low = 0] = groups;
  if (mapped === 0xffff && groups.slice(0, 5).every((group) => group === 0)) {
    return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (isIP() === 6). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split("%", 1)[0] ?? "";
  // An embedded IPv4 tail (::ffff:192.0.2.1, 64:ff9b::192.0.2.1) as its two groups.
  const ipv4 = /\d+\.\d+\.\d+\.\d+$/.exec(text)?.[0];
  if (ipv4 !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = ipv4.split(".").map(Number);
    const tail = [a * 256 + b, c * 256 + d].map((group) => group.toString(16)).join(":");
    text = text.slice(0, -ipv4.length) + tail;
  }
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  const [head, tail] = text.split("::");
  const front = parse(head);
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}
