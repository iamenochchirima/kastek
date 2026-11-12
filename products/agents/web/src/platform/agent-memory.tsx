import { useState } from "react";
import { PiBrain } from "react-icons/pi";
import { AgentMemoryPanel, type AgentMemoryItem, type AgentMemoryMutation } from "@kasitek-labs/ui/agent-memory";
import { Button } from "@/components/ui/button";
import { api, organizationPath } from "./api";
import { useWorkspace } from "./shell";

export function AgentMemory({ agentId, enabled, label = "Memory", variant = "ghost" }: { agentId: string; enabled: boolean; label?: string; variant?: "ghost" | "outline" }) {
  const { organizationId, session } = useWorkspace();
  const [open, setOpen] = useState(false);
  const scopeKey = `${session.account.id}:${organizationId}:${agentId}`;
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/memory`;
  const mutate = (id: string, change: AgentMemoryMutation) => {
    const body = { operationId: change.requestKey, expectedRevision: change.expectedRevision,
      ...(change.assertion ? { assertion: change.assertion } : {}) };
    const memory = `${path}/${encodeURIComponent(id)}`;
    if (change.action === "accept") return api(`${path}/candidates/${encodeURIComponent(id)}/accept`, body);
    if (change.action === "correct") return api(memory, { ...body, content: change.content }, "PATCH");
    return api(`${memory}/forget`, { operationId: change.requestKey, expectedRevision: change.expectedRevision });
  };
  return <>
    <Button type="button" variant={variant} size="sm" onClick={() => setOpen(true)}><PiBrain aria-hidden size={16} />{label}</Button>
    <AgentMemoryPanel key={scopeKey} open={open} onOpenChange={setOpen} scopeKey={scopeKey} enabled={enabled}
      load={async (page = {}) => {
        const query = new URLSearchParams({ offset: String(page.offset ?? 0), limit: String(page.limit ?? 30) });
        const result = await api<{ items: AgentMemoryItem[]; candidates: AgentMemoryItem[]; nextOffset: number | null }>(`${path}?${query}`);
        return { memories: result.items, candidates: result.candidates, nextOffset: result.nextOffset };
      }} mutate={mutate} />
  </>;
}
