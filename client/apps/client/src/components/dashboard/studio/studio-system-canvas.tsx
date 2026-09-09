"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { CSSProperties } from "react";
import {
  applyNodeChanges,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
  type XYPosition,
  ViewportPortal,
} from "@xyflow/react";
import {
  BookOpen,
  Bot,
  CircleDot,
  Database,
  GitBranch,
  KeyRound,
  MessageSquareText,
  Network,
  PlugZap,
  Route,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Workflow,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type StudioGraphStatus = "idle" | "ready" | "running" | "complete" | "error" | "waiting" | "blocked" | "unavailable" | "skipped";

export type StudioGraphNode = {
  id: string;
  label: string;
  detail: string;
  kind: "input" | "channel" | "session" | "context" | "memory" | "retrieval" | "model" | "router" | "tool" | "connector" | "mcp" | "skill" | "approval" | "handoff" | "output" | "delivery";
  status: StudioGraphStatus;
  configured: boolean;
  configurable?: boolean;
  provider?: string;
  scope?: string;
  event?: string;
  data: Record<string, string>;
  position?: XYPosition;
  evidence?: {
    id: string;
    event: string;
    sequence: number;
    detail: string;
    operation?: { id: string; kind: string; status: string };
    memory?: { id: string; kind: string; status: string; sequence: number; evidenceCount: number; revisionCount: number; sourceEventCount: number; revisionIds: string[]; sourceEventIds: string[]; evidenceIds: string[]; errorCode?: string };
  };
};

export type StudioGraphEdge = { id: string; source: string; target: string; sourceAnchor: EdgeAnchor; targetAnchor: EdgeAnchor; dashed?: boolean; routeY?: number; relation?: string };

type StudioCanvasProps = {
  nodes: StudioGraphNode[];
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  running: boolean;
  traceCount: number;
  edges?: StudioGraphEdge[];
  storageKey?: string;
  graphMode?: "topology" | "execution";
};

type CanvasNodeData = StudioGraphNode & Record<string, unknown>;
type CanvasNode = Node<CanvasNodeData>;

const nodePositions: Record<string, { x: number; y: number }> = {
  input: { x: 62, y: 94 },
  channel: { x: 62, y: 202 },
  session: { x: 62, y: 306 },
  context: { x: 380, y: 108 },
  "memory-read": { x: 380, y: 210 },
  retrieval: { x: 560, y: 210 },
  model: { x: 560, y: 108 },
  router: { x: 268, y: 480 },
  calendar: { x: 56, y: 590 },
  mcp: { x: 230, y: 590 },
  "content-skill": { x: 404, y: 590 },
  approval: { x: 670, y: 480 },
  handoff: { x: 670, y: 574 },
  "memory-write": { x: 670, y: 668 },
  output: { x: 838, y: 480 },
  delivery: { x: 838, y: 574 },
};

const movableKinds = new Set<StudioGraphNode["kind"]>(["tool", "connector", "mcp", "skill"]);

function isMovableNode(node: Pick<StudioGraphNode, "kind" | "configurable">) {
  return Boolean(node.configurable && movableKinds.has(node.kind));
}

function nodeSize(kind: StudioGraphNode["kind"]) {
  if (kind === "input") return { width: 112, height: 78 };
  if (kind === "model") return { width: 174, height: 92 };
  if (movableKinds.has(kind)) return { width: 112, height: 84 };
  if (kind === "router") return { width: 136, height: 78 };
  return { width: 112, height: 76 };
}

const sectionFrames = [
  { id: "ingress", title: "INGRESS", detail: "Messages, channels, session", x: 32, y: 40, width: 300, height: 370 },
  { id: "context", title: "CONTEXT & REASONING", detail: "Working state, memory, model", x: 352, y: 40, width: 600, height: 370 },
  { id: "capabilities", title: "CAPABILITIES", detail: "Tools, MCP, and skills", x: 32, y: 440, width: 600, height: 320 },
  { id: "outcome", title: "CONTROL & DELIVERY", detail: "Approval, handoff, response", x: 652, y: 440, width: 340, height: 320 },
];

type EdgeAnchor = "left" | "right" | "top" | "bottom";
type EdgeDefinition = { id: string; source: string; target: string; sourceAnchor: EdgeAnchor; targetAnchor: EdgeAnchor; dashed?: boolean; routeY?: number };

const edgeDefinitions: EdgeDefinition[] = [
  { id: "input-channel", source: "input", target: "channel", sourceAnchor: "bottom", targetAnchor: "top" },
  { id: "channel-session", source: "channel", target: "session", sourceAnchor: "bottom", targetAnchor: "top" },
  { id: "session-context", source: "session", target: "context", sourceAnchor: "right", targetAnchor: "left" },
  { id: "context-model", source: "context", target: "model", sourceAnchor: "right", targetAnchor: "left" },
  { id: "context-memory", source: "context", target: "memory-read", sourceAnchor: "bottom", targetAnchor: "top" },
  { id: "memory-retrieval", source: "memory-read", target: "retrieval", sourceAnchor: "right", targetAnchor: "left" },
  { id: "retrieval-model", source: "retrieval", target: "model", sourceAnchor: "top", targetAnchor: "bottom" },
  { id: "model-router", source: "model", target: "router", sourceAnchor: "right", targetAnchor: "top" },
  { id: "router-calendar", source: "router", target: "calendar", sourceAnchor: "bottom", targetAnchor: "top" },
  { id: "router-mcp", source: "router", target: "mcp", sourceAnchor: "bottom", targetAnchor: "top" },
  { id: "router-content", source: "router", target: "content-skill", sourceAnchor: "bottom", targetAnchor: "top" },
  { id: "calendar-model", source: "calendar", target: "model", sourceAnchor: "top", targetAnchor: "bottom", dashed: true },
  { id: "mcp-model", source: "mcp", target: "model", sourceAnchor: "top", targetAnchor: "bottom", dashed: true },
  { id: "content-approval", source: "content-skill", target: "approval", sourceAnchor: "right", targetAnchor: "left" },
  { id: "router-handoff", source: "router", target: "handoff", sourceAnchor: "right", targetAnchor: "left", dashed: true },
  { id: "approval-output", source: "approval", target: "output", sourceAnchor: "right", targetAnchor: "left" },
  { id: "handoff-output", source: "handoff", target: "output", sourceAnchor: "right", targetAnchor: "left", dashed: true },
  { id: "router-output", source: "router", target: "output", sourceAnchor: "right", targetAnchor: "left", routeY: 445 },
  { id: "output-memory", source: "output", target: "memory-write", sourceAnchor: "bottom", targetAnchor: "top", dashed: true },
  { id: "output-delivery", source: "output", target: "delivery", sourceAnchor: "bottom", targetAnchor: "top" },
  { id: "delivery-session", source: "delivery", target: "session", sourceAnchor: "left", targetAnchor: "right", dashed: true },
];

function graphStatusLabel(status: StudioGraphStatus) {
  if (status === "running") return "Active";
  if (status === "complete") return "Complete";
  if (status === "error") return "Error";
  if (status === "waiting") return "Waiting";
  if (status === "ready") return "Ready";
  if (status === "blocked") return "Blocked";
  if (status === "unavailable") return "Unavailable";
  if (status === "skipped") return "Skipped";
  return "Configured";
}

function nodeIcon(kind: StudioGraphNode["kind"]) {
  const className = "size-4";
  if (kind === "input" || kind === "output") return <MessageSquareText className={className} />;
  if (kind === "channel" || kind === "delivery") return <Send className={className} />;
  if (kind === "session") return <KeyRound className={className} />;
  if (kind === "context") return <Settings2 className={className} />;
  if (kind === "memory") return <Database className={className} />;
  if (kind === "retrieval") return <BookOpen className={className} />;
  if (kind === "model") return <Bot className={className} />;
  if (kind === "router") return <Route className={className} />;
  if (kind === "tool") return <Wrench className={className} />;
  if (kind === "connector") return <PlugZap className={className} />;
  if (kind === "mcp") return <PlugZap className={className} />;
  if (kind === "skill") return <Sparkles className={className} />;
  if (kind === "approval") return <ShieldCheck className={className} />;
  if (kind === "handoff") return <Network className={className} />;
  return <GitBranch className={className} />;
}

function statusClasses(status: StudioGraphStatus) {
  if (status === "running") return { border: "border-primary/80", icon: "bg-primary/15 text-primary", text: "text-primary" };
  if (status === "complete") return { border: "border-emerald-500/55", icon: "bg-emerald-500/12 text-emerald-500", text: "text-emerald-500" };
  if (status === "error") return { border: "border-destructive/70", icon: "bg-destructive/12 text-destructive", text: "text-destructive" };
  if (status === "waiting") return { border: "border-amber-500/65", icon: "bg-amber-500/12 text-amber-500", text: "text-amber-500" };
  if (status === "ready") return { border: "border-emerald-500/55", icon: "bg-emerald-500/10 text-emerald-500", text: "text-emerald-500" };
  if (status === "blocked") return { border: "border-amber-500/70", icon: "bg-amber-500/10 text-amber-500", text: "text-amber-500" };
  if (status === "unavailable") return { border: "border-destructive/55", icon: "bg-destructive/10 text-destructive", text: "text-destructive" };
  return { border: "border-[#52617e]/80", icon: "bg-muted text-muted-foreground", text: "text-muted-foreground" };
}

function displayNodeLabel(node: StudioGraphNode) {
  const labels: Record<string, string> = {
    input: "Input",
    channel: "Channel",
    session: "Session",
    context: "Context",
    "memory-read": "Memory",
    retrieval: "Retrieval",
    model: "Model",
    router: "Router",
    calendar: "Bookings",
    mcp: "MCP",
    "content-skill": "Content",
    approval: "Approval",
    handoff: "Handoff",
    "memory-write": "Persist",
    output: "Response",
    delivery: "Delivery",
  };
  return labels[node.id] ?? labels[node.kind] ?? node.label.split(/\s|:|·/)[0] ?? node.label;
}

function nodeStatusDot(status: StudioGraphStatus) {
  if (status === "running") return "animate-pulse bg-primary";
  if (status === "error") return "bg-destructive";
  if (status === "complete") return "bg-emerald-400";
  if (status === "ready") return "bg-emerald-400";
  if (status === "blocked") return "bg-amber-400";
  if (status === "unavailable") return "bg-destructive";
  return "bg-emerald-500";
}

function ObservatoryNode({ data, selected }: NodeProps<CanvasNode>) {
  const status = statusClasses(data.status);
  const compact = movableKinds.has(data.kind);
  const model = data.kind === "model";
  const trigger = data.kind === "input";
  const decision = data.kind === "router";
  const label = displayNodeLabel(data);
  const labelView = <span className="flex max-w-full items-center justify-center gap-1"><span className="max-w-[116px] truncate text-[9px] font-medium text-foreground">{label}</span><span className={cn("size-1.5 shrink-0 rounded-full", nodeStatusDot(data.status))} title={graphStatusLabel(data.status)} /></span>;

  if (compact || trigger || (!model && !decision)) {
    return <div className={cn("relative flex h-full w-full flex-col items-center gap-1", isMovableNode(data) && "cursor-grab active:cursor-grabbing", selected && "rounded-xl ring-2 ring-primary/35")}>
      <span className={cn("flex size-11 shrink-0 items-center justify-center border shadow-[0_8px_20px_-15px_rgba(0,0,0,.9)]", trigger || ["channel", "session", "context", "approval", "handoff", "output", "delivery"].includes(data.kind) ? "rounded-xl" : "rounded-full", status.icon, status.border, data.status === "running" && "shadow-[0_0_22px_-8px_color-mix(in_srgb,var(--primary)_80%,transparent)]")}>{nodeIcon(data.kind)}</span>
      {labelView}
    </div>;
  }

  if (decision) {
    return <div className={cn("relative h-full w-full", selected && "rounded-xl ring-2 ring-primary/35")}>
      <span className={cn("absolute left-1/2 top-[37%] flex size-10 -translate-x-1/2 -translate-y-1/2 rotate-45 items-center justify-center rounded-lg border bg-[#222c41]/95", status.border, status.icon)}><span className="-rotate-45">{nodeIcon(data.kind)}</span></span>
      <span className="absolute inset-x-0 bottom-0">{labelView}</span>
    </div>;
  }

  return <div className={cn("relative flex h-full w-full flex-col items-center gap-1", selected && "rounded-xl ring-2 ring-primary/35")}>
    <div className="flex h-[72px] w-full shrink-0 items-center justify-center rounded-xl border bg-[#f6f8fc]/95 shadow-[0_8px_24px_-18px_rgba(0,0,0,.9)] transition-all dark:bg-[#222c41]/95"><span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">{nodeIcon(data.kind)}</span></div>
    {labelView}
  </div>;
}

function createCanvasNodes(nodes: StudioGraphNode[], selectedNodeId: string | null, positions: Record<string, XYPosition>): CanvasNode[] {
  return [
      ...nodes.map((node) => { const size = nodeSize(node.kind); return { id: node.id, type: "observatory" as const, position: positions[node.id] ?? node.position ?? nodePositions[node.id] ?? { x: 0, y: 0 }, data: node, selected: node.id === selectedNodeId, width: size.width, height: size.height, style: { zIndex: 10 }, draggable: isMovableNode(node) }; }),
  ];
}

function ObservatorySectionFrames() {
  return <ViewportPortal>
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-0 overflow-visible" width="1000" height="760" viewBox="0 0 1000 760">
      {sectionFrames.map((section) => <g key={section.id}>
        <rect x={section.x} y={section.y} width={section.width} height={section.height} rx="16" fill="rgba(28, 39, 59, .42)" stroke="rgba(122, 143, 180, .34)" strokeWidth="1.5" />
        <rect x={section.x + 1} y={section.y + 1} width={section.width - 2} height="34" rx="15" fill="rgba(46, 61, 88, .34)" />
        <text x={section.x + 16} y={section.y + 16} fill="#b9c6df" fontSize="8.5" fontWeight="700" letterSpacing="1.1">{section.title}</text>
        <text x={section.x + 16} y={section.y + 28} fill="#8492ab" fontSize="7.5">{section.detail}</text>
      </g>)}
    </svg>
  </ViewportPortal>;
}

function anchorPoint(position: XYPosition, kind: StudioGraphNode["kind"], anchor: EdgeAnchor) {
  const size = nodeSize(kind);
  const surface = kind !== "model" && kind !== "router"
    ? { width: 44, height: 44, offsetX: (size.width - 44) / 2, offsetY: 0 }
    : kind === "router"
      ? { width: 48, height: 48, offsetX: (size.width - 48) / 2, offsetY: 4 }
      : { width: size.width, height: kind === "model" ? 72 : 58, offsetX: 0, offsetY: 0 };
  const left = position.x + surface.offsetX;
  const top = position.y + surface.offsetY;
  if (anchor === "left") return { x: left, y: top + surface.height / 2 };
  if (anchor === "right") return { x: left + surface.width, y: top + surface.height / 2 };
  if (anchor === "top") return { x: left + surface.width / 2, y: top };
  return { x: left + surface.width / 2, y: top + surface.height };
}

function orthogonalPath(start: { x: number; y: number }, end: { x: number; y: number }, sourceAnchor: EdgeAnchor, targetAnchor: EdgeAnchor, routeY?: number) {
  if (routeY !== undefined) return `M ${start.x} ${start.y} L ${start.x} ${routeY} L ${end.x} ${routeY} L ${end.x} ${end.y}`;
  if ((sourceAnchor === "left" || sourceAnchor === "right") && (targetAnchor === "left" || targetAnchor === "right")) {
    const midX = start.x + (end.x - start.x) / 2;
    return `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`;
  }
  if ((sourceAnchor === "top" || sourceAnchor === "bottom") && (targetAnchor === "top" || targetAnchor === "bottom")) {
    const midY = start.y + (end.y - start.y) / 2;
    return `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`;
  }
  const midY = start.y + (end.y - start.y) / 2;
  return `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`;
}

function ObservatoryLinks({ nodes, positions, edges }: { nodes: StudioGraphNode[]; positions: Record<string, XYPosition>; edges: StudioGraphEdge[] }) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return <ViewportPortal>
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-[1] overflow-visible" width="1000" height="760" viewBox="0 0 1000 760">
      <defs>
        <marker id="observatory-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L9,4.5 L0,9 z" fill="#8490a8" />
        </marker>
      </defs>
      {edges.map((definition) => {
        const sourcePosition = positions[definition.source] ?? nodePositions[definition.source];
        const targetPosition = positions[definition.target] ?? nodePositions[definition.target];
        if (!sourcePosition || !targetPosition || !nodeById.has(definition.source) || !nodeById.has(definition.target)) return null;
        const source = nodeById.get(definition.source);
        const target = nodeById.get(definition.target);
        if (!source || !target) return null;
        const live = source.status === "running" || target.status === "running";
        const failed = source.status === "error" || target.status === "error";
        const completed = source.status === "complete" && target.status === "complete";
        const start = anchorPoint(sourcePosition, source.kind, definition.sourceAnchor);
        const end = anchorPoint(targetPosition, target.kind, definition.targetAnchor);
        const color = failed ? "#f87171" : live ? "#a78bfa" : completed ? "#34d399" : "#8b98b2";
        return <path key={definition.id} d={orthogonalPath(start, end, definition.sourceAnchor, definition.targetAnchor, definition.routeY)} fill="none" stroke={color} strokeWidth={live ? 2.4 : 1.35} strokeOpacity={live ? 0.95 : 0.62} strokeDasharray={definition.dashed ? "6 6" : undefined} markerEnd="url(#observatory-arrow)" />;
      })}
    </svg>
  </ViewportPortal>;
}

