"use client";

import { FormEvent, useState } from "react";
import { OperatorDeleteMemoryButton } from "@/components/admin/operator-command-button";

type SearchResult = { kind: string; id: string; organization_id?: string | null; state?: string; resource_type?: string; created_at?: string };

export function OperatorSearch({ canCommand = false }: { canCommand?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/search?q=${encodeURIComponent(query.trim())}`);
      const data = await response.json() as { results?: SearchResult[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Search failed");
      setResults(data.results ?? []);
    } catch (error) {
      setResults([]);
      setMessage(error instanceof Error ? error.message : "Search failed");
    }
  }
  return <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Global investigation search</h2><p className="mt-1 text-xs text-muted-foreground">Search organization, agent, installation, run, memory, approval, effect, delivery, audit, and correlation identifiers without exposing payloads.</p></div><form className="flex gap-2 p-5" onSubmit={submit}><label htmlFor="operator-search" className="sr-only">Search platform records</label><input id="operator-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ID, organization, capability, or correlation ID" className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm" /><button type="submit" className="h-9 rounded-md border border-border px-3 text-sm font-medium text-foreground">Search</button></form>{message ? <p className="px-5 pb-4 text-xs text-destructive">{message}</p> : null}{results.length ? <div className="divide-y divide-border border-t border-border">{results.map((result) => <div key={`${result.kind}-${result.id}`} className="flex items-center justify-between gap-3 px-5 py-3"><div><p className="font-mono text-xs text-foreground">{result.id}</p><p className="text-xs text-muted-foreground">{result.kind} · {result.resource_type ?? "record"} · {result.organization_id ?? "platform"}</p></div><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{result.state ?? "—"}</span>{canCommand && result.kind === "memory" && result.state === "active" ? <OperatorDeleteMemoryButton memoryId={result.id} expectedOrganizationId={result.organization_id ?? undefined} /> : null}</div></div>)}</div> : null}</section>;
}
