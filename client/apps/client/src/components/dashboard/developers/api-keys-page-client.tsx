"use client";

import { useMemo, useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import type { CreatedDeveloperApiKey, DeveloperApiKey } from "@/lib/developers";
import { createDeveloperApiKey, revokeDeveloperApiKey, rotateDeveloperApiKey } from "@/lib/developers";
import { useDevelopersData } from "./developers-data";

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function statusLabel(status: string) {
  if (status === "ACTIVE") return "Active";
  if (status === "EXPIRED") return "Expired";
  return "Revoked";
}

export function ApiKeysPageClient() {
  const { apiKeys: initialKeys, config } = useDevelopersData();
  const [keys, setKeys] = useState(initialKeys);
  const [keyName, setKeyName] = useState("");
  const [newCredential, setNewCredential] = useState<CreatedDeveloperApiKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { confirm } = useConfirmationDialog();
  const activeKeys = useMemo(() => keys.filter((key) => key.status === "ACTIVE"), [keys]);

  async function createKey() {
    if (!keyName.trim() || busy) return;
    setBusy("create");
    setError("");
    try {
      const created = await createDeveloperApiKey(keyName.trim());
      setKeys((current) => [created.key, ...current]);
      setNewCredential(created);
      setKeyName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create API key");
    } finally {
      setBusy(null);
    }
  }

  async function rotateKey(key: DeveloperApiKey) {
    if (busy) return;
    setBusy(`rotate:${key.id}`);
    setError("");
    try {
      const created = await rotateDeveloperApiKey(key.id);
      setKeys((current) => [created.key, ...current.map((item) => item.id === key.id ? { ...item, status: "REVOKED", revokedAt: new Date().toISOString() } : item)]);
      setNewCredential(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rotate API key");
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(key: DeveloperApiKey) {
    if (busy || !await confirm({ title: `Revoke ${key.name}?`, description: "Existing requests using it will stop working.", confirmLabel: "Revoke", variant: "destructive" })) return;
    setBusy(`revoke:${key.id}`);
    setError("");
    try {
      await revokeDeveloperApiKey(key.id);
      setKeys((current) => current.map((item) => item.id === key.id ? { ...item, status: "REVOKED", revokedAt: new Date().toISOString() } : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke API key");
    } finally {
      setBusy(null);
    }
  }

  const restExample = `curl ${config.restBaseUrl}/capabilities \\
  -H "Authorization: Bearer <developer-api-key>"`;

  return (
    <div className="p-5 lg:p-8">
      <div className="mx-auto max-w-[1080px] space-y-7">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">API Keys</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Create a Developer API key</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Use one workspace key for REST, MCP, scripts, and local AI clients. Keys are scoped to this workspace and the secret is shown only once.</p>
        </header>

        {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}

        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-start gap-3"><KeyRound className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-base font-semibold">Create an API key</h2><p className="mt-1 text-sm text-muted-foreground">The default test profile includes `api:read` and `api:write`. It does not grant secrets, billing mutations, roles, or workspace deletion.</p></div></div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><Input value={keyName} onChange={(event) => setKeyName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createKey(); }} placeholder="Key name, for example Local development" maxLength={80} /><Button type="button" onClick={() => void createKey()} disabled={!keyName.trim() || busy === "create"}>{busy === "create" ? "Creating…" : "Create API key"}</Button></div>
          </CardContent>
        </Card>

        {newCredential ? <div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-5" role="alert"><p className="flex items-center gap-2 text-sm font-semibold text-status-attention"><Check className="h-4 w-4" />Copy this API key now</p><p className="mt-1 text-xs text-muted-foreground">This is the only time the complete secret will be shown.</p><div className="mt-3 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 text-xs text-foreground">{newCredential.secret}</code><Button type="button" variant="outline" size="sm" onClick={() => copy(newCredential.secret)}><Copy className="mr-2 h-3.5 w-3.5" />Copy</Button></div><Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setNewCredential(null)}>Dismiss</Button></div> : null}

        <Card>
          <CardContent className="space-y-4 p-5">
            <div><h2 className="text-base font-semibold">Use the key</h2><p className="mt-1 text-sm text-muted-foreground">Use this same workspace key as a Bearer credential for REST and MCP.</p></div>
            <div className="rounded-lg border border-border bg-secondary/30 p-4"><p className="text-xs text-muted-foreground">REST base URL</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 text-xs text-foreground">{config.restBaseUrl}</code><Button type="button" variant="outline" size="icon-sm" onClick={() => copy(config.restBaseUrl)} aria-label="Copy REST base URL"><Copy className="h-3.5 w-3.5" /></Button></div><pre className="mt-3 overflow-x-auto rounded-md bg-background p-3 text-xs text-muted-foreground">{restExample}</pre></div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-0"><div className="flex items-center justify-between gap-3 px-5 pt-5"><div><h2 className="text-base font-semibold">Your API keys</h2><p className="mt-1 text-sm text-muted-foreground">Rotate a key if it may have been exposed. Revocation takes effect immediately.</p></div><Badge variant="outline">{activeKeys.length} active</Badge></div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-y border-border bg-secondary/30 text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Name</th><th className="px-5 py-3 font-medium">Key</th><th className="px-5 py-3 font-medium">Scopes</th><th className="px-5 py-3 font-medium">Last used</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3" /></tr></thead><tbody>{keys.map((key) => <tr key={key.id} className="border-b border-border last:border-0"><td className="px-5 py-3 font-medium">{key.name}</td><td className="px-5 py-3 font-mono text-xs text-muted-foreground">{key.prefix}••••••••</td><td className="px-5 py-3 text-xs text-muted-foreground">{key.scopes.join(", ")}</td><td className="px-5 py-3 text-xs text-muted-foreground">{formatDate(key.lastUsedAt)}</td><td className="px-5 py-3"><Badge variant="outline" className={key.status === "ACTIVE" ? "border-emerald-500/30 text-emerald-500" : "text-muted-foreground"}>{statusLabel(key.status)}</Badge></td><td className="px-5 py-3"><div className="flex justify-end gap-2">{key.status === "ACTIVE" ? <><Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void rotateKey(key)}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Rotate</Button><Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void revokeKey(key)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Revoke</Button></> : null}</div></td></tr>)}</tbody></table>{!keys.length ? <div className="p-8 text-center text-sm text-muted-foreground">No developer API keys yet. Create one above to get started.</div> : null}</div></CardContent>
        </Card>
      </div>
    </div>
  );
}
