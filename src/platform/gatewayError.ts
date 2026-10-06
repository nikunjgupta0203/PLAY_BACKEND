/**
 * A payment provider failed or refused. `status` is the HTTP status the API
 * should answer with (payments R7).
 *
 * Lives apart from paymentGateway.ts because adapters throw it and
 * paymentGateway.ts constructs the adapters at load time: importing it from
 * there is a cycle, and under Vitest the adapter's factory is not yet defined
 * when paymentGateway.ts calls it.
 */
export class GatewayError extends Error {
  readonly status: number;
  /** The provider's own HTTP status, when it answered (404: it has no such object). */
  readonly upstreamStatus: number | null;
  constructor(status: number, message: string, upstreamStatus: number | null = null) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}
