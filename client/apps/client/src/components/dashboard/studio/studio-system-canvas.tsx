"use client";

import {
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  Background,
  BackgroundVariant,
  applyNodeChanges,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type XYPosition,
} from "@xyflow/react";
import {
  BookOpen,
  Bot,
  Check,
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
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type StudioGraphStatus = "idle" | "running" | "complete" | "error" | "waiting" | "skipped";

export type StudioGraphNode = {
  id: string;
  label: string;
  detail: string;
  kind: "input" | "channel" | "session" | "context" | "memory" | "retrieval" | "model" | "router" | "tool" | "mcp" | "skill" | "approval" | "handoff" | "output" | "delivery";
  status: StudioGraphStatus;
  configured: boolean;
  configurable?: boolean;
  provider?: string;
  scope?: string;
  event?: string;
  data: Record<string, string>;
};

type StudioCanvasProps = {
  nodes: StudioGraphNode[];
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  running: boolean;
  traceCount: number;
  storageKey?: string;
};

type CanvasNodeData = StudioGraphNode & Record<string, unknown>;
type CanvasNode = Node<CanvasNodeData>;

const NODE_WIDTH = 210;
const NODE_HEIGHT = 104;

const nodePositions: Record<string, { x: number; y: number }> = {
  input: { x: 30, y: 285 },
  channel: { x: 285, y: 285 },
  session: { x: 540, y: 285 },
  context: { x: 795, y: 205 },
  "memory-read": { x: 795, y: 410 },
  retrieval: { x: 1050, y: 410 },
  model: { x: 1050, y: 205 },
  router: { x: 1305, y: 285 },
  calendar: { x: 1500, y: 90 },
  mcp: { x: 1500, y: 285 },
  "content-skill": { x: 1500, y: 480 },
  approval: { x: 1760, y: 90 },
  handoff: { x: 1760, y: 285 },
  "memory-write": { x: 2020, y: 480 },
  output: { x: 2020, y: 205 },
  delivery: { x: 2275, y: 205 },
};

const edgeDefinitions: Array<{ id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string; label?: string; dashed?: boolean }> = [
  { id: "input-channel", source: "input", target: "channel", label: "accepted" },
  { id: "channel-session", source: "channel", target: "session", label: "admitted" },
  { id: "session-context", source: "session", target: "context", label: "turn" },
  { id: "context-model", source: "context", target: "model", label: "working set" },
  { id: "context-memory", source: "context", target: "memory-read", sourceHandle: "bottom-source", targetHandle: "top-target", label: "retrieve" },
  { id: "memory-retrieval", source: "memory-read", target: "retrieval", label: "evidence" },
  { id: "retrieval-model", source: "retrieval", target: "model", sourceHandle: "top-source", targetHandle: "bottom-target", label: "ground" },
  { id: "model-router", source: "model", target: "router", label: "next action" },
  { id: "router-calendar", source: "router", target: "calendar", sourceHandle: "top-source", targetHandle: "left-target", label: "tool" },
  { id: "router-mcp", source: "router", target: "mcp", label: "tool" },
  { id: "router-content", source: "router", target: "content-skill", sourceHandle: "bottom-source", targetHandle: "left-target", label: "skill" },
  { id: "calendar-model", source: "calendar", target: "model", sourceHandle: "left-source", targetHandle: "top-target", label: "result", dashed: true },
  { id: "mcp-model", source: "mcp", target: "model", sourceHandle: "left-source", targetHandle: "right-target", label: "result", dashed: true },
  { id: "content-approval", source: "content-skill", target: "approval", sourceHandle: "right-source", targetHandle: "left-target", label: "sensitive action" },
  { id: "router-handoff", source: "router", target: "handoff", sourceHandle: "bottom-source", targetHandle: "left-target", label: "escalate", dashed: true },
  { id: "approval-output", source: "approval", target: "output", label: "approved" },
  { id: "handoff-output", source: "handoff", target: "output", label: "resolved", dashed: true },
  { id: "router-output", source: "router", target: "output", label: "answer" },
  { id: "output-memory", source: "output", target: "memory-write", sourceHandle: "bottom-source", targetHandle: "top-target", label: "persist", dashed: true },
  { id: "output-delivery", source: "output", target: "delivery", label: "send" },
  { id: "delivery-session", source: "delivery", target: "session", sourceHandle: "top-source", targetHandle: "top-target", label: "follow-up", dashed: true },
];

function graphStatusLabel(status: StudioGraphStatus) {
  if (status === "running") return "Active";
  if (status === "complete") return "Complete";
  if (status === "error") return "Error";
  if (status === "waiting") return "Waiting";
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
  return { border: "border-border/90", icon: "bg-muted text-muted-foreground", text: "text-muted-foreground" };
}

function ObservatoryNode({ data, selected }: NodeProps<CanvasNode>) {
  const status = statusClasses(data.status);
  return <div className={cn("relative h-full w-full rounded-xl border bg-card/95 px-3.5 py-3 shadow-[0_10px_30px_-20px_rgba(0,0,0,.8)] transition-all", status.border, selected && "ring-2 ring-primary/35", data.status === "running" && "shadow-[0_0_26px_-8px_color-mix(in_srgb,var(--primary)_80%,transparent)]")}>
    <Handle id="left-target" type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="left-source" type="source" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="right-target" type="target" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="right-source" type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="top-target" type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="top-source" type="source" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="bottom-target" type="target" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="bottom-source" type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <div className="flex items-start gap-2.5"><span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", status.icon)}>{nodeIcon(data.kind)}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><p className="truncate text-xs font-semibold text-foreground">{data.label}</p><span className="size-1.5 shrink-0 rounded-full bg-emerald-500" title="Configured" /></div><p className="mt-1 truncate text-[10px] leading-4 text-muted-foreground">{data.detail}</p><p className={cn("mt-2 inline-flex items-center gap-1 text-[9px] font-medium", status.text)}>{data.status === "running" ? <CircleDot className="size-2.5 animate-pulse" /> : data.status === "complete" ? <Check className="size-2.5" /> : data.status === "error" ? <X className="size-2.5" /> : <span className="size-1.5 rounded-full bg-current" />}{graphStatusLabel(data.status)}</p></div></div>
  </div>;
}

function createCanvasNodes(nodes: StudioGraphNode[], selectedNodeId: string | null, positions: Record<string, XYPosition>): CanvasNode[] {
  return [
    ...nodes.map((node) => ({ id: node.id, type: "observatory" as const, position: positions[node.id] ?? nodePositions[node.id] ?? { x: 0, y: 0 }, data: node, selected: node.id === selectedNodeId, style: { width: NODE_WIDTH, height: NODE_HEIGHT, zIndex: 10 }, draggable: true })),
  ];
}

function createCanvasEdges(nodes: StudioGraphNode[]): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return edgeDefinitions.map((definition) => {
    const source = byId.get(definition.source);
    const target = byId.get(definition.target);
    const live = source?.status === "running" || target?.status === "running";
    const completed = source?.status === "complete" && target?.status === "complete";
    const failed = source?.status === "error" || target?.status === "error";
    return {
      ...definition,
      type: "smoothstep",
      animated: live,
      className: cn(definition.dashed && "observatory-edge-dashed", live && "observatory-edge-live", failed && "observatory-edge-error"),
      style: { stroke: failed ? "var(--destructive)" : live ? "var(--primary)" : completed ? "var(--status-success)" : "color-mix(in srgb, var(--muted-foreground) 52%, transparent)", strokeWidth: live ? 2.4 : 1.35 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: failed ? "var(--destructive)" : live ? "var(--primary)" : "color-mix(in srgb, var(--muted-foreground) 68%, transparent)" },
      label: definition.label,
      labelStyle: { fill: "var(--muted-foreground)", fontSize: 9, fontWeight: 500 },
      labelBgStyle: { fill: "var(--card)", fillOpacity: 0.92 },
      sourceHandle: definition.sourceHandle,
      targetHandle: definition.targetHandle,
    } satisfies Edge;
  });
}

