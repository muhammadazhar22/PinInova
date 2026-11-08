import { execFileSync } from "node:child_process";
import postgres from "postgres";

export default async function setup() {
  const admin = postgres("postgres://postgres:dev@localhost:5432/postgres", { max: 1, onnotice: () => {} });
  await admin.unsafe("DROP DATABASE IF EXISTS pinpulse_test WITH (FORCE)");
  await admin.unsafe("CREATE DATABASE pinpulse_test");
  await admin.end();
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_OWNER_URL: "postgres://postgres:dev@localhost:5432/pinpulse_test" },
  });
}
