/**
 * Error categories every outbound call is translated into. Callers act on the category, never on a
 * provider's own status codes or messages.
 */

/**
 * The service is down, not configured, or refuses the whole account (bad key, rate limit, no balance).
 * Retrying single items cannot help; callers pause the whole kind of work for `retryAfterMs`.
 */
export class ServiceUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 60_000,
  ) {
    super(message);
  }
}

/** The service rejected this one request (for example an image it cannot read). Retrying it cannot help. */
export class RejectedError extends Error {}

/** The answer was cut off at the output limit. */
export class OutputTooLongError extends Error {}

// Anything else (network error, timeout, 5xx) is a plain Error: transient, worth retrying later.
