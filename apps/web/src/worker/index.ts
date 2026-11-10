/**
 * PinInova worker: one process running all background jobs on pg-boss.
 * Job payloads carry identifiers only (no tokens, no metrics).
 */
import * as Sentry from "@sentry/node";
import { env } from "@/env";
import { db, one } from "@/lib/db";
import { redact } from "@/lib/crypto/vault";
import { deliverSlackAlert, evaluateAlerts, pendingDeliveries } from "@/modules/alerts/evaluate";
import { analyzeAccount } from "@/modules/health/analyze";
import { runIntegrityChecks } from "@/modules/integrity/run";
import { boss, enqueue, QUEUES, stopBoss } from "@/modules/jobs/boss";
import { startHeartbeat } from "@/modules/jobs/heartbeat";
import { sentryOptions } from "@/lib/observability/sentry-options";
import { deliverEmail } from "@/modules/notify/email";
import { disconnect, refreshNow } from "@/modules/pinterest/connections";
import { PinterestAuthError } from "@/modules/pinterest/errors";
import { assertPurged, purgeConnection, runRetention } from "@/modules/privacy/purge";
import { renderReportPdf } from "@/modules/reports/pdf";
import { InactiveConnectionError, syncAccount } from "@/modules/sync/sync";

type Job<T> = { id: string; data: T };
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

async function orgOf(workspaceId: string) {
  return (await one(db()<{ org: string }[]>`SELECT system_workspace_org(${workspaceId}::uuid) AS org`)).org;
}

