import dns from "node:dns";
import net from "node:net";

/** Addresses PinPulse must never fetch on a user's behalf (loopback, private, link-local, metadata, CGNAT, multicast). */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isBlockedAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
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
