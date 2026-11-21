import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Plus, X } from "lucide-react";
import type { AgentProfileDetail, AgentProfileSpec, AgentSetupStep, AgentTargetType, AgentTemplate } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { EmptyState, ErrorBox, Loading, StatusBadge } from "../components";
import { configFieldSummary } from "../data/agent-config-catalogue";

const responsibilityOptions: Array<{
  id: AgentProfileSpec["responsibilities"][number];
  label: string;
}> = [
  { id: "answer-questions", label: "Answer questions" },
  { id: "customer-support", label: "Customer support" },
  { id: "bookings", label: "Bookings and calendar" },
  { id: "enquiries", label: "Enquiries" },
];

export function AgentProfilesPanel({
  sandboxId,
  workspaceRefId,
  onAgentChanged,
}: {
  sandboxId: string;
  workspaceRefId: string;
  onAgentChanged: () => void;
}) {
  const [profiles, setProfiles] = useState<AgentProfileDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"form" | "table">("form");
  const notified = useRef(new Set<string>());
  const defaultForm = {
    targetType: "business_agent" as AgentTargetType,
    agentName: "Customer support",
    instructions: "Help customers with clear, accurate answers. Use approved knowledge and ask for missing details. Do not invent business facts.",
    knowledgeTitle: "Customer support policy",
    knowledgeContent: "",
    responsibilities: ["answer-questions", "customer-support", "bookings"] as AgentProfileSpec["responsibilities"],
    offering: "customer-service" as "customer-service" | "custom",
    configurationJson: "{}",
    setupJson: "{}",
  };
  const [form, setForm] = useState(defaultForm);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [templateError, setTemplateError] = useState<string | null>(null);
  const selectedTemplate = templates.find((template) => template.key === templateKey);

  function openCreate() {
    setEditingProfileId(null);
    setForm(defaultForm);
    setTemplateKey("");
    setFormError(null);
    setViewMode("form");
    setOpen(true);
  }

  function openVersion(profile: AgentProfileDetail) {
    const spec = profile.version.spec;
    setEditingProfileId(profile.id);
    setTemplateKey("");
    setForm({
      targetType: spec.targetType,
      agentName: spec.agentName,
      instructions: spec.instructions,
      knowledgeTitle: spec.knowledge.title,
      knowledgeContent: spec.knowledge.content,
      responsibilities: spec.responsibilities,
      offering: spec.offering === "customer-service" ? "customer-service" : "custom",
      configurationJson: JSON.stringify(spec.configuration ?? {}, null, 2),
      setupJson: JSON.stringify(spec.setup ?? {}, null, 2),
    });
    setFormError(null);
    setViewMode("form");
    setOpen(true);
  }

  useEffect(() => {
    let cancelled = false;
    api<{ profiles: AgentProfileDetail[] }>(`/api/sandboxes/${encodeURIComponent(sandboxId)}/agent-profiles`)
      .then((value) => { if (!cancelled) { setProfiles(value.profiles); setError(null); } })
      .catch((value) => { if (!cancelled) setError(errorMessage(value)); });
    return () => { cancelled = true; };
  }, [sandboxId, refresh]);

  useEffect(() => {
    let cancelled = false;
    api<{ templates: AgentTemplate[] }>("/api/agent-templates")
      .then((value) => {
        if (!cancelled) {
          setTemplates(value.templates);
          setTemplateError(null);
        }
      })
      .catch((value) => {
        if (!cancelled) {
          setTemplates([]);
          setTemplateError(errorMessage(value));
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!profiles) return;
    for (const profile of profiles) {
      if (profile.latestRun?.status === "ready" && !notified.current.has(profile.id)) {
        notified.current.add(profile.id);
        onAgentChanged();
      }
    }
    const active = profiles.some((profile) =>
      profile.latestRun?.status === "pending" || profile.latestRun?.status === "running");
    if (!active) return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 1_500);
    return () => clearTimeout(timer);
  }, [profiles, onAgentChanged]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    if (!form.agentName.trim() || !form.instructions.trim() || !form.knowledgeTitle.trim() || !form.knowledgeContent.trim()) {
      setFormError("Name, instructions and knowledge are required");
      return;
    }
    if (form.responsibilities.length === 0) {
      setFormError("Choose at least one responsibility");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      let configuration: Record<string, unknown> | undefined;
      let setup: Record<string, unknown> | undefined;
      try {
        const parsedConfiguration = JSON.parse(form.configurationJson || "{}") as unknown;
        if (!parsedConfiguration || typeof parsedConfiguration !== "object" || Array.isArray(parsedConfiguration)) {
          throw new Error("configuration must be a JSON object");
        }
        if (Object.keys(parsedConfiguration).length) configuration = parsedConfiguration as Record<string, unknown>;
        const parsedSetup = JSON.parse(form.setupJson || "{}") as unknown;
        if (!parsedSetup || typeof parsedSetup !== "object" || Array.isArray(parsedSetup)) {
          throw new Error("setup must be a JSON object");
        }
        if (Object.keys(parsedSetup).length) setup = parsedSetup as Record<string, unknown>;
      } catch (value) {
        setFormError(errorMessage(value));
        setCreating(false);
        return;
      }
      const spec: AgentProfileSpec = {
        targetType: form.targetType,
        agentName: form.agentName.trim(),
        instructions: form.instructions.trim(),
        ...(form.targetType === "business_agent" && form.offering === "customer-service"
          ? { offering: "customer-service" as const }
          : {}),
        ...(configuration ? { configuration } : {}),
        ...(form.targetType === "business_agent" && form.offering === "customer-service" && setup
          ? { setup }
          : {}),
        knowledge: {
          title: form.knowledgeTitle.trim(),
          content: form.knowledgeContent,
          visibility: "private",
        },
        responsibilities: form.responsibilities,
      };
      let savedProfileId: string;
      if (editingProfileId) {
        const saved = await api<{ profile: AgentProfileDetail }>(`/api/agent-profiles/${encodeURIComponent(editingProfileId)}/versions`, {
          method: "POST",
          body: JSON.stringify({ spec }),
        });
        savedProfileId = saved.profile.id;
      } else {
        const saved = await api<{ profile: AgentProfileDetail }>(`/api/sandboxes/${encodeURIComponent(sandboxId)}/agent-profiles`, {
          method: "POST",
          body: JSON.stringify({ workspaceRefId, spec }),
        });
        savedProfileId = saved.profile.id;
      }
      setOpen(false);
      setEditingProfileId(null);
      setRefresh((value) => value + 1);
      try {
        await api(`/api/agent-profiles/${encodeURIComponent(savedProfileId)}/apply`, {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
        });
      } catch (value) {
        setError(`Agent saved, but setup could not start: ${errorMessage(value)}`);
      }
      setRefresh((value) => value + 1);
    } catch (value) {
      setFormError(errorMessage(value));
    } finally {
      setCreating(false);
    }
  }

  async function apply(profile: AgentProfileDetail) {
    if (applying) return;
    setApplying(profile.id);
    setError(null);
    try {
      await api(`/api/agent-profiles/${encodeURIComponent(profile.id)}/apply`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      setRefresh((value) => value + 1);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setApplying(null);
    }
  }

  function toggleResponsibility(id: AgentProfileSpec["responsibilities"][number]) {
    setForm((current) => ({
      ...current,
      responsibilities: current.responsibilities.includes(id)
        ? current.responsibilities.filter((value) => value !== id)
        : [...current.responsibilities, id],
    }));
  }

  function selectTemplate(key: string) {
    setTemplateKey(key);
    setFormError(null);
    const template = templates.find((item) => item.key === key);
    if (!template) {
      setForm(defaultForm);
      return;
    }
    const spec = template.spec;
    setForm({
      targetType: spec.targetType,
      agentName: spec.agentName,
      instructions: spec.instructions,
      knowledgeTitle: spec.knowledge.title,
      knowledgeContent: spec.knowledge.content,
      responsibilities: spec.responsibilities,
      offering: spec.offering === "customer-service" ? "customer-service" : "custom",
      configurationJson: JSON.stringify(spec.configuration ?? {}, null, 2),
      setupJson: JSON.stringify(spec.setup ?? {}, null, 2),
    });
  }

  function renderTable() {
    const row = (field: string, summary: string, value: ReactNode) => (
      <tr key={field}>
        <th scope="row">{field}</th>
        <td className="profile-config-summary">{summary}</td>
        <td>{value}</td>
      </tr>
    );
    return (
      <table className="profile-config-table">
        <thead><tr><th scope="col">Field</th><th scope="col">What it controls</th><th scope="col">Value</th></tr></thead>
        <tbody>
          {!editingProfileId && row("Template", "Starts the form from a saved preset. You can edit every value before creating.", (
            <select className="select" value={templateKey} onChange={(event) => selectTemplate(event.target.value)} disabled={creating}>
              <option value="">Start from scratch</option>
              {templates.map((template) => <option key={template.key} value={template.key}>{template.name}</option>)}
            </select>
          ))}
          {selectedTemplate && <tr><td colSpan={3} className="profile-config-hint">{selectedTemplate.description}</td></tr>}
          {templateError && <tr><td colSpan={3}><ErrorBox message={templateError} /></td></tr>}
          {row("Target", configFieldSummary("Target"), (
            <select className="select" value={form.targetType} onChange={(event) => { setTemplateKey(""); setForm((current) => ({ ...current, targetType: event.target.value as AgentTargetType, agentName: event.target.value === "platform_assistant" ? "Assistant" : "Customer support", responsibilities: event.target.value === "platform_assistant" ? ["answer-questions"] : ["answer-questions", "customer-support", "bookings"] })); }} disabled={creating}>
              <option value="business_agent">New business agent</option>
              <option value="platform_assistant">Platform Assistant</option>
            </select>
          ))}
          {form.targetType === "business_agent" && row("Agent kind", "Customer service uses the product offering and setup; custom merges advanced configuration over the Assistant draft.", (
            <select className="select" value={form.offering} onChange={(event) => { setTemplateKey(""); setForm((current) => ({ ...current, offering: event.target.value as "customer-service" | "custom" })); }} disabled={creating}>
              <option value="customer-service">Customer service offering</option>
              <option value="custom">Custom configuration</option>
            </select>
          ))}
          {row("Name", configFieldSummary("Name"), <input className="input" value={form.agentName} onChange={(event) => setForm((current) => ({ ...current, agentName: event.target.value }))} disabled={creating} />)}
          {row("Instructions", configFieldSummary("Instructions"), <textarea className="textarea" value={form.instructions} onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))} disabled={creating} />)}
          {row("Knowledge title", configFieldSummary("Knowledge sources"), <input className="input" value={form.knowledgeTitle} onChange={(event) => setForm((current) => ({ ...current, knowledgeTitle: event.target.value }))} disabled={creating} />)}
          {row("Knowledge content", configFieldSummary("Knowledge uploads"), <textarea className="textarea" value={form.knowledgeContent} onChange={(event) => setForm((current) => ({ ...current, knowledgeContent: event.target.value }))} disabled={creating} placeholder="Policy, FAQs or service details" />)}
          {row("Responsibilities", configFieldSummary("Responsibilities"), (
            <div className="profile-config-checks">{responsibilityOptions.map((item) => <label className="check-row" key={item.id}><input type="checkbox" checked={form.responsibilities.includes(item.id)} onChange={() => toggleResponsibility(item.id)} disabled={creating || (form.targetType === "platform_assistant" && item.id !== "answer-questions")} /><span>{item.label}</span></label>)}</div>
          ))}
          {row("Model", configFieldSummary("Model"), <span className="field-hint">Workspace default; resolved when the profile is applied.</span>)}
          {form.targetType === "business_agent" && row("Advanced configuration", "Raw AgentConfiguration overrides for tools, memory, context, program, skills, capabilities, retrieval and product bindings. Channels are excluded.", <textarea className="textarea mono json-editor" value={form.configurationJson} onChange={(event) => setForm((current) => ({ ...current, configurationJson: event.target.value }))} disabled={creating} spellCheck={false} />)}
          {form.targetType === "business_agent" && form.offering === "customer-service" && row("Customer-service setup", "Business, booking, intake, support hours and behaviour overrides. Channels are forced empty.", <textarea className="textarea mono json-editor" value={form.setupJson} onChange={(event) => setForm((current) => ({ ...current, setupJson: event.target.value }))} disabled={creating} spellCheck={false} />)}
          {row("Channels", "Channels are deferred in Evals. They are not configured in a sandbox profile.", <span className="field-hint">Deferred</span>)}
        </tbody>
      </table>
    );
  }

  if (error && !profiles) return <ErrorBox message={error} />;
  if (!profiles) return <Loading label="Loading agents" />;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Agents</h2>
            <p className="muted">Create, configure and publish agents through normal Agents APIs.</p>
          </div>
          <button className="button" onClick={openCreate}>
            <Plus size={15} /> New agent
          </button>
        </div>
        {error && <ErrorBox message={error} />}
        {profiles.length === 0 ? (
          <EmptyState title="No agents yet" description="Create an agent to configure and publish it." />
        ) : (
          <div className="card-grid">
            {profiles.map((profile) => {
              const run = profile.latestRun;
              const agentRefId = typeof run?.result.agentRefId === "string" ? run.result.agentRefId : null;
              return (
                <article className="card profile-card" key={profile.id}>
                  <div className="card-head">
                    <div className="card-icon"><Bot size={18} /></div>
                    <StatusBadge status={run?.status ?? "pending"} />
                  </div>
                  <h3>{profile.name}</h3>
                  <p className="muted">
                    {profile.targetType === "platform_assistant" ? "Platform Assistant" : "Business agent"}
                  </p>
                  <div className="kv compact">
                    <div><span>Version</span><code>v{profile.currentVersion}</code></div>
                    <div><span>Updated</span><code>{formatDate(profile.updatedAt)}</code></div>
                    {run && <div><span>Run</span><code className="mono">{shortId(run.id)}</code></div>}
                  </div>
                  {run?.steps?.length ? (
                    <div className="step-list profile-steps">
                      {run.steps.map((item) => <ProfileStep key={item.name} step={item} />)}
                    </div>
                  ) : null}
                  {run?.error && <ErrorBox message={run.error} />}
                  <div className="card-foot profile-actions">
                    <button
                      className="button"
                      onClick={() => void apply(profile)}
                      disabled={applying === profile.id || run?.status === "pending" || run?.status === "running"}
                    >
                      {applying === profile.id ? "Starting…" : run?.status === "ready" ? "Apply again" : "Apply"}
                    </button>
                    <button className="button ghost" onClick={() => openVersion(profile)}>New version</button>
                    {agentRefId && (
                      <a className="button ghost" href={`/sandboxes/${sandboxId}/chat/${agentRefId}`}>
                        Open agent
                      </a>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {open && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !creating) setOpen(false); }}>
          <section className="modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="agent-profile-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Agent setup</div>
                <h2 id="agent-profile-title">{editingProfileId ? "New agent version" : "New agent"}</h2>
              </div>
              <div className="profile-view-toggle" role="group" aria-label="Setup view">
                <button type="button" className={viewMode === "form" ? "active" : ""} onClick={() => setViewMode("form")} disabled={creating}>Form</button>
                <button type="button" className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")} disabled={creating}>Table</button>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)} disabled={creating} aria-label="Close"><X size={17} /></button>
            </div>
            <form onSubmit={create}>
              <div className="modal-body">
                {viewMode === "table" ? renderTable() : (<>
                {!editingProfileId && (
                  <label className="field">
                    <span className="field-label">Template</span>
                    <select
                      className="select"
                      value={templateKey}
                      onChange={(event) => selectTemplate(event.target.value)}
                      disabled={creating}
                    >
                      <option value="">Start from scratch</option>
                      {templates.map((template) => (
                        <option key={template.key} value={template.key}>{template.name}</option>
                      ))}
                    </select>
                    {selectedTemplate && <span className="field-hint">{selectedTemplate.description}</span>}
                  </label>
                )}
                {templateError && <ErrorBox message={templateError} />}
                <label className="field">
                  <span className="field-label">Target</span>
                  <select
                    className="select"
                    value={form.targetType}
                    onChange={(event) => {
                      setTemplateKey("");
                      setForm((current) => ({
                        ...current,
                        targetType: event.target.value as AgentTargetType,
                        agentName: event.target.value === "platform_assistant" ? "Assistant" : "Customer support",
                        responsibilities: event.target.value === "platform_assistant"
                          ? ["answer-questions"]
                          : ["answer-questions", "customer-support", "bookings"],
                      }));
                    }}
                    disabled={creating}
                  >
                    <option value="business_agent">New business agent</option>
                    <option value="platform_assistant">Platform Assistant</option>
                  </select>
                  <span className="field-hint">
                    {form.targetType === "platform_assistant"
                      ? "Configures and publishes the existing Assistant."
                      : "Creates a new agent in this workspace."}
                  </span>
                </label>
                {form.targetType === "business_agent" && (
                  <label className="field">
                    <span className="field-label">Agent kind</span>
                    <select
                      className="select"
                      value={form.offering}
                      onChange={(event) => {
                        setTemplateKey("");
                        setForm((current) => ({ ...current, offering: event.target.value as "customer-service" | "custom" }));
                      }}
                      disabled={creating}
                    >
                      <option value="customer-service">Customer service offering</option>
                      <option value="custom">Custom configuration</option>
                    </select>
                    <span className="field-hint">
                      {form.offering === "customer-service"
                        ? "Uses the product customer-service program and setup."
                        : "Merges the advanced configuration over the platform Assistant draft."}
                    </span>
                  </label>
                )}
                <label className="field">
                  <span className="field-label">Agent name</span>
                  <input className="input" value={form.agentName} onChange={(event) => setForm((current) => ({ ...current, agentName: event.target.value }))} disabled={creating} />
                </label>
                <label className="field">
                  <span className="field-label">Instructions</span>
                  <textarea className="textarea" value={form.instructions} onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))} disabled={creating} />
                </label>
                <label className="field">
                  <span className="field-label">Knowledge title</span>
                  <input className="input" value={form.knowledgeTitle} onChange={(event) => setForm((current) => ({ ...current, knowledgeTitle: event.target.value }))} disabled={creating} />
                </label>
                <label className="field">
                  <span className="field-label">Knowledge content</span>
                  <textarea className="textarea" value={form.knowledgeContent} onChange={(event) => setForm((current) => ({ ...current, knowledgeContent: event.target.value }))} disabled={creating} placeholder="Policy, FAQs or service details" />
                </label>
                <fieldset className="profile-responsibilities">
                  <legend className="field-label">Responsibilities</legend>
                  {responsibilityOptions.map((item) => (
                    <label className="check-row" key={item.id}>
                      <input
                        type="checkbox"
                        checked={form.responsibilities.includes(item.id)}
                        onChange={() => toggleResponsibility(item.id)}
                        disabled={creating || (form.targetType === "platform_assistant" && item.id !== "answer-questions")}
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </fieldset>
                {form.targetType === "business_agent" && (
                  <details className="advanced-config">
                    <summary>Advanced configuration</summary>
                    <label className="field">
                      <span className="field-label">Configuration JSON</span>
                      <textarea
                        className="textarea mono json-editor"
                        value={form.configurationJson}
                        onChange={(event) => setForm((current) => ({ ...current, configurationJson: event.target.value }))}
                        disabled={creating}
                        spellCheck={false}
                      />
                      <span className="field-hint">
                        Full agent configuration overrides: model, tools, memory, context, program, skills, capabilities, retrieval and product bindings. Channels are excluded.
                      </span>
                    </label>
                    {form.offering === "customer-service" && (
                      <label className="field">
                        <span className="field-label">Customer-service setup JSON</span>
                        <textarea
                          className="textarea mono json-editor"
                          value={form.setupJson}
                          onChange={(event) => setForm((current) => ({ ...current, setupJson: event.target.value }))}
                          disabled={creating}
                          spellCheck={false}
                        />
                        <span className="field-hint">Optional business, booking, intake, support hours and behaviour overrides. Channels are forced empty.</span>
                      </label>
                    )}
                  </details>
                )}
                </>)}
                {formError && <ErrorBox message={formError} />}
              </div>
              <div className="modal-actions">
                <button className="button ghost" type="button" onClick={() => setOpen(false)} disabled={creating}>Cancel</button>
                <button className="button" type="submit" disabled={creating}>
                  {creating ? "Saving…" : editingProfileId ? "Create version and apply" : "Create and apply"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

function ProfileStep({ step }: { step: AgentSetupStep }) {
  return (
    <div className={`step ${step.status}`}>
      <StatusBadge status={step.status} />
      <div>
        <strong>{step.name.replace(/^./, (letter) => letter.toUpperCase())}</strong>
        {step.message && <div className="muted small">{step.message}</div>}
      </div>
    </div>
  );
}
