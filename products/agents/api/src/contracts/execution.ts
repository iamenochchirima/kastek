import type { CapabilityBinding } from "./capability-catalog";
import type { AgentConfiguration } from "./contracts";
import type { TaskRecord } from "./records";
import type { DependencyManifest } from "./source-contracts";
import type { AcceptedModelRoutes } from "./model-bindings";
export const HARNESS_RELEASE = "growth-products-v10";
export const WORKFLOW_NAME = "AgentsBusinessRunV20";
export const dispatcherPhases = ["dispatch", "capacity", "capacity_notifications", "controls", "reconciliation"] as const;
export type DispatcherPhase = typeof dispatcherPhases[number];
export interface Execution { task: TaskRecord & { turn_sequence: string; history_cutoff: string | null;
  tokens_used: number; tokens_reserved: number; root_token_limit: number; model_calls: number; tool_calls: number;
  deadline_at: Date; harness_release: string; control_generation: string; pending_outcome: TaskOutcome | null }; configuration: AgentConfiguration; agentId: string;
  toolBindings:{name:string;version:string;digest:string}[]; connectedBindings: CapabilityBinding[]; models: AcceptedModelRoutes }
export interface MemoryFence { id: string; generation: number; expiresAt?: number }
export interface OperationRequest { id: string; kind: "model" | "compaction" | "tool" | "delegation" | "resource"; name: string;
  request: unknown; reservedTokens: number; reservedMs: number; memoryFence?: MemoryFence; evidenceManifest?: DependencyManifest; retrySafe?: boolean; reconcile?: boolean; maxResultBytes?:number }
export interface OperationRecord { kind: OperationRequest["kind"]; id: string; task_id: string; state: "started" | "completed" | "failed" | "uncertain";
  output: unknown; error_code: string | null; reserved_tokens: number; reserved_ms: number; accounted_tokens: number; started_at: Date; attempt_id: string }
export interface TaskOutcome { state: "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "uncertain"; output?: string; errorCode?: string }
