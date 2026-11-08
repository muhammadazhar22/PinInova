import { describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env";
import { newDataKey, openSecret, redact, rewrap, sealSecret, unwrapDataKey } from "./vault";

describe("vault", () => {
  it("round-trips a secret bound to its owner and field", () => {
    const k = newDataKey("conn-1", "pinterest");
    const ct = sealSecret(k.dataKey, "conn-1", "pinterest", "access", "pina_secret_token");
    expect(ct.toString("utf8")).not.toContain("pina_secret_token");
    const dk = unwrapDataKey("conn-1", "pinterest", k);
    expect(openSecret(dk, "conn-1", "pinterest", "access", ct)).toBe("pina_secret_token");
  });
  it("refuses a ciphertext moved to another row or field", () => {
    const k = newDataKey("conn-1", "pinterest");
    const ct = sealSecret(k.dataKey, "conn-1", "pinterest", "access", "x");
    expect(() => openSecret(k.dataKey, "conn-2", "pinterest", "access", ct)).toThrow();
    expect(() => openSecret(k.dataKey, "conn-1", "pinterest", "refresh", ct)).toThrow();
    expect(() => unwrapDataKey("conn-2", "pinterest", k)).toThrow();
  });
  it("re-wraps data keys under a new KEK without re-encrypting secrets", () => {
    process.env.TOKEN_KEK_V2 = Buffer.alloc(32, 7).toString("base64");
    resetEnvCache();
    const k = newDataKey("c", "pinterest");
    const ct = sealSecret(k.dataKey, "c", "pinterest", "refresh", "r1");
    const k2 = rewrap("c", "pinterest", k, "v2");
    expect(k2.kekVersion).toBe("v2");
    expect(openSecret(unwrapDataKey("c", "pinterest", k2), "c", "pinterest", "refresh", ct)).toBe("r1");
    delete process.env.TOKEN_KEK_V2;
    resetEnvCache();
  });
  it("redacts tokens in log lines", () => {
    expect(redact('refresh_token="pinr.abcdefghijklmnop" Bearer pina.ABCDEFGH12345')).toBe('refresh_token="[redacted]" Bearer [redacted]');
  });
});
