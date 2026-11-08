/**
 * Consent text shown to the account holder before Pinterest OAuth. Versioned; the version
 * is stored on every consent_record. Changing the wording requires a new version.
 */
export const CONSENT_TEXT_VERSION = "2026-11-08.v1";

export function consentText(p: { orgName: string; workspaceName: string; rawDays: number; derivedDays: number; scopes: string[] }) {
  return {
    version: CONSENT_TEXT_VERSION,
    title: `${p.orgName} is asking to monitor your Pinterest account with PinPulse`,
    points: [
      `Access is read-only. PinPulse requests these Pinterest permissions: ${p.scopes.join(", ")}. It never creates, edits or deletes your Pins or boards.`,
      `PinPulse stores numbers only (daily impressions, saves, clicks per account and per Pin), plus each Pin's id, creation date, board id and link. It does not store your Pin titles, descriptions or images.`,
      `Daily numbers are kept for up to ${p.rawDays} days; PinPulse's own analysis (detected drops, checks, reports) for up to ${p.derivedDays} days.`,
      `Your data is visible only to ${p.orgName} inside the "${p.workspaceName}" workspace. It is never combined with other people's accounts or shown to other clients.`,
      `You can revoke access at any time from the link you receive after connecting, or by removing PinPulse in your Pinterest settings. Your data is deleted within 24 hours of revocation.`,
      `PinPulse is not affiliated with or endorsed by Pinterest.`,
    ],
  };
}
