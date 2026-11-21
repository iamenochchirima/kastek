import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Account, Organization } from "../../contracts/records";

/** Session and workspace records used by the shell routes. */
export interface WorkspaceStorePort {
  revokeSession(token: string): Promise<void>;
  ensureInitialWorkspace(accountId: string): Promise<void>;
  listOrganizations(accountId: string): Promise<Organization[]>;
  createOrganization(accountId: string, name: string): Promise<Organization>;
}

export interface WorkspaceIdentityPort {
  logoutUrl(): Promise<string>;
  backchannelLogout(token: string): Promise<void>;
}

/** Session, workspace creation and health routes. Paths and payloads stay unchanged. */
export function registerWorkspaceRoutes(app: FastifyInstance, options: {
  pool: Pool;
  store: WorkspaceStorePort;
  identity: WorkspaceIdentityPort;
  sessionCookie: string;
  cookieOptions: { httpOnly: boolean; secure: boolean; sameSite: "lax"; path: string };
  effectivePermissions(organizationId: string, accountId: string): Promise<{ permissions: string[] } | null | undefined>;
  initializeOwnerModel(accountId: string, organizationId: string): Promise<void>;
  account(request: FastifyRequest): Promise<Account>;
}) {
  app.get("/health", async () => ({ status: "ok", service: "agents-platform", schema: "001_platform" }));
  app.get("/ready", async (_request, reply) => {
    const result = await options.pool.query("SELECT version FROM agents_platform.schema_version");
    const ready = result.rows[0]?.version === "001_platform";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable", business: ready, workspace: false });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await options.store.revokeSession(request.cookies[options.sessionCookie] ?? "");
    reply.clearCookie(options.sessionCookie, options.cookieOptions);
    return { redirectTo: await options.identity.logoutUrl() };
  });

  app.post("/api/auth/backchannel-logout", async (request, reply) => {
    const input = z.strictObject({ logout_token: z.string().min(1).max(16_000) }).parse(request.body);
    await options.identity.backchannelLogout(input.logout_token);
    return reply.code(204).send();
  });

  app.get("/api/session", async request => {
    const user = await options.account(request);
    await options.store.ensureInitialWorkspace(user.id);
    const organizations = await Promise.all((await options.store.listOrganizations(user.id)).map(async organization => ({
      ...organization,
      permissions: (await options.effectivePermissions(organization.id, user.id))?.permissions ?? [],
    })));
    for (const organization of organizations) if (organization.role === "owner") await options.initializeOwnerModel(user.id, organization.id);
    return { account: { id: user.id, email: user.email, displayName: user.display_name }, organizations };
  });

  app.post("/api/organizations", async (request, reply) => {
    const user = await options.account(request), input = z.strictObject({ name: z.string().min(1).max(120) }).parse(request.body);
    const organization = await options.store.createOrganization(user.id, input.name);
    await options.initializeOwnerModel(user.id, organization.id);
    return reply.code(201).send({ organization });
  });
}
