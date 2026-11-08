import { Card, Chip } from "@/components/ui";
import { env } from "@/env";

export const metadata = { title: "Integrations" };

export default function IntegrationsPage() {
  const e = env();
  const rows: [string, string, "warn" | "bad" | "info", string][] = [
    ["Pinterest API v5", e.PINTEREST_MODE === "mock" ? "Mock server (simulated data)" : "Live mode — implemented, not yet verified against Pinterest", e.PINTEREST_MODE === "mock" ? "warn" : "bad", "Needs Pinterest Standard access and app review; policy assumptions PA-01…PA-10 remain unresolved."],
    ["GA4 (Traffic Leak Check)", e.GA4_MODE === "mock" ? "Mock" : "CSV import only", "warn", "Direct GA4 API connection not built; needs Google OAuth verification."],
    ["Shopify orders", e.SHOPIFY_MODE === "mock" ? "Mock" : "CSV import only", "warn", "Needs a Shopify app, protected-data approval and app review."],
    ["Paddle billing", e.BILLING_MODE === "simulated" ? "Simulated" : "Paddle sandbox", "warn", "Needs seller verification and live price ids."],
    ["Email", e.EMAIL_TRANSPORT === "outbox" ? "Outbox (not sent externally)" : "Resend", e.EMAIL_TRANSPORT === "outbox" ? "warn" : "info", "Needs a verified sending domain."],
    ["Link checks", `User agent: ${e.INTEGRITY_UA_MODE}`, "info", "Fetches only your own Pin links; policy assumption PA-07."],
  ];
  return (
    <div className="space-y-4">
      <h1>Integrations</h1>
      <p className="muted text-sm">No integration is production-ready yet. This page always shows which data is simulated.</p>
      <Card>
        <table className="data"><thead><tr><th>Integration</th><th>Status</th><th>Before production</th></tr></thead><tbody>
          {rows.map(([n, s, t, b]) => <tr key={n}><td className="font-medium">{n}</td><td><Chip tone={t}>{s}</Chip></td><td className="text-sm">{b}</td></tr>)}
        </tbody></table>
      </Card>
      <p className="muted text-xs">PinPulse is not affiliated with, endorsed by, or approved by Pinterest.</p>
    </div>
  );
}
