import { redact } from "@/lib/crypto/vault";

export class PinterestError extends Error {
  constructor(public status: number, public code: number | string | undefined, message: string, public retryable = false) {
    super(redact(`Pinterest ${status}${code !== undefined ? ` (code ${code})` : ""}: ${message}`));
  }
}
/** 401: token invalid, expired or revoked by the user. Never retried. */
export class PinterestAuthError extends PinterestError {}
/** 403: e.g. PINNER_DATA_ACCESS_DENIED for content not owned by the authorizing account. */
export class PinterestForbiddenError extends PinterestError {}
export class PinterestRateLimitError extends PinterestError {}
