import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { typedQuery } from '../typed-query.js';
import { extractUser, resolveActiveOrgId } from '../identity/session.js';
import { requireAdmin } from '../services/orgs.js';
import * as email from '../services/email/index.js';
export function registerEmailRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  async function scope(request: FastifyRequest) {
    const user = await extractUser(request, context),
      orgId = await resolveActiveOrgId(request, context, user.id);
    return { user, orgId };
  }
  app.get('/api/email/providers', async () => ({
    providers: email.providerOptions(),
    customEmail: { status: 'coming_soon' },
  }));
  app.get('/api/email/connections', async (request) => ({
    connections: (
      await email.listEmailConnections(
        context.pool,
        (await scope(request)).orgId,
      )
    ).map(email.publicEmailConnection),
  }));
  app.post<{ Params: { id: string } }>(
    '/api/email/connections/:id/sync',
    async (request) => ({
      success: true,
      messagesInserted: await email.syncConnection(
        context.pool,
        context.config,
        (await scope(request)).orgId,
        request.params.id,
      ),
    }),
  );
  app.get<{ Params: { provider: string }; Querystring: { returnTo?: string } }>(
    '/api/email/oauth/:provider/start',
    async (request) => {
      const query = typedQuery<{ returnTo?: string }>(request.query, [
          'returnTo',
        ]),
        { user, orgId } = await scope(request);
      await requireAdmin(context.pool, orgId, user.id);
      const provider = email.providerConfig(
          context.config,
          request.params.provider,
        ),
        state = await email.createOAuthState(
          context.pool,
          orgId,
          user.id,
          provider,
          email.safeReturnPath(query.returnTo),
        );
      return {
        provider: provider.provider,
        authorizationUrl: email.authorizationUrl(provider, state),
      };
    },
  );
  app.get<{
    Params: { provider: string };
    Querystring: {
      state?: string;
      code?: string;
      error?: string;
      error_description?: string;
    };
  }>(
    '/api/email/oauth/:provider/callback',
    async (request, reply) => {
      const query = typedQuery<{
        state?: string;
        code?: string;
        error?: string;
        error_description?: string;
      }>(request.query, ['state', 'code', 'error', 'error_description']);
      if (query.state === undefined)
        throw new ApiError(400, 'bad_request', 'Email OAuth state is missing');
      const state = await email.consumeOAuthState(context.pool, query.state);
      if (!state)
        throw new ApiError(
          400,
          'bad_request',
          'Email OAuth state is invalid or expired',
        );
      const provider = email.normalizeProvider(request.params.provider);
      if (state.provider !== provider)
        throw new ApiError(
          400,
          'bad_request',
          'Email OAuth provider does not match the request',
        );
      const redirect = (path: string) =>
        reply
          .code(302)
          .header('Location', email.frontendRedirect(context.config, path))
          .send();
      if (typeof query.error === 'string')
        return redirect(
          email.oauthErrorPath(
            state,
            query.error === 'access_denied'
              ? 'access_denied'
              : 'provider_error',
          ),
        );
      if (typeof query.code !== 'string')
        throw new ApiError(400, 'bad_request', 'Email OAuth code is missing');
      try {
        await email.finishOAuth(
          context.pool,
          context.config,
          state,
          query.code,
        );
        return redirect(email.oauthSuccessPath(state, provider));
      } catch (error) {
        return redirect(
          email.oauthErrorPath(
            state,
            error instanceof ApiError ? error.code : 'internal_error',
          ),
        );
      }
    },
  );
}
