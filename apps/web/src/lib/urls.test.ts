import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env";
import { appUrl, secureCookies } from "./urls";

const prev = process.env.APP_URL;
afterEach(() => {
  process.env.APP_URL = prev;
  resetEnvCache();
});

describe("appUrl", () => {
  it("builds redirects on the public APP_URL, never on the bind address behind a proxy", () => {
    process.env.APP_URL = "https://staging.example.com";
    resetEnvCache();
    expect(appUrl("/consent/done").toString()).toBe("https://staging.example.com/consent/done");
    expect(appUrl("/connect-error?r=state").toString()).toBe("https://staging.example.com/connect-error?r=state");
    expect(secureCookies()).toBe(true);
  });

  it("refuses to leave APP_URL's origin", () => {
    process.env.APP_URL = "https://staging.example.com";
    resetEnvCache();
    expect(() => appUrl("//evil.example/x")).toThrow();
    expect(() => appUrl("https://evil.example/x")).toThrow();
  });

  it("does not mark cookies Secure on plain-http local dev", () => {
    process.env.APP_URL = "http://localhost:3000";
    resetEnvCache();
    expect(secureCookies()).toBe(false);
    expect(appUrl("/app").toString()).toBe("http://localhost:3000/app");
  });
});
