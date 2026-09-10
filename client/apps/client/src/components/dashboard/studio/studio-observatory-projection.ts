import type {
  AgentCapability,
  AgentConnectionDirectoryEntry,
  AgentEffectiveConfigProjection,
  AgentMemoryObservatoryGraph,
} from "@/lib/agent-platform";
import type { StudioGraphEdge, StudioGraphNode, StudioGraphStatus, StudioNodeActivity } from "@/components/dashboard/studio/studio-system-canvas";

export type StudioTraceItem = {
  id: string;
  event: string;
  label: string;
  detail: string;
  status: "pending" | "running" | "complete" | "error";
  sequence: number;
  data: Record<string, unknown>;
};

export type StudioReadinessSnapshot = {
  ready?: boolean;
  status?: string;
  blockers?: Array<{ code?: string; title?: string; detail?: string; capability?: string; connection?: string }>;
};

type ProjectionInput = {
  effectiveConfig: AgentEffectiveConfigProjection | null;
  capabilities?: AgentCapability[];
  connections?: AgentConnectionDirectoryEntry[];
  readiness?: StudioReadinessSnapshot | null;
  modelLabel?: string;
  trace: StudioTraceItem[];
  operations?: Array<Record<string, unknown>>;
  memory?: AgentMemoryObservatoryGraph | null;
  configurationState?: "loading" | "ready" | "unavailable";
};

export type StudioObservatoryProjection = {
  nodes: StudioGraphNode[];
  edges: StudioGraphEdge[];
};

