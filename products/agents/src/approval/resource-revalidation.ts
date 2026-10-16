/**
 * Approval snapshots are JSON projections, not provider payloads. Comparing
 * their canonical form prevents key-order differences from invalidating an
 * otherwise identical review while still failing closed on any reviewed
 * resource, capability, or operation change.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function approvalResourceSnapshotsEqual(
  reviewed: Record<string, unknown> | null | undefined,
  current: Record<string, unknown> | null | undefined,
): boolean {
  return JSON.stringify(canonicalize(reviewed ?? {})) === JSON.stringify(canonicalize(current ?? {}));
}