const observatoryNodeTypes = { observatory: ObservatoryNode };

export function StudioSystemCanvas({ nodes, selectedNodeId, onSelect, running, traceCount, storageKey }: StudioCanvasProps) {
  const [positions, setPositions] = useState<Record<string, XYPosition>>(() => Object.fromEntries(nodes.map((node) => [node.id, nodePositions[node.id] ?? { x: 0, y: 0 }])));
  const [positionsLoaded, setPositionsLoaded] = useState(!storageKey);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, XYPosition>;
        setPositions((current) => ({ ...current, ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && typeof value.x === "number" && typeof value.y === "number")) }));
      }
    } catch {
      // A stale layout should never prevent the observatory from opening.
    } finally {
      setPositionsLoaded(true);
    }
  }, [storageKey]);

  useEffect(() => {
    setPositions((current) => {
      const next = { ...current };
      for (const node of nodes) {
        if (!next[node.id]) next[node.id] = nodePositions[node.id] ?? { x: 0, y: 0 };
      }
      return next;
    });
  }, [nodes]);

  useEffect(() => {
    if (!storageKey || !positionsLoaded) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(positions));
    } catch {
      // Layout persistence is best effort.
    }
  }, [positions, positionsLoaded, storageKey]);

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setPositions((current) => {
      const currentNodes = createCanvasNodes(nodes, selectedNodeId, current);
      const changedNodes = applyNodeChanges(changes, currentNodes);
      const next = { ...current };
      for (const changedNode of changedNodes) {
        if (changedNode.type !== "group") next[changedNode.id] = changedNode.position;
      }
      return next;
    });
  }, [nodes, selectedNodeId]);

  const resetLayout = useCallback(() => {
    setPositions(Object.fromEntries(nodes.map((node) => [node.id, nodePositions[node.id] ?? { x: 0, y: 0 }])));
  }, [nodes]);

  const canvasNodes = createCanvasNodes(nodes, selectedNodeId, positions);
  const canvasEdges = createCanvasEdges(nodes);
  const nodeColor = (node: Node) => {
    const data = node.data as Partial<StudioGraphNode>;
    if (data.status === "running") return "var(--primary)";
    if (data.status === "error") return "var(--destructive)";
    if (data.status === "complete") return "var(--status-success)";
    return "var(--muted-foreground)";
  };
  return <div className="relative h-full min-h-[560px] w-full overflow-hidden bg-[#0b0d15] [&_.react-flow__attribution]:bg-transparent [&_.react-flow__attribution]:text-muted-foreground/50 [&_.react-flow__controls]:overflow-hidden [&_.react-flow__controls]:rounded-lg [&_.react-flow__controls]:border-border/70 [&_.react-flow__controls_button]:border-border/70 [&_.react-flow__controls_button]:bg-card/90 [&_.react-flow__controls_button]:fill-muted-foreground [&_.react-flow__minimap]:overflow-hidden [&_.react-flow__minimap]:rounded-lg [&_.react-flow__minimap]:border [&_.react-flow__minimap]:border-border/70 [&_.react-flow__minimap]:bg-card/90">
    <ReactFlow nodes={canvasNodes} edges={canvasEdges} nodeTypes={observatoryNodeTypes} onNodesChange={handleNodesChange} onNodeClick={(_, node) => onSelect(node.id)} fitView fitViewOptions={{ padding: 0.16, minZoom: 0.48, maxZoom: 1.1 }} minZoom={0.32} maxZoom={1.6} nodesDraggable nodesConnectable={false} elementsSelectable panOnScroll zoomOnScroll zoomOnPinch selectionOnDrag={false}>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(148,163,184,.18)" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap nodeColor={nodeColor} nodeStrokeWidth={2} pannable zoomable position="bottom-right" />
      <Panel position="top-left" className="!m-4 flex items-center gap-3 rounded-lg border border-border/70 bg-card/90 px-3 py-2 text-[10px] text-muted-foreground shadow-lg backdrop-blur">
        <span className="inline-flex items-center gap-1.5 font-semibold text-foreground"><Workflow className="size-3.5 text-primary" />System topology</span>
        <span>{nodes.length} nodes</span>
        <span className="text-border">•</span>
        <span>{traceCount ? `${traceCount} events` : "Ready"}</span>
        {running ? <span className="inline-flex items-center gap-1 text-primary"><CircleDot className="size-3 animate-pulse" />Live</span> : null}
        <button type="button" onClick={resetLayout} className="ml-1 inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[9px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" title="Reset node positions"><RotateCcw className="size-3" />Reset layout</button>
      </Panel>
      <Panel position="top-right" className="!m-4 flex items-center gap-3 rounded-lg border border-border/70 bg-card/90 px-3 py-2 text-[9px] text-muted-foreground shadow-lg backdrop-blur">
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-slate-400" />Configured</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-primary" />Active</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />Complete</span>
      </Panel>
    </ReactFlow>
  </div>;
}
