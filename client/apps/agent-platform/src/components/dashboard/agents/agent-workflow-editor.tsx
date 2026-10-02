"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import Link from "@/lib/link";
import {
  MessageCircle,
  Bot,
  Boxes,
  Check,
  Clock3,
  Link2,
  Merge,
  MousePointer2,
  Plus,
  Route,
  ShieldCheck,
  Sparkles,
  Split,
  Trash2,
  Upload,
  UserRound,
  Workflow,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { MotionReveal } from "@/components/ui/motion-reveal";

export type WorkflowNodeType = "deterministic" | "model" | "agent_loop" | "tool" | "route" | "fan_out" | "fan_in" | "approval" | "wait" | "handoff";

export type WorkflowGraphValue = {
  version: 1;
  entryNodeId: string;
  nodes: Array<{ id: string; type: WorkflowNodeType; config: Record<string, unknown>; reads: string[]; writes: string[]; maxIterations?: number; parallelGroup?: string }>;
  edges: Array<{ from: string; to: string; condition?: string; maxIterations?: number }>;
  stateSchema: Record<string, unknown>;
};

type NodeDraft = { id: string; type: WorkflowNodeType; configText: string; readsText: string; writesText: string; maxIterationsText: string; parallelGroup: string };
type EdgeDraft = { from: string; to: string; condition: string; maxIterationsText: string };
type EditorDraft = { entryNodeId: string; nodes: NodeDraft[]; edges: EdgeDraft[] };
type Position = { x: number; y: number };
type NodeMeta = { label: string; description: string; icon: typeof Bot; kind: string };
type CanvasEvent = { clientX: number; clientY: number };

const CANVAS_WIDTH = 1120;
const CANVAS_HEIGHT = 560;
const NODE_WIDTH = 184;
const NODE_HEIGHT = 92;
const KNOWLEDGE_POSITION: Position = { x: 470, y: 330 };
const nodeTypes: WorkflowNodeType[] = ["deterministic", "model", "agent_loop", "tool", "route", "fan_out", "fan_in", "approval", "wait", "handoff"];
const nodeMeta: Record<WorkflowNodeType, NodeMeta> = {
  deterministic: { label: "Set or transform", description: "Prepare information for the next step.", icon: Boxes, kind: "Data" },
  model: { label: "AI response", description: "Ask the configured model to reason or reply.", icon: Sparkles, kind: "AI" },
  agent_loop: { label: "Agent loop", description: "Let the model iterate on a task.", icon: Bot, kind: "AI" },
  tool: { label: "Tool or service", description: "Call an external tool connected to this agent.", icon: Wrench, kind: "Tool" },
  route: { label: "Route", description: "Choose the next path from state.", icon: Route, kind: "Flow" },
  fan_out: { label: "Run in parallel", description: "Start multiple connected branches.", icon: Split, kind: "Flow" },
  fan_in: { label: "Join branches", description: "Continue after parallel work completes.", icon: Merge, kind: "Flow" },
  approval: { label: "Require approval", description: "Pause before a consequential action.", icon: ShieldCheck, kind: "Control" },
  wait: { label: "Wait for event", description: "Pause until an external event arrives.", icon: Clock3, kind: "Control" },
  handoff: { label: "Hand off", description: "Pause for a workspace member.", icon: UserRound, kind: "Control" },
};

function resolvedNodeMeta(node: Pick<NodeDraft, "type" | "configText">): NodeMeta {
  try {
    const config = JSON.parse(node.configText || "{}") as Record<string, unknown>;
    if (config.uiRole === "gateway") return { label: "Chat", description: "Receive messages from the test chat gateway.", icon: MessageCircle, kind: "Gateway" };
    if (config.uiRole === "agent") return { label: "Agent", description: "Reason, choose tools, and prepare the response.", icon: Bot, kind: "Agent" };
  } catch { /* invalid JSON is reported by the graph validator */ }
  return nodeMeta[node.type];
}

export const starterGraph: WorkflowGraphValue = {
  version: 1,
  entryNodeId: "chat",
  nodes: [
    { id: "chat", type: "deterministic", config: { uiRole: "gateway", operation: "set", path: "workflow.gateway", value: "chat" }, reads: ["input"], writes: ["workflow.gateway"] },
    { id: "agent", type: "model", config: { uiRole: "agent", instruction: "Respond using the agent instructions, connected knowledge, and available tools." }, reads: ["input", "knowledge"], writes: ["output"] },
  ],
  edges: [{ from: "chat", to: "agent" }],
  stateSchema: {},
};

function graphToDraft(graph: WorkflowGraphValue): EditorDraft {
  return {
    entryNodeId: graph.entryNodeId,
    nodes: graph.nodes.map((node) => ({ id: node.id, type: node.type, configText: JSON.stringify(node.config ?? {}, null, 2), readsText: node.reads.join(", "), writesText: node.writes.join(", "), maxIterationsText: node.maxIterations === undefined ? "" : String(node.maxIterations), parallelGroup: node.parallelGroup ?? "" })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, condition: edge.condition ?? "", maxIterationsText: edge.maxIterations === undefined ? "" : String(edge.maxIterations) })),
  };
}

