import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams, useBlocker } from "react-router-dom";
import { toast } from "sonner";
import { flushSync } from "react-dom";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, ApiError, message, organizationPath, type Agent, type Configuration, type Deployment, type KnowledgeSource, type KnowledgeSources, type Version } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { useAgentDirectory } from "./agent-directory";
import { Chat } from "./chat";
import { SourceConfiguration } from "./source-configuration";
import { AgentCatalogue } from "./catalogue";
import { AnalysisConfiguration } from "./analysis-configuration";
import { BookingPolicies } from "./booking-policies";

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
  const [searchParams, setSearchParams] = useSearchParams();
  const section = searchParams.get("section") ?? "chat";
  const view = ["configuration", "tools", "skills", "publish"].includes(section) ? "configure" : section === "activity" ? "activity" : "chat";
  const setSection = (value: string) => setSearchParams(value === "chat" ? {} : { section: value }, { replace: true });
  const [origins, setOrigins] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  useEffect(() => { let live = true; Promise.all([api<{ agent: Agent; versions: Version[]; deployments: Deployment[] }>(path), api<KnowledgeSources>(`${organizationPath(organizationId)}/knowledge/sources`)]).then(([result, sources]) => { if (!live) return; setAgent(result.agent); setConfiguration(result.agent.draft); setName(result.agent.name); setVersions(result.versions); setDeployments(result.deployments); setKnowledge(sources.sources); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, organizationId, agentId, session.account.id]);
  const latestDraft = useRef({ name, configuration }); latestDraft.current = { name, configuration };
  const dirty = Boolean(agent && configuration && (name !== agent.name || JSON.stringify(configuration) !== JSON.stringify(agent.draft)));
  const pendingSetup = Boolean(agent && (!versions[0] || JSON.stringify(agent.draft) !== JSON.stringify(versions[0].configuration)));
  const needsApply = dirty || pendingSetup;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { if (blocker.state !== "blocked") return; let live = true; void confirm({ title: "Discard unsaved changes?", description: "Your configuration has not been saved.", confirmLabel: "Discard changes", variant: "destructive" }).then(discard => { if (live) { if (discard) blocker.proceed(); else blocker.reset(); } }); return () => { live = false; }; }, [blocker, confirm]);
  async function applyConfiguration(configuration: Configuration, name: string) {
    if (!agent) return;
    const payload = { name, configuration, expectedRevision: agent.draftRevision };
    type Saved = { agent: Agent; snapshot: Version; deployments: Deployment[] };
    let result: Saved;
    try { result = await api<Saved>(`${path}/configuration`, payload); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "CONFIGURATION_CONFIRMATION_REQUIRED") throw error;
      const approved = await confirm({ title: "Apply changes?", description: "These changes expand agent permissions or update connected customer channels. New messages will use the saved configuration. In-progress work keeps its original settings.", confirmLabel: "Apply changes" });
      if (!approved) return;
      result = await api<Saved>(`${path}/configuration`, { ...payload, confirmImpact: true });
    }
    setAgent(result.agent);
    const unchanged = JSON.stringify(latestDraft.current) === JSON.stringify({ name, configuration });
    if (unchanged) { setName(result.agent.name); setConfiguration(result.agent.draft); }
    setVersions(current => [result.snapshot, ...current.filter(item => item.id !== result.snapshot.id)]);
    setDeployments(result.deployments); refresh(); toast.success(unchanged ? "Changes saved" : "Changes saved. Newer edits remain unsaved.");
  }
  async function save(event: FormEvent) { event.preventDefault(); if (event.target !== event.currentTarget) return; if (!agent || !configuration) return; setBusy(true); setError(""); try { await applyConfiguration(configuration, name); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function beforeConnect() {
    if (!agent || !configuration || busy) return false;
    if (!dirty) return true;
    const snapshot = JSON.stringify({ name, configuration }); setBusy(true); setError("");
    try {
      const result = await api<{ agent: Agent }>(path, { name, configuration, expectedRevision: agent.draftRevision }, "PUT");
      if (JSON.stringify(latestDraft.current) !== snapshot) {
        setAgent(result.agent); refresh(); throw new Error("You have more unsaved changes. Connect again to save them.");
      }
      flushSync(() => { setAgent(result.agent); setName(result.agent.name); setConfiguration(result.agent.draft); }); refresh();
      return true;
    } finally { setBusy(false); }
  }
  const embedCode = (deployment: Deployment) => `<script async src="${window.location.origin}/api/website/${deployment.id}/widget.js"></script>`;
  async function copyEmbed(deployment: Deployment) { try { await navigator.clipboard.writeText(embedCode(deployment)); toast.success("Embed code copied"); } catch { toast.error("Copy the embed code manually"); } }
  async function publish(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const { deployment } = await api<{ deployment: Deployment }>(`${path}/deployments`, { allowedOrigins: origins.split(/[\n,]/).map(origin => origin.trim()).filter(Boolean) }); setDeployments(current => [...current, deployment]); setPublishOpen(false); toast.success("Website published"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  if (!agent || !configuration) return <><ErrorMessage value={error} />{!error ? <Loading /> : null}</>;
  return <div className={`agent-editor agent-view-${view}`}><header className="agent-editor-header"><div className="flex min-w-0 items-center gap-3"><span className="agent-avatar"><Bot size={20} /></span><h1 className="truncate text-lg font-semibold">{agent.name}</h1></div><div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={newChat}><Plus size={15} />New chat</Button></div></header>
    <nav className="agent-tabs" aria-label="Agent sections">{[["chat", "Chat"], ["activity", "Activity"], ["configuration", "Configure"]].map(([id, label]) => <button type="button" key={id} onClick={() => setSection(id)} aria-current={(id === "configuration" ? view === "configure" : view === id) ? "page" : undefined} className={(id === "configuration" ? view === "configure" : view === id) ? "is-active" : ""}>{label}</button>)}</nav>
    <div className="agent-editor-body"><ErrorMessage value={error} />{view === "configure" && pendingSetup ? <p role="status" className="mb-4 text-sm text-muted-foreground">Save changes to apply the updated setup.</p> : null}
    {view !== "configure" ? <Chat endpoint={`${organizationPath(organizationId)}/tasks`} key={`${agent.id}.${conversationId ?? "new"}.${chatGeneration}`} storageKey={`agents.chat.${session.account.id}.${organizationId}.${agent.id}.${conversationId ?? "new"}`} agentId={agent.id} initialConversationId={conversationId} expectedAgentId={agent.id} onConversationReady={id => { refresh(); if (!conversationId) navigate(`/app/agents/${agent.id}/conversations/${id}`, { replace: true }); }} view={view} cancellable /> : <>
    <nav className="configuration-tabs" aria-label="Configuration sections">{[["configuration", "General"], ["tools", "Tools"], ["skills", "Skills"], ["publish", "Website"]].map(([id, label]) => <button key={id} onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined}>{label}</button>)}</nav>
    {searchParams.get("skill") && section !== "skills" ? <Button type="button" size="sm" variant="ghost" onClick={() => setSearchParams({ section: "skills", skill: searchParams.get("skill")! }, { replace: true })}>Back to skill</Button> : null}
    {section === "configuration" ? <form className="max-w-2xl space-y-6" onSubmit={event => void save(event)}>
      <label className="block space-y-2 text-sm font-medium">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-2 text-sm font-medium">Instructions<Textarea required maxLength={8_000} rows={7} value={configuration.instructions} onChange={event => setConfiguration({ ...configuration, instructions: event.target.value })} /></label>
      {agent.offering === "booking" || agent.offering === "customer-service" || configuration.capabilities.businessActions.enabled || searchParams.get("setup") === "booking" ? <BookingPolicies agentId={agent.id} configuration={configuration} onChange={setConfiguration} /> : null}
      {configuration.capabilities.sandbox.enabled || searchParams.get("setup") === "analysis" ? <AnalysisConfiguration configuration={configuration} onChange={setConfiguration} /> : null}
      <SourceConfiguration sources={knowledge} configuration={configuration} onChange={setConfiguration} />
      <details className="rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Model and limits</summary><div className="mt-4 space-y-4"><label className="block space-y-2">Model<select aria-label="Model" className="w-full rounded-md border bg-background p-2" value={configuration.model.model} onChange={event => setConfiguration({ ...configuration, model: { ...configuration.model, model: event.target.value as Configuration["model"]["model"] } })}><option value="nvidia/nemotron-3-super-120b-a12b">Nemotron 3 Super · Paid</option><option value="nvidia/nemotron-3-super-120b-a12b:free">Nemotron 3 Super · Free</option></select></label><label className="block space-y-2">Maximum reply tokens<Input type="number" min={1} max={1024} required value={configuration.model.maxOutputTokens} onChange={event => setConfiguration({ ...configuration, model: { ...configuration.model, maxOutputTokens: Number(event.target.value) } })} /></label><p className="text-xs text-muted-foreground">Input budget: {configuration.context?.maxInputTokens ?? 8192} serialized bytes · {configuration.model.maxDurationSeconds}-second call timeout</p></div></details>
      <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={!needsApply || busy}>{busy ? "Saving…" : "Save changes"}</Button></div>
      <details className="rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Configuration history</summary><div className="mt-3 space-y-3">{versions.map((snapshot, index) => <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2"><span>{snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : index === 0 ? "Current configuration" : "Previous configuration"}</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={async () => { if (dirty && !await confirm({ title: "Replace unsaved changes?", description: "Load this saved configuration into the editor. Apply it with Save changes.", confirmLabel: "Load configuration" })) return; setConfiguration(structuredClone(snapshot.configuration)); toast.success("Configuration loaded. Save changes to apply it."); }}>Load configuration</Button></div>)}</div></details>
    </form> : section === "tools" || section === "skills" ? <><AgentCatalogue key={`${agent.id}.${section}`} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} kind={section} configuration={configuration} onChange={setConfiguration} onBeforeConnect={beforeConnect} /><form className="catalogue-save" onSubmit={event => void save(event)}><Button type="submit" disabled={!needsApply || busy}>{busy ? "Saving…" : "Save changes"}</Button></form></> : <div className="max-w-2xl space-y-5">      {dirty ? <p role="status" className="text-sm text-muted-foreground">Save changes before connecting your website.</p> : null}
      <><Button disabled={needsApply || busy || !versions.length} onClick={() => setPublishOpen(true)}>Publish website</Button>{deployments.length ? <div className="divide-y divide-border rounded-lg border border-border">{deployments.map(deployment => <div key={deployment.id} className="space-y-2 p-4"><p className="break-all text-xs text-muted-foreground">{deployment.allowedOrigins.join(", ")}</p><a href={`/chat/${deployment.id}`} target="_blank" rel="noreferrer" className="inline-block text-sm underline underline-offset-4">Open website chat</a><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Embed code</summary><code className="mt-3 block whitespace-pre-wrap break-all rounded-md bg-muted p-3">{embedCode(deployment)}</code><Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void copyEmbed(deployment)}>Copy embed code</Button></details></div>)}</div> : null}</>
    </div>}
    </>}
    </div>
    <Dialog open={publishOpen} onOpenChange={setPublishOpen}><DialogContent><DialogHeader><DialogTitle>Publish website</DialogTitle><DialogDescription>Your agent will be available on the listed websites. Saved changes apply to new messages.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => void publish(event)}><ErrorMessage value={error} /><label className="block space-y-2 text-sm">Allowed website origins<Textarea rows={3} required placeholder="https://example.com" value={origins} onChange={event => setOrigins(event.target.value)} /></label><p className="text-xs text-muted-foreground">One HTTPS origin per line. Public knowledge only.</p><Button type="submit" disabled={busy || !origins.trim()}>{busy ? "Publishing…" : "Publish website"}</Button></form></DialogContent></Dialog>
  </div>;
}
