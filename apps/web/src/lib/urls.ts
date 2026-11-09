import { env } from "@/env";

/**
 * Absolute URL on the app's public origin (APP_URL). Route handlers must use this for redirects instead of
 * `new URL(path, req.url)`: behind Caddy, `req.url` carries the bind address (e.g. http://0.0.0.0:3000), not the
 * public host. Only same-origin paths are accepted.
 */
export function appUrl(pathAndQuery: string): URL {
  const base = new URL(env().APP_URL);
  const u = new URL(pathAndQuery, base);
  if (!pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//") || u.origin !== base.origin) {
    throw new Error("appUrl: only same-origin paths are allowed");
  }
  return u;
}

/** Cookies get the Secure flag whenever the public origin is https (TLS ends at the proxy, so req.nextUrl says http). */
export function secureCookies(): boolean {
  return new URL(env().APP_URL).protocol === "https:";
}
