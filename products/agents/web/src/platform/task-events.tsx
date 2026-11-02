import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiError, message, type TaskEvent } from "./api";
import { ErrorMessage } from "./shell";

export function TaskEvents({ endpoint, initial, initialCursor, onUnavailable, token }: { endpoint: string; token?: string; initial: TaskEvent[]; initialCursor: string | null; onUnavailable: (cause: unknown) => void }) {
  const [loaded, setLoaded] = useState<{ events: TaskEvent[]; nextCursor: string | null } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const events = [...new Map([...initial, ...(loaded?.events ?? [])].map(item => [String(item.sequence), item])).values()].sort((a,b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0);
  const cursor = loaded ? loaded.nextCursor : initialCursor;
  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ events: TaskEvent[]; nextCursor: string | null }>(`${endpoint}/events?limit=30&cursor=${encodeURIComponent(cursor)}`, undefined, "GET", token);
      if (live.current) setLoaded(current => ({ events: [...(current?.events ?? []), ...result.events], nextCursor: result.nextCursor }));
    } catch (cause) {
      if (live.current) { setError(message(cause)); if (cause instanceof ApiError && [401,403,404].includes(cause.status)) onUnavailable(cause); }
    } finally { if (live.current) setBusy(false); }
  }
  if (!events.length && !cursor) return null;
  return <details className="border-t border-border pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Event history</summary><ol className="mt-3 divide-y divide-border">{events.map(event => <li key={event.sequence} className="flex flex-wrap justify-between gap-2 py-2"><span>{event.kind.replaceAll(".", " ").replaceAll("_", " ")}</span>{event.createdAt ? <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time> : null}</li>)}</ol><ErrorMessage value={error} />{cursor ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadMore()}>{busy ? "Loading…" : "Load more events"}</Button> : null}</details>;
}
