import type { ConnectorManifest } from "./types";

export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorManifest>();

  public register(manifest: ConnectorManifest): void {
    if (!/^[a-z0-9][a-z0-9._-]{1,119}$/.test(manifest.id)) throw new Error("Connector id is invalid");
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Connector version is invalid: ${manifest.id}`);
    if (!manifest.ownerService.trim() || !manifest.displayName.trim()) throw new Error(`Connector ownership metadata is required: ${manifest.id}`);
    if (manifest.rateLimit.requests < 1 || manifest.rateLimit.windowSeconds < 1) throw new Error(`Connector rate limit is invalid: ${manifest.id}`);
    if (this.connectors.has(manifest.id)) throw new Error(`Duplicate connector: ${manifest.id}`);
    this.connectors.set(manifest.id, { ...manifest, requiredScopes: [...manifest.requiredScopes], capabilityNames: [...manifest.capabilityNames], redactedFields: [...manifest.redactedFields] });
  }

  public get(id: string): ConnectorManifest | undefined {
    const manifest = this.connectors.get(id);
    return manifest ? { ...manifest, requiredScopes: [...manifest.requiredScopes], capabilityNames: [...manifest.capabilityNames], redactedFields: [...manifest.redactedFields] } : undefined;
  }

  public list(): ConnectorManifest[] {
    return [...this.connectors.values()].map((manifest) => ({ ...manifest, requiredScopes: [...manifest.requiredScopes], capabilityNames: [...manifest.capabilityNames], redactedFields: [...manifest.redactedFields] }));
  }
}
