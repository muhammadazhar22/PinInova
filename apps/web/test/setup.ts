import { testDb } from "./db-config";

const t = testDb();
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = t.appUrl;
process.env.DATABASE_OWNER_URL = t.ownerUrl;
process.env.INTEGRITY_ALLOW_PRIVATE_HOSTS = "true";
