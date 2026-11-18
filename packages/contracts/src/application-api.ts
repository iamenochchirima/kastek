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
