/**
 * Re-wrap every data key with TOKEN_KEK_CURRENT. Run after adding TOKEN_KEK_V2 and setting
 * TOKEN_KEK_CURRENT=v2. Secrets themselves are not re-encrypted. Runs as the schema owner.
 */
import postgres from "postgres";
import { env } from "../src/env";
import { rewrap } from "../src/lib/crypto/vault";

async function main() {
  const to = env().TOKEN_KEK_CURRENT;
  const sql = postgres(env().DATABASE_OWNER_URL, { max: 1 });
  let n = 0;
  const conns = await sql<{ id: string; wrapped_key: Buffer; kek_version: string }[]>`
    SELECT id, wrapped_key, kek_version FROM pinterest_connection WHERE wrapped_key IS NOT NULL AND kek_version <> ${to}`;
  for (const c of conns) {
    const k = rewrap(c.id, "pinterest", { wrappedKey: c.wrapped_key, kekVersion: c.kek_version }, to);
    await sql`UPDATE pinterest_connection SET wrapped_key = ${k.wrappedKey}, kek_version = ${k.kekVersion} WHERE id = ${c.id}`;
    n++;
  }
  const slack = await sql<{ workspace_id: string; slack_wrapped_key: Buffer; slack_kek_version: string }[]>`
    SELECT workspace_id, slack_wrapped_key, slack_kek_version FROM alert_settings WHERE slack_wrapped_key IS NOT NULL AND slack_kek_version <> ${to}`;
  for (const s of slack) {
    const k = rewrap(s.workspace_id, "slack", { wrappedKey: s.slack_wrapped_key, kekVersion: s.slack_kek_version }, to);
    await sql`UPDATE alert_settings SET slack_wrapped_key = ${k.wrappedKey}, slack_kek_version = ${k.kekVersion} WHERE workspace_id = ${s.workspace_id}`;
    n++;
  }
  console.log(`re-wrapped ${n} data keys to ${to}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
