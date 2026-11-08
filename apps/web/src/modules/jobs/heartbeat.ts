import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { env } from "@/env";
import { db } from "@/lib/db";

/**
 * Worker liveness (SPEC-072). The worker beats every 30 s into Postgres (read by GET /api/health/worker for the
 * uptime monitor) and touches a local file (read by the container healthcheck in infra/docker-compose.prod.yml).
 */
export const HEARTBEAT_FILE = "/tmp/pinpulse-worker-heartbeat";
export const HEARTBEAT_MS = 30_000;

export async function beat(workerId: string, startedAt: Date): Promise<void> {
  await db()`SELECT system_worker_beat(${workerId}, ${startedAt}, ${env().APP_RELEASE ?? null})`;
  await writeFile(HEARTBEAT_FILE, new Date().toISOString()).catch(() => {});
}

export function startHeartbeat(onError: (e: unknown) => void): () => void {
  const id = `${process.env.HOSTNAME ?? "worker"}:${randomUUID().slice(0, 8)}`;
  const started = new Date();
  const tick = () => beat(id, started).catch(onError);
  void tick();
  const t = setInterval(tick, HEARTBEAT_MS);
  t.unref();
  return () => clearInterval(t);
}

export async function workerStatus(now = new Date()): Promise<{ ok: boolean; last_beat_age_s: number | null; workers: number }> {
  const [r] = await db()<{ beat_at: Date | null; workers: number }[]>`SELECT * FROM system_worker_last_beat()`;
  const age = r?.beat_at ? Math.round((now.getTime() - r.beat_at.getTime()) / 1000) : null;
  return { ok: age !== null && age <= env().WORKER_STALE_SECONDS, last_beat_age_s: age, workers: r?.workers ?? 0 };
}
