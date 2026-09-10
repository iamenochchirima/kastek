import type {
  AgentCapability,
  AgentConnectionDirectoryEntry,
  AgentEffectiveConfigProjection,
  AgentMemoryObservatoryGraph,
} from "@/lib/agent-platform";
import type { ExecutionObservatoryState, ExecutionStageState } from "./studio-execution-reducer";
import type { StudioGraphEdge, StudioGraphNode, StudioGraphStatus, StudioNodeActivity } from "./studio-system-canvas";

type ProjectionInput = {
  effectiveConfig: AgentEffectiveConfigProjection | null;
  capabilities?: AgentCapability[];
  connections?: AgentConnectionDirectoryEntry[];
  modelLabel?: string;
  execution?: ExecutionObservatoryState;
  memory?: AgentMemoryObservatoryGraph | null;
  configurationState?: "loading" | "ready" | "unavailable";
  handoffEnabled?: boolean;
};

export type StudioObservatoryProjection = {
  nodes: StudioGraphNode[];
  edges: StudioGraphEdge[];
};

type CoreDefinition = Pick<StudioGraphNode, "id" | "label" | "detail" | "kind" | "configured" | "configurable" | "scope" | "event"> & { data: Record<string, string> };

const coreDefinitions: CoreDefinition[] = [
  { id: "input", label: "Message input", detail: "Inbound message or interaction", kind: "input", configured: true, scope: "channel", event: "run.received", data: { source: "conversation or gateway", mode: "inbound" } },
  { id: "channel", label: "Channel gateway", detail: "Normalize and authenticate", kind: "channel", configured: true, configurable: true, scope: "workspace", event: "channel.accepted", data: { channels: "configured channels", auth: "workspace binding" } },
  { id: "session", label: "Session", detail: "Durable run and conversation", kind: "session", configured: true, scope: "tenant / conversation", event: "run.started", data: { state: "durable", retries: "journal-backed" } },
  { id: "context", label: "Context engine", detail: "Compose the model's working set", kind: "context", configured: true, configurable: true, scope: "agent / run", event: "agent.context.prepared", data: { policy: "bounded context", sources: "messages · knowledge · memory" } },
  { id: "memory-read", label: "Memory read", detail: "Facts, preferences, and prior work", kind: "memory", configured: true, configurable: true, scope: "tenant / user / agent", event: "memory.retrieval.completed", data: { mode: "configured memory policy" } },
  { id: "retrieval", label: "Knowledge retrieval", detail: "Connected sources and evidence", kind: "retrieval", configured: true, configurable: true, scope: "workspace", event: "context.retrieval.completed", data: { sources: "configured knowledge sources" } },
  { id: "model", label: "Primary model", detail: "Reason, plan, and choose next step", kind: "model", configured: true, configurable: true, scope: "agent version", event: "agent.model.completed", data: { provider: "configured model provider", turn: "bounded by run policy" } },
  { id: "router", label: "Capability router", detail: "Select the next operation", kind: "router", configured: true, scope: "agent version", event: "agent.route.selected", data: { policy: "effective capability set" } },
  { id: "approval", label: "Approval gate", detail: "Pause before sensitive actions", kind: "approval", configured: true, configurable: true, scope: "workspace policy", event: "approval.requested", data: { policy: "runtime approval contract" } },
  { id: "handoff", label: "Human handoff", detail: "Escalate with full context", kind: "handoff", configured: true, configurable: true, scope: "workspace / team", event: "handoff.requested", data: { target: "configured handoff destination" } },
  { id: "memory-write", label: "Memory write", detail: "Persist useful outcomes", kind: "memory", configured: true, configurable: true, scope: "tenant / user / agent", event: "memory.write.completed", data: { lifecycle: "configured memory policy" } },
  { id: "output", label: "Response", detail: "Assemble the final answer", kind: "output", configured: true, scope: "run", event: "run.output.completed", data: { format: "channel-aware response" } },
  { id: "delivery", label: "Delivery", detail: "Send and record the result", kind: "delivery", configured: true, configurable: true, scope: "channel", event: "message.delivered", data: { receipts: "durable delivery evidence" } },
];

function statusFromExecution(stage?: ExecutionStageState): StudioGraphStatus | undefined {
  if (!stage) return undefined;
  if (stage.status === "running") return "running";
  if (stage.status === "waiting") return "waiting";
  if (stage.status === "error") return "error";
  if (stage.status === "complete") return "complete";
  if (stage.status === "skipped") return "skipped";
  if (stage.status === "queued") return "ready";
  return "idle";
}

function traceStatus(status: StudioGraphStatus): "pending" | "running" | "complete" | "error" {
  if (status === "running" || status === "waiting") return "running";
  if (status === "error") return "error";
  if (status === "complete" || status === "skipped") return "complete";
  return "pending";
}

