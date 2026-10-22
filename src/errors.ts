// Only these fixed codes cross the logging/CLI boundary. Never expose fetch errors,
// upstream response bodies, URLs (Telegram embeds a token), or account identifiers.
export class SafeError extends Error {
  constructor(public readonly code: string, public readonly retryable = false,
    public readonly retryAt = 0, public readonly auth = false) {
    super(code);
    this.name = 'SafeError';
  }
}
export function errorCode(error: unknown): string {
  return error instanceof SafeError ? error.code : 'internal_error';
}
