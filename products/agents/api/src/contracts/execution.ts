import type { CapabilityBinding } from "./capability-catalog";
import type { AgentConfiguration } from "./contracts";
import type { TaskRecord } from "./records";
import type { DependencyManifest } from "./source-contracts";
import type { AcceptedModelRoutes } from "./model-bindings";
export const HARNESS_RELEASE = "product-capabilities-v11";
export const WORKFLOW_NAME = "AgentsBusinessRunV21";
// The contextual handoff controller is published separately from existing V21 tasks.
export const HANDOFF_HARNESS_RELEASE = "product-capabilities-v12";
export const HANDOFF_WORKFLOW_NAME = "AgentsBusinessRunV22";
export const LEGACY_ADAPTIVE_HARNESS_RELEASE = "product-capabilities-v13";
export const LEGACY_ADAPTIVE_WORKFLOW_NAME = "AgentsBusinessRunV23";
export const ADAPTIVE_HARNESS_RELEASE = "product-capabilities-v14";
export const ADAPTIVE_WORKFLOW_NAME = "AgentsBusinessRunV24";
export const SHARED_HARNESS_RELEASE = "product-capabilities-v15";
export const SHARED_WORKFLOW_NAME = "AgentsBusinessRunV25";
export const supportedRuntimeReleases = [HARNESS_RELEASE, HANDOFF_HARNESS_RELEASE, LEGACY_ADAPTIVE_HARNESS_RELEASE, ADAPTIVE_HARNESS_RELEASE, SHARED_HARNESS_RELEASE] as const;
export const runtimeWorkflows: Readonly<Record<string,string>> = { [HARNESS_RELEASE]: WORKFLOW_NAME, [HANDOFF_HARNESS_RELEASE]: HANDOFF_WORKFLOW_NAME, [LEGACY_ADAPTIVE_HARNESS_RELEASE]: LEGACY_ADAPTIVE_WORKFLOW_NAME, [ADAPTIVE_HARNESS_RELEASE]: ADAPTIVE_WORKFLOW_NAME, [SHARED_HARNESS_RELEASE]: SHARED_WORKFLOW_NAME };
export const CONTEXT_COMPACTION_WORKFLOW = "AgentsContextCompactionV1";
export const dispatcherPhases = ["dispatch", "capacity", "capacity_notifications", "controls", "reconciliation"] as const;
export type DispatcherPhase = typeof dispatcherPhases[number];
export interface Execution { task: TaskRecord & { turn_sequence: string; history_cutoff: string | null;
  tokens_used: number; tokens_reserved: number; active_ms: number; active_reserved_ms: number; root_token_limit: number | null; model_calls: number; tool_calls: number;
  deadline_at: Date | null; harness_release: string; control_generation: string; pending_outcome: TaskOutcome | null }; configuration: AgentConfiguration; agentId: string;
  toolBindings:{name:string;version:string;digest:string}[]; connectedBindings: CapabilityBinding[]; models: AcceptedModelRoutes }
export interface MemoryFence { id: string; generation: number; expiresAt?: number }
export interface OperationRequest { id: string; kind: "model" | "compaction" | "tool" | "delegation" | "resource"; name: string;
  instructionHead?:string;
  workload?:"background";
  primaryReserve?:{tokens:number;activeMs:number};
  request: unknown; reservedTokens: number; reservedMs: number; memoryFence?: MemoryFence; evidenceManifest?: DependencyManifest; retrySafe?: boolean; reconcile?: boolean; maxResultBytes?:number }
export interface OperationRecord { kind: OperationRequest["kind"]; id: string; task_id: string; state: "started" | "completed" | "failed" | "uncertain";
  output: unknown; error_code: string | null; reserved_tokens: number; reserved_ms: number; accounted_tokens: number; started_at: Date; attempt_id: string }
export interface TaskOutcome { state: "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "uncertain"; output?: string; errorCode?: string }
