import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, message, organizationPath, type Agent, type Configuration, type Deployment, type Knowledge, type Version } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { Chat } from "./chat";

const selectClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
export function AgentsList() {
  const { organizationId } = useWorkspace();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `${organizationPath(organizationId)}/agents`;
  useEffect(() => { let live = true; api<{ agents: Agent[] }>(path).then(result => { if (live) setAgents(result.agents); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path]);
  async function create(event: FormEvent) { event.preventDefault(); setBusy(true); try { const { agent } = await api<{ agent: Agent }>(path, { name }); setOpen(false); navigate(`/app/agents/${agent.id}`); toast.success("Agent created"); } catch (e) { toast.error(message(e)); } finally { setBusy(false); } }
  return <div className="space-y-6"><div className="flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold tracking-tight">Agents</h1><Button onClick={() => setOpen(true)}><Plus className="size-4" />Create agent</Button></div><ErrorMessage value={error} />
    {!agents && !error ? <Loading /> : agents?.length ? <div className="divide-y divide-border rounded-lg border border-border bg-card">{agents.map(agent => <Link key={agent.id} to={`/app/agents/${agent.id}`} className="flex items-center justify-between gap-4 p-5 transition-colors hover:bg-accent"><span className="min-w-0 break-words font-medium">{agent.name}</span><span className="shrink-0 text-xs text-muted-foreground">Open →</span></Link>)}</div> : !error ? <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No agents yet</div> : null}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Create agent</DialogTitle><DialogDescription>Give your support assistant a name.</DialogDescription></DialogHeader><form onSubmit={event => void create(event)} className="space-y-4"><label className="block space-y-2 text-sm">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create agent"}</Button></form></DialogContent></Dialog>
  </div>;
}
export function AgentEditor() {
  const { organizationId, session } = useWorkspace();
  const { agentId } = useParams();
  const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId ?? "")}`;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [name, setName] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const section = ["test", "publish"].includes(searchParams.get("section") ?? "") ? searchParams.get("section")! : "configuration";
  const setSection = (value: string) => setSearchParams(value === "configuration" ? {} : { section: value }, { replace: true });
  const [origins, setOrigins] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  useEffect(() => { let live = true; Promise.all([api<{ agent: Agent; versions: Version[]; deployments: Deployment[] }>(path), api<{ knowledge: Knowledge[] }>(`${organizationPath(organizationId)}/knowledge`)]).then(([result, sources]) => { if (!live) return; setAgent(result.agent); setConfiguration(result.agent.draft); setName(result.agent.name); setVersions(result.versions); setDeployments(result.deployments); setSelectedVersion(result.versions[0]?.id ?? ""); setKnowledge(sources.knowledge); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, organizationId]);
  const dirty = Boolean(agent && configuration && (name !== agent.name || JSON.stringify(configuration) !== JSON.stringify(agent.draft)));
  async function save(event: FormEvent) { event.preventDefault(); if (!agent || !configuration) return; setBusy(true); setError(""); try { const result = await api<{ agent: Agent }>(path, { name, configuration, expectedRevision: agent.draftRevision }, "PUT"); setAgent(result.agent); setConfiguration(result.agent.draft); toast.success("Configuration saved"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function createVersion() { if (!agent) return; setBusy(true); setError(""); try { const { version } = await api<{ version: Version }>(`${path}/versions`, { expectedRevision: agent.draftRevision }); setVersions(current => [version, ...current]); setSelectedVersion(version.id); toast.success("Version created"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const embedCode = (deployment: Deployment) => `<script async src="${window.location.origin}/api/website/${deployment.id}/widget.js"></script>`;
  async function copyEmbed(deployment: Deployment) { try { await navigator.clipboard.writeText(embedCode(deployment)); toast.success("Embed code copied"); } catch { toast.error("Copy the embed code manually"); } }
  async function publish(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const { deployment } = await api<{ deployment: Deployment }>(`${path}/deployments`, { versionId: selectedVersion, allowedOrigins: origins.split(/[\n,]/).map(origin => origin.trim()).filter(Boolean) }); setDeployments(current => [...current, deployment]); setPublishOpen(false); toast.success("Website published"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  if (!agent || !configuration) return <><ErrorMessage value={error} />{!error ? <Loading /> : null}</>;
  const selected = versions.find(version => version.id === selectedVersion);
  return <div className="space-y-6"><Link to="/app/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Agents</Link><h1 className="break-words text-2xl font-semibold tracking-tight">{agent.name}</h1>
    <nav className="flex gap-5 overflow-x-auto border-b border-border" aria-label="Agent sections">{[["configuration", "Configuration"], ["test", "Test"], ["publish", "Publish"]].map(([id, label]) => <button type="button" key={id} onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined} className={`border-b-2 pb-3 text-sm ${section === id ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}>{label}</button>)}</nav>
    <ErrorMessage value={error} />
    {section === "configuration" ? <form className="max-w-2xl space-y-6" onSubmit={event => void save(event)}>
      <label className="block space-y-2 text-sm font-medium">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-2 text-sm font-medium">Instructions<Textarea required maxLength={2_000} rows={7} value={configuration.instructions} onChange={event => setConfiguration({ ...configuration, instructions: event.target.value })} /></label>
      <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">Knowledge</legend>{!knowledge.length ? <p className="text-sm text-muted-foreground">No sources yet. <Link className="underline underline-offset-4" to="/app/knowledge">Add knowledge</Link></p> : knowledge.map(source => <label key={source.id} className="flex items-start gap-3 text-sm"><input type="checkbox" checked={configuration.knowledgeIds.includes(source.id)} onChange={event => setConfiguration({ ...configuration, knowledgeIds: event.target.checked ? [...configuration.knowledgeIds, source.id] : configuration.knowledgeIds.filter(id => id !== source.id) })} className="mt-0.5 size-4 accent-primary" /><span>{source.title}<span className="ml-2 text-xs text-muted-foreground">{source.visibility}</span></span></label>)}</fieldset>
      <details className="rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Model and limits</summary><div className="mt-4 space-y-4"><p className="break-all text-xs text-muted-foreground">{configuration.model.model}</p><label className="block space-y-2">Maximum reply tokens<Input type="number" min={1} max={1024} required value={configuration.model.maxOutputTokens} onChange={event => setConfiguration({ ...configuration, model: { ...configuration.model, maxOutputTokens: Number(event.target.value) } })} /></label><p className="text-xs text-muted-foreground">16 KiB input · 120 seconds maximum</p></div></details>
      <Button type="submit" disabled={!dirty || busy}>{busy ? "Saving…" : "Save configuration"}</Button>
    </form> : <div className="max-w-2xl space-y-5"><div className="flex flex-wrap items-end gap-3"><label className="min-w-40 flex-1 space-y-2 text-sm font-medium">Version<select aria-label="Version" className={selectClass} value={selectedVersion} onChange={event => setSelectedVersion(event.target.value)}><option value="" disabled>Select version</option>{versions.map(version => <option key={version.id} value={version.id}>Version {version.number}</option>)}</select></label>{section === "test" ? <Button variant="outline" onClick={() => void createVersion()} disabled={dirty || busy}>{busy ? "Creating…" : "Create test version"}</Button> : null}</div>
      {dirty ? <p role="status" className="text-sm text-muted-foreground">Save your configuration to create a new test version.</p> : null}
      {section === "test" && selected ? <Chat endpoint={`${organizationPath(organizationId)}/tasks`} storageKey={`agents.test.${session.account.id}.${organizationId}.${agent.id}`} versionId={selected.id} versionNumber={selected.number} cancellable /> : section === "test" ? <p className="text-sm text-muted-foreground">Create a version to test this agent.</p> : <><Button disabled={!selected || busy} onClick={() => setPublishOpen(true)}>Publish website</Button>{deployments.length ? <div className="divide-y divide-border rounded-lg border border-border">{deployments.map(deployment => <div key={deployment.id} className="space-y-2 p-4"><p className="text-sm font-medium">Version {versions.find(version => version.id === deployment.versionId)?.number ?? ""}</p><p className="break-all text-xs text-muted-foreground">{deployment.allowedOrigins.join(", ")}</p><a href={`/chat/${deployment.id}`} target="_blank" rel="noreferrer" className="inline-block text-sm underline underline-offset-4">Open website chat</a><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Embed code</summary><code className="mt-3 block whitespace-pre-wrap break-all rounded-md bg-muted p-3">{embedCode(deployment)}</code><Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void copyEmbed(deployment)}>Copy embed code</Button></details></div>)}</div> : null}</>}
    </div>}
    <Dialog open={publishOpen} onOpenChange={setPublishOpen}><DialogContent><DialogHeader><DialogTitle>Publish website</DialogTitle><DialogDescription>Version {selected?.number} will be available on the listed websites.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => void publish(event)}><ErrorMessage value={error} /><label className="block space-y-2 text-sm">Allowed website origins<Textarea rows={3} required placeholder="https://example.com" value={origins} onChange={event => setOrigins(event.target.value)} /></label><p className="text-xs text-muted-foreground">One HTTPS origin per line. Public knowledge only.</p><Button type="submit" disabled={busy || !origins.trim()}>{busy ? "Publishing…" : "Publish version"}</Button></form></DialogContent></Dialog>
  </div>;
}
