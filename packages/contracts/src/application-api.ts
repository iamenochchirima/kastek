/** Standalone Agents application API response shapes. */
export interface ApplicationAgentSummary {
  id: string;
  name: string;
}

export interface ApplicationAgentVersion {
  id: string;
  number: number;
  createdAt: string;
}

export interface ApplicationAgentDetail extends ApplicationAgentSummary {
  version: ApplicationAgentVersion;
}

export interface ApplicationAgentsResponse {
  agents: ApplicationAgentSummary[];
}

export interface ApplicationAgentResponse {
  agent: ApplicationAgentDetail;
}

export interface ApplicationCredentialSummary { id: string; scopes: string[]; createdAt: string; revokedAt: string | null }
export interface ApplicationCredentialSecret { id: string; scopes: string[]; secret: string }
export interface ApplicationSummary { id: string; name: string; agentIds: string[]; createdAt: string; revokedAt: string | null; credentials: ApplicationCredentialSummary[] }
export interface ApplicationCreateResponse { application: { id: string; name: string; agentIds: string[] }; credential: ApplicationCredentialSecret }
export interface ApplicationCredentialResponse { credential: ApplicationCredentialSecret }
export interface ApplicationRunStartResponse { taskId: string; conversationId: string; state: string; replayed: boolean }
export interface ApplicationRunSnapshot { taskId: string; conversationId: string; state: string; errorCode: string | null;
  output: string | null; outputAvailability: string; updates: unknown[]; updatesTruncated: boolean }

export interface ApplicationAgentCreateRequest { name: string; purpose?: string; instructions?: string; operationId: string }
export interface ApplicationAgentUpdateRequest { name?: string; configuration: unknown; expectedRevision: number }
export interface ApplicationAgentPublishRequest { expectedRevision: number }
export interface ApplicationAgentBindRequest { versionId?: string; allowedOrigins: string[] }
export interface ApplicationAgentPreviewRequest { configuration: unknown }
export interface ApplicationAgentPreviewResponse { ready: boolean; errors: Array<{ code: string; message: string }> }
export interface ApplicationAgentVersionSummary { id: string; number: number; createdAt: string }
export interface ApplicationAgentBinding { id: string; versionId: string; allowedOrigins: string[]; publishedAt: string }
