/**
 * Live Pinterest smoke test (SPEC-076). Read-only. Run after connecting the owner's own account on staging:
 *   docker compose -f docker-compose.prod.yml run --rm --entrypoint node_modules/.bin/tsx web \
 *     scripts/smoke-live.ts --workspace <uuid> --connection <uuid> [--csv /tmp/export.csv] [--json]
 * In mock mode the same checks run against MOCK Pinterest and the report says so.
 * Exit code 1 if any check fails. See docs/runbooks/live-smoke-test.md.
 */
import { parseArgs } from "node:util";
import { closeDb } from "@/lib/db";
import { runSmoke } from "@/modules/pinterest/smoke";

const { values } = parseArgs({
  options: { workspace: { type: "string" }, connection: { type: "string" }, csv: { type: "string" }, json: { type: "boolean" } },
});
if (!values.workspace || !values.connection) {
  console.error("usage: smoke-live.ts --workspace <uuid> --connection <uuid> [--csv <file>] [--json]");
  process.exit(2);
}

const report = await runSmoke({ workspaceId: values.workspace, connectionId: values.connection, csvPath: values.csv });
await closeDb();
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(report.mode === "mock" ? "\nMOCK Pinterest — this is NOT a live check\n" : "\nLIVE Pinterest API v5 smoke test\n");
  console.log(`window ${report.window.start}..${report.window.end}, ${report.apiCalls} API calls`);
  for (const r of report.results) console.log(`${r.status.toUpperCase().padEnd(5)} ${r.id.padEnd(24)} ${r.detail}`);
  console.log(`\n${report.ok ? "OK" : "FAILED"}: ${JSON.stringify(report.counts)}`);
}
process.exit(report.ok ? 0 : 1);
