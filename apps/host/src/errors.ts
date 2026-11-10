/**
 * Host error taxonomy.
 *
 * `HostHttpError` carries a wire status and a stable machine-readable code. Neither the
 * code nor the message may contain credentials: callers receive these responses, and the
 * host never echoes a bearer token, session hash, or provider password back to a client.
 */
export class HostHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'HostHttpError';
  }
}

/** Invalid or unsafe local configuration. Always fails closed at startup. */
export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostConfigError';
  }
}

/**
 * Raised when an operation needs a production adapter the host was not given.
 *
 * The host deliberately ships no fake executor or verifier: refusing is the honest
 * behavior until a real execution adapter is configured.
 */
export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostUnavailableError';
  }
}
