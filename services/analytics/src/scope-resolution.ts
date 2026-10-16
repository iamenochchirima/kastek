import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AnalyticsContext } from './context.js';
import type { ReportingResolverCredential } from './config.js';
import { apiJson } from './json.js';
import { typedQuery } from './query.js';
export const PATH = '/internal/reporting/scopes/resolve';
export class ScopeResolverAuthenticator {
  constructor(
    private readonly credentials: readonly ReportingResolverCredential[],
  ) {}
  authenticate(request: Pick<FastifyRequest, 'headers'>): string | null {
    const source = request.headers['x-source-service'],
      authorization = request.headers.authorization;
    if (
      typeof source !== 'string' ||
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    )
      return null;
    const service = source.trim(),
      token = authorization.slice(7).trim();
    if (!service || !token) return null;
    const credential = this.credentials.find(
      (value) => value.source_service === service,
    );
    return credential &&
      createHash('sha256').update(token).digest('hex') ===
        credential.token_sha256
      ? service
      : null;
  }
}
export function registerScopeResolutionRoutes(
  app: FastifyInstance,
  context: AnalyticsContext,
): void {
  const access = new ScopeResolverAuthenticator(
    context.config.reporting_resolver_credentials,
  );
  app.get(PATH, async (request, reply) => {
    const query = typedQuery(request.raw.url, ['scope_kind', 'external_source_id'], {
      required: ['scope_kind', 'external_source_id'],
    });
    const scopeKind = query.scope_kind as string,
      externalSourceId = query.external_source_id as string;
    const source = access.authenticate(request);
    if (!source)
      return reply
        .code(401)
        .send({ error: 'scope resolver authentication failed' });
    if (
      !scopeKind.trim() ||
      Buffer.byteLength(scopeKind) > 128 ||
      !externalSourceId.trim() ||
      Buffer.byteLength(externalSourceId) > 512
    )
      return reply
        .code(400)
        .send({ error: 'scope_kind and external_source_id are required' });
    try {
      const result = await context.pool.query(
        `SELECT scope_id,scope_kind,owning_source_service,external_source_id,root_scope_id,parent_scope_id,reporting_timezone FROM analytics.reporting_scope WHERE owning_source_service=$1 AND scope_kind=$2 AND external_source_id=$3 AND status='active' LIMIT 1`,
        [source, scopeKind.trim(), externalSourceId.trim()],
      );
      const row = result.rows[0];
      if (!row)
        return reply
          .code(404)
          .send({ error: 'reporting scope is not available' });
      return reply
        .type('application/json')
        .send(
          apiJson({
            ...row,
            scope_id: BigInt(row.scope_id),
            root_scope_id: BigInt(row.root_scope_id),
            parent_scope_id:
              row.parent_scope_id === null ? null : BigInt(row.parent_scope_id),
          }),
        );
    } catch (error) {
      request.log.error(
        {
          event: 'operation.failed',
          operation: 'reporting.resolve_scope',
          error_type: error instanceof Error ? error.name : 'unknown',
        },
        'reporting scope resolution failed',
      );
      return reply
        .code(500)
        .send({ error: 'reporting scope resolution failed' });
    }
  });
}