const coreDefinitions: Array<Pick<StudioGraphNode, "id" | "label" | "detail" | "kind" | "configured" | "configurable" | "scope" | "event"> & { data: Record<string, string> }> = [
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

const coreEventMatchers: Record<string, (event: StudioTraceItem) => boolean> = {
  input: (item) => item.event === "run.received",
  channel: (item) => item.event === "channel.accepted" || item.event.startsWith("channel."),
  session: (item) => item.event === "run.started" || item.event === "run.queued",
  context: (item) => item.event.startsWith("agent.context."),
  "memory-read": (item) => item.event.startsWith("memory.retrieval.") || item.event === "memory.read.completed",
  retrieval: (item) => item.event.startsWith("context.retrieval."),
  model: (item) => item.event.startsWith("agent.model."),
  router: (item) => item.event === "agent.route.selected" || item.event.startsWith("agent.capability."),
  approval: (item) => item.event.startsWith("approval."),
  handoff: (item) => item.event.startsWith("handoff.") || item.event.startsWith("human.handoff."),
  "memory-write": (item) => item.event.startsWith("memory.write.") || item.event.startsWith("memory.persist."),
  output: (item) => item.event.startsWith("run.output.") || item.event === "run.completed",
  delivery: (item) => item.event.startsWith("message.delivered") || item.event.startsWith("delivery."),
};

function normalized(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll("_", ".") : "";
}

function statusForEvent(item: StudioTraceItem): StudioGraphStatus {
  if (item.status === "error") return "error";
  if (item.event === "approval.requested" || item.event === "operation.waiting" || item.event.includes("paused")) return "waiting";
  if (item.status === "running") return "running";
  return "complete";
}

function statusForCore(id: string, trace: StudioTraceItem[]): StudioGraphStatus {
  const matching = trace.filter(coreEventMatchers[id]);
  const latest = matching.at(-1);
  return latest ? statusForEvent(latest) : "idle";
}

function activityForTrace(items: StudioTraceItem[]): StudioNodeActivity | undefined {
  const latest = items.at(-1);
  if (!latest) return undefined;
  return {
    count: items.length,
    running: items.filter((item) => item.status === "running").length,
    complete: items.filter((item) => item.status === "complete").length,
    waiting: items.filter((item) => item.event === "approval.requested" || item.event === "operation.waiting" || item.event.includes("paused")).length,
    errors: items.filter((item) => item.status === "error").length,
    latest: {
      id: latest.id,
      event: latest.event,
      label: latest.label,
      detail: latest.detail,
      status: latest.status,
      sequence: latest.sequence,
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

function tokensForTrace(item: StudioTraceItem) {
  const values = [
    item.event,
    item.label,
    item.detail,
    item.data.name,
    item.data.capability,
    item.data.capability_name,
    item.data.tool,
    item.data.tool_name,
    item.data.provider,
    item.data.operation,
    item.data.operation_key,
    item.data.server,
    item.data.skill,
  ];
  return values.map(normalized).filter(Boolean);
}

function matchesCapability(item: StudioTraceItem, names: string[]) {
  const eventTokens = tokensForTrace(item);
  const capabilityTokens = names.map(normalized).filter(Boolean);
  return capabilityTokens.some((capability) => eventTokens.some((eventToken) => eventToken === capability || eventToken.endsWith(`.${capability}`) || eventToken.includes(capability)));
}

function overlayCapabilityStatus(base: StudioGraphStatus, trace: StudioTraceItem[], names: string[]) {
  const latest = trace.filter((item) => matchesCapability(item, names)).at(-1);
  return latest ? statusForEvent(latest) : base;
}

function latestCapabilityEvidence(trace: StudioTraceItem[], names: string[], operations: Array<Record<string, unknown>> = []) {
  const latest = trace.filter((item) => matchesCapability(item, names)).at(-1);
  const operationNames = names.map(normalized).filter(Boolean);
  const operation = operations.filter((record) => {
    const values = [record.capability, record.name, record.tool_name, record.toolName, record.provider_tool_call_id, record.providerToolCallId];
    return values.map(normalized).some((value) => operationNames.some((name) => value === name || value.endsWith(`.${name}`) || value.includes(name)));
  }).at(-1);
  const operationId = operation && [operation.id, operation.provider_tool_call_id, operation.providerToolCallId, operation.step_id, operation.stepId].find((value): value is string => typeof value === "string" && value.length > 0);
  const operationStatus = operation && [operation.status, operation.outcome, operation.state].find((value): value is string => typeof value === "string" && value.length > 0);
  const operationKind = operation && [operation.kind, operation.operation_kind, operation.operationKind].find((value): value is string => typeof value === "string" && value.length > 0);
  const attemptId = operation && [operation.attempt_id, operation.attemptId].find((value): value is string => typeof value === "string" && value.length > 0);
  const errorRecord = operation && operation.error && typeof operation.error === "object" && !Array.isArray(operation.error) ? operation.error as Record<string, unknown> : undefined;
  const errorCode = operation && [operation.error_code, operation.errorCode, errorRecord?.code].find((value): value is string => typeof value === "string" && value.length > 0);
  const reconciliationRequired = operation?.reconciliation_required === true || operation?.reconciliationRequired === true;
  const receipt = operation && operation.provider_receipt !== undefined && operation.provider_receipt !== null ? "recorded" as const : "missing" as const;
  if (!latest && !operationId) return undefined;
  return {
    id: latest?.id ?? operationId ?? "operation",
    event: latest?.event ?? "operation.evidence",
    sequence: latest?.sequence ?? 0,
    detail: latest?.detail ?? "Redacted operation evidence available",
    ...(operationId ? { operation: { id: operationId, kind: operationKind ?? "capability", status: operationStatus ?? "recorded", ...(attemptId ? { attemptId } : {}), ...(errorCode ? { errorCode } : {}), ...(reconciliationRequired ? { reconciliationRequired: true } : {}), ...(operation ? { receipt } : {}) } } : {}),
  };
}

function latestMemoryEvidence(graph: AgentMemoryObservatoryGraph | null | undefined, kinds: string[]) {
  const kindSet = new Set(kinds);
  const node = graph?.nodes.filter((candidate) => kindSet.has(candidate.kind)).at(-1);
  if (!node) return undefined;
  return {
    id: node.id,
    kind: node.kind,
    status: node.status,
    sequence: node.sequence ?? 0,
    evidenceCount: node.evidenceIds.length,
    revisionCount: node.revisionIds.length,
    sourceEventCount: node.sourceEventIds.length,
    revisionIds: node.revisionIds.slice(0, 8),
    sourceEventIds: node.sourceEventIds.slice(0, 8),
    evidenceIds: node.evidenceIds.slice(0, 8),
    ...(node.errorCode ? { errorCode: node.errorCode } : {}),
  };
}

function capabilityPosition(index: number) {
  return { x: 48 + (index % 4) * 132, y: 560 + Math.floor(index / 4) * 104 };
}

function labelForCapability(name: string) {
  const last = name.split(/[.:/]/).at(-1) ?? name;
  return last.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
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
  names: string[];
  activity?: StudioNodeActivity;
  evidence?: StudioGraphNode["evidence"];
}) : StudioGraphNode {
  return {
    id: input.id,
    label: input.label,
    detail: input.detail,
    kind: input.kind,
    status: input.status,
    configured: true,
    configurable: true,
    provider: input.provider,
    scope: input.scope,
    event: input.event,
    data: {
      ...(input.evidence?.operation ? {
        latestOperation: `${input.evidence.operation.kind} · ${input.evidence.operation.status} · ${input.evidence.operation.id}`,
      } : {}),
      ...input.data,
      matchKeys: input.names.join(" · "),
    },
    position: capabilityPosition(input.index),
    ...(input.activity ? { activity: input.activity } : {}),
    evidence: input.evidence,
  };
}

export function projectStudioObservatory(input: ProjectionInput): StudioObservatoryProjection {
  const effective = input.effectiveConfig;
  const configUnavailable = input.configurationState === "unavailable";
  const coreNodes = coreDefinitions.map((definition) => {
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
    const matchingTrace = coreEventMatchers[definition.id] ? input.trace.filter(coreEventMatchers[definition.id]) : [];
    const evidence = matchingTrace.at(-1);
    const memory = definition.id === "memory-read"
      ? latestMemoryEvidence(input.memory, ["retrieval_plan", "evidence"])
      : definition.id === "retrieval"
        ? latestMemoryEvidence(input.memory, ["retrieval_plan", "evidence"])
        : definition.id === "memory-write"
          ? latestMemoryEvidence(input.memory, ["capture", "semantic_revision", "episodic_revision", "projection", "deletion"])
          : undefined;
    return {
      ...definition,
      status: configUnavailable ? "unavailable" : statusForCore(definition.id, input.trace),
      label: definition.id === "model" ? effective?.model.model ?? input.modelLabel ?? definition.label : definition.label,
      data,
      ...(activityForTrace(matchingTrace) ? { activity: activityForTrace(matchingTrace) } : {}),
      evidence: evidence || memory ? {
        id: evidence?.id ?? memory?.id ?? "memory",
        event: evidence?.event ?? "memory.observatory",
        sequence: evidence?.sequence ?? memory?.sequence ?? 0,
        detail: evidence?.detail ?? `${memory?.kind ?? "memory"} · ${memory?.status ?? "recorded"}`,
        ...(memory ? { memory } : {}),
      } : undefined,
    } satisfies StudioGraphNode;
  });

  if (!effective || configUnavailable) {
    return { nodes: coreNodes, edges: buildEdges(coreNodes, []) };
  }

  const capabilityByName = new Map((input.capabilities ?? []).map((capability) => [normalized(capability.name), capability]));
  const connectionByName = new Map((input.connections ?? []).flatMap((connection) => [
    [normalized(connection.id), connection] as const,
    [normalized(connection.name), connection] as const,
  ]));
  const capabilityNodes: StudioGraphNode[] = [];
  let index = 0;

  for (const tool of effective.tools) {
    const metadata = capabilityByName.get(normalized(tool));
    const provider = metadata?.catalog?.provider?.name;
    const activity = activityForTrace(input.trace.filter((item) => matchesCapability(item, [tool, metadata?.name ?? ""])));
    capabilityNodes.push(capabilityNode({
      id: `tool:${tool}`,
      label: labelForCapability(tool),
      detail: metadata?.description || "Configured tool capability",
      kind: metadata?.catalog?.kind === "mcp_tool" ? "mcp" : "tool",
      status: overlayCapabilityStatus(capabilityStatus(metadata), input.trace, [tool, metadata?.name ?? ""]),
      provider,
      scope: "installation grant",
      event: "agent.tool.completed",
      data: {
        capability: tool,
        version: metadata?.version ?? "registry",
        readiness: metadata?.availability ?? "declared",
        ...(metadata?.requiresApproval ? { approval: "required" } : {}),
      },
      index: index++,
      names: [tool, metadata?.name ?? ""],
      activity,
      evidence: latestCapabilityEvidence(input.trace, [tool, metadata?.name ?? ""], input.operations),
    }));
  }

  for (const connector of effective.connectors) {
    const metadata = connectionByName.get(normalized(connector));
    const activity = activityForTrace(input.trace.filter((item) => matchesCapability(item, [connector, metadata?.id ?? "", metadata?.name ?? ""])));
    capabilityNodes.push(capabilityNode({
      id: `connector:${connector}`,
      label: metadata?.name ?? labelForCapability(connector),
      detail: metadata?.description || "Configured connection",
      kind: "connector",
      status: overlayCapabilityStatus(connectionStatus(metadata), input.trace, [connector, metadata?.id ?? "", metadata?.name ?? ""]),
      provider: metadata?.provider ?? metadata?.oauthProvider,
      scope: "installation connection",
      event: "agent.connector.completed",
      data: { connection: connector, readiness: metadata?.status ?? "declared", auth: metadata?.auth ?? "managed" },
      index: index++,
      names: [connector, metadata?.id ?? "", metadata?.name ?? ""],
      activity,
      evidence: latestCapabilityEvidence(input.trace, [connector, metadata?.id ?? "", metadata?.name ?? ""], input.operations),
    }));
  }

  for (const skill of effective.skills) {
    const activity = activityForTrace(input.trace.filter((item) => matchesCapability(item, [skill.id, skill.name, skill.slug])));
    capabilityNodes.push(capabilityNode({
      id: `skill:${skill.id}`,
      label: skill.name || skill.slug,
      detail: `Skill v${skill.versionNumber}`,
      kind: "skill",
      status: overlayCapabilityStatus(skill.status === "published" ? "ready" : "blocked", input.trace, [skill.id, skill.name, skill.slug]),
      scope: "agent version",
      event: "agent.skill.completed",
      data: { skill: skill.slug, version: String(skill.versionNumber), checksum: skill.checksum, required: `${skill.requiredCapabilities.length} capabilities` },
      index: index++,
      names: [skill.id, skill.name, skill.slug],
      activity,
      evidence: latestCapabilityEvidence(input.trace, [skill.id, skill.name, skill.slug], input.operations),
    }));
  }

  for (const provider of effective.remoteMcpProviders) {
    const activity = activityForTrace(input.trace.filter((item) => matchesCapability(item, [provider.id, provider.providerName])));
    capabilityNodes.push(capabilityNode({
      id: `mcp:${provider.id}`,
      label: provider.providerName,
      detail: `${provider.toolCount} MCP tools · ${provider.protocolVersion}`,
      kind: "mcp",
      status: overlayCapabilityStatus(provider.status === "published" && provider.healthStatus === "healthy" ? "ready" : "blocked", input.trace, [provider.id, provider.providerName]),
      provider: provider.providerName,
      scope: "agent version",
      event: "agent.mcp.tool.completed",
      data: { provider: provider.providerName, revision: String(provider.revision), tools: String(provider.toolCount), checksum: provider.checksum },
      index: index++,
      names: [provider.id, provider.providerName],
      activity,
      evidence: latestCapabilityEvidence(input.trace, [provider.id, provider.providerName], input.operations),
    }));
  }

  if (input.readiness && input.readiness.ready === false && !capabilityNodes.length) {
    capabilityNodes.push(capabilityNode({
      id: "readiness:blocker",
      label: "Readiness blocker",
      detail: input.readiness.blockers?.[0]?.detail || "Installation is not ready",
      kind: "tool",
      status: "blocked",
      scope: "installation",
      event: "installation.readiness",
      data: { reason: input.readiness.blockers?.[0]?.code || input.readiness.status || "blocked" },
      index: 0,
      names: [],
    }));
  }

  const nodes = [...coreNodes, ...capabilityNodes];
  return { nodes, edges: buildEdges(nodes, capabilityNodes) };
}

function buildEdges(nodes: StudioGraphNode[], capabilityNodes: StudioGraphNode[]): StudioGraphEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: StudioGraphEdge[] = [
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
  for (const node of capabilityNodes) {
    edges.push({ id: `router-${node.id}`, source: "router", target: node.id, sourceAnchor: "bottom", targetAnchor: "top" });
    edges.push({ id: `${node.id}-model`, source: node.id, target: "model", sourceAnchor: "top", targetAnchor: "bottom", dashed: true });
  }
  return edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
}
