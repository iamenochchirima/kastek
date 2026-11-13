import "./agent-workspace.css";
import { CustomerRecordTools } from "./customer-record-tools";
import { TaskControlTools } from "./task-control-tools";
import { defaultSupportHours, normalizeSupportHours, SupportHoursFields, validSupportHours } from "./support-hours";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { flushSync } from "react-dom";
import { PiPlus as Plus, PiUploadSimple as Upload } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { api, ApiError, hasPermission, message, organizationPath, type Agent, type AgentGuidance, type AgentIdentity, type Configuration, type KnowledgeSource, type KnowledgeSources, type Version } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { normalizeAgentSection, useAgentDirectory } from "./agent-directory";
import { Chat } from "./chat";
import { SpecialistConfiguration } from "./specialist-configuration";
import { SourceConfiguration } from "./source-configuration";
import { AgentProcedures } from "./agent-procedures";
import { AgentCatalogue } from "./catalogue";
import { AnalysisConfiguration } from "./analysis-configuration";
import { BookingPolicies } from "./booking-policies";
import { AgentModel, ChatModelPicker, type ModelSettingsPatch } from "./agent-model";
import { AgentChannels } from "./agent-channels";
import { WebsiteChannelSettings } from "./website-channel-settings";
import { WebsiteKnowledgeImport } from "./website-knowledge-import";
import { KnowledgeUpload } from "./knowledge-upload";
import { AgentMemory } from "./agent-memory";
import { AgentAvatar } from "./agent-avatar";
import { AgentOverview } from "./agent-overview";
import { AgentConversations } from "./agent-conversations";
import { AgentCapabilities, type CapabilityId } from "./agent-capabilities";
import { AgentSettings } from "./agent-settings";
import { Switch } from "@/components/ui/switch";

