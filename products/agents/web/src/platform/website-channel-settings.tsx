import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, message, organizationPath, type Deployment } from "./api";
import { ErrorMessage, Loading } from "./shell";
import { WebsiteAppearanceEditor } from "./website-appearance-editor";
import type { WebsiteAppearance as Appearance } from "./website-appearance-preview";
type Settings = { deploymentId: string; appearance: Appearance; appearanceDigest: string; paused: boolean; allowedOrigins: string[] };
export function WebsiteChannelSettings({ agentId, organizationId, owner, showConnect = true }: { agentId: string; organizationId: string; owner: boolean; showConnect?: boolean }) {
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}`;
  const [deployments, setDeployments] = useState<Deployment[] | null>(null), [selected, setSelected] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null), [origins, setOrigins] = useState("");
  const [savedPaused, setSavedPaused] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; setDeployments(null); setSelected(""); setSettings(null); setError("");
    api<{ deployments: Deployment[] }>(path).then(result => { if (live) { setDeployments(result.deployments); setSelected(result.deployments[0]?.id ?? ""); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path]);
  useEffect(() => { let live = true; setSettings(null); if (selected) api<Settings>(`${path}/deployments/${encodeURIComponent(selected)}/appearance`).then(result => { if (live) { setSettings(result); setSavedPaused(result.paused); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [selected, path]);
  async function publish(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try {
    const result = await api<{ deployment: Deployment }>(`${path}/deployments`, { allowedOrigins: origins.split(/[\n,]/).map(value => value.trim()).filter(Boolean) });
    setDeployments(current => [result.deployment, ...current ?? []]); setSelected(result.deployment.id); setOrigins(""); toast.success("Website connected");
  } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function save(event: FormEvent) { event.preventDefault(); if (!settings) return; setBusy(true); setError(""); try {
    const result = await api<Settings>(`${path}/deployments/${encodeURIComponent(selected)}/appearance`, { appearance: settings.appearance, paused: settings.paused, expectedAppearanceDigest: settings.appearanceDigest }, "PUT");
    setSettings(result); setSavedPaused(result.paused); toast.success("Website settings saved");
  } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const appearance = settings?.appearance;
  async function saveAppearance(appearance: Appearance) {
    if (!settings) return;
    const result = await api<Settings>(`${path}/deployments/${encodeURIComponent(selected)}/appearance`, { appearance, paused: savedPaused, expectedAppearanceDigest: settings.appearanceDigest }, "PUT");
    setSettings(result); setSavedPaused(result.paused); toast.success("Widget appearance saved");
  }
  const embed = selected ? `<script async src="${window.location.origin}/api/website/${selected}/widget.js"></script>` : "";
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); toast.success("Copied"); } catch { toast.error("Select and copy the text"); } }
  return <div className="min-w-0 space-y-5"><ErrorMessage value={error} />{deployments === null && !error ? <Loading /> : null}
    {owner && showConnect ? <form onSubmit={publish} className="space-y-3"><label className="block space-y-2 text-sm"><span>Website domains</span><Textarea required value={origins} onChange={event => setOrigins(event.target.value)} placeholder="example.com" rows={2} disabled={busy} /></label><p className="text-xs text-muted-foreground">One domain per line.</p><Button type="submit" disabled={busy || !origins.trim()}>Connect website</Button></form> : null}
    {deployments?.length ? <label className="block space-y-2 text-sm"><span>Website</span><select className="w-full rounded-md border border-border bg-background p-2" value={selected} onChange={event => setSelected(event.target.value)} disabled={busy}>{deployments.map(deployment => <option value={deployment.id} key={deployment.id}>{deployment.allowedOrigins.join(", ")}</option>)}</select></label> : null}
    {settings && appearance ? <><div className="flex flex-wrap items-center gap-3"><span className="text-sm">{savedPaused ? "Paused" : "Active"}</span><a className="text-sm underline underline-offset-4" href={`/chat/${selected}`} target="_blank" rel="noreferrer">Open chat</a><Button type="button" size="sm" variant="outline" onClick={() => void copy(`${window.location.origin}/chat/${selected}`)}>Copy share link</Button></div>
      <details className="text-sm" open><summary className="cursor-pointer font-medium">Install widget</summary><code className="my-3 block whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{embed}</code><Button type="button" size="sm" variant="outline" onClick={() => void copy(embed)}>Copy embed code</Button><p className="mt-2 text-xs text-muted-foreground">Add before the closing body tag on an allowed website. Shared chat also requires an allowed origin.</p></details>
      <WebsiteAppearanceEditor key={selected} appearance={appearance} owner={owner} onSave={saveAppearance} />
      <form onSubmit={save} className="space-y-4">
      {owner ? <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.paused} disabled={busy} onChange={event => setSettings({ ...settings, paused: event.target.checked })} />Pause website chat</label><Button type="submit" disabled={busy}>Save settings</Button></> : null}</form><p className="text-xs text-muted-foreground">Text chat and booking confirmations. File uploads and audio are unavailable.</p>
    </> : null}</div>;
}
