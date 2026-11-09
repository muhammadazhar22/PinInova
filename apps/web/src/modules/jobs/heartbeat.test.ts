import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { beat, workerStatus } from "./heartbeat";

describe("worker heartbeat (SPEC-072)", () => {
  it("reports the worker down until it beats, then up; stale beats count as down", async () => {
    await db()`SELECT 1`; // pool up
    const started = new Date();
    await beat("test-worker", started);
    const s = await workerStatus();
    expect(s.ok).toBe(true);
    expect(s.last_beat_age_s).toBeLessThanOrEqual(2);
    expect(s.workers).toBeGreaterThanOrEqual(1);
    const later = await workerStatus(new Date(Date.now() + 10 * 60_000));
    expect(later.ok).toBe(false);
  });

  it("the app role cannot read or write the heartbeat table directly (RLS, no policy)", async () => {
    expect(await db()`SELECT * FROM worker_heartbeat`).toHaveLength(0);
    await expect(db()`INSERT INTO worker_heartbeat VALUES ('x', now(), now(), null)`).rejects.toThrow(/row-level security/);
  });
});
