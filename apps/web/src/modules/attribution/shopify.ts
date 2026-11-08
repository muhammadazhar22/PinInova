import { createHash, randomBytes } from "node:crypto";
import { audit } from "@/lib/audit";
import { num, one, withWorkspace } from "@/lib/db";
import { analytics } from "@/modules/health/analytics-client";

/**
 * Per-Pin revenue for NEW Pins tagged with a unique utm_content token, joined to Shopify orders.
 * NOT production-ready (docs/INTEGRATIONS.md): the Shopify Admin API path is mock-only; the supported
 * path is an orders CSV export. Only order id (hashed with a workspace salt), total, currency, date and
 * UTM fields are read — no customer data (Pinterest Terms §4.3(c): no joining with PII).
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newPinToken(): string {
  const b = randomBytes(8);
  return "pp_" + [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
}

export function taggedUrl(link: string, token: string): string {
  const u = new URL(link);
  u.searchParams.set("utm_source", "pinterest");
  u.searchParams.set("utm_medium", "organic");
  u.searchParams.set("utm_content", token);
  return u.toString();
}

export async function createTokens(workspaceId: string, connectionId: string, actor: string, items: { label: string; link: string; pinId?: string | null }[]) {
  return withWorkspace(workspaceId, async (tx) => {
    const out: { label: string; token: string; url: string }[] = [];
    for (const it of items.slice(0, 200)) {
      const token = newPinToken();
      await tx`INSERT INTO pin_token (workspace_id, connection_id, token, pin_id, label) VALUES (${workspaceId}, ${connectionId}, ${token}, ${it.pinId ?? null}, ${it.label.slice(0, 120)})`;
      out.push({ label: it.label, token, url: taggedUrl(it.link, token) });
    }
    await audit(tx, { workspaceId, actor, action: "attribution.tokens_created", target: connectionId, detail: { n: out.length } });
    return out;
  });
}

interface OrderRow { order_id: string; created_at: string; total_price: number; currency: string; utm_source: string | null; utm_medium: string | null; utm_content: string | null }

export async function importOrdersCsv(workspaceId: string, connectionId: string, actor: string, csv: string, source: "csv" | "mock" = "csv") {
  const parsed = await analytics.parseCsv<OrderRow>(csv, "shopify_orders");
  return withWorkspace(workspaceId, async (tx) => {
    const { salt } = await one(tx<{ salt: Buffer }[]>`SELECT salt FROM workspace WHERE id = ${workspaceId}`);
    const tokens = new Set((await tx<{ token: string }[]>`SELECT token FROM pin_token WHERE connection_id = ${connectionId}`).map((t) => t.token));
    let matched = 0;
    for (const o of parsed.rows) {
      const token = o.utm_content && tokens.has(o.utm_content) ? o.utm_content : null;
      if (token) matched++;
      const ref = createHash("sha256").update(salt).update(String(o.order_id)).digest();
      await tx`INSERT INTO order_attribution (workspace_id, connection_id, order_ref_hash, token, revenue, currency, ordered_at, source)
               VALUES (${workspaceId}, ${connectionId}, ${ref}, ${token}, ${o.total_price}, ${o.currency || "USD"}, ${o.created_at || null}, ${source})
               ON CONFLICT (connection_id, order_ref_hash) DO UPDATE SET token = EXCLUDED.token, revenue = EXCLUDED.revenue`;
    }
    await audit(tx, { workspaceId, actor, action: "attribution.orders_imported", target: connectionId, detail: { rows: parsed.rows.length, matched, source } });
    return { rows: parsed.rows.length, matched, warnings: parsed.warnings };
  });
}

export async function revenueByToken(workspaceId: string, connectionId: string) {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<{ token: string; label: string | null; orders: bigint; revenue: string; currency: string | null }[]>`
      SELECT t.token, t.label, count(o.order_ref_hash) AS orders, coalesce(sum(o.revenue), 0)::text AS revenue, min(o.currency) AS currency
      FROM pin_token t LEFT JOIN order_attribution o ON o.connection_id = t.connection_id AND o.token = t.token
      WHERE t.connection_id = ${connectionId} GROUP BY t.token, t.label ORDER BY sum(o.revenue) DESC NULLS LAST`;
    const { untagged } = await one(tx<{ untagged: string }[]>`SELECT coalesce(sum(revenue),0)::text AS untagged FROM order_attribution WHERE connection_id = ${connectionId} AND token IS NULL`);
    return { rows: rows.map((r) => ({ ...r, orders: num(r.orders), revenue: Number(r.revenue) })), untaggedRevenue: Number(untagged) };
  });
}