function parseList(value: string): string[] { return value.split(",").map((entry) => entry.trim()).filter(Boolean); }
function parsePositiveInteger(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${label} must be a whole number between 1 and 100`);
  return parsed;
}

function parseDraft(draft: EditorDraft): { graph?: WorkflowGraphValue; error?: string } {
  if (!draft.nodes.length) return { error: "Add at least one step to the workflow." };
  const ids = new Set<string>();
  const nodes: WorkflowGraphValue["nodes"] = [];
  try {
    for (const node of draft.nodes) {
      if (!/^[a-zA-Z0-9_-]+$/.test(node.id) || node.id.length > 120) return { error: `Step id “${node.id}” may only contain letters, numbers, _ and -.` };
      if (ids.has(node.id)) return { error: `Step id “${node.id}” is duplicated.` };
      ids.add(node.id);
      const config = JSON.parse(node.configText || "{}");
      if (!config || typeof config !== "object" || Array.isArray(config)) return { error: `Settings for “${node.id}” must be an object.` };
      const maxIterations = parsePositiveInteger(node.maxIterationsText, `Max iterations for ${node.id}`);
      if (node.type === "fan_out" && !node.parallelGroup.trim()) return { error: `Parallel step “${node.id}” needs a branch group.` };
      nodes.push({ id: node.id, type: node.type, config: config as Record<string, unknown>, reads: parseList(node.readsText), writes: parseList(node.writesText), ...(maxIterations === undefined ? {} : { maxIterations }), ...(node.parallelGroup.trim() ? { parallelGroup: node.parallelGroup.trim() } : {}) });
    }
    if (!ids.has(draft.entryNodeId)) return { error: "The starting step must exist in the workflow." };
    const edges: WorkflowGraphValue["edges"] = [];
    for (const edge of draft.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) return { error: "Every connection must point to an existing step." };
      const maxIterations = parsePositiveInteger(edge.maxIterationsText, "Connection max iterations");
      edges.push({ from: edge.from, to: edge.to, ...(edge.condition.trim() ? { condition: edge.condition.trim() } : {}), ...(maxIterations === undefined ? {} : { maxIterations }) });
    }
    return { graph: { version: 1, entryNodeId: draft.entryNodeId, nodes, edges, stateSchema: {} } };
  } catch (error) { return { error: error instanceof Error ? error.message : "Workflow is invalid." }; }
}

function initialGraph(configuration: Record<string, unknown> | undefined): WorkflowGraphValue {
  const workflow = configuration?.workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return starterGraph;
  const parsed = workflow as Partial<WorkflowGraphValue>;
  if (parsed.version !== 1 || typeof parsed.entryNodeId !== "string" || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return starterGraph;
  const legacyPrepare = parsed.nodes.find((node) => node.id === "prepare" && node.type === "deterministic");
  const legacyRespond = parsed.nodes.find((node) => node.id === "respond" && node.type === "model");
  const isLegacyStarter = parsed.entryNodeId === "prepare"
    && parsed.nodes.length === 2
    && parsed.edges.length === 1
    && parsed.edges[0]?.from === "prepare"
    && parsed.edges[0]?.to === "respond"
    && Boolean(legacyPrepare)
    && Boolean(legacyRespond);
  if (isLegacyStarter) {
    const instruction = typeof legacyRespond?.config?.instruction === "string"
      ? legacyRespond.config.instruction
      : starterGraph.nodes[1]!.config.instruction;
    return {
      ...starterGraph,
      nodes: starterGraph.nodes.map((node) => node.id === "agent"
        ? { ...node, config: { ...node.config, instruction } }
        : node),
    };
  }
  return parsed as WorkflowGraphValue;
}

function layoutPositions(nodes: NodeDraft[]): Record<string, Position> {
  if (nodes.some((node) => node.id === "chat") && nodes.some((node) => node.id === "agent")) {
    const rest = nodes.filter((node) => node.id !== "chat" && node.id !== "agent");
    return {
      chat: { x: 116, y: 118 },
      agent: { x: 470, y: 118 },
      ...Object.fromEntries(rest.map((node, index) => [node.id, { x: 470 + (index % 3) * 232, y: 330 + Math.floor(index / 3) * 130 }] as const)),
    };
  }
  return Object.fromEntries(nodes.map((node, index) => [node.id, { x: 64 + (index % 4) * 242, y: 92 + Math.floor(index / 4) * 154 }] as const));
}

function connectorPath(from: Position, to: Position): { d: string; startX: number; startY: number; endX: number; endY: number } {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const direction = endX >= startX ? 1 : -1;
  const curve = Math.max(56, Math.abs(endX - startX) * 0.45);
  const firstControlX = startX + direction * curve;
  const secondControlX = endX - direction * curve;
  return {
    d: `M ${startX} ${startY} C ${firstControlX} ${startY}, ${secondControlX} ${endY}, ${endX} ${endY}`,
    startX,
    startY,
    endX,
    endY,
  };
}

function defaultNode(type: WorkflowNodeType, id: string): NodeDraft {
  const base = { id, type, readsText: "", writesText: "", maxIterationsText: "", parallelGroup: "" };
  const configs: Record<WorkflowNodeType, { configText: string; readsText?: string; writesText?: string; maxIterationsText?: string; parallelGroup?: string }> = {
    deterministic: { configText: '{\n  "operation": "set",\n  "path": "workflow.value",\n  "value": true\n}', writesText: "workflow.value" },
    model: { configText: '{\n  "instruction": "Use the agent instructions and current context."\n}', readsText: "input", writesText: "output" },
    agent_loop: { configText: '{\n  "instruction": "Continue until the task is complete."\n}', readsText: "input", writesText: "output", maxIterationsText: "3" },
    tool: { configText: '{\n  "toolName": "",\n  "arguments": {}\n}', readsText: "input", writesText: "tool.output" },
    route: { configText: "{}" }, fan_out: { configText: '{\n  "fanInNodeId": "join"\n}', parallelGroup: "branch-1" }, fan_in: { configText: "{}" }, approval: { configText: "{}" },
    wait: { configText: `{\n  "eventKey": "${id}"\n}`, writesText: "event.payload" }, handoff: { configText: `{\n  "handoffKey": "${id}"\n}`, writesText: "handoff.payload" },
  };
  return { ...base, ...configs[type] };
}

export function AgentWorkflowEditor({ configuration, onChange, onValidityChange, onTestRun, knowledgeText = "", knowledgeFile = null, onKnowledgeTextChange, onKnowledgeFileChange }: { configuration?: Record<string, unknown>; onChange: (workflow: WorkflowGraphValue | null) => void; onValidityChange: (valid: boolean) => void; onTestRun?: (message: string) => Promise<{ runId: string; status: string }>; knowledgeText?: string; knowledgeFile?: File | null; onKnowledgeTextChange?: (value: string) => void; onKnowledgeFileChange?: (file: File | null) => void }) {
  const startingGraph = initialGraph(configuration);
  const initialDraft = graphToDraft(startingGraph);
  const [draft, setDraft] = useState<EditorDraft>(initialDraft);
  const [positions, setPositions] = useState<Record<string, Position>>(() => layoutPositions(initialDraft.nodes));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [connectionPreview, setConnectionPreview] = useState<{ from: string; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [addType, setAddType] = useState<WorkflowNodeType>("tool");
  const [testMessage, setTestMessage] = useState("Run this workflow and summarize the result.");
  const [testRun, setTestRun] = useState<{ runId: string; status: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const dragStartRef = useRef<Position | null>(null);
  const connectionRef = useRef<{ from: string } | null>(null);
  const suppressNodeClickRef = useRef(false);

  useEffect(() => { const result = parseDraft(draft); onChange(result.graph ?? null); onValidityChange(Boolean(result.graph)); }, [draft, onChange, onValidityChange]);

  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const selectedNode = draft.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const knowledgeSelected = selectedNodeId === "knowledge";
  const incoming = useMemo(() => Object.fromEntries(draft.nodes.map((node) => [node.id, draft.edges.filter((edge) => edge.to === node.id).length])), [draft.edges, draft.nodes]);
  const outgoing = useMemo(() => Object.fromEntries(draft.nodes.map((node) => [node.id, draft.edges.filter((edge) => edge.from === node.id).length])), [draft.edges, draft.nodes]);

  const updateNode = (index: number, patch: Partial<NodeDraft>) => setDraft((current) => ({ ...current, nodes: current.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch } : node) }));
  const updateSelectedNode = (patch: Partial<NodeDraft>) => { if (!selectedNodeId || knowledgeSelected) return; const index = draft.nodes.findIndex((node) => node.id === selectedNodeId); if (index >= 0) updateNode(index, patch); };
  const updateSelectedConfig = (key: string, value: unknown) => {
    if (!selectedNode) return;
    let config: Record<string, unknown> = {};
    try { const candidate = JSON.parse(selectedNode.configText || "{}"); if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) config = candidate as Record<string, unknown>; } catch { /* keep editing from the last valid object */ }
    updateSelectedNode({ configText: JSON.stringify({ ...config, [key]: value }, null, 2) });
  };
  const selectedConfigValue = (key: string): string => {
    if (!selectedNode) return "";
    try { const config = JSON.parse(selectedNode.configText) as Record<string, unknown>; return typeof config[key] === "string" ? config[key] : ""; } catch { return ""; }
  };
  const removeNode = (id: string) => {
    setDraft((current) => { const nodes = current.nodes.filter((node) => node.id !== id); return { ...current, entryNodeId: current.entryNodeId === id ? (nodes[0]?.id ?? "") : current.entryNodeId, nodes, edges: current.edges.filter((edge) => edge.from !== id && edge.to !== id) }; });
    setPositions((current) => { const next = { ...current }; delete next[id]; return next; });
    setSelectedNodeId((current) => current === id ? null : current);
    setConnectFrom((current) => current === id ? null : current);
  };
  const renameNode = (oldId: string, nextId: string) => {
    setDraft((current) => ({ ...current, entryNodeId: current.entryNodeId === oldId ? nextId : current.entryNodeId, nodes: current.nodes.map((node) => node.id === oldId ? { ...node, id: nextId } : node), edges: current.edges.map((edge) => ({ ...edge, from: edge.from === oldId ? nextId : edge.from, to: edge.to === oldId ? nextId : edge.to })) }));
    setPositions((current) => { const next = { ...current, [nextId]: current[oldId] ?? { x: 64, y: 92 } }; delete next[oldId]; return next; });
    setSelectedNodeId(nextId);
    setConnectFrom((current) => current === oldId ? nextId : current);
  };
  const addNode = () => {
    setDraft((current) => {
      const baseId = addType.replaceAll("_", "-");
      let id = `${baseId}-${current.nodes.length + 1}`;
      let suffix = current.nodes.length + 1;
      while (current.nodes.some((node) => node.id === id)) id = `${baseId}-${++suffix}`;
      const node = defaultNode(addType, id);
      setPositions((value) => ({ ...value, [id]: { x: 64 + (current.nodes.length % 4) * 242, y: 92 + Math.floor(current.nodes.length / 4) * 154 } }));
      setSelectedNodeId(id);
      return { ...current, nodes: [...current.nodes, node] };
    });
  };
  const connectNodes = (from: string, to: string) => {
    if (from === to) return;
    setDraft((current) => current.edges.some((edge) => edge.from === from && edge.to === to) ? current : { ...current, edges: [...current.edges, { from, to, condition: "", maxIterationsText: "" }] });
  };
  const chooseNodeForConnection = (id: string) => {
    if (!connectMode || id === "knowledge") return;
    if (!connectFrom) { setConnectFrom(id); return; }
    connectNodes(connectFrom, id);
    setConnectFrom(null);
  };
  const canvasPoint = (event: CanvasEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left + canvasRef.current.scrollLeft) / zoom, y: (event.clientY - rect.top + canvasRef.current.scrollTop) / zoom };
  };
  const beginConnection = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const point = canvasPoint(event);
    setConnectMode(true);
    setConnectFrom(id);
    connectionRef.current = { from: id };
    setConnectionPreview({ from: id, ...point });
  };
  const onCanvasPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (connectionRef.current) setConnectionPreview({ from: connectionRef.current.from, ...canvasPoint(event) });
    const drag = dragRef.current;
    if (!drag || !canvasRef.current) return;
    const point = canvasPoint(event);
    const x = Math.max(12, Math.min(CANVAS_WIDTH - NODE_WIDTH - 12, point.x - drag.offsetX));
    const y = Math.max(12, Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 12, point.y - drag.offsetY));
    const start = dragStartRef.current;
    if (start && (Math.abs(x - start.x) > 3 || Math.abs(y - start.y) > 3)) suppressNodeClickRef.current = true;
    setPositions((current) => ({ ...current, [drag.id]: { x, y } }));
  };
  const onCanvasPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    dragStartRef.current = null;
    if (!connectionRef.current) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-workflow-target]")?.dataset.workflowTarget;
    const from = connectionRef.current.from;
    if (target && target !== from) { connectNodes(from, target); setConnectFrom(null); }
    setConnectionPreview(null);
    connectionRef.current = null;
  };
  const onNodePointerDown = (event: PointerEvent<HTMLDivElement>, id: string) => {
    if (connectMode || !canvasRef.current) return;
    const position = positions[id] ?? { x: 12, y: 12 };
    const point = canvasPoint(event);
    suppressNodeClickRef.current = false;
    dragStartRef.current = position;
    dragRef.current = { id, offsetX: point.x - position.x, offsetY: point.y - position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onCanvasWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const worldX = (canvas.scrollLeft + pointerX) / zoom;
    const worldY = (canvas.scrollTop + pointerY) / zoom;
    const nextZoom = Math.min(1.8, Math.max(0.4, Number((zoom * Math.exp(-event.deltaY * 0.0015)).toFixed(2))));
    if (nextZoom === zoom) return;
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      canvas.scrollLeft = worldX * nextZoom - pointerX;
      canvas.scrollTop = worldY * nextZoom - pointerY;
    });
  };
  const nodePosition = (id: string, index: number): Position => positions[id] ?? { x: 64 + (index % 4) * 242, y: 92 + Math.floor(index / 4) * 154 };
  const closeInspector = () => setSelectedNodeId(null);
  const resetStarter = () => { const nextDraft = graphToDraft(starterGraph); setDraft(nextDraft); setPositions(layoutPositions(nextDraft.nodes)); setSelectedNodeId(null); setConnectFrom(null); setConnectMode(false); };
  const runTest = async () => { const message = testMessage.trim(); if (!onTestRun || !message || testing) return; setTesting(true); setTestError(null); setTestRun(null); try { setTestRun(await onTestRun(message)); } catch (error) { setTestError(error instanceof Error ? error.message : "Unable to start workflow test."); } finally { setTesting(false); } };

  return <MotionReveal delay={0.08}><Card className="overflow-hidden"><CardContent className="space-y-5 p-4 sm:p-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3"><Workflow className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">Workflow canvas</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Connect the steps your agent should run. Click a node to configure it.</p></div></div>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={resetStarter}>Use starter</Button><Button type="button" variant={connectMode ? "default" : "outline"} size="sm" onClick={() => { setConnectMode((current) => !current); setConnectFrom(null); setConnectionPreview(null); }}><Link2 className="mr-1.5 h-3.5 w-3.5" />{connectMode ? "Done" : "Connect steps"}</Button></div>
    </div>
    <div className="rounded-xl border border-border bg-secondary/20 p-3"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-2 text-sm text-foreground"><MousePointer2 className="h-4 w-4 text-primary" /><span>{connectMode ? connectFrom ? "Drag to a target handle or click the destination node." : "Choose a source handle to start a connection." : "Drag the node body to arrange it. Use the side handles to link steps."}</span></div><div className="flex items-center gap-2"><Select value={addType} onValueChange={(value) => setAddType(value as WorkflowNodeType)}><SelectTrigger aria-label="Step to add" className="h-9 min-w-44 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tool">Tool or service</SelectItem>{nodeTypes.filter((type) => type !== "tool").map((type) => <SelectItem key={type} value={type}>{nodeMeta[type].label}</SelectItem>)}</SelectContent></Select><Button type="button" size="sm" onClick={addNode}><Plus className="mr-1.5 h-3.5 w-3.5" />Add step</Button></div></div></div>
    <div ref={canvasRef} onWheel={onCanvasWheel} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp} onPointerLeave={() => { if (dragRef.current) suppressNodeClickRef.current = true; dragRef.current = null; dragStartRef.current = null; if (connectionRef.current) { connectionRef.current = null; setConnectionPreview(null); } }} className="relative min-h-[470px] overflow-auto rounded-2xl border border-border bg-[#15171a] bg-[linear-gradient(to_right,rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:24px_24px]">
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-lg backdrop-blur" title="Use the mouse wheel to zoom"><Button type="button" variant="ghost" size="icon-sm" className="pointer-events-auto" onClick={() => setZoom((current) => Math.max(0.4, Number((current - 0.1).toFixed(1))))} aria-label="Zoom out"><ZoomOut /></Button><span className="min-w-12 text-center text-xs font-medium text-muted-foreground">{Math.round(zoom * 100)}%</span><Button type="button" variant="ghost" size="icon-sm" className="pointer-events-auto" onClick={() => setZoom((current) => Math.min(1.8, Number((current + 0.1).toFixed(1))))} aria-label="Zoom in"><ZoomIn /></Button></div>
      <div className="relative" style={{ width: CANVAS_WIDTH * zoom, height: CANVAS_HEIGHT * zoom }}><div className="relative origin-top-left" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${zoom})` }}>
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-visible" width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
          <defs>
            <linearGradient id="workflow-flow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#60a5fa" /><stop offset="1" stopColor="#a78bfa" /></linearGradient>
            <linearGradient id="workflow-resource" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#34d399" /><stop offset="1" stopColor="#60a5fa" /></linearGradient>
            <filter id="workflow-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            <marker id="workflow-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M1 1 L9 5 L1 9 Z" fill="#a78bfa" />
            </marker>
            <marker id="workflow-resource-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L9 5 L1 9 Z" fill="#60a5fa" /></marker>
          </defs>
          {draft.edges.map((edge, index) => {
            const from = nodePosition(edge.from, draft.nodes.findIndex((node) => node.id === edge.from));
            const to = nodePosition(edge.to, draft.nodes.findIndex((node) => node.id === edge.to));
            const path = connectorPath(from, to);
            return <g key={`${edge.from}-${edge.to}-${index}`}>
              <path d={path.d} fill="none" stroke="#080a0d" strokeOpacity="0.95" strokeWidth="10" strokeLinecap="round" />
              <path d={path.d} fill="none" stroke="url(#workflow-flow)" strokeWidth="4" strokeLinecap="round" markerEnd="url(#workflow-arrow)" filter="url(#workflow-glow)" />
              <circle cx={path.startX} cy={path.startY} r="5" fill="#60a5fa" stroke="#15171a" strokeWidth="2" />
              <circle cx={path.endX} cy={path.endY} r="5" fill="#a78bfa" stroke="#15171a" strokeWidth="2" />
            </g>;
          })}
          {draft.nodes.some((node) => node.id === "agent") ? (() => {
            const agent = nodePosition("agent", draft.nodes.findIndex((node) => node.id === "agent"));
            const startX = KNOWLEDGE_POSITION.x + NODE_WIDTH / 2;
            const startY = KNOWLEDGE_POSITION.y;
            const endX = agent.x + NODE_WIDTH / 2;
            const endY = agent.y + NODE_HEIGHT;
            const midY = startY - Math.max(52, (startY - endY) * 0.5);
            const d = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
            return <g><path d={d} fill="none" stroke="#080a0d" strokeWidth="10" strokeLinecap="round" /><path d={d} fill="none" stroke="url(#workflow-resource)" strokeWidth="3" strokeDasharray="7 5" strokeLinecap="round" markerEnd="url(#workflow-resource-arrow)" /><circle cx={startX} cy={startY} r="5" fill="#34d399" stroke="#15171a" strokeWidth="2" /><circle cx={endX} cy={endY} r="5" fill="#60a5fa" stroke="#15171a" strokeWidth="2" /></g>;
          })() : null}
          {connectionPreview ? (() => {
            const from = nodePosition(connectionPreview.from, draft.nodes.findIndex((node) => node.id === connectionPreview.from));
            const startX = from.x + NODE_WIDTH;
            const startY = from.y + NODE_HEIGHT / 2;
            const direction = connectionPreview.x >= startX ? 1 : -1;
            const curve = Math.max(44, Math.abs(connectionPreview.x - startX) * 0.45);
            const previewPath = `M ${startX} ${startY} C ${startX + direction * curve} ${startY}, ${connectionPreview.x - direction * curve} ${connectionPreview.y}, ${connectionPreview.x} ${connectionPreview.y}`;
            return <path d={previewPath} fill="none" stroke="var(--primary)" strokeWidth="3" strokeDasharray="8 6" strokeLinecap="round" strokeOpacity="0.95" markerEnd="url(#workflow-arrow)" />;
          })() : null}
        </svg>
        {draft.nodes.map((node, index) => { const meta = resolvedNodeMeta(node); const Icon = meta.icon; const position = nodePosition(node.id, index); const selected = selectedNodeId === node.id; const source = connectFrom === node.id; return <div key={`${node.id}-${index}`} role="button" tabIndex={0} onClick={() => { if (suppressNodeClickRef.current) { suppressNodeClickRef.current = false; return; } if (connectMode) chooseNodeForConnection(node.id); else setSelectedNodeId(node.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (connectMode) chooseNodeForConnection(node.id); else setSelectedNodeId(node.id); } }} onPointerDown={(event) => onNodePointerDown(event, node.id)} className={`absolute z-10 select-none rounded-xl border bg-card/95 p-2.5 shadow-lg shadow-black/25 transition-[border-color,box-shadow,transform] ${selected ? "border-primary ring-2 ring-primary/25" : source ? "border-primary/80 ring-2 ring-primary/15" : "border-border hover:-translate-y-0.5 hover:border-primary/60"} ${connectMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`} style={{ left: position.x, top: position.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}>
          <button type="button" data-workflow-target={node.id} aria-label={`Connect into ${meta.label}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (connectFrom) { connectNodes(connectFrom, node.id); setConnectFrom(null); } }} className="absolute -left-2.5 top-1/2 z-20 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full border-2 border-card bg-background shadow-sm transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
          <button type="button" aria-label={`Connect from ${meta.label}`} onPointerDown={(event) => beginConnection(event, node.id)} onClick={(event) => event.stopPropagation()} className={`absolute -right-2.5 top-1/2 z-20 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full border-2 border-card shadow-sm transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${source ? "bg-primary" : "bg-primary/75"}`} />
          <div className="flex items-center gap-2"><div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="h-3.5 w-3.5" /></div><div className="min-w-0 flex-1"><p className="truncate text-[13px] font-semibold text-foreground">{meta.label}</p><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{node.id}</p></div><span className={`h-2 w-2 shrink-0 rounded-full ${node.id === draft.entryNodeId ? "bg-status-success" : "bg-muted-foreground/40"}`} /></div>
          <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground"><span className="rounded-full border border-border bg-secondary px-1.5 py-0.5">{meta.kind}</span><span>{incoming[node.id] ?? 0} in · {outgoing[node.id] ?? 0} out</span></div>
        </div>; })}
        <div role="button" tabIndex={0} onClick={() => { if (!connectMode) setSelectedNodeId("knowledge"); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!connectMode) setSelectedNodeId("knowledge"); } }} className={`absolute z-10 select-none rounded-xl border bg-card/95 p-2.5 shadow-lg shadow-black/25 transition-colors ${knowledgeSelected ? "border-emerald-400 ring-2 ring-emerald-400/20" : "border-border hover:border-emerald-400/70"}`} style={{ left: KNOWLEDGE_POSITION.x, top: KNOWLEDGE_POSITION.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}><span className="absolute -top-2.5 left-1/2 h-5 w-5 -translate-x-1/2 rounded-full border-2 border-card bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.65)]" /><div className="flex items-center gap-2"><div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300"><Upload className="h-3.5 w-3.5" /></div><div className="min-w-0 flex-1"><p className="truncate text-[13px] font-semibold text-foreground">Knowledge</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground">Agent context</p></div><span className={`h-2 w-2 shrink-0 rounded-full ${knowledgeText.trim() || knowledgeFile ? "bg-status-success" : "bg-muted-foreground/40"}`} /></div><div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground"><span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-emerald-300">Knowledge</span><span>{knowledgeText.trim() || knowledgeFile ? "Configured" : "Add information"}</span></div></div>
      </div></div>
    </div>

    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="rounded-full border border-border bg-secondary px-2.5 py-1">{draft.nodes.length} steps</span><span className="rounded-full border border-border bg-secondary px-2.5 py-1">{draft.edges.length} connections</span><span className="rounded-full border border-border bg-secondary px-2.5 py-1">State isolated per run</span>{connectMode ? <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-primary">{connectFrom ? "Choose a destination" : "Choose a source"}</span> : null}</div>
    {parsed.error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{parsed.error}</p> : <p className="flex items-center gap-2 rounded-lg bg-status-success-soft px-3 py-2 text-sm text-status-success"><Check className="h-4 w-4" />Workflow ready.</p>}
    {draft.nodes.some((node) => node.type === "approval") ? <p className="text-xs text-muted-foreground">Approval steps pause the run until an authorized decision resumes it.</p> : null}
    {onTestRun ? <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><div><h3 className="text-sm font-semibold text-foreground">Test the installed workflow</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Save and publish a draft first if you changed this graph.</p></div><div className="flex flex-col gap-2 sm:flex-row"><Input value={testMessage} onChange={(event) => setTestMessage(event.target.value)} maxLength={20_000} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runTest(); } }} placeholder="Message to send through the workflow" className="min-w-0 flex-1" /><Button type="button" onClick={() => void runTest()} disabled={testing || !testMessage.trim()}>{testing ? "Starting…" : "Run test"}</Button></div>{testError ? <p className="text-xs text-destructive" role="alert">{testError}</p> : null}{testRun ? <p className="text-xs text-muted-foreground">Run <Link className="font-mono text-primary underline-offset-2 hover:underline" href={`/agents/activity/${encodeURIComponent(testRun.runId)}`}>Run details</Link> accepted with status <span className="font-medium text-foreground">{testRun.status}</span>.</p> : null}</div> : null}

    <Sheet open={Boolean(selectedNodeId)} onOpenChange={(open: boolean) => { if (!open) closeInspector(); }}>
      <SheetContent side="right" className="w-full max-w-xl overflow-y-auto border-l border-border p-6 sm:w-[30rem]">
        {selectedNode ? <div className="space-y-6"><div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">{(() => { const Icon = nodeMeta[selectedNode.type].icon; return <Icon className="h-5 w-5" />; })()}</div><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Node configuration</p><h2 className="mt-1 text-xl font-semibold text-foreground">{nodeMeta[selectedNode.type].label}</h2></div></div><Button variant="ghost" size="icon-sm" onClick={closeInspector} aria-label="Close node configuration"><X /></Button></div><div className="space-y-4"><label className="block text-sm font-medium text-foreground">Node name<Input value={selectedNode.id} onChange={(event) => renameNode(selectedNode.id, event.target.value)} className="mt-1.5 h-10" /></label><label className="block text-sm font-medium text-foreground">Node type<Select value={selectedNode.type} onValueChange={(value) => updateSelectedNode({ type: value as WorkflowNodeType })}><SelectTrigger className="mt-1.5 h-10"><SelectValue /></SelectTrigger><SelectContent>{nodeTypes.map((type) => <SelectItem key={type} value={type}>{nodeMeta[type].label}</SelectItem>)}</SelectContent></Select></label>{selectedNode.type === "model" || selectedNode.type === "agent_loop" ? <label className="block text-sm font-medium text-foreground">Instructions<Textarea value={selectedConfigValue("instruction")} onChange={(event) => updateSelectedConfig("instruction", event.target.value)} rows={7} className="mt-1.5 resize-y leading-6" placeholder="Tell this step what to do…" /></label> : null}{selectedNode.type === "tool" ? <label className="block text-sm font-medium text-foreground">Tool or service<Input value={selectedConfigValue("toolName")} onChange={(event) => updateSelectedConfig("toolName", event.target.value)} placeholder="Select a connected service" className="mt-1.5 h-10" /></label> : null}{selectedNode.type === "deterministic" ? <><label className="block text-sm font-medium text-foreground">State path<Input value={selectedConfigValue("path")} onChange={(event) => updateSelectedConfig("path", event.target.value)} placeholder="workflow.value" className="mt-1.5 h-10" /></label><label className="block text-sm font-medium text-foreground">Operation<Select value={selectedConfigValue("operation") || "set"} onValueChange={(value) => updateSelectedConfig("operation", value)}><SelectTrigger className="mt-1.5 h-10"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="set">Set</SelectItem><SelectItem value="merge">Merge</SelectItem></SelectContent></Select></label></> : null}{selectedNode.type === "tool" || selectedNode.type === "route" || selectedNode.type === "wait" || selectedNode.type === "handoff" ? <label className="block text-sm font-medium text-foreground">{selectedNode.type === "tool" ? "Arguments (JSON)" : selectedNode.type === "route" ? "Route condition" : selectedNode.type === "wait" ? "Event key" : "Handoff key"}<Textarea value={selectedNode.type === "tool" ? (() => { try { const config = JSON.parse(selectedNode.configText) as Record<string, unknown>; return JSON.stringify(config.arguments ?? {}, null, 2); } catch { return "{}"; } })() : selectedConfigValue(selectedNode.type === "route" ? "condition" : selectedNode.type === "wait" ? "eventKey" : "handoffKey")} onChange={(event) => { if (selectedNode.type === "tool") { try { updateSelectedConfig("arguments", JSON.parse(event.target.value)); } catch { /* allow the user to finish valid JSON */ } } else updateSelectedConfig(selectedNode.type === "route" ? "condition" : selectedNode.type === "wait" ? "eventKey" : "handoffKey", event.target.value); }} rows={selectedNode.type === "tool" ? 5 : 2} className="mt-1.5 resize-y font-mono text-xs leading-5" /></label> : null}{selectedNode.type === "agent_loop" ? <label className="block text-sm font-medium text-foreground">Max iterations<Input type="number" min={1} max={100} value={selectedNode.maxIterationsText} onChange={(event) => updateSelectedNode({ maxIterationsText: event.target.value })} className="mt-1.5 h-10" /></label> : null}{selectedNode.type === "fan_out" ? <label className="block text-sm font-medium text-foreground">Branch group<Input value={selectedNode.parallelGroup} onChange={(event) => updateSelectedNode({ parallelGroup: event.target.value })} placeholder="branch-1" className="mt-1.5 h-10" /></label> : null}</div><div className="flex items-center justify-between border-t border-border pt-4"><p className="text-xs text-muted-foreground">Connections are created from the handles on the canvas.</p><Button type="button" variant="destructive" size="sm" onClick={() => removeNode(selectedNode.id)} disabled={draft.nodes.length <= 1}><Trash2 className="mr-1.5 h-4 w-4" />Remove node</Button></div></div> : knowledgeSelected ? <div className="space-y-6"><div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Upload className="h-5 w-5" /></div><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Knowledge</p><h2 className="mt-1 text-xl font-semibold text-foreground">Agent information</h2></div></div><Button variant="ghost" size="icon-sm" onClick={closeInspector} aria-label="Close knowledge configuration"><X /></Button></div><p className="text-sm leading-6 text-muted-foreground">Add the facts and documents this workflow can use.</p><Textarea value={knowledgeText} onChange={(event) => onKnowledgeTextChange?.(event.target.value)} rows={12} maxLength={200_000} placeholder="Paste information here…" className="resize-y leading-6" /><label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"><Upload className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{knowledgeFile ? knowledgeFile.name : "Add TXT, Markdown, CSV, PDF, DOCX, or Excel"}</span><input type="file" className="sr-only" accept=".txt,.text,.md,.markdown,.csv,.pdf,.docx,.xlsx,.xls,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => onKnowledgeFileChange?.(event.target.files?.[0] ?? null)} /></label></div> : null}
      </SheetContent>
    </Sheet>
  </CardContent></Card></MotionReveal>;
}
