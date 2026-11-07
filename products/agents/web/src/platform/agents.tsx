import "./agent-workspace.css";
import { CustomerRecordTools } from "./customer-record-tools";
import { TaskControlTools } from "./task-control-tools";
import { AgentSetupStatus } from "./agent-setup-status";
import { defaultSupportHours, normalizeSupportHours, SupportHoursFields, validSupportHours } from "./support-hours";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams, useBlocker } from "react-router-dom";
import { toast } from "sonner";
import { flushSync } from "react-dom";
import { PiPulse as Activity, PiChatCircle as MessageSquare, PiPlus as Plus, PiSlidersHorizontal as Settings2, PiUploadSimple as Upload } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { api, ApiError, message, organizationPath, type Agent, type Configuration, type KnowledgeSource, type KnowledgeSources, type Version } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { useAgentDirectory } from "./agent-directory";
import { Chat } from "./chat";
import { SpecialistConfiguration } from "./specialist-configuration";
import { SourceConfiguration } from "./source-configuration";
import { AgentProcedures } from "./agent-procedures";
import { AgentCatalogue } from "./catalogue";
import { AnalysisConfiguration } from "./analysis-configuration";
import { BookingPolicies } from "./booking-policies";
import { AgentModel, ChatModelPicker } from "./agent-model";
import { AgentChannels } from "./agent-channels";
import { WebsiteKnowledgeImport } from "./website-knowledge-import";
import { KnowledgeUpload } from "./knowledge-upload";
import { AgentMemory } from "./agent-memory";
import { AgentAvatar } from "./agent-avatar";

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
  const [knowledge, setKnowledge] = useState<KnowledgeSource[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const section = searchParams.get("section") === "publish" ? "channels" : searchParams.get("section") ?? "chat";
  const view = ["configuration", "tools", "skills", "publish", "channels"].includes(section) ? "configure" : section === "activity" ? "activity" : "chat";
  const setSection = (value: string) => setSearchParams(value === "chat" ? {} : { section: value }, { replace: true });
  useEffect(() => { if (searchParams.get("section") === "publish") setSearchParams({ section: "channels" }, { replace: true }); }, [searchParams, setSearchParams]);
  const [error, setError] = useState("");
  const [supportHoursError, setSupportHoursError] = useState("");
  const supportSection = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false), [deleteBusy, setDeleteBusy] = useState(false), [deleteError, setDeleteError] = useState("");
  const deleted = useRef(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false), [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false), [documentsBusy, setDocumentsBusy] = useState(false);
  async function refreshKnowledge() { const [current, sources] = await Promise.all([api<{ agent: Agent; versions: Version[] }>(path), api<KnowledgeSources>(`${organizationPath(organizationId)}/knowledge/sources`)]); setAgent(current.agent); setName(current.agent.name); setConfiguration(current.agent.draft); setVersions(current.versions); setKnowledge(sources.sources); refresh(); }
  useEffect(() => { let live = true; Promise.all([api<{ agent: Agent; versions: Version[] }>(path), api<KnowledgeSources>(`${organizationPath(organizationId)}/knowledge/sources`)]).then(([result, sources]) => { if (!live) return; setAgent(result.agent); setConfiguration(result.agent.draft); setName(result.agent.name); setVersions(result.versions); setKnowledge(sources.sources); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, organizationId, agentId, session.account.id]);
  const latestDraft = useRef({ name, configuration }); latestDraft.current = { name, configuration };
  const dirty = Boolean(agent && configuration && (name !== agent.name || JSON.stringify(configuration) !== JSON.stringify(agent.draft)));
  const pendingSetup = Boolean(agent && (!versions[0] || JSON.stringify(agent.draft) !== JSON.stringify(versions[0].configuration)));
  const needsApply = dirty || pendingSetup;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !deleted.current && dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { if (blocker.state !== "blocked") return; let live = true; void confirm({ title: "Discard unsaved changes?", description: "Your configuration has not been saved.", confirmLabel: "Discard changes", variant: "destructive" }).then(discard => { if (live) { if (discard) blocker.proceed(); else blocker.reset(); } }); return () => { live = false; }; }, [blocker, confirm]);
  async function applyConfiguration(configuration: Configuration, name: string, draftBefore = { name, configuration }, expectedRevision = agent?.draftRevision): Promise<boolean> {
    if (!agent) return false;
    if (!checkSupportHours(configuration)) return false;
    configuration = normalizedConfiguration(configuration);
    const payload = { name, configuration, expectedRevision };
    type Saved = { agent: Agent; snapshot: Version };
    let result: Saved;
    try { result = await api<Saved>(`${path}/configuration`, payload); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "CONFIGURATION_CONFIRMATION_REQUIRED") throw error;
      const approved = await confirm({ title: "Apply changes?", description: "These changes expand agent permissions or update connected customer channels. New messages will use the saved configuration. In-progress work keeps its original settings.", confirmLabel: "Apply changes" });
      if (!approved) return false;
      result = await api<Saved>(`${path}/configuration`, { ...payload, confirmImpact: true });
    }
    setAgent(result.agent);
    const unchanged = JSON.stringify(latestDraft.current) === JSON.stringify(draftBefore);
    if (unchanged) { setName(result.agent.name); setConfiguration(result.agent.draft); }
    setVersions(current => [result.snapshot, ...current.filter(item => item.id !== result.snapshot.id)]);
    refresh(); toast.success(unchanged ? "Changes saved" : "Changes saved. Newer edits remain unsaved.");
    return true;
  }
  function checkSupportHours(value: Configuration): boolean {
    if (!value.supportHours || validSupportHours(value.supportHours)) { setSupportHoursError(""); return true; }
    setSupportHoursError("Enter valid support days, hours and timezone.");
    setSection("configuration");
    requestAnimationFrame(() => {
      supportSection.current?.scrollIntoView({ block: "center" });
      supportSection.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
    });
    return false;
  }
  function normalizedConfiguration(value: Configuration): Configuration {
    return value.supportHours ? { ...value, supportHours: normalizeSupportHours(value.supportHours) } : value;
  }
  async function save(event: FormEvent) { event.preventDefault(); if (event.target !== event.currentTarget) return; if (!agent || !configuration) return; setBusy(true); setError(""); try { await applyConfiguration(configuration, name); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function changeChatModel(selection: NonNullable<Configuration["model"]["selection"]>) {
    if (!agent || busy || dirty) return false;
    const previous = { name: agent.name, configuration: agent.draft };
    setBusy(true);
    try {
      const { agent: current } = await api<{ agent: Agent }>(path);
      const next = { ...current.draft, model: { ...current.draft.model, selection } };
      return await applyConfiguration(next, current.name, previous, current.draftRevision);
    } finally { setBusy(false); }
  }
  async function beforeConnect() {
    if (!agent || !configuration || busy) return false;
    if (!dirty) return true;
    if (!checkSupportHours(configuration)) return false;
    const snapshot = JSON.stringify({ name, configuration }); setBusy(true); setError("");
    try {
      const result = await api<{ agent: Agent }>(path, { name, configuration: normalizedConfiguration(configuration), expectedRevision: agent.draftRevision }, "PUT");
      if (JSON.stringify(latestDraft.current) !== snapshot) {
        setAgent(result.agent); refresh(); throw new Error("You have more unsaved changes. Connect again to save them.");
      }
      flushSync(() => { setAgent(result.agent); setName(result.agent.name); setConfiguration(result.agent.draft); }); refresh();
      return true;
    } finally { setBusy(false); }
  }
  async function deleteAgent() {
    if (deleteBusy) return;
    setDeleteBusy(true); setDeleteError("");
    try {
      await api(path, undefined, "DELETE");
      deleted.current = true;
      refresh();
      toast.success("Agent deleted");
      navigate("/app/agents", { replace: true });
    } catch (e) { setDeleteError(message(e)); }
    finally { setDeleteBusy(false); }
  }
  if (!agent || !configuration) return <><ErrorMessage value={error} />{!error ? <Loading /> : null}</>;
  return <div className={`agent-editor agent-view-${view}`}><header className="agent-editor-header"><div className="flex min-w-0 items-center gap-3"><AgentAvatar id={agent.avatar} size={34} /><h1 className="truncate text-lg font-semibold">{agent.name}</h1></div><div className="flex shrink-0 items-center gap-2"><AgentMemory agentId={agent.id} enabled={agent.draft.memory?.enabled ?? false} />{section === "configuration" ? <Button type="submit" form="agent-general-form" disabled={!needsApply || busy}>{busy ? "Saving…" : "Save changes"}</Button> : <Button size="sm" variant="outline" onClick={newChat}><Plus size={15} />New chat</Button>}</div></header>
    <nav className="agent-tabs" aria-label="Agent sections">{([["chat", "Chat", MessageSquare], ["activity", "Activity", Activity], ["configuration", "Configure", Settings2]] as const).map(([id, label, Icon]) => <button type="button" key={id} onClick={() => setSection(id)} aria-current={(id === "configuration" ? view === "configure" : view === id) ? "page" : undefined} className={(id === "configuration" ? view === "configure" : view === id) ? "is-active" : ""}><Icon size={16} />{label}</button>)}</nav>
    <div className="agent-editor-body"><ErrorMessage value={error} />{view === "configure" && pendingSetup ? <p role="status" className="mb-4 text-sm text-muted-foreground">Save changes to apply the updated setup.</p> : null}
    {view !== "configure" ? <Chat endpoint={`${organizationPath(organizationId)}/tasks`} key={`${agent.id}.${conversationId ?? "new"}.${chatGeneration}`} storageKey={`agents.chat.${session.account.id}.${organizationId}.${agent.id}.${conversationId ?? "new"}`} agentId={agent.id} initialConversationId={conversationId} expectedAgentId={agent.id} onConversationReady={id => { refresh(); if (!conversationId) navigate(`/app/agents/${agent.id}/conversations/${id}`, { replace: true }); }} view={view} composerAccessory={view === "chat" ? <ChatModelPicker organizationId={organizationId} agentId={agent.id} configuration={agent.draft} dirty={dirty} saving={busy} onSelect={changeChatModel} /> : undefined} cancellable /> : <>
    <nav className="configuration-tabs" aria-label="Configuration sections">{[["configuration", "General"], ["tools", "Tools"], ["skills", "Skills"], ["channels", "Channels"]].map(([id, label]) => <button key={id} onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined}>{label}</button>)}</nav>
    {searchParams.get("skill") && section !== "skills" ? <Button type="button" size="sm" variant="ghost" onClick={() => setSearchParams({ section: "skills", skill: searchParams.get("skill")! }, { replace: true })}>Back to skill</Button> : null}
    {section === "configuration" ? <div className="agent-general-grid"><form id="agent-general-form" className="agent-general-form" onSubmit={event => void save(event)}>
      <section className="agent-config-panel agent-config-basic"><h2>Basic information</h2>
      <label className="block space-y-2 text-sm font-medium">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      {agent.setup && configuration.instructions.includes("The setup below is business context") ? <details className="agent-instructions-disclosure" onInvalid={event => { event.currentTarget.open = true; }}><summary>Instructions</summary><label className="agent-instructions block space-y-2 text-sm font-medium"><span className="sr-only">Instructions</span><Textarea required maxLength={8_000} rows={7} value={configuration.instructions} onChange={event => setConfiguration({ ...configuration, instructions: event.target.value })} /><span aria-hidden="true" className="agent-instructions-count">{configuration.instructions.length.toLocaleString()} / 8,000</span></label></details> : <label className="agent-instructions block space-y-2 text-sm font-medium">Instructions<Textarea required maxLength={8_000} rows={7} value={configuration.instructions} onChange={event => setConfiguration({ ...configuration, instructions: event.target.value })} /><span aria-hidden="true" className="agent-instructions-count">{configuration.instructions.length.toLocaleString()} / 8,000</span></label>}
      </section>
      {agent.setup?.responsibilities.includes("customer-support") || configuration.supportHours || configuration.tools?.some(tool => tool.startsWith("support.") || tool === "channel.request_handoff") ? <section className="agent-config-panel agent-config-support" aria-label="Human support" ref={supportSection}>
        <h2>Human support</h2>
        {configuration.supportHours ? <SupportHoursFields value={configuration.supportHours} onChange={supportHours => { setConfiguration({ ...configuration, supportHours }); setSupportHoursError(""); }} error={supportHoursError || undefined} /> : <Button type="button" size="sm" variant="outline" onClick={() => setConfiguration({ ...configuration, supportHours: agent.setup?.supportHours ?? defaultSupportHours() })}>Set support hours</Button>}
      </section> : null}
      <section className="agent-config-panel agent-config-knowledge">
      <SourceConfiguration sources={knowledge} configuration={configuration} onChange={setConfiguration} action={<div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={dirty || busy} onClick={() => setDocumentsOpen(true)}><Upload size={15} />Add documents</Button>{["faq", "customer-service"].includes(agent.offering ?? "") && (!agent.setup || agent.setup.responsibilities.some(value => ["answer-questions", "customer-support"].includes(value))) ? <Button type="button" size="sm" variant="outline" disabled={dirty || busy} onClick={() => setKnowledgeOpen(true)}><Upload size={15} />Import website</Button> : null}</div>} />
      </section>
      <section className="agent-config-panel agent-config-model">
      <AgentModel key={`${organizationId}:${agent.id}`} organizationId={organizationId} agentId={agent.id} configuration={configuration} onChange={setConfiguration} />
      </section>
      <section className="agent-config-panel agent-config-extras">
      {agent.offering === "booking" || (!agent.setup && agent.offering === "customer-service") || agent.setup?.responsibilities.includes("bookings") || configuration.capabilities.businessActions.enabled || searchParams.get("setup") === "booking" ? <BookingPolicies agentId={agent.id} configuration={configuration} onChange={setConfiguration} /> : null}
      {configuration.capabilities.sandbox.enabled || searchParams.get("setup") === "analysis" ? <AnalysisConfiguration configuration={configuration} onChange={setConfiguration} /> : null}
      </section>
      {configuration.executionKind === "business" && !agent.offering ? <SpecialistConfiguration key={agent.id} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} configuration={configuration} onChange={setConfiguration} /> : null}
      <details className="agent-config-history rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Configuration history</summary><div className="mt-3 space-y-3">{versions.map((snapshot, index) => <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2"><span>{snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : index === 0 ? "Current configuration" : "Previous configuration"}</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={async () => { if (dirty && !await confirm({ title: "Replace unsaved changes?", description: "Load this saved configuration into the editor. Apply it with Save changes.", confirmLabel: "Load configuration" })) return; setConfiguration(structuredClone(snapshot.configuration)); setSupportHoursError(""); toast.success("Configuration loaded. Save changes to apply it."); }}>Load configuration</Button></div>)}</div></details>
      <section className="agent-config-panel agent-config-delete"><h2>Delete agent</h2><Button type="button" variant="destructive" disabled={busy} onClick={() => { setDeleteError(""); setDeleteOpen(true); }}>Delete agent</Button></section>
    </form><AgentSetupStatus organizationId={organizationId} agent={agent} /></div> : section === "tools" || section === "skills" ? <><AgentCatalogue key={`${agent.id}.${section}`} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} kind={section} configuration={configuration} onChange={setConfiguration} onBeforeConnect={beforeConnect} />{section === "tools" ? <><AgentProcedures key={agent.id} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} configuration={configuration} onChange={setConfiguration} disabled={busy} /><CustomerRecordTools configuration={configuration} onChange={setConfiguration} />{configuration.executionKind === "business" && !agent.offering ? <TaskControlTools configuration={configuration} onChange={setConfiguration} /> : null}</> : null}<form className="catalogue-save" onSubmit={event => void save(event)}><Button type="submit" disabled={!needsApply || busy}>{busy ? "Saving…" : "Save changes"}</Button></form></> : <AgentChannels organizationId={organizationId} agentId={agent.id} owner={session.organizations.find(org => org.id === organizationId)?.role === "owner"} />}
    </>}
    </div>
    <Dialog open={deleteOpen} onOpenChange={value => { if (!deleteBusy) setDeleteOpen(value); }}><DialogContent showCloseButton={!deleteBusy} onInteractOutside={event => { if (deleteBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (deleteBusy) event.preventDefault(); }}><DialogHeader><DialogTitle>Delete {agent.name}?</DialogTitle><DialogDescription>Connected channels and automations will stop. Conversation history and customer records will be retained. This cannot be undone.{dirty ? " Unsaved changes will be discarded." : ""}</DialogDescription></DialogHeader><ErrorMessage value={deleteError} /><DialogFooter><Button type="button" variant="outline" disabled={deleteBusy} onClick={() => setDeleteOpen(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void deleteAgent()}>{deleteBusy ? "Deleting…" : "Delete agent"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={knowledgeOpen} onOpenChange={value => { if (!knowledgeBusy) setKnowledgeOpen(value); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!knowledgeBusy} onInteractOutside={event => { if (knowledgeBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (knowledgeBusy) event.preventDefault(); }}><DialogHeader><DialogTitle>Import website</DialogTitle><DialogDescription>Review website content before adding it to your agent.</DialogDescription></DialogHeader><WebsiteKnowledgeImport organizationId={organizationId} agentId={agent.id} onComplete={() => void refreshKnowledge().catch(e => setError(message(e)))} onBusyChange={setKnowledgeBusy} /></DialogContent></Dialog>
    <Dialog open={documentsOpen} onOpenChange={value => { if (!documentsBusy) setDocumentsOpen(value); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!documentsBusy} onInteractOutside={event => { if (documentsBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (documentsBusy) event.preventDefault(); }}><DialogHeader><DialogTitle>Add documents</DialogTitle><DialogDescription>Review content before adding it to your agent.</DialogDescription></DialogHeader><KnowledgeUpload organizationId={organizationId} agentId={agent.id} onComplete={() => { setDocumentsOpen(false); void refreshKnowledge().catch(e => setError(message(e))); }} onBusyChange={setDocumentsBusy} /></DialogContent></Dialog>
  </div>;
}
