import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";

type Review = { id: string; sourceTitle: string; state: "pending" | "approved" | "cancelled" | "expired"; preview?: { revision:number; excerpt:string; truncated:boolean } | null; previewUnavailable?:boolean };

export function McpSourceReview() {
  const [parameters] = useSearchParams();
  const request = parameters.get("request");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!request) { setError("This request is unavailable."); return; }
    const controller = new AbortController();
    void fetch(`/api/mcp/source-reviews/${encodeURIComponent(request)}`, { credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
      if (!response.ok) throw new Error("This request is unavailable or has expired.");
      setReview(await response.json() as Review);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load request."); });
    return () => controller.abort();
  }, [request]);
  async function decide(approved: boolean) {
    if (!request || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/mcp/source-reviews/${encodeURIComponent(request)}/decision`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved }) });
      if (!response.ok) throw new Error("The request could not be completed. It may have expired or the source may have changed.");
      setReview(await response.json() as Review);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not complete request."); }
    finally { setBusy(false); }
  }
  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground"><section className="mx-auto max-w-lg space-y-6 rounded-xl border border-border bg-card p-6">
    <h1 className="text-xl font-semibold">Review knowledge change</h1>
    {!review && !error && <p role="status">Loading request…</p>}
    {review && <><p>Source: <strong>{review.sourceTitle}</strong></p><p>Approve this source revision for use.</p>
      {review.preview && <section aria-label="Source preview" className="space-y-2"><p className="text-sm font-medium">Revision {review.preview.revision}</p><div className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 text-sm">{review.preview.excerpt}</div>{review.preview.truncated && <p className="text-sm text-muted-foreground">Preview truncated. Inspect the full source before approval.</p>}</section>}
      {review.previewUnavailable && <p role="alert" className="text-sm text-destructive">Source preview unavailable.</p>}
      <Link className="text-sm underline" to="/app/knowledge">Inspect knowledge</Link>
      {review.state === "pending" ? <div className="flex gap-3"><Button disabled={busy || !review.preview} onClick={() => void decide(true)}>{busy ? "Processing…" : "Apply change"}</Button><Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Cancel</Button></div> : <p role="status">{review.state === "approved" ? "Change applied" : review.state === "cancelled" ? "Request cancelled" : "Request expired"}</p>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section></main>;
}
