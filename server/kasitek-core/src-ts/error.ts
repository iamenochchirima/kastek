import type { FastifyInstance, FastifyError } from 'fastify';

/** Preserve the Rust API's {error,code} response and explicit status. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      if (error.status === 429) reply.header('retry-after', '60');
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    if ('validation' in error && error.validation) {
      return reply.code(400).send({ error: 'Invalid request', code: 'bad_request' });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message, code: 'bad_request' });
    }
    // Database error messages/details often contain row values or query parameters.
    const database = error as Error & { severity?: string; code?: string; table?: string; constraint?: string };
    const isDatabase = typeof database.severity === 'string' && /^[A-Z0-9]{5}$/.test(database.code ?? '');
    request.log.error({ event: isDatabase ? 'database.query.failed' : 'operation.failed',
      error_type: error.name, ...(isDatabase ? { sqlstate: database.code, table: database.table,
        constraint: database.constraint } : {}) }, 'Request failed');
    return reply.code(500).send({ error: isDatabase ? 'Database operation failed' : 'Internal server error', code: 'internal_error' });
  });
}
