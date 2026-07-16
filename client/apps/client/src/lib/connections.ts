export type ConnectionCapability = {
  key: string;
  enabled: boolean;
  entitlementKey: string | null;
};

export type WorkspaceConnection = {
  id: string;
  provider: string;
  externalAccountId: string | null;
  displayName: string;
  handle: string | null;
  status: "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "NEEDS_ATTENTION" | "DISCONNECTED" | "REVOKED";
  credentialStatus: string;
  healthStatus: string;
  webhookStatus: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
  capabilities: ConnectionCapability[];
  consumers: string[];
  createdAt: string;
  updatedAt: string;
};

export type WhatsappConnectionView = {
  id: string;
  phoneNumberId: string;
  phoneDisplayNumber: string | null;
  wabaId: string;
  currentQualityRating: string;
  dailyLimitEstimate: number | null;
  verified: boolean;
  createdAt: string;
};