export async function registerHandlers() {
  const b = await boss();
  const w = <T,>(q: string, fn: (d: T) => Promise<unknown>, opts: Record<string, unknown> = {}) =>
    b.work<T>(q, { batchSize: 1, ...opts } as never, async (jobs: Job<T>[]) => {
      for (const j of jobs) {
        const started = Date.now();
        try {
          const r = await fn(j.data);
          log("job.done", { q, id: j.id, ms: Date.now() - started, r: typeof r === "object" ? r : undefined });
        } catch (e) {
          log("job.failed", { q, id: j.id, error: redact((e as Error).message) });
          Sentry.captureException(e, { tags: { queue: q } }); // scrubbed in beforeSend; job payloads are never attached
          if (!(e instanceof PinterestAuthError)) throw e; // auth failures are terminal for the job; connection is flagged
        }
      }
    });

  await w<Record<string, never>>(QUEUES.nightlyPlan, async () => {
    const conns = await db()<{ connection_id: string; workspace_id: string }[]>`SELECT * FROM system_connections_to_sync()`;
    for (const c of conns) await enqueue(QUEUES.syncAccount, { connectionId: c.connection_id, workspaceId: c.workspace_id, reason: "nightly" }, { singletonKey: c.connection_id });
    return { planned: conns.length };
  });

  // Up to 20 accounts sync concurrently; each account's own rate gate keeps it within Pinterest's per-user limits.
  await w<{ connectionId: string; workspaceId: string }>(QUEUES.syncAccount, async (d) => {
    let r;
    try {
      r = await syncAccount(d.workspaceId, d.connectionId);
    } catch (err) {
      if (err instanceof InactiveConnectionError) return { skipped: err.status };
      throw err;
    }
    // Pipeline: sync → integrity checks → analysis (uses duplicate/link signals, computes the health score) → alerts.
    await enqueue(QUEUES.integrityChecks, d, { singletonKey: `integrity:${d.connectionId}` });
    return r;
  }, { localConcurrency: 20 });

  await w<{ connectionId: string; workspaceId: string }>(QUEUES.analyzeAccount, async (d) => {
    const r = await analyzeAccount(d.workspaceId, d.connectionId);
    await enqueue(QUEUES.evaluateAlerts, { workspaceId: d.workspaceId }, { singletonKey: `alerts:${d.workspaceId}` });
    return { status: r.result?.status ?? "insufficient_data", score: r.score };
  }, { localConcurrency: 4 });

  await w<{ connectionId: string; workspaceId: string }>(QUEUES.integrityChecks, async (d) => {
    try {
      return await runIntegrityChecks(d.workspaceId, d.connectionId);
    } finally {
      // Link checks are best-effort; analysis runs even if they fail. Manual "Run link checks" also refreshes the score.
      await enqueue(QUEUES.analyzeAccount, { workspaceId: d.workspaceId, connectionId: d.connectionId });
    }
  }, { localConcurrency: 4 });

  await w<{ workspaceId: string }>(QUEUES.evaluateAlerts, async (d) => {
    const r = await evaluateAlerts(d.workspaceId, await orgOf(d.workspaceId));
    const p = await pendingDeliveries(d.workspaceId);
    for (const id of p.slack) await enqueue(QUEUES.deliverAlert, { workspaceId: d.workspaceId, alertId: id });
    for (const id of p.email) await enqueue(QUEUES.sendEmail, { workspaceId: d.workspaceId, emailId: id });
    return { ...r, slack: p.slack.length, email: p.email.length };
  });

  await w<{ workspaceId: string; alertId: string }>(QUEUES.deliverAlert, (d) => deliverSlackAlert(d.workspaceId, d.alertId));
  await w<{ workspaceId: string; emailId: string }>(QUEUES.sendEmail, (d) => deliverEmail(d.workspaceId, d.emailId));

  await w<Record<string, never>>(QUEUES.refreshTokens, async () => {
    const due = await db()<{ connection_id: string; workspace_id: string }[]>`SELECT * FROM system_connections_needing_refresh(${new Date(Date.now() + 2 * 86400_000)})`;
    let ok = 0;
    for (const c of due) {
      try {
        await refreshNow(c.workspace_id, c.connection_id);
        ok++;
      } catch (e) {
        log("refresh.failed", { connection: c.connection_id, error: redact((e as Error).message) });
      }
    }
    return { due: due.length, ok };
  });

  await w<{ connectionId: string; workspaceId: string }>(QUEUES.purgeConnection, (d) => purgeConnection(d.workspaceId, d.connectionId));

  // Disconnected past the purge delay, or needs_reauth beyond the grace period: purge.
  await w<Record<string, never>>(QUEUES.purgeSweep, async () => {
    const rows = await db()<{ connection_id: string; workspace_id: string; status: string }[]>`SELECT * FROM system_connections_to_purge(${env().REAUTH_GRACE_DAYS})`;
    for (const r of rows) {
      if (r.status === "needs_reauth") await disconnect({ workspaceId: r.workspace_id, connectionId: r.connection_id, actor: "system", reason: "reauth_expired" });
      else await purgeConnection(r.workspace_id, r.connection_id);
    }
    return { swept: rows.length };
  });

  await w<Record<string, never>>(QUEUES.purgeAssert, async () => {
    const bad = await assertPurged();
    if (bad.length) {
      log("ALERT purge.leftovers", { bad }); // pages the founder via log-based alerting
      Sentry.captureMessage(`purge assertion: ${bad.length} connection(s) still have rows after purge`, "fatal");
    }
    return { leftovers: bad.length };
  });

  await w<Record<string, never>>(QUEUES.retention, () => runRetention());
  await w<{ workspaceId: string; reportId: string }>(QUEUES.buildReport, async (d) => {
    const pdf = await renderReportPdf(d.workspaceId, d.reportId);
    return { bytes: pdf.length };
  });

  // Schedules (UTC). Minutes are off the hour on purpose.
  await b.schedule(QUEUES.nightlyPlan, "17 0 * * *");
  await b.schedule(QUEUES.refreshTokens, "41 */6 * * *");
  await b.schedule(QUEUES.purgeSweep, "*/15 * * * *");
  await b.schedule(QUEUES.purgeAssert, "23 5 * * *");
  await b.schedule(QUEUES.retention, "53 3 * * *");
}

if (process.argv[1]?.endsWith("worker/index.ts")) {
  const sentry = sentryOptions("worker");
  if (sentry) Sentry.init(sentry);
  let stopBeat = () => {};
  registerHandlers()
    .then(() => {
      stopBeat = startHeartbeat((e) => log("heartbeat.failed", { error: redact((e as Error).message) }));
      log("worker.started", { mode: env().PINTEREST_MODE });
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
  const shutdown = async () => {
    log("worker.stopping");
    stopBeat();
    await stopBoss();
    await Sentry.flush(2000).catch(() => false);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
