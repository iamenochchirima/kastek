import type { ExecutionScope } from "./execution-scope";

/**
 * The deliberately small projection accepted by memory and knowledge
 * repositories. It is derived from the canonical scope; callers do not get
 * to provide a second organization or installation identity.
 */
export interface ScopedResourceAccess {
  organizationId: string;
  agentId: string;
  installationId?: string;
  conversationId?: string;
  actorId?: string;
  runId?: string;
}

export function resourceAccessFromExecutionScope(scope: ExecutionScope): ScopedResourceAccess {
  return {
    organizationId: scope.organizationId,
    agentId: scope.agentDefinitionId,
    installationId: scope.installationId,
    ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    ...(scope.actorId ? { actorId: scope.actorId } : {}),
    runId: scope.runId,
  };
}

