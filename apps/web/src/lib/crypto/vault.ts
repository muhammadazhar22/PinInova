import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/env";

/**
 * Envelope encryption for OAuth tokens and webhook URLs.
 * - Each owner row (connection, workspace) gets a random 256-bit data key.
 * - Secrets are sealed with AES-256-GCM under the data key, with AAD binding them to
 *   `${purpose}:${ownerId}` so a ciphertext copied to another row fails to decrypt.
 * - The data key is wrapped with the current key-encryption key (KEK); rotation re-wraps
 *   data keys only (scripts/rotate-kek.ts), never re-encrypts secrets.
 * Format of every blob: iv(12) | tag(16) | ciphertext.
 */

function kek(version: string): Buffer {
  const e = env();
  const raw = version === "v1" ? e.TOKEN_KEK_V1 : version === "v2" ? e.TOKEN_KEK_V2 : undefined;
  if (!raw) throw new Error(`KEK ${version} is not configured`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`KEK ${version} must be 32 bytes base64`);
  return key;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < 29) throw new Error("ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export type Purpose = "pinterest" | "slack";

export interface SealedKey {
  wrappedKey: Buffer;
  kekVersion: string;
}

export function newDataKey(ownerId: string, purpose: Purpose): SealedKey & { dataKey: Buffer } {
  const dataKey = randomBytes(32);
  const kekVersion = env().TOKEN_KEK_CURRENT;
  return { dataKey, kekVersion, wrappedKey: seal(kek(kekVersion), dataKey, `kek:${purpose}:${ownerId}`) };
}

export function unwrapDataKey(ownerId: string, purpose: Purpose, k: SealedKey): Buffer {
  return open(kek(k.kekVersion), k.wrappedKey, `kek:${purpose}:${ownerId}`);
}

export function rewrap(ownerId: string, purpose: Purpose, k: SealedKey, toVersion: string): SealedKey {
  const dataKey = unwrapDataKey(ownerId, purpose, k);
  return { kekVersion: toVersion, wrappedKey: seal(kek(toVersion), dataKey, `kek:${purpose}:${ownerId}`) };
}

export function sealSecret(dataKey: Buffer, ownerId: string, purpose: Purpose, field: string, value: string): Buffer {
  return seal(dataKey, Buffer.from(value, "utf8"), `${purpose}:${field}:${ownerId}`);
}

export function openSecret(dataKey: Buffer, ownerId: string, purpose: Purpose, field: string, blob: Buffer): string {
  return open(dataKey, blob, `${purpose}:${field}:${ownerId}`).toString("utf8");
}

/** Redact anything that looks like a bearer token before logging. */
export function redact(s: string): string {
  return s.replace(/(access_token|refresh_token|Bearer)([=:\s"]+)[A-Za-z0-9._\-~+/]{8,}/gi, "$1$2[redacted]");
}
