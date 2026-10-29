import { BlockList, isIP } from "node:net";
import { HttpClientError } from "./errors.js";

/**
 * IPv4 ranges that must never be a fetch target: "this network", private
 * (RFC 1918), CGNAT, loopback, link-local (incl. cloud metadata 169.254.169.254),
 * IETF protocol assignments, documentation, 6to4 relay, benchmarking, multicast,
 * reserved and broadcast.
 */
const blockedIpv4Subnets: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4], // includes 255.255.255.255
];

/**
 * IPv6 is checked the stricter way round: only global unicast 2000::/3 is
 * allowed at all. That already excludes ::, ::1, IPv4-mapped ::ffff:0:0/96,
 * NAT64 64:ff9b::/96, discard 100::/64, ULA fc00::/7, link-local fe80::/10 and
 * multicast ff00::/8. Inside 2000::/3 these special-purpose blocks are removed:
 * IETF protocol assignments 2001::/23 (Teredo, benchmarking, ORCHID, ...),
 * documentation 2001:db8::/32 and 3fff::/20, and 6to4 2002::/16 (embeds an
 * arbitrary, possibly private, IPv4 address).
 */
const allowedIpv6Subnets: readonly (readonly [string, number])[] = [["2000::", 3]];
const blockedIpv6Subnets: readonly (readonly [string, number])[] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

function buildList(subnets: readonly (readonly [string, number])[], type: "ipv4" | "ipv6") {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, type);
  return list;
}

const blockedIpv4 = buildList(blockedIpv4Subnets, "ipv4");
const allowedIpv6 = buildList(allowedIpv6Subnets, "ipv6");
const blockedIpv6 = buildList(blockedIpv6Subnets, "ipv6");

/**
 * True when a resolved address must not be connected to. Fails closed: anything
 * that is not a plain IPv4/IPv6 address (including IPv6 with a zone index such
 * as `fe80::1%eth0`) is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  if (address.includes("%")) return true;
  switch (isIP(address)) {
    case 4:
      return blockedIpv4.check(address, "ipv4");
    case 6:
      return !allowedIpv6.check(address, "ipv6") || blockedIpv6.check(address, "ipv6");
    default:
      return true;
  }
}

/**
 * Validates and normalizes an adapter's static host allowlist. Entries are exact
 * hostnames (no wildcards, ports, schemes or IP literals), compared
 * case-insensitively. Throws on an invalid entry: that is a programming error in
 * the adapter, not a runtime condition.
 */
export function normalizeAllowedHosts(hosts: readonly string[]): ReadonlySet<string> {
  if (hosts.length === 0) throw new TypeError("allowedHosts must not be empty");
  const normalized = new Set<string>();
  for (const host of hosts) {
    const lower = host.toLowerCase();
    const url = URL.parse(`https://${lower}/`);
    if (
      lower === "" ||
      url === null ||
      url.hostname !== lower ||
      url.port !== "" ||
      lower.includes("*") ||
      isIpLiteral(url.hostname)
    ) {
      throw new TypeError(`Invalid allowedHosts entry: ${JSON.stringify(host)}`);
    }
    normalized.add(lower);
  }
  return normalized;
}

function isIpLiteral(hostname: string): boolean {
  // WHATWG URL already turns IPv4 shorthand (0x7f.1, 2130706433) into dotted
  // form and keeps IPv6 in brackets, so these two checks cover every literal.
  return hostname.startsWith("[") || isIP(hostname) !== 0;
}

/**
 * Parses and checks a request target before any network activity: WHATWG URL,
 * `https:` only, no credentials, default port only, no IP-literal host, host on
 * the allowlist. The fragment is dropped (it is never sent anyway). Used for
 * the initial URL and for every redirect target.
 */
export function parseRequestUrl(
  input: string | URL,
  allowedHosts: ReadonlySet<string>,
  base?: URL,
): URL {
  const url = URL.parse(typeof input === "string" ? input : input.href, base?.href);
  if (url === null) throw new HttpClientError("invalid_url");
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    host === "" ||
    isIpLiteral(host)
  ) {
    throw new HttpClientError("invalid_url", { host: host === "" ? null : host });
  }
  if (!allowedHosts.has(host)) throw new HttpClientError("host_not_allowed", { host });
  url.hash = "";
  return url;
}
