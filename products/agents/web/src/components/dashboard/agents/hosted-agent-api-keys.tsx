import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createHostedAgentApiKey, listHostedAgentApiKeys, revokeHostedAgentApiKey, type HostedAgentApiKey } from "@/lib/agent-platform";

export function HostedAgentApiKeys({ installationId }: { installationId: string }) {
  const [keys, setKeys] = useState<HostedAgentApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("90");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setSecret(null); setError(null);
    void listHostedAgentApiKeys(installationId).then(result => { if (!cancelled) setKeys(result.keys); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load API keys"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [installationId]);
  async function create() {
    const duration = Number(days);
    if (!label.trim() || !Number.isInteger(duration) || duration < 1 || duration > 365) {
      setError("Enter a label and an expiry between 1 and 365 days."); return;
    }
    setBusy(true); setError(null); setSecret(null);
    try {
      const result = await createHostedAgentApiKey(installationId, label.trim(), new Date(Date.now() + duration * 86400000).toISOString());
      setKeys(current => [result.key, ...current]); setSecret(result.secret); setLabel("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create API key"); }
    finally { setBusy(false); }
  }
  async function revoke(keyId: string) {
    setBusy(true); setError(null); setSecret(null);
    try {
      await revokeHostedAgentApiKey(installationId, keyId);
      setKeys(current => current.map(key => key.id === keyId ? { ...key, revoked_at: new Date().toISOString() } : key));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to revoke API key"); }
    finally { setBusy(false); }
  }
  const origin = typeof window === "undefined" ? "https://your-agents-domain" : window.location.origin;
  return <section className="space-y-4 rounded-xl border border-border bg-card p-5" aria-labelledby="hosted-api-keys-title">
    <div><h3 id="hosted-api-keys-title" className="font-semibold text-foreground">Agent API keys</h3>
      <p className="mt-1 text-sm text-muted-foreground">Call this agent from your server. A key can send messages, read conversations and runs, and cancel runs for this installation. Keep it out of website code.</p></div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-48 flex-1 text-sm">Key label<Input value={label} onChange={event => setLabel(event.target.value)} maxLength={160} placeholder="My website server" /></label>
      <label className="w-32 text-sm">Expires in days<Input type="number" min={1} max={365} value={days} onChange={event => setDays(event.target.value)} /></label>
      <Button type="button" disabled={busy || loading} onClick={() => void create()}>{busy ? "Updating…" : "Create API key"}</Button>
    </div>
    {error ? <p role="alert" className="text-sm text-status-danger">{error}</p> : null}
    {secret ? <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <p className="text-sm font-medium">Save this key now. It is shown only once.</p>
      <code className="block break-all select-all text-xs">{secret}</code>
      <Button type="button" size="sm" variant="outline" onClick={() => setSecret(null)}>I saved it. Hide key</Button>
    </div> : null}
    {loading ? <p className="text-sm text-muted-foreground">Loading keys…</p> : keys.length ? <ul className="divide-y divide-border">
      {keys.map(key => {
        const expired = Date.parse(key.expires_at) <= Date.now();
        return <li key={key.id} className="flex items-center justify-between gap-3 py-3">
          <div><p className="text-sm font-medium">{key.label}</p><p className="text-xs text-muted-foreground">{key.revoked_at ? "Revoked" : expired ? "Expired" : "Active"} · Expires {new Date(key.expires_at).toLocaleDateString()} · {key.last_used_at ? `Last used ${new Date(key.last_used_at).toLocaleString()}` : "Never used"}</p></div>
          {!key.revoked_at ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void revoke(key.id)}>Revoke</Button> : null}
        </li>;
      })}
    </ul> : <p className="text-sm text-muted-foreground">No API keys created yet.</p>}
    <details><summary className="cursor-pointer text-sm font-medium">Request example</summary>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-secondary/40 p-3 text-xs">{`curl '${origin}/api/v1/agent/messages' \\\n+  -H "Authorization: Bearer $AGENT_API_KEY" \\\n+  -H 'Content-Type: application/json' \\\n+  -d '{"message":"Hello","createNew":true,"idempotencyKey":"first-request-001"}'`}</pre>
      <p className="mt-2 text-sm text-muted-foreground">The response includes conversation.id and runId. Reuse conversationId for the next message and read /api/v1/agent/runs/RUN_ID for the answer. Use a new idempotency key for each message.</p>
    </details>
  </section>;
}
