import type { CoreConfig } from '../config.js';
import { AgentPlatformClient } from './agent-platform/client.js';

/** Inbox persists first; its caller handles an unavailable Agent Platform independently. */
export function forwardIncomingChannelMessage(
  config: CoreConfig,
  organizationId: string,
  actorId: string,
  body: unknown,
  http: typeof fetch = fetch,
): Promise<unknown> {
  return new AgentPlatformClient(config, { fetch: http }).ingestChannelMessage(
    organizationId,
    actorId,
    body,
  );
}
