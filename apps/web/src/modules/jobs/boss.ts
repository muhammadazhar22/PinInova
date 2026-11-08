import { PgBoss } from "pg-boss";
import { env } from "@/env";

export const QUEUES = {
  nightlyPlan: "nightly-plan",
  syncAccount: "sync-account",
  analyzeAccount: "analyze-account",
  integrityChecks: "integrity-checks",
  evaluateAlerts: "evaluate-alerts",
  deliverAlert: "deliver-alert",
  refreshTokens: "refresh-tokens",
  purgeConnection: "purge-connection",
  purgeSweep: "purge-sweep",
  retention: "retention",
  purgeAssert: "purge-assert",
  buildReport: "build-report",
  sendEmail: "send-email",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const g = globalThis as unknown as { __boss?: Promise<PgBoss> };

/** Single pg-boss instance per process, using the pgboss schema owned by the app role. */
export function boss(): Promise<PgBoss> {
  if (!g.__boss) {
    g.__boss = (async () => {
      const b = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss", createSchema: false });
      b.on("error", (e: unknown) => console.error("[pg-boss]", e instanceof Error ? e.message : e));
      await b.start();
      for (const q of Object.values(QUEUES)) {
        await b.createQueue(q, {
          retryLimit: 5,
          retryDelay: 30,
          retryBackoff: true,
          expireInSeconds: q === QUEUES.syncAccount ? 3 * 60 * 60 : 15 * 60,
          policy: q === QUEUES.syncAccount || q === QUEUES.purgeConnection ? "singleton" : "standard",
        } as never).catch(() => {});
      }
      return b;
    })();
  }
  return g.__boss;
}

export async function enqueue(queue: QueueName, data: Record<string, unknown>, opts: { singletonKey?: string; startAfter?: number | string | Date } = {}) {
  const b = await boss();
  return b.send(queue, data, opts as never);
}

export async function stopBoss() {
  if (g.__boss) {
    const b = await g.__boss;
    await b.stop({ graceful: true, wait: true } as never);
    g.__boss = undefined;
  }
}
