import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, message, organizationPath, type Deployment } from "./api";
import { ErrorMessage, Loading } from "./shell";
import { WebsiteAppearanceEditor } from "./website-appearance-editor";
import { WebsiteAppearancePreview, type WebsiteAppearance as Appearance } from "./website-appearance-preview";
type Settings = { deploymentId: string; appearance: Appearance; appearanceDigest: string; paused: boolean; allowedOrigins: string[] };
type WidgetTab = "appearance" | "install" | "domains" | "settings";
const tabs: Array<[WidgetTab, string]> = [["appearance", "Appearance"], ["install", "Install"], ["domains", "Domains"], ["settings", "Settings"]];

export function WebsiteChannelSettings({ agentId, organizationId, owner, showConnect = true }: { agentId: string; organizationId: string; owner: boolean; showConnect?: boolean }) {
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}`;
  const [deployments, setDeployments] = useState<Deployment[] | null>(null), [selected, setSelected] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null), [origins, setOrigins] = useState("");
  const [savedPaused, setSavedPaused] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<WidgetTab>("appearance");
  useEffect(() => { let live = true; setDeployments(null); setSelected(""); setSettings(null); setOrigins(""); setError("");
    api<{ deployments: Deployment[]; agent?: { setup?: { business?: { website?: string } } | null } }>(path).then(result => { if (live) { setDeployments(result.deployments); setSelected(result.deployments[0]?.id ?? ""); if (!result.deployments.length && typeof result.agent?.setup?.business?.website === "string") setOrigins(result.agent.setup.business.website); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path]);
  useEffect(() => { let live = true; setSettings(null); if (selected) api<Settings>(`${path}/deployments/${encodeURIComponent(selected)}/appearance`).then(result => { if (live) { setSettings(result); setSavedPaused(result.paused); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [selected, path]);
  async function publish(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try {
    const result = await api<{ deployment: Deployment }>(`${path}/deployments`, { allowedOrigins: origins.split(/[\n,]/).map(value => value.trim()).filter(Boolean) });
    setDeployments(current => [result.deployment, ...current ?? []]); setSelected(result.deployment.id); setOrigins(""); setTab("appearance"); toast.success("Website connected");
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
  const shareLink = selected ? `${window.location.origin}/chat/${selected}` : "";
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); toast.success("Copied"); } catch { toast.error("Select and copy the text"); } }
  const domainForm = owner && showConnect ? <form onSubmit={publish} className="widget-domain-form">
    <label className="block space-y-2 text-sm font-medium">Website domains<Textarea required value={origins} onChange={event => setOrigins(event.target.value)} placeholder={"example.com\nwww.example.com"} rows={3} disabled={busy} /></label>
    <p className="text-xs text-muted-foreground">One origin per line. Each connection publishes the current version.</p>
    <Button type="submit" disabled={busy || !origins.trim()}>{busy ? "Connecting…" : "Connect website"}</Button>
  </form> : null;
  if (!deployments && !error) return <Loading />;
  if (!deployments?.length) return <section className="agent-config-panel widget-settings"><ErrorMessage value={error} />{domainForm ?? <p className="text-sm text-muted-foreground">No website widget connected.</p>}</section>;
  return <div className="widget-settings"><ErrorMessage value={error} />
    <div className="widget-toolbar">
      <label>Website<select aria-label="Website" value={selected} onChange={event => setSelected(event.target.value)} disabled={busy}>{deployments.map(deployment => <option value={deployment.id} key={deployment.id}>{deployment.allowedOrigins.join(", ")}</option>)}</select></label>
      <span className="widget-status" data-state={savedPaused ? "paused" : "active"}>{savedPaused ? "Paused" : "Active"}</span>
      <a className="widget-link" href={`/chat/${selected}`} target="_blank" rel="noreferrer">Open chat</a>
    </div>
    <nav className="agent-subtabs" aria-label="Widget sections">{tabs.map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}>{label}</button>)}</nav>
    {settings && appearance ? <>
      {tab === "appearance" ? <section className="agent-config-panel widget-panel" aria-label="Widget appearance">
        <div className="widget-appearance-grid">
          <div className="widget-appearance-copy"><h3>Appearance</h3><p className="widget-note">Theme, text, colour and layout for the website chat window.</p>
            <div className="widget-summary"><span className="widget-summary-swatch" style={{ backgroundColor: appearance.accent }} /><div><strong>{appearance.theme === "dark" ? "Dark" : "Light"} theme</strong><span>{appearance.position === "bottom-left" ? "Bottom left" : "Bottom right"} launcher</span></div></div>
            <div className="widget-facts"><span>{appearance.windowWidth} × {appearance.windowHeight}</span><span>{appearance.launcherSize}px launcher</span><span>{appearance.borderRadius}px corners</span><span>{appearance.accent}</span></div>
            <WebsiteAppearanceEditor key={selected} appearance={appearance} owner={owner} onSave={saveAppearance} />
          </div>
          <div className="widget-preview-frame"><WebsiteAppearancePreview appearance={appearance} /></div>
        </div>
      </section> : null}
      {tab === "install" ? <section className="agent-config-panel widget-panel" aria-label="Install widget">
        <h3>Install</h3><p>Add this line before the closing body tag on an allowed website.</p>
        <code className="widget-code">{embed}</code>
        <div className="widget-actions"><Button type="button" size="sm" variant="outline" onClick={() => void copy(embed)}>Copy embed code</Button><Button type="button" size="sm" variant="outline" onClick={() => void copy(shareLink)}>Copy share link</Button></div>
        <p className="widget-note">The widget only loads on an allowed origin. Shared chat links also check the origin.</p>
      </section> : null}
      {tab === "domains" ? <section className="agent-config-panel widget-panel" aria-label="Website domains">
        <h3>Domains</h3><p>Allowed origins for this widget.</p>
        <ul className="widget-domain-list">{(settings.allowedOrigins.length ? settings.allowedOrigins : ["No origins recorded"]).map(origin => <li key={origin}>{origin}</li>)}</ul>
        {domainForm ?? <p className="text-sm text-muted-foreground">Only workspace owners can connect a website.</p>}
      </section> : null}
      {tab === "settings" ? <section className="agent-config-panel widget-panel" aria-label="Widget settings">
        <h3>Settings</h3>
        <form onSubmit={save} className="widget-settings-form">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.paused} disabled={!owner || busy} onChange={event => setSettings({ ...settings, paused: event.target.checked })} />Pause website chat</label>
          <p className="widget-note">Pausing stops new visitors from starting a chat. Existing conversations stay available.</p>
          {owner ? <div className="widget-actions"><Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button></div> : null}
        </form>
        <p className="widget-note">Text chat and booking confirmations. File uploads and audio are unavailable.</p>
      </section> : null}
    </> : <Loading />}
  </div>;
}
