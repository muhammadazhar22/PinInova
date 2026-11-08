import postgres from "postgres";
import { env } from "@/env";

export type Tx = postgres.TransactionSql;
export type Sql = postgres.Sql;

const g = globalThis as unknown as { __pinpulseSql?: Sql };

/** Pool connected as pinpulse_app (non-owner, NOBYPASSRLS): row-level security always applies. */
export function db(): Sql {
  if (!g.__pinpulseSql) {
    g.__pinpulseSql = postgres(env().DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      onnotice: () => {},
      types: { bigint: postgres.BigInt },
      transform: { undefined: null },
    });
  }
  return g.__pinpulseSql;
}

export async function closeDb() {
  if (g.__pinpulseSql) {
    await g.__pinpulseSql.end({ timeout: 5 });
    g.__pinpulseSql = undefined;
  }
}

/**
 * Run fn inside a transaction scoped to one workspace. The setting is transaction-local
 * (set_config(..., true)) so pooled connections can never leak a tenant context.
 * Authorization (may this user see this workspace?) is checked BEFORE calling this;
 * RLS is the second line of defence against query bugs.
 */
export async function withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>, orgId?: string): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error("invalid workspace id");
  return db().begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.org_id', ${orgId ?? ""}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Org-level scope: lists the org's workspaces; no workspace data is visible. */
export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true), set_config('app.workspace_id', '', true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** BigInt/number normaliser for metric columns. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "bigint" ? Number(v) : Number(v);
}

/** First row of a query that must return exactly one row. */
export async function one<T>(q: PromiseLike<readonly T[]>): Promise<T> {
  const rows = await q;
  if (!rows.length) throw new Error("expected one row");
  return rows[0]!;
}
