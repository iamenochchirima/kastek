const namespacePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Restate service names are global to a Restate instance. Evaluation sandboxes
 * share one local Restate server, so each sandbox prefixes its registered
 * services with a stable namespace. Product records keep the logical workflow
 * names; only registration and dispatch use the physical name.
 */
export function restateServiceName(
  name: string,
  namespace = process.env.AGENTS_RESTATE_NAMESPACE?.trim(),
): string {
  if (!namespace) return name;
  if (!namespacePattern.test(namespace)) {
    throw new Error("Invalid AGENTS_RESTATE_NAMESPACE");
  }
  return `${namespace}-${name}`;
}
