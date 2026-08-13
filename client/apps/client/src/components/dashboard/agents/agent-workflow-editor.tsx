"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, GitBranch, Plus, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export type WorkflowNodeType = "deterministic" | "model" | "agent_loop" | "tool" | "route" | "fan_out" | "fan_in" | "approval" | "wait";

export type WorkflowGraphValue = {
  version: 1;
  entryNodeId: string;
  nodes: Array<{
    id: string;
    type: WorkflowNodeType;
    config: Record<string, unknown>;
    reads: string[];
    writes: string[];
    maxIterations?: number;
    parallelGroup?: string;
  }>;
  edges: Array<{ from: string; to: string; condition?: string; maxIterations?: number }>;
  stateSchema: Record<string, unknown>;
};

type NodeDraft = {
  id: string;
  type: WorkflowNodeType;
  configText: string;
  readsText: string;
  writesText: string;
  maxIterationsText: string;
  parallelGroup: string;
};

type EdgeDraft = {
  from: string;
  to: string;
  condition: string;
  maxIterationsText: string;
};

type EditorDraft = {
  entryNodeId: string;
  nodes: NodeDraft[];
  edges: EdgeDraft[];
};

const nodeTypes: WorkflowNodeType[] = ["deterministic", "model", "agent_loop", "tool", "route", "fan_out", "fan_in", "approval", "wait"];

const starterGraph: WorkflowGraphValue = {
  version: 1,
  entryNodeId: "prepare",
  nodes: [
    { id: "prepare", type: "deterministic", config: { operation: "set", path: "workflow.started", value: true }, reads: [], writes: ["workflow.started"] },
    { id: "respond", type: "model", config: { instruction: "Respond using the agent instructions and the available context." }, reads: ["input"], writes: ["output"] },
  ],
  edges: [{ from: "prepare", to: "respond" }],
  stateSchema: {},
};

function graphToDraft(graph: WorkflowGraphValue): EditorDraft {
  return {
    entryNodeId: graph.entryNodeId,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      configText: JSON.stringify(node.config ?? {}, null, 2),
      readsText: node.reads.join(", "),
      writesText: node.writes.join(", "),
      maxIterationsText: node.maxIterations === undefined ? "" : String(node.maxIterations),
      parallelGroup: node.parallelGroup ?? "",
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      condition: edge.condition ?? "",
      maxIterationsText: edge.maxIterations === undefined ? "" : String(edge.maxIterations),
    })),
  };
}

