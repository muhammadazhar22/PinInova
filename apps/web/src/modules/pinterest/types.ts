/** Shapes from Pinterest API v5.28.0 (fixtures/pinterest/openapi-v5.28.0.json). */
export type DataStatus = "PROCESSING" | "READY" | "ESTIMATE" | string;

export interface DailyMetrics {
  date: string;
  data_status?: DataStatus;
  metrics: Record<string, number>;
}
export interface AnalyticsMetricsResponse {
  daily_metrics: DailyMetrics[];
  summary_metrics?: Record<string, number>;
  lifetime_metrics?: Record<string, number>;
}
/** AnalyticsResponse / PinAnalyticsResponse: additionalProperties keyed by split value (e.g. "all"). */
export type AnalyticsResponse = Record<string, AnalyticsMetricsResponse>;

export interface TopPinsResponse {
  date_availability?: { is_realtime?: boolean; latest_available_timestamp?: number };
  pins: { pin_id: string; metrics: Record<string, number>; data_status?: Record<string, DataStatus> }[];
  sort_by?: string;
}

export interface Pin {
  id: string;
  created_at?: string;
  link?: string | null;
  title?: string | null;
  description?: string | null;
  board_id?: string;
  is_owner?: boolean;
  ai_disclosures?: { values?: string[] } | null;
  media?: { media_type?: string; images?: Record<string, { url?: string; width?: number; height?: number }> };
  pin_metrics?: Record<string, unknown> | null;
}
export interface Paginated<T> {
  items: T[];
  bookmark?: string | null;
}
export interface UserWebsite {
  website?: string;
  status?: string;
  verified_at?: string;
}
export interface UserAccount {
  id?: string;
  username?: string;
  account_type?: string;
  business_name?: string;
  website_url?: string;
}
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  refresh_token_expires_at?: number;
  scope?: string;
  token_type: string;
}

export type SplitField = "NO_SPLIT" | "OWNED_CONTENT" | "SOURCE" | "PIN_FORMAT" | "APP_TYPE";
export const ACCOUNT_METRICS = ["IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE"] as const;
