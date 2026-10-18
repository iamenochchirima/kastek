import type { CapabilityBinding, Configuration, Connection } from "./api";

export function connectedAuthorityIds(configuration: Configuration): Set<string> {
  const delegation = configuration.capabilities.delegation;
  return new Set([...(configuration.connectedToolBindingIds ?? []), ...(delegation.enabled
    ? delegation.bindings.flatMap(binding => binding.connectedToolBindingIds ?? []) : [])]);
}

export function connectedBindingAvailable(binding: CapabilityBinding, connections: Connection[]): boolean {
  const connection = connections.find(item => item.id === binding.connection?.id);
  return connection?.state === "active" && new Date(connection.expiresAt).getTime() > Date.now()
    && connection.policyRevision === binding.connection?.policyRevision;
}
