import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams, useBlocker } from "react-router-dom";
import { toast } from "sonner";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, message, organizationPath, type Agent, type Configuration, type Deployment, type KnowledgeSource, type KnowledgeSources, type Version } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { useAgentDirectory } from "./agent-directory";
import { Chat } from "./chat";
import { SourceConfiguration } from "./source-configuration";

export function AgentEditor() {
  const { organizationId, session } = useWorkspace();
  const { agentId, conversationId } = useParams();
  const navigate = useNavigate();
  const { refresh, newChat, chatGeneration } = useAgentDirectory();
  const { confirm } = useConfirmationDialog();
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId ?? "")}`;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [name, setName] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeSource[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const section = searchParams.get("section") ?? "chat";
  const view = ["configuration", "publish"].includes(section) ? "configure" : section === "activity" ? "activity" : "chat";
  const setSection = (value: string) => setSearchParams(value === "chat" ? {} : { section: value }, { replace: true });
  const [origins, setOrigins] = useState("");
  const [error, setError] = useState("");
  const [pendingAdmission, setPendingAdmission] = useState(false);
  const [busy, setBusy] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  useEffect(() => { let live = true; Promise.all([api<{ agent: Agent; versions: Version[]; deployments: Deployment[] }>(path), api<KnowledgeSources>(`${organizationPath(organizationId)}/knowledge/sources`)]).then(([result, sources]) => { if (!live) return; setAgent(result.agent); setConfiguration(result.agent.draft); setName(result.agent.name); setVersions(result.versions); setDeployments(result.deployments); let recoveryVersion = "";
      try { const prefix = `agents.chat.${session.account.id}.${organizationId}.${agentId}.`; for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix) && !key.endsWith(".draft"))) { const value = JSON.parse(sessionStorage.getItem(key) ?? "null"); if (Array.isArray(value)) { const pending = value.find(entry => entry.requestKey && !entry.task); if (pending?.versionId) { recoveryVersion = pending.versionId; break; } } } } catch { /* Continue with server-backed history. */ }
      setSelectedVersion(result.versions.some(version => version.id === recoveryVersion) ? recoveryVersion : result.versions[0]?.id ?? ""); setKnowledge(sources.sources); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, organizationId, agentId, session.account.id]);
  const dirty = Boolean(agent && configuration && (name !== agent.name || JSON.stringify(configuration) !== JSON.stringify(agent.draft)));
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { if (blocker.state !== "blocked") return; let live = true; void confirm({ title: "Discard unsaved changes?", description: "Your configuration has not been saved.", confirmLabel: "Discard changes", variant: "destructive" }).then(discard => { if (live) { if (discard) blocker.proceed(); else blocker.reset(); } }); return () => { live = false; }; }, [blocker, confirm]);
  async function save(event: FormEvent) { event.preventDefault(); if (!agent || !configuration) return; setBusy(true); setError(""); try { const result = await api<{ agent: Agent }>(path, { name, configuration, expectedRevision: agent.draftRevision }, "PUT"); setAgent(result.agent); setConfiguration(result.agent.draft); refresh(); toast.success("Configuration saved"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function createVersion() { if (!agent) return; setBusy(true); setError(""); try { const { version } = await api<{ version: Version }>(`${path}/versions`, { expectedRevision: agent.draftRevision }); setVersions(current => [version, ...current]); setSelectedVersion(version.id); refresh(); toast.success("Version created"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const embedCode = (deployment: Deployment) => `<script async src="${window.location.origin}/api/website/${deployment.id}/widget.js"></script>`;
  async function copyEmbed(deployment: Deployment) { try { await navigator.clipboard.writeText(embedCode(deployment)); toast.success("Embed code copied"); } catch { toast.error("Copy the embed code manually"); } }
  async function publish(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const { deployment } = await api<{ deployment: Deployment }>(`${path}/deployments`, { versionId: selectedVersion, allowedOrigins: origins.split(/[\n,]/).map(origin => origin.trim()).filter(Boolean) }); setDeployments(current => [...current, deployment]); setPublishOpen(false); toast.success("Website published"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  if (!agent || !configuration) return <><ErrorMessage value={error} />{!error ? <Loading /> : null}</>;
  const selected = versions.find(version => version.id === selectedVersion);
  return <div className={`agent-editor agent-view-${view}`}><header className="agent-editor-header"><div className="flex min-w-0 items-center gap-3"><span className="agent-avatar"><Bot size={20} /></span><h1 className="truncate text-lg font-semibold">{agent.name}</h1></div><div className="flex items-center gap-2"><label className="sr-only" htmlFor="chat-version">Version</label><select id="chat-version" aria-label="Version" className="version-selector" value={selectedVersion} disabled={Boolean(conversationId) || pendingAdmission} onChange={event => { setSelectedVersion(event.target.value); newChat(); }}><option value="" disabled>No version</option>{versions.map(version => <option key={version.id} value={version.id}>Version {version.number}</option>)}</select><Button size="sm" variant="outline" onClick={newChat}><Plus size={15} />New chat</Button></div></header>
    <nav className="agent-tabs" aria-label="Agent sections">{[["chat", "Chat"], ["activity", "Activity"], ["configuration", "Configure"]].map(([id, label]) => <button type="button" key={id} onClick={() => setSection(id)} aria-current={(id === "configuration" ? view === "configure" : view === id) ? "page" : undefined} className={(id === "configuration" ? view === "configure" : view === id) ? "is-active" : ""}>{label}</button>)}</nav>
    <div className="agent-editor-body"><ErrorMessage value={error} />
    {view !== "configure" ? selected || conversationId ? <Chat endpoint={`${organizationPath(organizationId)}/tasks`} key={`${agent.id}.${selected?.id ?? "history"}.${conversationId ?? "new"}.${chatGeneration}`} storageKey={`agents.chat.${session.account.id}.${organizationId}.${agent.id}.${selected?.id ?? "history"}.${conversationId ?? "new"}`} versionId={selected?.id} versionNumber={selected?.number} initialConversationId={conversationId} expectedAgentId={agent.id} onPendingChanged={setPendingAdmission} onConversationReady={id => { refresh(); if (!conversationId) navigate(`/app/agents/${agent.id}/conversations/${id}`, { replace: true }); }} onPinnedVersion={id => { if (id !== selectedVersion) setSelectedVersion(id); }} view={view} cancellable /> : <section className="agent-welcome"><span className="agent-welcome-icon"><Bot size={30} /></span><h2>Ready when you are</h2><p>Create a version to start chatting.</p><Button onClick={() => void createVersion()} disabled={dirty || busy}>{busy ? "Creating…" : "Create version"}</Button>{dirty ? <Button variant="ghost" onClick={() => setSection("configuration")}>Save configuration</Button> : null}</section> : <>
    <nav className="configuration-tabs" aria-label="Configuration sections">{[["configuration", "General"], ["publish", "Website"]].map(([id, label]) => <button key={id} onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined}>{label}</button>)}</nav>
    {section === "configuration" ? <form className="max-w-2xl space-y-6" onSubmit={event => void save(event)}>
      <label className="block space-y-2 text-sm font-medium">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-2 text-sm font-medium">Instructions<Textarea required maxLength={8_000} rows={7} value={configuration.instructions} onChange={event => setConfiguration({ ...configuration, instructions: event.target.value })} /></label>
      <SourceConfiguration sources={knowledge} configuration={configuration} onChange={setConfiguration} />
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={(configuration.tools ?? []).includes("knowledge.search")} onChange={event => setConfiguration({ ...configuration, tools: event.target.checked ? [...new Set([...(configuration.tools ?? []), "knowledge.search" as const, "knowledge.read" as const])] : (configuration.tools ?? []).filter(tool => !tool.startsWith("knowledge.")) })} /><span>Search approved knowledge</span></label>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={(configuration.tools ?? []).includes("channel.request_handoff")} onChange={event => setConfiguration({ ...configuration, tools: event.target.checked ? [...new Set([...(configuration.tools ?? []), "channel.request_handoff" as const])] : (configuration.tools ?? []).filter(tool => tool !== "channel.request_handoff") })} /><span>Offer human support</span></label>
      <details className="rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Model and limits</summary><div className="mt-4 space-y-4"><p className="break-all text-xs text-muted-foreground">{configuration.model.model}</p><label className="block space-y-2">Maximum reply tokens<Input type="number" min={1} max={1024} required value={configuration.model.maxOutputTokens} onChange={event => setConfiguration({ ...configuration, model: { ...configuration.model, maxOutputTokens: Number(event.target.value) } })} /></label><p className="text-xs text-muted-foreground">{configuration.context?.maxInputTokens ?? 8192} context tokens · {configuration.model.maxDurationSeconds} seconds per model call</p></div></details>
      <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={!dirty || busy}>{busy ? "Saving…" : "Save configuration"}</Button><Button type="button" variant="outline" onClick={() => void createVersion()} disabled={dirty || busy}>Create version</Button></div>
    </form> : <div className="max-w-2xl space-y-5">      {dirty ? <p role="status" className="text-sm text-muted-foreground">Save your configuration to create a new version.</p> : null}
      <><Button disabled={!selected || busy} onClick={() => setPublishOpen(true)}>Publish website</Button>{deployments.length ? <div className="divide-y divide-border rounded-lg border border-border">{deployments.map(deployment => <div key={deployment.id} className="space-y-2 p-4"><p className="text-sm font-medium">Version {versions.find(version => version.id === deployment.versionId)?.number ?? ""}</p><p className="break-all text-xs text-muted-foreground">{deployment.allowedOrigins.join(", ")}</p><a href={`/chat/${deployment.id}`} target="_blank" rel="noreferrer" className="inline-block text-sm underline underline-offset-4">Open website chat</a><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Embed code</summary><code className="mt-3 block whitespace-pre-wrap break-all rounded-md bg-muted p-3">{embedCode(deployment)}</code><Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void copyEmbed(deployment)}>Copy embed code</Button></details></div>)}</div> : null}</>
    </div>}
    </>}
    </div>
    <Dialog open={publishOpen} onOpenChange={setPublishOpen}><DialogContent><DialogHeader><DialogTitle>Publish website</DialogTitle><DialogDescription>Version {selected?.number} will be available on the listed websites.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => void publish(event)}><ErrorMessage value={error} /><label className="block space-y-2 text-sm">Allowed website origins<Textarea rows={3} required placeholder="https://example.com" value={origins} onChange={event => setOrigins(event.target.value)} /></label><p className="text-xs text-muted-foreground">One HTTPS origin per line. Public knowledge only.</p><Button type="submit" disabled={busy || !origins.trim()}>{busy ? "Publishing…" : "Publish version"}</Button></form></DialogContent></Dialog>
  </div>;
}
