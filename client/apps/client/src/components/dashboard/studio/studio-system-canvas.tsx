"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  applyNodeChanges,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
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
  input: { x: 80, y: 160 },
  channel: { x: 305, y: 160 },
  session: { x: 192, y: 285 },
  context: { x: 640, y: 105 },
  "memory-read": { x: 640, y: 255 },
  retrieval: { x: 865, y: 255 },
  model: { x: 865, y: 105 },
  router: { x: 80, y: 585 },
  calendar: { x: 305, y: 475 },
  mcp: { x: 305, y: 615 },
  "content-skill": { x: 305, y: 755 },
  approval: { x: 640, y: 475 },
  handoff: { x: 640, y: 615 },
  "memory-write": { x: 640, y: 755 },
  output: { x: 865, y: 545 },
  delivery: { x: 865, y: 685 },
};

const movableKinds = new Set<StudioGraphNode["kind"]>(["tool", "mcp", "skill"]);

function isMovableNode(node: Pick<StudioGraphNode, "kind" | "configurable">) {
  return Boolean(node.configurable && movableKinds.has(node.kind));
}

const sectionFrames = [
  { id: "ingress", title: "INGRESS & SESSION", detail: "How work enters and becomes durable", x: 40, y: 45, width: 510, height: 365 },
  { id: "context", title: "CONTEXT & REASONING", detail: "What the agent knows before acting", x: 600, y: 45, width: 510, height: 365 },
  { id: "capabilities", title: "CAPABILITIES", detail: "Tools, MCP, and skills available to the agent", x: 40, y: 445, width: 510, height: 410 },
  { id: "outcome", title: "CONTROL & DELIVERY", detail: "Approvals, handoff, memory, and response", x: 600, y: 445, width: 510, height: 410 },
];

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
  return { border: "border-[#52617e]/80", icon: "bg-muted text-muted-foreground", text: "text-muted-foreground" };
}

function ObservatoryNode({ data, selected }: NodeProps<CanvasNode>) {
  const status = statusClasses(data.status);
  return <div className={cn("relative h-full w-full rounded-xl border bg-[#f6f8fc]/95 px-3.5 py-3 shadow-[0_10px_30px_-20px_rgba(0,0,0,.8)] transition-all dark:bg-[#222c41]/95", isMovableNode(data) && "cursor-grab active:cursor-grabbing", status.border, selected && "ring-2 ring-primary/35", data.status === "running" && "shadow-[0_0_26px_-8px_color-mix(in_srgb,var(--primary)_80%,transparent)]")}>
    <Handle id="target" type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <Handle id="source" type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-muted-foreground/70" />
    <div className="flex items-start gap-2.5"><span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", status.icon)}>{nodeIcon(data.kind)}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><p className="truncate text-xs font-semibold text-foreground">{data.label}</p><span className="size-1.5 shrink-0 rounded-full bg-emerald-500" title="Configured" /></div><p className="mt-1 truncate text-[10px] leading-4 text-muted-foreground">{data.detail}</p><p className={cn("mt-2 inline-flex items-center gap-1 text-[9px] font-medium", status.text)}>{data.status === "running" ? <CircleDot className="size-2.5 animate-pulse" /> : data.status === "complete" ? <Check className="size-2.5" /> : data.status === "error" ? <X className="size-2.5" /> : <span className="size-1.5 rounded-full bg-current" />}{graphStatusLabel(data.status)}</p></div></div>
  </div>;
}

function createCanvasNodes(nodes: StudioGraphNode[], selectedNodeId: string | null, positions: Record<string, XYPosition>): CanvasNode[] {
  return [
    ...nodes.map((node) => ({ id: node.id, type: "observatory" as const, position: isMovableNode(node) ? positions[node.id] ?? nodePositions[node.id] ?? { x: 0, y: 0 } : nodePositions[node.id] ?? { x: 0, y: 0 }, data: node, selected: node.id === selectedNodeId, width: NODE_WIDTH, height: NODE_HEIGHT, style: { zIndex: 10 }, draggable: isMovableNode(node) })),
  ];
}

function ObservatorySectionFrames() {
  return <ViewportPortal>
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-0 overflow-visible" width="1200" height="900" viewBox="0 0 1200 900">
      {sectionFrames.map((section) => <g key={section.id}>
        <rect x={section.x} y={section.y} width={section.width} height={section.height} rx="22" fill="rgba(28, 39, 59, .42)" stroke="rgba(122, 143, 180, .34)" strokeWidth="1.5" />
        <rect x={section.x + 1} y={section.y + 1} width={section.width - 2} height="54" rx="21" fill="rgba(46, 61, 88, .34)" />
        <text x={section.x + 22} y={section.y + 25} fill="#b9c6df" fontSize="11" fontWeight="700" letterSpacing="1.6">{section.title}</text>
        <text x={section.x + 22} y={section.y + 43} fill="#8492ab" fontSize="10">{section.detail}</text>
      </g>)}
    </svg>
  </ViewportPortal>;
}

