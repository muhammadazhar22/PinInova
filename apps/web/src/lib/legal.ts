import { env } from "@/env";

/**
 * Facts the public legal pages state (SPEC-071). Every number is read from the switch the code enforces, so the
 * pages cannot drift from behaviour (retention: PA-01; scopes: read-only; purge delay; e-mail retention).
 * Operator details and the refund window are owner decisions: until set they render as visible placeholders.
 */
export const placeholder = (what: string) => `[to be set: ${what}]`;

export function legalFacts() {
  const e = env();
  return {
    operator: e.LEGAL_OPERATOR_NAME ?? placeholder("operator legal name"),
    supportEmail: e.SUPPORT_EMAIL ?? placeholder("support e-mail"),
    governingLaw: e.LEGAL_GOVERNING_LAW ?? placeholder("governing law"),
    effectiveDate: e.LEGAL_EFFECTIVE_DATE ?? placeholder("effective date"),
    refundWindow: e.REFUND_WINDOW_DAYS ? `${e.REFUND_WINDOW_DAYS} days` : placeholder("refund window"),
    rawDays: e.RETENTION_RAW_DAYS,
    derivedDays: e.RETENTION_DERIVED_DAYS,
    purgeHours: Math.max(24, e.PURGE_DELAY_HOURS),
    reauthGraceDays: e.REAUTH_GRACE_DAYS,
    emailDays: 30,
    consentLinkDays: 14,
    scopes: e.PINTEREST_SCOPES.split(",").map((s) => s.trim()).filter(Boolean),
  };
}
