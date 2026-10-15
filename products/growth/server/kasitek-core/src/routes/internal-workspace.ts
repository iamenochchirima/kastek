import type { FastifyInstance } from 'fastify';
import type { CoreContext } from '../context.js';
import { requireInternalAgent } from '../identity/internal-delegation.js';
import { agentWorkspaceReport } from '../services/workspace-reporting.js';

export async function registerInternalWorkspaceRoutes(app: FastifyInstance, core: CoreContext): Promise<void> {
  app.get('/api/internal/agents/v1/workspace/report', async (request) => {
    const { organizationId, actorId } = await requireInternalAgent(request, core, 'kasitek.core.workspace_report');
    const report = await agentWorkspaceReport(core.pool, organizationId);
    request.log.info({ event: 'http.request.completed', operation: 'workspace.report',
      organization_id: organizationId, actor_id: actorId }, 'agent workspace report completed');
    return report;
  });
}