const sections = ["overview", "conversations", "capabilities", "knowledge", "behaviour", "widget", "deploy", "settings"] as const;
const memoryTools = ["memory.search", "memory.read", "memory.propose"] as const;
type EffectiveSettings = { composed: string; sources: number; tools: number; connectedTools: number; skills: number };
type Section = (typeof sections)[number];
type BehaviourTab = "general" | "tools" | "skills";

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
  const rawSection = searchParams.get("section");
  const normalized = normalizeAgentSection(rawSection);
  const section: Section = (sections as readonly string[]).includes(normalized) ? normalized as Section : "overview";
  const behaviourTab: BehaviourTab = searchParams.get("panel") === "tools" || rawSection === "tools" ? "tools" : searchParams.get("panel") === "skills" || rawSection === "skills" ? "skills" : "general";
  function setBehaviourTab(tab: BehaviourTab) {
    const next = new URLSearchParams(searchParams);
    next.set("section", "behaviour");
    if (tab === "general") next.delete("panel"); else next.set("panel", tab);
    setSearchParams(next, { replace: true });
  }
  function goSection(value: Section, panel?: string) {
    const next = new URLSearchParams();
    next.set("section", value);
    if (panel) next.set("panel", panel);
    setSearchParams(next, { replace: true });
  }
  const [error, setError] = useState("");
  const [supportHoursError, setSupportHoursError] = useState("");
  const supportSection = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false), [deleteBusy, setDeleteBusy] = useState(false), [deleteError, setDeleteError] = useState("");
  const deleted = useRef(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false), [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false), [documentsBusy, setDocumentsBusy] = useState(false);
  const [effective, setEffective] = useState<EffectiveSettings | null>(null), [effectiveBusy, setEffectiveBusy] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false), [instructionsDraft, setInstructionsDraft] = useState("");
  async function refreshKnowledge() { const [current, sources] = await Promise.all([api<{ agent: Agent; versions: Version[] }>(path), api<KnowledgeSources>(`${organizationPath(organizationId)}/knowledge/sources`)]); setAgent(current.agent); setName(current.agent.name); setConfiguration(current.agent.draft); setVersions(current.versions); setKnowledge(sources.sources); refresh(); }
  useEffect(() => { let live = true; Promise.all([api<{ agent: Agent; versions: Version[] }>(path), api<KnowledgeSources>(`${organizationPath(organizationId)}/knowledge/sources`)]).then(([result, sources]) => { if (!live) return; setAgent(result.agent); setConfiguration(result.agent.draft); setName(result.agent.name); setVersions(result.versions); setKnowledge(sources.sources); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, organizationId, agentId, session.account.id]);
  const latestDraft = useRef({ name, configuration }); latestDraft.current = { name, configuration };
  const dirty = Boolean(agent && configuration && (name !== agent.name || JSON.stringify(configuration) !== JSON.stringify(agent.draft)));
  const pendingSetup = Boolean(agent && (!versions[0] || JSON.stringify(agent.draft) !== JSON.stringify(versions[0].configuration)));
  const needsApply = dirty || pendingSetup;
  const workspace = session.organizations.find(org => org.id === organizationId);
  const canConfigure = hasPermission(workspace, "agents.manage");
  const canConfigureAgents = canConfigure || hasPermission(workspace, "agents.delete");
  const editableSection = canConfigure && (section === "knowledge" || section === "behaviour" || section === "capabilities");
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !deleted.current && dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { if (blocker.state !== "blocked") return; let live = true; void confirm({ title: "Discard unsaved changes?", description: "Your configuration has not been saved.", confirmLabel: "Discard changes", variant: "destructive" }).then(discard => { if (live) { if (discard) blocker.proceed(); else blocker.reset(); } }); return () => { live = false; }; }, [blocker, confirm]);
  async function applyConfiguration(configuration: Configuration, name: string, draftBefore = { name, configuration }, expectedRevision = agent?.draftRevision, successMessage?: string, preserveLocalDraft = false): Promise<boolean> {
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
    if (!preserveLocalDraft && unchanged) { setName(result.agent.name); setConfiguration(result.agent.draft); }
    setVersions(current => [result.snapshot, ...current.filter(item => item.id !== result.snapshot.id)]);
    refresh();
    const base = successMessage ?? "Changes saved";
    toast.success(preserveLocalDraft ? (dirty ? `${base}. Other unsaved changes remain unsaved.` : base)
      : (unchanged ? base : `${base}. Other unsaved changes remain unsaved.`));
    return true;
  }
  function checkSupportHours(value: Configuration): boolean {
    if (!value.supportHours || validSupportHours(value.supportHours)) { setSupportHoursError(""); return true; }
    setSupportHoursError("Enter valid support days, hours and timezone.");
    goSection("behaviour");
    requestAnimationFrame(() => {
      if (supportSection.current) supportSection.current.open = true;
      supportSection.current?.scrollIntoView({ block: "center" });
      supportSection.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
    });
    return false;
  }
  function normalizedConfiguration(value: Configuration): Configuration {
    const tools = new Set(value.tools ?? []);
    for (const tool of memoryTools) if (value.memory?.enabled) tools.add(tool); else tools.delete(tool);
    return { ...value, tools: [...tools] as NonNullable<Configuration["tools"]>, ...(value.supportHours ? { supportHours: normalizeSupportHours(value.supportHours) } : {}) };
  }
  function setMemoryEnabled(enabled: boolean) {
    if (!configuration) return;
    const tools = new Set(configuration.tools ?? []);
    for (const tool of memoryTools) if (enabled) tools.add(tool); else tools.delete(tool);
    setConfiguration({ ...configuration, memory: { enabled }, tools: [...tools] as NonNullable<Configuration["tools"]> });
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (event && event.target !== event.currentTarget) return;
    if (!agent || !configuration) return;
    setBusy(true); setError("");
    try { await applyConfiguration(configuration, name); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function saveModelSettings(patch: ModelSettingsPatch): Promise<boolean> {
    if (!agent) return false;
    // Publish from the current saved draft so unrelated unsaved edits remain unsaved.
    const { agent: currentAgent } = await api<{ agent: Agent }>(path);
    const model = { ...currentAgent.draft.model, ...patch };
    // Generation settings are model-specific. A model switch uses the new model's defaults.
    if (patch.selection !== undefined) model.generation = undefined;
    const next = { ...currentAgent.draft, model };
    const saved = await applyConfiguration(next, currentAgent.name, { name: currentAgent.name, configuration: next }, currentAgent.draftRevision,
      patch.selection !== undefined ? "Model published" : "Reasoning published", true);
    if (saved) setConfiguration(current => current ? { ...current, model: {
      ...current.model, ...patch, ...(patch.selection !== undefined ? { generation: undefined } : {}),
    } } : current);
    return saved;
  }
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
  async function changeCapabilities(id: CapabilityId, enabled: boolean) {
    if (!agent || busy) return;
    if (dirty) { toast.error("Save your changes before changing capabilities."); return; }
    const current = agent.setup?.responsibilities ?? [];
    const responsibilities = enabled ? [...new Set([...current, id])] : current.filter(value => value !== id);
    if (!responsibilities.length) { toast.error("Keep at least one capability."); return; }
    const removing = !enabled;
    if (removing && !await confirm({ title: "Remove capability?", description: "The agent stops using this capability. Configuration and conversation history are kept.", confirmLabel: "Remove capability", variant: "destructive" })) return;
    setBusy(true); setError("");
    try {
      const body = { responsibilities, expectedRevision: agent.draftRevision, ...(removing ? { confirmImpact: true } : {}) };
      type Saved = { agent: Agent; snapshot: Version };
      let result: Saved;
      try { result = await api<Saved>(`${path}/capabilities`, body, "PUT"); }
      catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== "CONFIGURATION_CONFIRMATION_REQUIRED") throw reason;
        const approved = await confirm({ title: "Add capability?", description: "This lets the agent perform more work for customers. New messages use the updated capability after saving.", confirmLabel: "Add capability" });
        if (!approved) return;
        result = await api<Saved>(`${path}/capabilities`, { ...body, confirmImpact: true }, "PUT");
      }
      setAgent(result.agent); setName(result.agent.name); setConfiguration(result.agent.draft);
      setVersions(values => [result.snapshot, ...values.filter(item => item.id !== result.snapshot.id)]);
      refresh(); toast.success("Capabilities updated");
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  function configureCapability(id: CapabilityId) {
    if (!agent) return;
    if (id === "answer-questions") goSection("knowledge");
    else if (id === "customer-support") goSection("behaviour");
    else if (id === "bookings") { goSection("capabilities"); requestAnimationFrame(() => document.getElementById("agent-booking-config")?.scrollIntoView({ behavior: "smooth", block: "start" })); }
    else navigate(`/app/agents/${agent.id}?setup=guided`);
  }
  async function recommendedDefaults() {
    return api<{ defaults: { identity: AgentIdentity; guidance: AgentGuidance } }>(`${path}/identity-defaults`);
  }
  async function applyRecommendedIdentity() {
    try {
      const result = await recommendedDefaults();
      setConfiguration(current => current ? { ...current, identity: result.defaults.identity } : current);
      toast.success("Recommended identity added");
    } catch (reason) { toast.error(message(reason)); }
  }
  async function applyRecommendedGuidance() {
    try {
      const result = await recommendedDefaults();
      setConfiguration(current => current ? { ...current, guidance: result.defaults.guidance } : current);
      toast.success("Recommended guidance added");
    } catch (reason) { toast.error(message(reason)); }
  }
  function openInstructions() {
    if (!configuration) return;
    setInstructionsDraft(configuration.instructions);
    setInstructionsOpen(true);
  }
  function applyInstructions() {
    if (!configuration || !instructionsDraft.trim()) return;
    setConfiguration({ ...configuration, instructions: instructionsDraft });
    setInstructionsOpen(false);
  }
  async function loadEffectiveSettings() {
    if (!configuration) return;
    setEffectiveBusy(true);
    try {
      setEffective(await api<EffectiveSettings>(`${path}/effective-settings`, { configuration }));
    } catch (reason) { toast.error(message(reason)); }
    finally { setEffectiveBusy(false); }
  }
  function updateIdentity(patch: Partial<AgentIdentity>) {
    if (!configuration) return;
    const current = configuration.identity ?? { purpose: "", voice: "", values: "", boundaries: "", refusal: "", escalation: "", examples: [] };
    setConfiguration({ ...configuration, identity: { ...current, ...patch } });
  }
  function updateGuidance(patch: Partial<AgentGuidance>) {
    if (!configuration) return;
    const current = configuration.guidance ?? { topicScope: "", avoid: [], refusalStyle: "brief", redirectTo: "" };
    setConfiguration({ ...configuration, guidance: { ...current, ...patch } });
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
  if (!canConfigure && (section === "capabilities" || section === "knowledge" || section === "behaviour")) {
    return <section className="agent-section"><h1>Read-only access</h1><p>Ask an owner or admin for agent configuration access.</p></section>;
  }
  if (!canConfigureAgents && section === "settings") {
    return <section className="agent-section"><h1>Read-only access</h1><p>Ask an owner or admin for agent configuration access.</p></section>;
  }
  const chatOpen = Boolean(conversationId) || rawSection === "chat";
  const view = chatOpen ? "chat" : "section";
  const knowledgeCount = configuration.sourceRevisionIds?.length ?? 0;
  const memoryAvailable = configuration.executionKind === "business" && !agent.offering && configuration.program?.id !== "grounded-conversation";
  return <div className={`agent-editor agent-view-${view}`}><header className="agent-editor-header"><div className="flex min-w-0 items-center gap-3"><AgentAvatar id={agent.avatar} size={34} /><h1 className="truncate text-lg font-semibold">{agent.name}</h1></div><div className="flex shrink-0 items-center gap-2">{chatOpen ? <AgentMemory agentId={agent.id} enabled={agent.draft.memory?.enabled ?? false} /> : null}{chatOpen || section === "conversations" ? <Button size="sm" variant="outline" onClick={newChat}><Plus size={15} />New chat</Button> : editableSection ? <Button size="sm" onClick={() => void save()} disabled={!needsApply || busy}>{busy ? "Saving…" : "Save changes"}</Button> : null}</div></header>
    <div className="agent-editor-body"><ErrorMessage value={error} />{!chatOpen && editableSection && pendingSetup ? <p role="status" className="agent-unsaved-note">Save changes to apply the updated setup.</p> : null}
    {chatOpen ? <Chat endpoint={`${organizationPath(organizationId)}/tasks`} key={`${agent.id}.${conversationId ?? "new"}.${chatGeneration}`} storageKey={`agents.chat.${session.account.id}.${organizationId}.${agent.id}.${conversationId ?? "new"}`} agentId={agent.id} initialConversationId={conversationId} expectedAgentId={agent.id} onConversationReady={id => { refresh(); if (!conversationId) navigate(`/app/agents/${agent.id}/conversations/${id}`, { replace: true }); }} view="chat" composerAccessory={<ChatModelPicker organizationId={organizationId} agentId={agent.id} configuration={agent.draft} dirty={dirty} saving={busy} onSelect={changeChatModel} />} cancellable /> :
    section === "overview" ? <AgentOverview organizationId={organizationId} agent={agent} /> :
    section === "conversations" ? <AgentConversations organizationId={organizationId} agentId={agent.id} onNewChat={newChat} /> :
    section === "capabilities" ? <><AgentCapabilities agent={agent} configuration={configuration} knowledgeCount={knowledgeCount} busy={busy || dirty || pendingSetup} onToggle={(id, enabled) => void changeCapabilities(id, enabled)} onConfigure={configureCapability} />{agent.setup?.responsibilities.includes("bookings") ? <section className="agent-section agent-capability-config" id="agent-booking-config"><BookingPolicies agentId={agent.id} configuration={configuration} onChange={setConfiguration} embedded returnTo={`/app/agents/${agent.id}?section=capabilities`} onBeforeConnect={async () => { await beforeConnect(); }} onBusyChange={setBusy} /></section> : null}</> :
    section === "knowledge" ? <section className="agent-section agent-knowledge-page"><p className="agent-section-lead">Sources this agent answers from.</p><SourceConfiguration agentId={agent.id} sources={knowledge} configuration={configuration} onChange={setConfiguration} onRefresh={refreshKnowledge} action={<div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={dirty || busy} onClick={() => setDocumentsOpen(true)}><Upload size={15} />Add documents</Button>{["faq", "customer-service"].includes(agent.offering ?? "") && (!agent.setup || agent.setup.responsibilities.some(value => ["answer-questions", "customer-support"].includes(value))) ? <Button type="button" size="sm" variant="outline" disabled={dirty || busy} onClick={() => setKnowledgeOpen(true)}><Upload size={15} />Import website</Button> : null}</div>} /></section> :
    section === "behaviour" ? <section className="agent-section agent-behaviour-page"><header className="agent-section-heading"><div><h1>Behaviour</h1><p>How this agent introduces itself, responds, and remembers.</p></div></header><nav className="agent-subtabs" aria-label="Behaviour sections">{([["general", "General"], ["tools", "Tools"], ["skills", "Skills"]] as const).map(([id, label]) => <button key={id} type="button" onClick={() => setBehaviourTab(id)} aria-current={behaviourTab === id ? "page" : undefined}>{label}</button>)}</nav>
      {behaviourTab === "general" ? <form id="agent-behaviour-form" className="agent-general-grid" onSubmit={event => void save(event)}>
        <div className="agent-general-primary">
          <section className="agent-config-panel agent-config-basic agent-config-instructions">
            <div className="agent-config-card-head">
              <div><h2>Instructions</h2><p>What this agent should do. Keep it specific.</p></div>
              <Button type="button" size="sm" variant="outline" onClick={openInstructions}>Edit</Button>
            </div>
            <button type="button" className={`agent-instructions-preview ${configuration.instructions.trim() ? "" : "is-empty"}`} onClick={openInstructions} aria-label="Edit instructions">
              <span className="agent-instructions-preview-text">{configuration.instructions.trim() || "No instructions yet."}</span>
            </button>
            <div className="agent-instructions-meta">
              <span>{agent.setup && configuration.instructions.includes("The setup below is business context") ? "Includes setup details" : ""}</span>
              <span aria-hidden="true">{configuration.instructions.length.toLocaleString()} / 8,000</span>
            </div>
          </section>
          <section className="agent-config-panel agent-config-guidance">
            <div className="agent-config-card-head">
              <div><h2>Guidance</h2><p>What to stay within, avoid and redirect.</p></div>
              {!configuration.guidance ? <Button type="button" size="sm" variant="outline" onClick={() => void applyRecommendedGuidance()}>Use recommended guidance</Button> : null}
            </div>
            <div className="agent-guidance-fields">
              <label className="agent-field agent-field-wide">Topic scope<Textarea rows={2} maxLength={800} value={configuration.guidance?.topicScope ?? ""} onChange={event => updateGuidance({ topicScope: event.target.value })} /></label>
              <label className="agent-field agent-field-wide">Avoid (one per line)<Textarea rows={3} maxLength={2000} value={(configuration.guidance?.avoid ?? []).join("\n")} onChange={event => updateGuidance({ avoid: event.target.value.split("\n").map(value => value.trim()).filter(Boolean).slice(0, 20) })} /></label>
              <label className="agent-field">Refusal style<select className="w-full min-w-0 rounded-md border border-border bg-background p-2 text-sm" value={configuration.guidance?.refusalStyle ?? "brief"} onChange={event => updateGuidance({ refusalStyle: event.target.value as AgentGuidance["refusalStyle"] })}><option value="brief">Brief</option><option value="warm">Warm</option><option value="formal">Formal</option></select></label>
              <label className="agent-field">Redirect to<Input maxLength={300} value={configuration.guidance?.redirectTo ?? ""} onChange={event => updateGuidance({ redirectTo: event.target.value })} /></label>
            </div>
          </section>
        </div>
        <aside className="agent-general-aside">
          <section className="agent-config-panel agent-config-identity">
            <div className="agent-config-card-head"><div><h2>Identity</h2><p>Who this agent is and how it speaks.</p></div></div>
            {configuration.identity ? <div className="agent-identity-fields">
              <label className="agent-field">Purpose<Textarea required rows={2} maxLength={600} value={configuration.identity.purpose} onChange={event => updateIdentity({ purpose: event.target.value })} /></label>
              <label className="agent-field">Voice<Textarea required rows={2} maxLength={600} value={configuration.identity.voice} onChange={event => updateIdentity({ voice: event.target.value })} /></label>
              <details className="agent-identity-more">
                <summary>Values and boundaries</summary>
                <div className="agent-identity-more-fields">
                  <label className="agent-field">Values<Textarea rows={2} maxLength={600} value={configuration.identity.values} onChange={event => updateIdentity({ values: event.target.value })} /></label>
                  <label className="agent-field">Boundaries<Textarea rows={3} maxLength={800} value={configuration.identity.boundaries} onChange={event => updateIdentity({ boundaries: event.target.value })} /></label>
                  <label className="agent-field">When refusing<Textarea rows={2} maxLength={400} value={configuration.identity.refusal} onChange={event => updateIdentity({ refusal: event.target.value })} /></label>
                  <label className="agent-field">Escalation<Textarea rows={2} maxLength={400} value={configuration.identity.escalation} onChange={event => updateIdentity({ escalation: event.target.value })} /></label>
                  <label className="agent-field">Examples (one per line)<Textarea rows={3} maxLength={1500} value={configuration.identity.examples.join("\n")} onChange={event => updateIdentity({ examples: event.target.value.split("\n").map(value => value.trim()).filter(Boolean).slice(0, 5) })} /></label>
                </div>
              </details>
            </div> : <div className="agent-config-empty"><p>No identity yet. The agent uses its instructions only.</p><Button type="button" size="sm" variant="outline" onClick={() => void applyRecommendedIdentity()}>Use recommended identity</Button></div>}
          </section>
          <section className="agent-config-panel agent-config-memory">
            <div className="agent-config-card-head">
              <div><h2>Memory</h2><p>Remember accepted preferences across conversations.</p></div>
              {memoryAvailable || configuration.memory?.enabled ? <div className="agent-switch-row"><Switch id="agent-memory-enabled" checked={configuration.memory?.enabled ?? false} disabled={busy || !editableSection} onCheckedChange={value => { if (memoryAvailable || !value) setMemoryEnabled(value); }} aria-label="Enable memory" /></div> : null}
            </div>
            {memoryAvailable || configuration.memory?.enabled ? <div className="agent-memory-review"><AgentMemory agentId={agent.id} enabled={configuration.memory?.enabled ?? false} label="Review memory" variant="outline" /></div> : <p className="agent-config-note">Not available for customer agents.</p>}
          </section>
        </aside>
        <div className="agent-general-secondary">
          <section className="agent-config-panel agent-config-model"><AgentModel key={`${organizationId}:${agent.id}`} organizationId={organizationId} agentId={agent.id} configuration={configuration} onChange={setConfiguration} onSaveSettings={editableSection ? saveModelSettings : undefined} /></section>
          {agent.setup?.responsibilities.includes("customer-support") || configuration.supportHours || configuration.tools?.some(tool => tool.startsWith("support.") || tool === "channel.request_handoff") ? <section className="agent-config-panel agent-config-support" aria-label="Human support">
            <details className="agent-support-disclosure" ref={supportSection}>
              <summary><span>Human support</span><span className="agent-support-state" data-state={configuration.supportHours ? "set" : "unset"}>{configuration.supportHours ? "Configured" : "Not set"}</span></summary>
              <div className="agent-support-body">
                {configuration.supportHours ? <SupportHoursFields value={configuration.supportHours} onChange={supportHours => { setConfiguration({ ...configuration, supportHours }); setSupportHoursError(""); }} error={supportHoursError || undefined} /> : <Button type="button" size="sm" variant="outline" onClick={() => setConfiguration({ ...configuration, supportHours: agent.setup?.supportHours ?? defaultSupportHours() })}>Set support hours</Button>}
              </div>
            </details>
          </section> : null}
          {configuration.capabilities.sandbox.enabled || searchParams.get("setup") === "analysis" ? <section className="agent-config-panel"><AnalysisConfiguration configuration={configuration} onChange={setConfiguration} /></section> : null}
          {configuration.executionKind === "business" && !agent.offering ? <SpecialistConfiguration key={agent.id} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} configuration={configuration} onChange={setConfiguration} /> : null}
          <details className="agent-config-panel agent-effective-settings" onToggle={event => { if (event.currentTarget.open && !effective && !effectiveBusy) void loadEffectiveSettings(); }}><summary className="cursor-pointer font-medium">Effective settings</summary><div className="mt-3 space-y-3 text-sm">
            {effectiveBusy ? <Loading /> : effective ? <><pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 font-sans text-sm leading-6">{effective.composed}</pre><p className="text-muted-foreground">{effective.sources} {effective.sources === 1 ? "source" : "sources"} · {effective.tools} tools · {effective.connectedTools} connected · {effective.skills} skills</p></> : <p className="text-muted-foreground">Preview the prompt the agent runs with.</p>}
            <Button type="button" size="sm" variant="outline" disabled={effectiveBusy} onClick={() => void loadEffectiveSettings()}>Refresh preview</Button>
          </div></details>
          <details className="agent-config-history rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Configuration history</summary><div className="mt-3 space-y-3">{versions.map((snapshot, index) => <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2"><span>{snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : index === 0 ? "Current configuration" : "Previous configuration"}</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={async () => { if (dirty && !await confirm({ title: "Replace unsaved changes?", description: "Load this saved configuration into the editor. Apply it with Save changes.", confirmLabel: "Load configuration" })) return; setConfiguration(structuredClone(snapshot.configuration)); setSupportHoursError(""); toast.success("Configuration loaded. Save changes to apply it."); }}>Load configuration</Button></div>)}</div></details>
        </div>
      </form> : null}
      {behaviourTab === "tools" ? <><AgentCatalogue key={`${agent.id}.tools`} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} kind="tools" configuration={configuration} onChange={setConfiguration} onBeforeConnect={beforeConnect} /><AgentProcedures key={agent.id} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} configuration={configuration} onChange={setConfiguration} disabled={busy} /><CustomerRecordTools configuration={configuration} onChange={setConfiguration} />{configuration.executionKind === "business" && !agent.offering ? <TaskControlTools configuration={configuration} onChange={setConfiguration} /> : null}</> : null}
      {behaviourTab === "skills" ? <AgentCatalogue key={`${agent.id}.skills`} organizationId={organizationId} agentId={agent.id} draftRevision={agent.draftRevision} kind="skills" configuration={configuration} onChange={setConfiguration} onBeforeConnect={beforeConnect} /> : null}
    </section> :
    section === "widget" ? <section className="agent-section agent-widget-page"><header className="agent-section-heading"><div><h1>Chat widget</h1><p>Customize the website chat window.</p></div></header><WebsiteChannelSettings organizationId={organizationId} agentId={agent.id} owner={hasPermission(session.organizations.find(org => org.id === organizationId), "deploy.manage")} /></section> :
    section === "deploy" ? <section className="agent-section agent-deploy-page"><header className="agent-section-heading"><div><h1>Deploy</h1><p>Connect the channels customers use.</p></div></header><AgentChannels organizationId={organizationId} agentId={agent.id} owner={hasPermission(session.organizations.find(org => org.id === organizationId), "channels.manage")} hideWebsite /></section> :
    section === "settings" ? <AgentSettings organizationId={organizationId} agent={agent} onUpdated={updated => { setAgent(updated); setName(updated.name); refresh(); }} onDelete={() => { setDeleteError(""); setDeleteOpen(true); }} /> :
    null}
    </div>
    <Dialog open={instructionsOpen} onOpenChange={value => { if (!value) setInstructionsOpen(false); }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader><DialogTitle>Instructions</DialogTitle><DialogDescription>What this agent should do. Keep it specific.</DialogDescription></DialogHeader>
        <label className="block space-y-2 text-sm font-medium"><span className="sr-only">Instructions</span>
          <Textarea autoFocus maxLength={8_000} className="agent-instructions-editor" value={instructionsDraft} onChange={event => setInstructionsDraft(event.target.value)} />
        </label>
        <div className="agent-instructions-meta"><span>Save changes to apply.</span><span aria-hidden="true">{instructionsDraft.length.toLocaleString()} / 8,000</span></div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setInstructionsOpen(false)}>Cancel</Button><Button type="button" disabled={!instructionsDraft.trim()} onClick={applyInstructions}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={deleteOpen} onOpenChange={value => { if (!deleteBusy) setDeleteOpen(value); }}><DialogContent showCloseButton={!deleteBusy} onInteractOutside={event => { if (deleteBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (deleteBusy) event.preventDefault(); }}><DialogHeader><DialogTitle>Delete {agent.name}?</DialogTitle><DialogDescription>Connected channels and automations will stop. Conversation history and customer records will be retained. This cannot be undone.{dirty ? " Unsaved changes will be discarded." : ""}</DialogDescription></DialogHeader><ErrorMessage value={deleteError} /><DialogFooter><Button type="button" variant="outline" disabled={deleteBusy} onClick={() => setDeleteOpen(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void deleteAgent()}>{deleteBusy ? "Deleting…" : "Delete agent"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={knowledgeOpen} onOpenChange={value => { if (!knowledgeBusy) setKnowledgeOpen(value); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!knowledgeBusy} onInteractOutside={event => { if (knowledgeBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (knowledgeBusy) event.preventDefault(); }}><DialogHeader><DialogTitle>Import website</DialogTitle><DialogDescription>Review website content before adding it to your agent.</DialogDescription></DialogHeader><WebsiteKnowledgeImport organizationId={organizationId} agentId={agent.id} onComplete={() => void refreshKnowledge().catch(e => setError(message(e)))} onBusyChange={setKnowledgeBusy} /></DialogContent></Dialog>
    <Dialog open={documentsOpen} onOpenChange={value => { if (!documentsBusy) setDocumentsOpen(value); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!documentsBusy} onInteractOutside={event => { if (documentsBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (documentsBusy) event.preventDefault(); }}><DialogHeader><DialogTitle>Add documents</DialogTitle><DialogDescription>Review content before adding it to your agent.</DialogDescription></DialogHeader><KnowledgeUpload organizationId={organizationId} agentId={agent.id} onComplete={() => { setDocumentsOpen(false); void refreshKnowledge().catch(e => setError(message(e))); }} onBusyChange={setDocumentsBusy} /></DialogContent></Dialog>
  </div>;
}