const observatoryNodeTypes = { observatory: ObservatoryNode };

export function StudioSystemCanvas({ nodes, selectedNodeId, onSelect, running, traceCount, edges = edgeDefinitions, storageKey, graphMode = "topology" }: StudioCanvasProps) {
  const layoutStorageKey = storageKey ? `${storageKey}:compact-v1` : undefined;
  const [positions, setPositions] = useState<Record<string, XYPosition>>(() => Object.fromEntries(nodes.map((node) => [node.id, node.position ?? nodePositions[node.id] ?? { x: 0, y: 0 }])));
  const [positionsLoaded, setPositionsLoaded] = useState(!layoutStorageKey);
  const [isMounted, setIsMounted] = useState(false);
  const movableNodeIds = useMemo(() => new Set(nodes.filter(isMovableNode).map((node) => node.id)), [nodes]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!layoutStorageKey) return;
    try {
      const stored = window.localStorage.getItem(layoutStorageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, XYPosition>;
        setPositions((current) => ({ ...current, ...Object.fromEntries(Object.entries(parsed).filter(([id, value]) => movableNodeIds.has(id) && value && typeof value.x === "number" && typeof value.y === "number")) }));
      }
    } catch {
      // A stale layout should never prevent the observatory from opening.
    } finally {
      setPositionsLoaded(true);
    }
  }, [layoutStorageKey, movableNodeIds]);

  useEffect(() => {
    setPositions((current) => {
      const next = { ...current };
      for (const node of nodes) {
        if (!next[node.id]) next[node.id] = node.position ?? nodePositions[node.id] ?? { x: 0, y: 0 };
      }
      return next;
    });
  }, [nodes]);

  useEffect(() => {
    if (!layoutStorageKey || !positionsLoaded) return;
    try {
      window.localStorage.setItem(layoutStorageKey, JSON.stringify(positions));
    } catch {
      // Layout persistence is best effort.
    }
  }, [layoutStorageKey, positions, positionsLoaded]);

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setPositions((current) => {
      const currentNodes = createCanvasNodes(nodes, selectedNodeId, current);
      const changedNodes = applyNodeChanges(changes, currentNodes);
      const next = { ...current };
      for (const changedNode of changedNodes) {
        if (changedNode.type !== "group" && movableNodeIds.has(changedNode.id)) next[changedNode.id] = changedNode.position;
      }
      return next;
    });
  }, [movableNodeIds, nodes, selectedNodeId]);

  const resetLayout = useCallback(() => {
    setPositions(Object.fromEntries(nodes.map((node) => [node.id, node.position ?? nodePositions[node.id] ?? { x: 0, y: 0 }])));
  }, [nodes]);

  const canvasNodes = createCanvasNodes(nodes, selectedNodeId, positions);
  const nodeColor = (node: Node) => {
    const data = node.data as Partial<StudioGraphNode>;
    if (data.status === "running") return "var(--primary)";
    if (data.status === "error") return "var(--destructive)";
    if (data.status === "complete") return "var(--status-success)";
    return "var(--muted-foreground)";
  };
  if (!isMounted) {
    return <div className="h-full min-h-[560px] w-full bg-[#141a29]" aria-busy="true" />;
  }
  return <div className="relative h-full min-h-[560px] w-full overflow-hidden bg-[#141a29] [&_.react-flow__attribution]:bg-transparent [&_.react-flow__attribution]:text-muted-foreground/50 [&_.react-flow__controls]:overflow-hidden [&_.react-flow__controls]:rounded-lg [&_.react-flow__controls]:border-border/70 [&_.react-flow__controls-button]:border-border/70 [&_.react-flow__controls-button]:bg-card/90 [&_.react-flow__controls-button]:fill-muted-foreground [&_.react-flow__minimap]:overflow-hidden [&_.react-flow__minimap]:rounded-lg [&_.react-flow__minimap]:border [&_.react-flow__minimap]:border-border/70 [&_.react-flow__minimap]:bg-card/90">
    <ReactFlow nodes={canvasNodes} edges={[]} nodeTypes={observatoryNodeTypes} onNodesChange={handleNodesChange} onNodeClick={(_, node) => onSelect(node.id)} fitView fitViewOptions={{ padding: 0.08, minZoom: 0.62, maxZoom: 0.92 }} minZoom={0.45} maxZoom={1.6} nodesDraggable nodesConnectable={false} elementsSelectable panOnScroll zoomOnScroll zoomOnPinch selectionOnDrag={false}>
      <ObservatorySectionFrames />
      <ObservatoryLinks nodes={nodes} positions={positions} edges={edges} />
      <Controls
        showInteractive={false}
        position="bottom-left"
        style={{
          "--xy-controls-button-background-color": "#1b2538",
          "--xy-controls-button-background-color-hover": "#2b3954",
          "--xy-controls-button-color": "#b8c5dd",
          "--xy-controls-button-color-hover": "#eef3ff",
          "--xy-controls-button-border-color": "#3d4b67",
          "--xy-controls-box-shadow": "0 8px 20px rgba(3, 8, 20, 0.35)",
        } as CSSProperties}
      />
      <MiniMap
        nodeColor={nodeColor}
        nodeStrokeColor="#8ea0c2"
        nodeStrokeWidth={2}
        bgColor="#1b2538"
        maskColor="rgba(9, 11, 17, 0.68)"
        maskStrokeColor="#60708d"
        pannable
        zoomable
        position="bottom-right"
      />
      <Panel position="top-left" className="!m-4 flex items-center gap-3 rounded-lg border border-border/70 bg-card/90 px-3 py-2 text-[10px] text-muted-foreground shadow-lg backdrop-blur">
        <span className="inline-flex items-center gap-1.5 font-semibold text-foreground"><Workflow className="size-3.5 text-primary" />{graphMode === "execution" ? "Generated execution" : "System topology"}</span>
        <span>{nodes.length} nodes</span>
        <span className="text-border">•</span>
        <span>{traceCount ? `${traceCount} events` : "Ready"}</span>
        {running ? <span className="inline-flex items-center gap-1 text-primary"><CircleDot className="size-3 animate-pulse" />Live</span> : null}
        <button type="button" onClick={resetLayout} className="ml-1 inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[9px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" title="Reset tool positions"><RotateCcw className="size-3" />Reset tools</button>
      </Panel>
      <Panel position="top-right" className="!m-4 flex items-center gap-3 rounded-lg border border-border/70 bg-card/90 px-3 py-2 text-[9px] text-muted-foreground shadow-lg backdrop-blur">
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-slate-400" />Configured</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />Ready</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-amber-500" />Blocked</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-primary" />Active</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />Complete</span>
      </Panel>
    </ReactFlow>
  </div>;
}
