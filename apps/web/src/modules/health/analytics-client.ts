import { env } from "@/env";

/** Contract of services/analytics POST /v1/diagnose (snake_case). */
export interface DiagnoseRequest {
  dates?: string[];
  impressions: number[];
  outbound_clicks: number[];
  saves?: number[] | null;
  pin_clicks?: number[] | null;
  provisional_days?: number;
  age_buckets?: Record<"0-7" | "8-14" | "15-29" | "30+", number[]> | null;
  domains?: { domain: string; impressions: number[] }[] | null;
  unlinked_impressions?: number[] | null;
  pins?: { pin_id: string; before: number; after: number }[] | null;
  signals?: Partial<{
    domain_block_error: boolean;
    visit_site_demoted: boolean | null;
    bulk_upload_or_ad_prefix: boolean;
    duplicate_url_rate_14d: number;
    peers_hit_fraction: number | null;
    yoy_same_window_ratio: number | null;
    ga4_pinterest_vs_direct_gap: number | null;
    linked_new_impr: number | null;
    unlinked_new_impr: number | null;
  }> | null;
  min_drop?: number;
}

export type Cause = "A_enforcement" | "B_quality" | "C_behavioural" | "D_platform" | "E_decay" | "M_measurement";

export interface DiagnoseResponse {
  status: "none" | "warning" | "drop";
  onset_index: number | null;
  onset_date: string | null;
  warning_index: number | null;
  warning_date: string | null;
  drop: { before_median: number; after_median: number; ratio: number; effect: number } | null;
  methods_agree: boolean;
  p_value: number | null;
  rate: { verdict: "stable" | "changed" | "insufficient"; log_bf: number | null; ctr_before: number | null; ctr_after: number | null; post_impressions: number };
  breadth: {
    age: Record<string, number | null> | null;
    domains: { domain: string; ratio: number | null; share_before: number }[] | null;
    linked_ratio: number | null;
    unlinked_ratio: number | null;
  };
  pin_contributions: { pin_id: string; delta: number; share: number }[];
  concentration: { top1_share: number | null; top_pin_share: number | null; gini: number | null };
  shape: "step" | "fade" | "unknown";
  classes: { cause: Cause; probability: number }[];
  evidence: { code: string; text: string; supports: string[] }[];
  confidence: "low" | "medium" | "high";
  detector_version: string;
}

export interface CsvParseResponse<T = Record<string, unknown>> {
  kind: string;
  rows: T[];
  columns_matched: Record<string, string>;
  warnings: string[];
  date_range: [string, string] | null;
}

export class AnalyticsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${env().ANALYTICS_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const j = JSON.parse(text) as { detail?: unknown };
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      /* keep text */
    }
    throw new AnalyticsError(res.status, `analytics ${path} ${res.status}: ${detail.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

export const analytics = {
  diagnose: (b: DiagnoseRequest, f?: typeof fetch) => post<DiagnoseResponse>("/v1/diagnose", b, f),
  parseCsv: <T>(csv: string, kind: "pinterest_analytics" | "ga4_sessions" | "shopify_orders" | "pin_drafts", f?: typeof fetch) =>
    post<CsvParseResponse<T>>("/v1/csv/parse", { csv, kind }, f),
  duplicates: (items: { pin_id: string; image_base64?: string | null; phash?: string | null }[], threshold = 8, f?: typeof fetch) =>
    post<{ clusters: string[][]; duplicate_rate: number; hashes: Record<string, string> | null }>("/v1/duplicates", { items, threshold, return_hashes: false }, f),
  weather: (windows: { date: string; reports: number; active_reporters: number }[], f?: typeof fetch) =>
    post<{ days: { date: string; fraction: number; log_bf: number; tail_p: number; level: "normal" | "elevated" | "platform_wide"; insufficient?: boolean }[] }>("/v1/weather", { windows }, f),
  preflight: (drafts: unknown[], history: { link: string; created_at: string }[] | null, now: string, f?: typeof fetch) =>
    post<{ findings: { rule_id: string; severity: "error" | "warning" | "info"; source: "official" | "vendor" | "hypothesis"; draft_index: number | null; message: string; policy_ref: string }[] }>(
      "/v1/preflight", { drafts, history, now }, f),
};

export const CAUSE_LABELS: Record<Cause, { title: string; source: "pinterest" | "you" | "unknown"; short: string }> = {
  A_enforcement: { title: "Link or domain restriction", source: "pinterest", short: "Pinterest appears to be limiting Pins that link to one of your domains." },
  B_quality: { title: "Quality down-ranking", source: "unknown", short: "Pins are being shown less and people engage less with them when they are shown." },
  C_behavioural: { title: "Publishing pattern", source: "you", short: "Recent publishing behaviour (duplicates, repeated links, bulk uploads) matches patterns Pinterest's spam systems penalise." },
  D_platform: { title: "Platform-side change", source: "pinterest", short: "Distribution was cut across the whole account at once while engagement per view held; this usually comes from Pinterest's side." },
  E_decay: { title: "Normal decay of a top Pin", source: "unknown", short: "One or two Pins that carried the account are fading, which is normal and not a penalty." },
  M_measurement: { title: "Measurement artefact", source: "unknown", short: "Pinterest numbers look fine; your analytics is likely mislabelling Pinterest traffic." },
};
