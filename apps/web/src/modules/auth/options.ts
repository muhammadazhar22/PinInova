import type { BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { Pool } from "pg";

/**
 * Shared Better Auth options. Used by the app (as pinpulse_app) and by the migration
 * script (as the schema owner). Auth tables are not tenant data and carry no RLS;
 * tenant data lives in workspace-scoped tables protected by RLS.
 */
export function authOptions(connectionString: string, baseURL: string, secret: string): BetterAuthOptions {
  return {
    appName: "PinPulse",
    baseURL,
    secret,
    database: new Pool({ connectionString, max: 5 }),
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, window: 60, max: 100, storage: "memory" },
    advanced: { useSecureCookies: baseURL.startsWith("https://") },
    plugins: [organization({
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
      // Deleting an org must go through PinPulse's erasure path (disconnect + purge + audit), never a raw cascade.
      disableOrganizationDeletion: true,
    })],
  };
}
