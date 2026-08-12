export type ConnectorAuthScheme = "oauth2" | "api_key" | "webhook";

export interface ConnectorRateLimit {
  requests: number;
  windowSeconds: number;
}

export interface ConnectorManifest {
  id: string;
  version: string;
  displayName: string;
  ownerService: string;
  auth: ConnectorAuthScheme;
  requiredScopes: string[];
  capabilityNames: string[];
  rateLimit: ConnectorRateLimit;
  redactedFields: string[];
  supportsReconciliation: boolean;
}
