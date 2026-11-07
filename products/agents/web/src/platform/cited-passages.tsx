import "./management.css";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { citationNumbers } from "@kasitek-labs/ui/agent";
import { api, ApiError, message, type CitedPassage, type TaskEvidence } from "./api";

export function CitedPassages({ passages, sourceText }: { passages: CitedPassage[]; sourceText?: string }) {
  if (!passages.length) return null;
  const numbers = sourceText ? citationNumbers(sourceText) : new Map(passages.map((passage, index) => [passage.label, index + 1] as const));
  return <section aria-label="Cited sources" className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Sources</h3>{passages.map(passage => <details key={passage.id} className="source-passage text-sm"><summary className="cursor-pointer break-words"><span className="font-medium">{passage.title}</span>{passage.page !== null ? <span> · Page {passage.page}</span> : null}{passage.section ? <span> · {passage.section}</span> : null}</summary><div className="mt-3 space-y-2"><p className="text-xs text-muted-foreground">Retrieved {new Date(passage.acquiredAt).toLocaleString()}</p><blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 leading-6">{passage.text}</blockquote><code className="block break-all text-xs text-muted-foreground">[{numbers.get(passage.label) ?? 0}]</code></div></details>)}</section>;
}

export function TaskSources({ endpoint, token, output, onUnavailable }: { endpoint: string; token?: string; output: string | null; onUnavailable?: (cause?: unknown) => void }) {
  const [result, setResult] = useState<TaskEvidence | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!output || !/\[E(?:[a-f0-9]{32}|[0-9]+)\]/.test(output)) return null;
  async function refresh() {
    setBusy(true); setError(""); setResult(null);
    try { const value = await api<TaskEvidence>(`${endpoint}/evidence`, undefined, "GET", token); setResult(value); if (value.state === "unavailable") onUnavailable?.(); }
    catch (e) { setError(message(e)); if (e instanceof ApiError && [401,403,404].includes(e.status)) onUnavailable?.(e); } finally { setBusy(false); }
  }
  return <details className="space-y-3 text-primary" onToggle={event => { if (event.currentTarget.open && !result && !busy) void refresh(); }}><summary className="cursor-pointer text-sm">View sources</summary><div className="space-y-3 text-foreground">{busy ? <p className="text-sm text-muted-foreground">Loading sources…</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{result?.state === "unavailable" ? <p className="text-sm text-muted-foreground">These sources are no longer available.</p> : result ? <CitedPassages passages={result.passages} sourceText={output} /> : null}{result || error ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh sources</Button> : null}</div></details>;
}