function parseList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parsePositiveInteger(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${label} must be a whole number between 1 and 100`);
  return parsed;
}

function parseDraft(draft: EditorDraft): { graph?: WorkflowGraphValue; error?: string } {
  if (!draft.nodes.length) return { error: "Add at least one workflow node." };
  const ids = new Set<string>();
  const nodes: WorkflowGraphValue["nodes"] = [];
  try {
    for (const node of draft.nodes) {
      if (!/^[a-zA-Z0-9_-]+$/.test(node.id) || node.id.length > 120) return { error: `Node id “${node.id}” may only contain letters, numbers, _ and -.` };
      if (ids.has(node.id)) return { error: `Node id “${node.id}” is duplicated.` };
      ids.add(node.id);
      const config = JSON.parse(node.configText || "{}");
      if (!config || typeof config !== "object" || Array.isArray(config)) return { error: `Config for “${node.id}” must be a JSON object.` };
      const maxIterations = parsePositiveInteger(node.maxIterationsText, `Max iterations for ${node.id}`);
      if (node.type === "fan_out" && !node.parallelGroup.trim()) return { error: `Fan-out node “${node.id}” needs a parallel group.` };
      nodes.push({
        id: node.id,
        type: node.type,
        config: config as Record<string, unknown>,
        reads: parseList(node.readsText),
        writes: parseList(node.writesText),
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(node.parallelGroup.trim() ? { parallelGroup: node.parallelGroup.trim() } : {}),
      });
    }
    if (!ids.has(draft.entryNodeId)) return { error: "The entry node must exist in the graph." };
    const edges: WorkflowGraphValue["edges"] = [];
    for (const edge of draft.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) return { error: "Every edge must point to existing nodes." };
      const maxIterations = parsePositiveInteger(edge.maxIterationsText, "Edge max iterations");
      edges.push({
        from: edge.from,
        to: edge.to,
        ...(edge.condition.trim() ? { condition: edge.condition.trim() } : {}),
        ...(maxIterations === undefined ? {} : { maxIterations }),
      });
    }
    return { graph: { version: 1, entryNodeId: draft.entryNodeId, nodes, edges, stateSchema: {} } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Workflow graph is invalid." };
  }
}

function assertSecretSafe(value: unknown, path = "workflow"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretSafe(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/secret|password|credential|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key/i.test(key)) {
      throw new Error(`Secret-like field “${path}.${key}” is not allowed in workflow exports.`);
    }
    assertSecretSafe(entry, `${path}.${key}`);
  }
}

function initialGraph(configuration: Record<string, unknown> | undefined): WorkflowGraphValue {
  const workflow = configuration?.workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return starterGraph;
  const parsed = workflow as Partial<WorkflowGraphValue>;
  if (parsed.version !== 1 || typeof parsed.entryNodeId !== "string" || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return starterGraph;
  return parsed as WorkflowGraphValue;
}

export function AgentWorkflowEditor({
  configuration,
  onChange,
  onValidityChange,
}: {
  configuration?: Record<string, unknown>;
  onChange: (workflow: WorkflowGraphValue | null) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [draft, setDraft] = useState<EditorDraft>(() => graphToDraft(initialGraph(configuration)));
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const result = parseDraft(draft);
    onChange(result.graph ?? null);
    onValidityChange(Boolean(result.graph));
  }, [draft, onChange, onValidityChange]);

  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const nodeById = useMemo(() => new Map(draft.nodes.map((node) => [node.id, node])), [draft.nodes]);

  const updateNode = (index: number, patch: Partial<NodeDraft>) => {
    setDraft((current) => ({ ...current, nodes: current.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch } : node) }));
  };

  const removeNode = (index: number) => {
    setDraft((current) => {
      const removed = current.nodes[index]?.id;
      const nodes = current.nodes.filter((_, nodeIndex) => nodeIndex !== index);
      const edges = current.edges.filter((edge) => edge.from !== removed && edge.to !== removed);
      return { ...current, entryNodeId: current.entryNodeId === removed ? (nodes[0]?.id ?? "") : current.entryNodeId, nodes, edges };
    });
  };

  const addNode = () => {
    setDraft((current) => {
      const id = `node-${current.nodes.length + 1}`;
      return {
        ...current,
        nodes: [...current.nodes, { id, type: "deterministic", configText: '{\n  "operation": "set",\n  "path": "workflow.value",\n  "value": true\n}', readsText: "", writesText: "workflow.value", maxIterationsText: "", parallelGroup: "" }],
      };
    });
  };

  const addEdge = () => {
    setDraft((current) => {
      if (current.nodes.length < 2) return current;
      return { ...current, edges: [...current.edges, { from: current.nodes[0]!.id, to: current.nodes[1]!.id, condition: "", maxIterationsText: "" }] };
    });
  };

  const resetStarter = () => setDraft(graphToDraft(starterGraph));

  const exportGraph = () => {
    if (!parsed.graph) return;
    try {
      assertSecretSafe(parsed.graph);
      const blob = new Blob([JSON.stringify(parsed.graph, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "kasitek-agent-workflow.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Workflow export was blocked.");
    }
  };

  const importGraph = async (file: File | undefined) => {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text()) as WorkflowGraphValue;
      assertSecretSafe(value);
      if (value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || typeof value.entryNodeId !== "string") throw new Error("Workflow export must use graph version 1.");
      const nextDraft = graphToDraft(value);
      const result = parseDraft(nextDraft);
      if (!result.graph) throw new Error(result.error ?? "Workflow graph is invalid.");
      setDraft(nextDraft);
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Unable to import workflow graph.");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return <Card>
    <CardContent className="space-y-5 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3"><GitBranch className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">Workflow graph</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Compose the durable graph that runs after this version is published. Nodes never receive provider credentials; use capability names and safe state keys instead.</p></div></div>
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={resetStarter}>Use starter</Button><Button type="button" variant="outline" size="sm" onClick={() => importInputRef.current?.click()}><Upload className="mr-1.5 h-3.5 w-3.5" />Import</Button><input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importGraph(event.target.files?.[0])} /><Button type="button" variant="outline" size="sm" onClick={exportGraph} disabled={!parsed.graph}><Download className="mr-1.5 h-3.5 w-3.5" />Export</Button><Button type="button" size="sm" onClick={addNode}><Plus className="mr-1.5 h-3.5 w-3.5" />Node</Button><Button type="button" variant="outline" size="sm" onClick={addEdge} disabled={draft.nodes.length < 2}><Plus className="mr-1.5 h-3.5 w-3.5" />Edge</Button></div>
      </div>
      <div className="grid gap-3 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[0.7fr_1fr] sm:items-center"><label className="text-xs font-medium text-foreground">Entry node<select value={draft.entryNodeId} onChange={(event) => setDraft((current) => ({ ...current, entryNodeId: event.target.value }))} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{draft.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label><div className="text-xs text-muted-foreground">{draft.nodes.length} nodes · {draft.edges.length} edges · state is isolated per run</div></div>
      {draft.nodes.map((node, index) => <div key={`${node.id}-${index}`} className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-2"><Badge className="border-primary/20 bg-primary/10 text-primary">Node {index + 1}</Badge><span className="text-xs text-muted-foreground">{node.type}</span></div><Button type="button" variant="ghost" size="sm" onClick={() => removeNode(index)} disabled={draft.nodes.length <= 1}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove</Button></div>
        <div className="grid gap-3 sm:grid-cols-[1fr_0.8fr_1fr]"><label className="text-xs font-medium text-foreground">Node id<input value={node.id} onChange={(event) => updateNode(index, { id: event.target.value })} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono" /></label><label className="text-xs font-medium text-foreground">Type<select value={node.type} onChange={(event) => updateNode(index, { type: event.target.value as WorkflowNodeType })} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{nodeTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label className="text-xs font-medium text-foreground">Parallel group (fan-out)<input value={node.parallelGroup} onChange={(event) => updateNode(index, { parallelGroup: event.target.value })} placeholder="optional" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-foreground">Reads (comma-separated)<input value={node.readsText} onChange={(event) => updateNode(index, { readsText: event.target.value })} placeholder="input.message" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-foreground">Writes (comma-separated)<input value={node.writesText} onChange={(event) => updateNode(index, { writesText: event.target.value })} placeholder="output.text" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label></div>
        <div className="grid gap-3 sm:grid-cols-[0.5fr_1.5fr]"><label className="text-xs font-medium text-foreground">Max iterations<input value={node.maxIterationsText} onChange={(event) => updateNode(index, { maxIterationsText: event.target.value })} inputMode="numeric" placeholder="optional" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-foreground">Node config (JSON object)<textarea value={node.configText} onChange={(event) => updateNode(index, { configText: event.target.value })} rows={3} spellCheck={false} className="mt-1 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-5" /></label></div>
      </div>)}
      {draft.edges.length ? <div className="space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-foreground">Edges</h3><span className="text-xs text-muted-foreground">Conditions use JSON: {`{"path":"state.key","equals":true}`}</span></div>{draft.edges.map((edge, index) => <div key={`${index}-${edge.from}-${edge.to}`} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_1.4fr_0.5fr_auto] sm:items-end"><label className="text-xs font-medium text-foreground">From<select value={edge.from} onChange={(event) => setDraft((current) => ({ ...current, edges: current.edges.map((entry, edgeIndex) => edgeIndex === index ? { ...entry, from: event.target.value } : entry) }))} className="mt-1 block w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">{draft.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label><label className="text-xs font-medium text-foreground">To<select value={edge.to} onChange={(event) => setDraft((current) => ({ ...current, edges: current.edges.map((entry, edgeIndex) => edgeIndex === index ? { ...entry, to: event.target.value } : entry) }))} className="mt-1 block w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">{draft.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label><label className="text-xs font-medium text-foreground">Condition<input value={edge.condition} onChange={(event) => setDraft((current) => ({ ...current, edges: current.edges.map((entry, edgeIndex) => edgeIndex === index ? { ...entry, condition: event.target.value } : entry) }))} placeholder="optional JSON condition" className="mt-1 block w-full rounded-lg border border-border bg-background px-2 py-2 font-mono text-xs" /></label><label className="text-xs font-medium text-foreground">Loop cap<input value={edge.maxIterationsText} onChange={(event) => setDraft((current) => ({ ...current, edges: current.edges.map((entry, edgeIndex) => edgeIndex === index ? { ...entry, maxIterationsText: event.target.value } : entry) }))} inputMode="numeric" placeholder="—" className="mt-1 block w-full rounded-lg border border-border bg-background px-2 py-2 text-sm" /></label><Button type="button" variant="ghost" size="sm" onClick={() => setDraft((current) => ({ ...current, edges: current.edges.filter((_, edgeIndex) => edgeIndex !== index) }))} aria-label={`Remove edge ${index + 1}`}><Trash2 className="h-4 w-4" /></Button></div>)}</div> : <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">No edges yet. Add an edge to continue from the entry node.</p>}
      {parsed.error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{parsed.error}</p> : <p className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">Graph is valid and will be validated again by the Agent API before the draft is stored.</p>}
      {importError ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{importError}</p> : null}
      <p className="text-xs text-muted-foreground">{[...nodeById.values()].some((node) => node.type === "approval") ? "Approval nodes pause the durable run until an authorized decision resumes it." : "Add an approval node before any consequential tool node when the capability policy requires review."}</p>
    </CardContent>
  </Card>;
}