function ObservatoryLinks({ nodes, positions }: { nodes: StudioGraphNode[]; positions: Record<string, XYPosition> }) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return <ViewportPortal>
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-[1] overflow-visible" width="2600" height="700" viewBox="0 0 2600 700">
      <defs>
        <marker id="observatory-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L9,4.5 L0,9 z" fill="#8490a8" />
        </marker>
      </defs>
      {edgeDefinitions.map((definition) => {
        const sourcePosition = positions[definition.source] ?? nodePositions[definition.source];
        const targetPosition = positions[definition.target] ?? nodePositions[definition.target];
        if (!sourcePosition || !targetPosition || !nodeById.has(definition.source) || !nodeById.has(definition.target)) return null;
        const source = nodeById.get(definition.source);
        const target = nodeById.get(definition.target);
        const live = source?.status === "running" || target?.status === "running";
        const failed = source?.status === "error" || target?.status === "error";
        const completed = source?.status === "complete" && target?.status === "complete";
        const startX = sourcePosition.x + NODE_WIDTH;
        const startY = sourcePosition.y + NODE_HEIGHT / 2;
        const endX = targetPosition.x;
        const endY = targetPosition.y + NODE_HEIGHT / 2;
        const bend = Math.max(38, Math.abs(endX - startX) * 0.42);
        const color = failed ? "#f87171" : live ? "#a78bfa" : completed ? "#34d399" : "#8b98b2";
        return <path key={definition.id} d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`} fill="none" stroke={color} strokeWidth={live ? 3 : 1.8} strokeOpacity={live ? 0.95 : 0.78} strokeDasharray={definition.dashed ? "8 6" : undefined} markerEnd="url(#observatory-arrow)" />;
      })}
    </svg>
  </ViewportPortal>;
}

const observatoryNodeTypes = { observatory: ObservatoryNode };

export function StudioSystemCanvas({ nodes, selectedNodeId, onSelect, running, traceCount, storageKey }: StudioCanvasProps) {
  const [positions, setPositions] = useState<Record<string, XYPosition>>(() => Object.fromEntries(nodes.map((node) => [node.id, nodePositions[node.id] ?? { x: 0, y: 0 }])));
  const [positionsLoaded, setPositionsLoaded] = useState(!storageKey);
  const [isMounted, setIsMounted] = useState(false);
  const movableNodeIds = useMemo(() => new Set(nodes.filter(isMovableNode).map((node) => node.id)), [nodes]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, XYPosition>;
        setPositions((current) => ({ ...current, ...Object.fromEntries(Object.entries(parsed).filter(([id, value]) => movableNodeIds.has(id) && value && typeof value.x === "number" && typeof value.y === "number")) }));
      }
    } catch {
      // A stale layout should never prevent the observatory from opening.
    } finally {
      setPositionsLoaded(true);
    }
  }, [movableNodeIds, storageKey]);

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
        if (changedNode.type !== "group" && movableNodeIds.has(changedNode.id)) next[changedNode.id] = changedNode.position;
      }
      return next;
    });
  }, [movableNodeIds, nodes, selectedNodeId]);

  const resetLayout = useCallback(() => {
    setPositions(Object.fromEntries(nodes.map((node) => [node.id, nodePositions[node.id] ?? { x: 0, y: 0 }])));
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
  return <div className="relative h-full min-h-[560px] w-full overflow-hidden bg-[#141a29] [&_.react-flow__attribution]:bg-transparent [&_.react-flow__attribution]:text-muted-foreground/50 [&_.react-flow__controls]:overflow-hidden [&_.react-flow__controls]:rounded-lg [&_.react-flow__controls]:border-border/70 [&_.react-flow__controls_button]:border-border/70 [&_.react-flow__controls_button]:bg-card/90 [&_.react-flow__controls_button]:fill-muted-foreground [&_.react-flow__minimap]:overflow-hidden [&_.react-flow__minimap]:rounded-lg [&_.react-flow__minimap]:border [&_.react-flow__minimap]:border-border/70 [&_.react-flow__minimap]:bg-card/90">
    <ReactFlow nodes={canvasNodes} edges={[]} nodeTypes={observatoryNodeTypes} onNodesChange={handleNodesChange} onNodeClick={(_, node) => onSelect(node.id)} fitView fitViewOptions={{ padding: 0.14, minZoom: 0.18, maxZoom: 0.8 }} minZoom={0.18} maxZoom={1.6} nodesDraggable nodesConnectable={false} elementsSelectable panOnScroll zoomOnScroll zoomOnPinch selectionOnDrag={false}>
      <ObservatorySectionFrames />
      <ObservatoryLinks nodes={nodes} positions={positions} />
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(148,163,184,.18)" />
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
        <span className="inline-flex items-center gap-1.5 font-semibold text-foreground"><Workflow className="size-3.5 text-primary" />System topology</span>
        <span>{nodes.length} nodes</span>
        <span className="text-border">•</span>
        <span>{traceCount ? `${traceCount} events` : "Ready"}</span>
        {running ? <span className="inline-flex items-center gap-1 text-primary"><CircleDot className="size-3 animate-pulse" />Live</span> : null}
        <button type="button" onClick={resetLayout} className="ml-1 inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[9px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" title="Reset tool positions"><RotateCcw className="size-3" />Reset tools</button>
      </Panel>
      <Panel position="top-right" className="!m-4 flex items-center gap-3 rounded-lg border border-border/70 bg-card/90 px-3 py-2 text-[9px] text-muted-foreground shadow-lg backdrop-blur">
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-slate-400" />Configured</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-primary" />Active</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />Complete</span>
      </Panel>
    </ReactFlow>
  </div>;
}
