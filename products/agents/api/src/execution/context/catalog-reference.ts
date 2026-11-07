/**
 * The snapshot embeds the full tool catalog (about 108KB of a 189KB payload) on every step, even
 * when it is byte-identical to the previous step. A content-addressed reference keeps one owner copy
 * per task while replay still resolves the exact same bytes.
 *
 * Activation is opt-in (AGENTS_CATALOG_REFERENCE=on) because replay determinism must be proven first.
 * Hydration is always available, so a snapshot written with a reference stays readable even if the
 * flag is later turned off.
 */
export interface CatalogDigest {
  digest: string;
}

export interface PreviousCatalog {
  id: string;
  /** Snapshot that physically holds the inline catalogue, when the previous step referenced one. */
  owner: string | null;
  digest: string | null;
}

export function catalogReferenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTS_CATALOG_REFERENCE === "on";
}

export function catalogSnapshotFields(
  catalog: CatalogDigest | undefined,
  previous: PreviousCatalog | undefined,
  enabled = catalogReferenceEnabled(),
): Record<string, unknown> {
  if (!catalog) return {};
  const digest = catalog.digest;
  if (!enabled || !previous || previous.digest !== digest) {
    return { catalog, catalogDigest: digest, catalogOwner: null };
  }
  const owner = previous.owner ?? previous.id;
  return { catalogRef: owner, catalogDigest: digest, catalogOwner: owner };
}

/** Resolve a reference into the catalogue the runtime expects. A missing owner is a hard failure. */
export async function hydrateCatalog<T extends Record<string, unknown>, C>(
  payload: T,
  load: (snapshotId: string) => Promise<C | null>,
): Promise<T> {
  if (payload.catalog !== undefined || typeof payload.catalogRef !== "string") return payload;
  const catalog = await load(payload.catalogRef);
  if (catalog === null) throw new Error("CATALOG_REFERENCE_UNAVAILABLE");
  return { ...payload, catalog } as T;
}
