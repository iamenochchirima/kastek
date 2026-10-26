import type { AdmissionAuthority,AgentConfiguration,TaskState } from "./contracts";
import type { EffectiveComposition } from "./programs";
import type { CustomerSetup } from "./customer-setup";
import type { ChannelBinding } from "./channel";

export interface Account { id: string; issuer: string; subject: string; email: string; display_name: string }
export interface Organization { id: string; name: string; role: "owner" | "member" }
export interface Session { account: Account; providerSessionId: string; expiresAt: Date }
export interface AgentRecord { id: string; organization_id: string; name: string; offering: "faq" | "customer-service" | null; setup?: CustomerSetup | null; draft: AgentConfiguration;
  draft_revision: number; created_by: string; created_at: Date; updated_at: Date }
export interface VersionRecord { id: string; organization_id: string; agent_id: string; number: number;
  draft_revision: number; execution_kind: "business" | "workspace"; configuration: AgentConfiguration; effective_composition: EffectiveComposition; created_by: string; created_at: Date }
export interface WebsiteDeployment { id: string; organization_id: string; agent_id: string; version_id: string;
  appearance: Record<string,unknown>; paused:boolean;
  allowed_origins: string[]; published_by: string; published_at: Date; revoked_at: Date | null }
export interface TaskRecord { id: string; product: AdmissionAuthority["product"]; organization_id: string; resource_id: string;
  caller_client_id: string; principal: AdmissionAuthority["principal"]; version_id: string; grant_id: string;
  conversation_id: string; request_key: string; request_digest: string; input: string; state: TaskState;
  runtime_invocation_id: string | null; output: string | null; error_code: string | null; created_at: Date; updated_at: Date;
  root_task_id: string; parent_task_id: string | null; depth: number; root_token_limit: number; disposition: string;
  delegation_operation_id: string | null; allocation_active_ms: number; allocation_released: boolean; effective_configuration: AgentConfiguration | null;
  effective_composition: EffectiveComposition; evaluation_trial_id: string | null; channel_binding: ChannelBinding | null }
export interface TaskEvent { sequence: string; task_id: string; event_key: string; kind: string; payload: Record<string,unknown>; created_at: Date }
export interface AdmitTaskInput { authority: AdmissionAuthority; grantId: string; versionId: string;
  requestKey: string; input: string; taskId?: string; conversationId?: string; evaluationTrialId?: string; channelBinding?: ChannelBinding; configurationMode?: "current" }
