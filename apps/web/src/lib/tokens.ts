import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Random URL-safe token; only its SHA-256 is stored. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
