import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";

/** Strip the brackets URL.hostname keeps around IPv6 literals ("[::1]" → "::1"). */
export function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Addresses PinInova must never fetch on a user's behalf. Allow-list, not deny-list: only global unicast passes.
 * IPv4-mapped (::ffff:a.b.c.d, incl. the hex form ::ffff:7f00:1) is judged as the IPv4 address it carries;
 * IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16), Teredo, site-local (fec0::/10),
 * unique-local, link-local, multicast and every other special range are refused. Unparseable → refused.
 */
export function isBlockedAddress(ip: string): boolean {
  const raw = bareHost(ip.trim()).replace(/%.*$/, ""); // drop zone id
  if (!ipaddr.isValid(raw)) return true;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(raw); // unwraps IPv4-mapped IPv6
  } catch {
    return true;
  }
  if (addr.kind() === "ipv6") {
    const p = (addr as ipaddr.IPv6).parts;
    if (p.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, ::a.b.c.d
    if (p[0]! >= 0xfec0 && p[0]! <= 0xfeff) return true; // site-local + link-local
  }
  return addr.range() !== "unicast";
}

/** dns.lookup replacement that refuses blocked addresses at connect time (defeats DNS rebinding). */
export function safeLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addrs) => {
      if (err) return (callback as (e: Error) => void)(err);
      const list = (addrs as dns.LookupAddress[]).filter((a) => allowPrivate || !isBlockedAddress(a.address));
      if (!list.length) return (callback as (e: Error) => void)(Object.assign(new Error(`blocked address for ${hostname}`), { code: "EBLOCKED" }));
      if ((options as dns.LookupOptions).all) return (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      return (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
    });
  };
}