function activityForExecution(stage?: ExecutionStageState, execution?: ExecutionObservatoryState): StudioNodeActivity | undefined {
  if (!stage || stage.operationCount === 0) return undefined;
  const latest = stage.latestOperationId ? execution?.operations[stage.latestOperationId] : undefined;
  const status = statusFromExecution(stage) ?? "idle";
  return {
    count: stage.operationCount,
    running: stage.activeOperationIds.length,
    complete: stage.completedCount,
    waiting: status === "waiting" ? 1 : 0,
    errors: stage.errorCount,
    latest: {
      id: latest?.operationId ?? stage.stageId,
      event: latest?.status === "error" ? "stage.failed" : latest?.status === "running" ? "stage.started" : "stage.completed",
      label: stage.label,
      detail: latest?.error?.message ?? stage.label,
      status: traceStatus(status),
      sequence: latest?.cursor ?? execution?.cursor ?? 0,
    },
  };
}

function executionEvidence(stage?: ExecutionStageState, execution?: ExecutionObservatoryState): StudioGraphNode["evidence"] | undefined {
  if (!stage?.latestOperationId) return undefined;
  const operation = execution?.operations[stage.latestOperationId];
  if (!operation) return undefined;
  return {
    id: operation.operationId,
    event: operation.status === "error" ? "stage.failed" : operation.status === "running" ? "stage.started" : "stage.completed",
    sequence: operation.cursor,
    detail: operation.error?.message ?? `${stage.label} · ${operation.status}`,
    operation: {
      id: operation.operationId,
      kind: stage.kind,
      status: operation.status,
      ...(operation.attemptId ? { attemptId: operation.attemptId } : {}),
      ...(operation.error?.code ? { errorCode: operation.error.code } : {}),
    },
  };
}

function capabilityStatus(capability?: AgentCapability, configured = true): StudioGraphStatus {
  if (!configured) return "unavailable";
  if (!capability) return "ready";
  if (capability.available === true || capability.availability === "available" || capability.reasonCode === "available") return "ready";
  if (["not_configured", "unhealthy", "provider_not_configured", "provider_unhealthy", "credential_denied", "feature_disabled", "not_granted"].includes(capability.reasonCode ?? capability.availability)) return "blocked";
  return "unavailable";
}

function connectionStatus(connection?: AgentConnectionDirectoryEntry): StudioGraphStatus {
  if (!connection) return "ready";
  if (connection.configured === true || connection.status === "connected" || connection.status === "ready") return "ready";
  if (["not_configured", "unhealthy", "revoked", "unsupported"].includes(connection.status ?? "")) return "blocked";
  return "unavailable";
}

function normalized(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function labelForCapability(name: string) {
  const last = name.split(/[.:/]/).at(-1) ?? name;
  return last.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function capabilityPosition(index: number) {
  return { x: 48 + (index % 4) * 132, y: 560 + Math.floor(index / 4) * 104 };
}

function stageForCapability(execution: ExecutionObservatoryState | undefined, name: string) {
  return execution?.topology[`capability:${name}`];
}

function capabilityNode(input: {
  id: string;
  label: string;
  detail: string;
  kind: StudioGraphNode["kind"];
  status: StudioGraphStatus;
  provider?: string;
  scope: string;
  event: string;
  data: Record<string, string>;
  index: number;
  configured: boolean;
  configurable: boolean;
  stage?: ExecutionStageState;
  execution?: ExecutionObservatoryState;
}): StudioGraphNode {
  const executionStatus = statusFromExecution(input.stage);
  const activity = activityForExecution(input.stage, input.execution);
  return {
    id: input.id,
    label: input.label,
    detail: input.detail,
    kind: input.kind,
    status: executionStatus ?? input.status,
    configured: input.configured,
    configurable: input.configurable,
    provider: input.provider,
    scope: input.scope,
    event: input.event,
    data: input.data,
    position: capabilityPosition(input.index),
    ...(activity ? { activity } : {}),
    evidence: executionEvidence(input.stage, input.execution),
  };
}

function coreStageId(id: string) {
  return id === "output" ? "response" : id;
}

function buildEdges(nodes: StudioGraphNode[], execution?: ExecutionObservatoryState): StudioGraphEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const definitions: StudioGraphEdge[] = [
    { id: "input-channel", source: "input", target: "channel", sourceAnchor: "bottom", targetAnchor: "top" },
    { id: "channel-session", source: "channel", target: "session", sourceAnchor: "bottom", targetAnchor: "top" },
    { id: "session-context", source: "session", target: "context", sourceAnchor: "right", targetAnchor: "left" },
    { id: "context-model", source: "context", target: "model", sourceAnchor: "right", targetAnchor: "left" },
    { id: "context-memory", source: "context", target: "memory-read", sourceAnchor: "bottom", targetAnchor: "top" },
    { id: "memory-retrieval", source: "memory-read", target: "retrieval", sourceAnchor: "right", targetAnchor: "left" },
    { id: "retrieval-model", source: "retrieval", target: "model", sourceAnchor: "top", targetAnchor: "bottom" },
    { id: "model-router", source: "model", target: "router", sourceAnchor: "right", targetAnchor: "top" },
    { id: "router-approval", source: "router", target: "approval", sourceAnchor: "right", targetAnchor: "left", dashed: true },
    { id: "router-handoff", source: "router", target: "handoff", sourceAnchor: "right", targetAnchor: "left", dashed: true },
    { id: "router-output", source: "router", target: "output", sourceAnchor: "right", targetAnchor: "left", routeY: 445 },
    { id: "approval-output", source: "approval", target: "output", sourceAnchor: "right", targetAnchor: "left" },
    { id: "handoff-output", source: "handoff", target: "output", sourceAnchor: "right", targetAnchor: "left", dashed: true },
    { id: "output-memory", source: "output", target: "memory-write", sourceAnchor: "bottom", targetAnchor: "top", dashed: true },
    { id: "output-delivery", source: "output", target: "delivery", sourceAnchor: "bottom", targetAnchor: "top" },
    { id: "delivery-session", source: "delivery", target: "session", sourceAnchor: "left", targetAnchor: "right", dashed: true },
  ];
  for (const node of nodes.filter((candidate) => ["tool", "connector", "mcp", "skill", "child"].includes(candidate.kind))) {
    definitions.push({ id: `router-${node.id}`, source: "router", target: node.id, sourceAnchor: "bottom", targetAnchor: "top" });
    definitions.push({ id: `${node.id}-model`, source: node.id, target: "model", sourceAnchor: "top", targetAnchor: "bottom", dashed: true });
  }
  const activeRoute = execution?.activeRoute;
  return definitions
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      ...(activeRoute && activeRoute.sourceStageId === edge.source && activeRoute.targetStageId === edge.target
        ? {
            status: execution?.topology[edge.target]?.status === "error"
              ? "failed" as const
              : execution?.topology[edge.target]?.status === "complete"
                ? "complete" as const
                : "active" as const,
          }
        : {}),
    }));
}

