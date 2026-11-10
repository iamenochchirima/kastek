export interface ProvisioningStep {
  name: string;
  status: "pending" | "running" | "complete" | "failed";
  message?: string;
  at?: string;
}

export interface Sandbox {
  id: string;
  product: string;
  status: string;
  profile: string;
  provisioningError: string | null;
  provisioningSteps: ProvisioningStep[];
  provisionedAt: string | null;
  runtime: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxVersion {
  id: string;
  sandboxId: string;
  codeRevision: string;
  imageDigest: string;
  schemaVersion: string;
  migrationChecksum: string;
  configDigest: string;
  runtimeVersion: string;
  modelRoutesDigest: string;
  adapterVersions: Record<string, string>;
  createdAt: string;
  activatedAt: string;
  retiredAt: string | null;
}

export interface WorkspaceRef {
  id: string;
  sandboxId: string;
  productWorkspaceId: string;
  label: string | null;
  createdAt: string;
}

export interface AgentRef {
  id: string;
  sandboxId: string;
  workspaceRefId: string;
  productAgentId: string;
  productVersionId: string;
  sourceIds: string[];
  compositionDigest: string;
  modelRoutesDigest: string;
  createdAt: string;
  updatedAt: string;
}

export type InteractiveSessionState =
  | "active"
  | "waiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export interface InteractiveSession {
  id: string;
  sandboxId: string;
  workspaceRefId: string;
  agentRefId: string;
  productConversationId: string;
  firstTaskId: string;
  latestTaskId: string;
  state: InteractiveSessionState;
  turnCount: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InteractiveTurn {
  id: string;
  sessionId: string;
  productTaskId: string;
  sequence: number;
  inputDigest: string;
  outputDigest: string | null;
  state: InteractiveSessionState;
  createdAt: string;
  updatedAt: string;
}

export type OutcomeKind = "enquiry" | "booking" | "record";
export type OutcomeStatus = "submitted" | "completed" | "unknown";

export interface OutcomeRef {
  id: string;
  sandboxId: string;
  workspaceRefId: string;
  agentRefId: string;
  kind: OutcomeKind;
  productOutcomeId: string;
  productRecordId: string | null;
  status: OutcomeStatus;
  taskId: string | null;
  requestDigest: string;
  responseDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxSummary {
  sandbox: Sandbox;
  version: SandboxVersion | null;
  workspaceRefs: WorkspaceRef[];
  counts: {
    agents: number;
    sessions: number;
    outcomes: number;
  };
}

export interface SandboxPair {
  id: string;
  growthSandboxId: string;
  agentsSandboxId: string;
  createdAt: string;
}

export interface SandboxDetail extends SandboxSummary {
  agents: AgentRef[];
  sessions: InteractiveSession[];
  outcomes: OutcomeRef[];
  pair: SandboxPair | null;
}

export interface SessionSummary extends InteractiveSession {
  sandboxProduct: string;
}

export interface OutcomeSummary extends OutcomeRef {
  sandboxProduct: string;
}

export interface SessionDetail {
  session: InteractiveSession;
  turns: InteractiveTurn[];
}

export interface ServiceHealth {
  ok: boolean;
  service: string;
  version: string;
  controlPlane: {
    url: string;
    configured: boolean;
    reachable: boolean;
    status: string;
  };
}

export interface ProductAgent {
  refId: string;
  product: "agents" | "growth";
  productAgentId: string;
  productVersionId: string;
  workspaceRefId: string;
  name: string;
  description: string | null;
  avatar: string | null;
  ready: boolean;
  revision: string | null;
  model: { label: string; provider?: string; modelId?: string } | null;
  specialists: Array<{ id: string; name: string; state: string }>;
  source: "growth-feature" | "agents-agent";
}

export interface ProductChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  taskId: string | null;
  sources: Array<Record<string, unknown>>;
}

export interface ProductChatResult {
  session: InteractiveSession;
  turn: InteractiveTurn;
  messages: ProductChatMessage[];
  productTaskState: string;
}

export interface AgentModelOption {
  connectionId: string;
  modelId: string;
  label: string;
  provider: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  pricing: {
    currency: "USD";
    inputMicrosPerMillionTokens: number | null;
    outputMicrosPerMillionTokens: number | null;
  } | null;
}

export interface AgentModelCatalogue {
  current: { connectionId: string; modelId: string } | null;
  defaultModel: AgentModelOption | null;
  inherited: boolean;
  revision: number;
  models: AgentModelOption[];
}

export type AgentTargetType = "platform_assistant" | "business_agent";

export interface AgentProfileSpec {
  targetType: AgentTargetType;
  agentName: string;
  offering?: "customer-service";
  avatar?: string;
  model?: {
    providerId: string;
    connectionName: string;
    modelId: string;
  };
  configuration?: Record<string, unknown>;
  setup?: Record<string, unknown>;
  instructions: string;
  knowledge: {
    title: string;
    content: string;
    visibility?: "private" | "public";
  };
  responsibilities: Array<
    "answer-questions" | "customer-support" | "bookings" | "enquiries"
  >;
  website?: {
    allowedOrigins: string[];
  };
}

export interface AgentSetupStep {
  name: string;
  status: "pending" | "running" | "complete" | "failed";
  message?: string;
  at?: string;
}

export interface AgentSetupRun {
  id: string;
  sandboxId: string;
  profileVersionId: string;
  idempotencyKey: string;
  status: "pending" | "running" | "ready" | "failed";
  steps: AgentSetupStep[];
  result: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfile {
  id: string;
  sandboxId: string;
  workspaceRefId: string;
  name: string;
  targetType: AgentTargetType;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileVersion {
  id: string;
  profileId: string;
  version: number;
  spec: AgentProfileSpec;
  specDigest: string;
  createdAt: string;
}

export interface AgentProfileDetail extends AgentProfile {
  version: AgentProfileVersion;
  latestRun: AgentSetupRun | null;
}
