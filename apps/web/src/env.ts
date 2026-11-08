import { z } from "zod";

/**
 * Central configuration. Every policy switch from docs/policy/ASSUMPTIONS.md is read here
 * so that tightening an assumption is a config change, not a code change.
 */
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Database. The app connects as a non-owner role so row-level security applies.
  DATABASE_URL: z.string().default("postgres://pinpulse_app:pinpulse_app@localhost:5432/pinpulse"),
  DATABASE_OWNER_URL: z.string().default("postgres://postgres:dev@localhost:5432/pinpulse"),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(32).default("dev-only-secret-change-me-0123456789abcdef"),

  // Pinterest. "mock" talks to services/pinterest-mock; "live" talks to Pinterest and is NOT
  // production-ready until docs/INTEGRATIONS.md says live-verified.
  PINTEREST_MODE: z.enum(["mock", "live"]).default("mock"),
  PINTEREST_API_BASE: z.string().url().default("http://127.0.0.1:4010/v5"),
  PINTEREST_OAUTH_BASE: z.string().url().default("http://127.0.0.1:4010/oauth/"),
  PINTEREST_CLIENT_ID: z.string().default("mock-client-id"),
  PINTEREST_CLIENT_SECRET: z.string().default("mock-client-secret"),
  PINTEREST_SCOPES: z.string().default("user_accounts:read,pins:read,boards:read"),

  // Envelope encryption: data keys per connection wrapped by a versioned key-encryption key.
  TOKEN_KEK_CURRENT: z.string().default("v1"),
  TOKEN_KEK_V1: z.string().default("ZGV2LW9ubHkta2VrLWNoYW5nZS1tZS0wMTIzNDU2Nzg="),
  TOKEN_KEK_V2: z.string().optional(),

  ANALYTICS_URL: z.string().url().default("http://127.0.0.1:8000"),

  // policy: PA-01
  RETENTION_RAW_DAYS: z.coerce.number().int().min(0).max(90).default(90),
  RETENTION_DERIVED_DAYS: z.coerce.number().int().min(0).default(395),
  // policy: PA-02
  STORE_PIN_METADATA: bool.default(true),
  // policy: PA-03
  PERSIST_IMAGE_HASHES: bool.default(false),
  // policy: PA-06
  WEATHER_SOURCE: z.enum(["user_reports"]).default("user_reports"),
  // policy: PA-07
  INTEGRITY_UA_MODE: z.enum(["pinterestbot", "honest"]).default("pinterestbot"),
  INTEGRITY_ALLOW_PRIVATE_HOSTS: bool.default(false),
  // policy: PA-08
  PROVISIONAL_DAYS: z.coerce.number().int().min(0).max(7).default(2),

  // Disconnect purge target (Terms allow 30 days; design target is 24 h).
  PURGE_DELAY_HOURS: z.coerce.number().min(0).default(0),
  REAUTH_GRACE_DAYS: z.coerce.number().int().default(14),

  TRACKED_PINS_CAP: z.coerce.number().int().default(300),

  EMAIL_TRANSPORT: z.enum(["outbox", "resend"]).default("outbox"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("PinPulse <alerts@pinpulse.local>"),

  GA4_MODE: z.enum(["mock", "csv"]).default("csv"),
  SHOPIFY_MODE: z.enum(["mock", "csv"]).default("csv"),
  BILLING_MODE: z.enum(["simulated", "paddle_sandbox"]).default("simulated"),
  PADDLE_WEBHOOK_SECRET: z.string().default("dev-paddle-webhook-secret"),

  CHROME_PATH: z.string().default("/usr/bin/google-chrome"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid configuration: ${parsed.error.message}`);
    }
    if (parsed.data.NODE_ENV === "production") {
      if (parsed.data.BETTER_AUTH_SECRET.startsWith("dev-only")) throw new Error("Set BETTER_AUTH_SECRET in production");
      if (parsed.data.TOKEN_KEK_V1.startsWith("ZGV2")) throw new Error("Set TOKEN_KEK_V1 in production");
      if (parsed.data.INTEGRITY_ALLOW_PRIVATE_HOSTS) throw new Error("INTEGRITY_ALLOW_PRIVATE_HOSTS must be false in production");
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
