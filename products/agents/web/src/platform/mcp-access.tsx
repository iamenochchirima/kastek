import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError, message } from "./api";

type Connection = { id: string; client_name: string; revoked_at: string | null };

export function McpAccess({ organizationId }: { organizationId: string }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/api/organizations/${encodeURIComponent(organizationId)}/mcp/oauth/connections`;

  useEffect(() => {
    const controller = new AbortController();
    void api<{ connections: Connection[] }>(path, undefined, "GET", undefined, controller.signal)
      .then(result => setConnections(result.connections.filter(item => !item.revoked_at)))
      .catch(reason => { if (controller.signal.aborted) return; if (reason instanceof ApiError && reason.status === 404) setUnavailable(true); else setError(message(reason)); });
    return () => controller.abort();
  }, [path]);

  async function disconnect() {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      await api(`${path}/${encodeURIComponent(selected.id)}`, undefined, "DELETE");
      setConnections(current => current?.filter(item => item.id !== selected.id) ?? []);
      setSelected(null); toast.success("Access removed");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  if (unavailable) return null;
  return <section className="settings-group" aria-labelledby="mcp-access-heading">
    <h2 id="mcp-access-heading" className="settings-heading">Connected assistants</h2>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!connections && !error && <p role="status" className="text-sm">Loading…</p>}
    {connections?.length === 0 && <p className="text-sm text-muted-foreground">No connected assistants</p>}
    {connections?.map(item => <div key={item.id} className="flex items-center justify-between gap-4 py-2"><span>{item.client_name}</span><Button size="sm" variant="outline" onClick={() => setSelected(item)}>Disconnect</Button></div>)}
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !busy) setSelected(null); }}><DialogContent><DialogHeader><DialogTitle>Disconnect {selected?.client_name}?</DialogTitle><DialogDescription>This assistant will lose access to this workspace.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setSelected(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect"}</Button></div></DialogContent></Dialog>
  </section>;
}