export function projectStudioObservatory(input: ProjectionInput): StudioObservatoryProjection {
  const effective = input.effectiveConfig;
  const execution = input.execution;
  const configUnavailable = input.configurationState === "unavailable";
  const definitions = coreDefinitions.filter((definition) => definition.id !== "handoff" || input.handoffEnabled === true);
  const coreNodes = definitions.map((definition) => {
    const data = { ...definition.data };
    if (definition.id === "channel" && effective?.channels.length) data.channels = effective.channels.join(" · ");
    if (definition.id === "context" && effective) data.sources = `${effective.knowledge.sourceIds.length} knowledge · ${effective.memory.mode ? `memory ${String(effective.memory.mode)}` : "memory configured"}`;
    if (definition.id === "memory-read" && effective) data.mode = typeof effective.memory.mode === "string" ? effective.memory.mode : "configured";
    if (definition.id === "retrieval" && effective) data.sources = effective.knowledge.sourceIds.length ? effective.knowledge.sourceIds.join(" · ") : "none configured";
    if (definition.id === "model" && effective) {
      data.provider = effective.model.provider ?? "unresolved";
      data.model = effective.model.model ?? "unresolved";
      if (effective.model.error) data.error = effective.model.error;
    }
    if (definition.id === "router" && effective) data.capabilities = `${effective.tools.length} tools · ${effective.skills.length} skills · ${effective.remoteMcpProviders.length} MCP`;
    const stage = execution?.topology[coreStageId(definition.id)];
    const memory = definition.id === "memory-read" || definition.id === "retrieval"
      ? input.memory?.nodes.filter((candidate) => ["retrieval_plan", "evidence"].includes(candidate.kind)).at(-1)
      : definition.id === "memory-write"
        ? input.memory?.nodes.filter((candidate) => ["capture", "semantic_revision", "episodic_revision", "projection", "deletion"].includes(candidate.kind)).at(-1)
        : undefined;
    const status = statusFromExecution(stage) ?? (configUnavailable ? "unavailable" : "idle");
    return {
      ...definition,
      status,
      label: definition.id === "model" ? effective?.model.model ?? input.modelLabel ?? definition.label : definition.label,
      data,
      ...(activityForExecution(stage, execution) ? { activity: activityForExecution(stage, execution) } : {}),
      evidence: executionEvidence(stage, execution) ?? (memory ? {
        id: memory.id,
        event: "memory.observatory",
        sequence: memory.sequence ?? 0,
        detail: `${memory.kind} · ${memory.status}`,
        memory: {
          id: memory.id,
          kind: memory.kind,
          status: memory.status,
          sequence: memory.sequence ?? 0,
          evidenceCount: memory.evidenceIds.length,
          revisionCount: memory.revisionIds.length,
          sourceEventCount: memory.sourceEventIds.length,
          revisionIds: memory.revisionIds.slice(0, 8),
          sourceEventIds: memory.sourceEventIds.slice(0, 8),
          evidenceIds: memory.evidenceIds.slice(0, 8),
          ...(memory.errorCode ? { errorCode: memory.errorCode } : {}),
        },
      } : undefined),
    } satisfies StudioGraphNode;
  });

  const capabilityByName = new Map((input.capabilities ?? []).map((capability) => [normalized(capability.name), capability]));
  const connectionByName = new Map((input.connections ?? []).flatMap((connection) => [[normalized(connection.id), connection] as const, [normalized(connection.name), connection] as const]));
  const capabilityNodes: StudioGraphNode[] = [];
  let index = 0;
  if (effective) {
    for (const tool of effective.tools) {
      const metadata = capabilityByName.get(normalized(tool));
      capabilityNodes.push(capabilityNode({
        id: `capability:${tool}`,
        label: labelForCapability(tool),
        detail: metadata?.description || "Configured tool capability",
        kind: metadata?.catalog?.kind === "mcp_tool" ? "mcp" : "tool",
        status: capabilityStatus(metadata),
        provider: metadata?.catalog?.provider?.name,
        scope: "installation grant",
        event: "agent.tool.completed",
        data: { capability: tool, version: metadata?.version ?? "registry", readiness: metadata?.availability ?? "declared", ...(metadata?.requiresApproval ? { approval: "required" } : {}) },
        index: index++,
        configured: true,
        configurable: true,
        stage: stageForCapability(execution, tool),
        execution,
      }));
    }
    for (const connector of effective.connectors) {
      const metadata = connectionByName.get(normalized(connector));
      capabilityNodes.push(capabilityNode({
        id: `capability:${connector}`,
        label: metadata?.name ?? labelForCapability(connector),
        detail: metadata?.description || "Configured connection",
        kind: "connector",
        status: connectionStatus(metadata),
        provider: metadata?.provider ?? metadata?.oauthProvider,
        scope: "installation connection",
        event: "agent.connector.completed",
        data: { connection: connector, readiness: metadata?.status ?? "declared", auth: metadata?.auth ?? "managed" },
        index: index++,
        configured: true,
        configurable: true,
        stage: stageForCapability(execution, connector),
        execution,
      }));
    }
    for (const skill of effective.skills) {
      const name = skill.id || skill.slug;
      capabilityNodes.push(capabilityNode({
        id: `capability:${name}`,
        label: skill.name || skill.slug,
        detail: `Skill v${skill.versionNumber}`,
        kind: "skill",
        status: skill.status === "published" ? "ready" : "blocked",
        scope: "agent version",
        event: "agent.skill.completed",
        data: { skill: skill.slug, version: String(skill.versionNumber), checksum: skill.checksum, required: `${skill.requiredCapabilities.length} capabilities` },
        index: index++,
        configured: true,
        configurable: true,
        stage: stageForCapability(execution, name) ?? stageForCapability(execution, skill.slug),
        execution,
      }));
    }
    for (const provider of effective.remoteMcpProviders) {
      capabilityNodes.push(capabilityNode({
        id: `capability:${provider.id}`,
        label: provider.providerName,
        detail: `${provider.toolCount} MCP tools · ${provider.protocolVersion}`,
        kind: "mcp",
        status: provider.status === "published" && provider.healthStatus === "healthy" ? "ready" : "blocked",
        provider: provider.providerName,
        scope: "agent version",
        event: "agent.mcp.tool.completed",
        data: { provider: provider.providerName, revision: String(provider.revision), tools: String(provider.toolCount), checksum: provider.checksum },
        index: index++,
        configured: true,
        configurable: true,
        stage: stageForCapability(execution, provider.id),
        execution,
      }));
    }
  }

  const declaredStageIds = new Set([...coreNodes, ...capabilityNodes].map((node) => node.id));
  const observedNodes = Object.values(execution?.topology ?? {})
    .filter((stage) => stage.stageId.startsWith("capability:") && !declaredStageIds.has(stage.stageId))
    .map((stage) => capabilityNode({
      id: stage.stageId,
      label: stage.label,
      detail: "Observed capability not declared in this configuration",
      kind: "tool",
      status: "unavailable",
      scope: "runtime observation",
      event: "agent.tool.completed",
      data: { capability: stage.stageId.slice("capability:".length), availability: "observed", configuration: "unresolved" },
      index: index++,
      configured: false,
      configurable: false,
      stage,
      execution,
    }));
  const nodes = [...coreNodes, ...capabilityNodes, ...observedNodes];
  return { nodes, edges: buildEdges(nodes, execution) };
}
