import { useEffect, useRef, useState } from "react";
import { Bot, Plus, X } from "lucide-react";
import type { AgentProfileDetail, AgentProfileSpec, AgentSetupStep, AgentTargetType } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { EmptyState, ErrorBox, Loading, StatusBadge } from "../components";

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
  const notified = useRef(new Set<string>());
  const defaultForm = {
    targetType: "business_agent" as AgentTargetType,
    agentName: "Customer support",
    instructions: "Help customers with clear, accurate answers. Use approved knowledge and ask for missing details. Do not invent business facts.",
    knowledgeTitle: "Customer support policy",
    knowledgeContent: "",
    responsibilities: ["answer-questions", "customer-support", "bookings"] as AgentProfileSpec["responsibilities"],
  };
  const [form, setForm] = useState(defaultForm);

  function openCreate() {
    setEditingProfileId(null);
    setForm(defaultForm);
    setFormError(null);
    setOpen(true);
  }

  function openVersion(profile: AgentProfileDetail) {
    const spec = profile.version.spec;
    setEditingProfileId(profile.id);
    setForm({
      targetType: spec.targetType,
      agentName: spec.agentName,
      instructions: spec.instructions,
      knowledgeTitle: spec.knowledge.title,
      knowledgeContent: spec.knowledge.content,
      responsibilities: spec.responsibilities,
    });
    setFormError(null);
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
      const spec: AgentProfileSpec = {
        targetType: form.targetType,
        agentName: form.agentName.trim(),
        instructions: form.instructions.trim(),
        knowledge: {
          title: form.knowledgeTitle.trim(),
          content: form.knowledgeContent,
          visibility: "private",
        },
        responsibilities: form.responsibilities,
      };
      if (editingProfileId) {
        await api(`/api/agent-profiles/${encodeURIComponent(editingProfileId)}/versions`, {
          method: "POST",
          body: JSON.stringify({ spec }),
        });
      } else {
        await api(`/api/sandboxes/${encodeURIComponent(sandboxId)}/agent-profiles`, {
          method: "POST",
          body: JSON.stringify({ workspaceRefId, spec }),
        });
      }
      setOpen(false);
      setEditingProfileId(null);
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

  if (error && !profiles) return <ErrorBox message={error} />;
  if (!profiles) return <Loading label="Loading agent profiles" />;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Agent profiles</h2>
            <p className="muted">Configure a published agent through normal Agents APIs.</p>
          </div>
          <button className="button" onClick={openCreate}>
            <Plus size={15} /> New profile
          </button>
        </div>
        {error && <ErrorBox message={error} />}
        {profiles.length === 0 ? (
          <EmptyState title="No agent profiles" description="Create a profile to configure and publish an agent." />
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
                    <div><span>Profile</span><code>v{profile.currentVersion}</code></div>
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
                <h2 id="agent-profile-title">{editingProfileId ? "New profile version" : "New profile"}</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)} disabled={creating} aria-label="Close"><X size={17} /></button>
            </div>
            <form onSubmit={create}>
              <div className="modal-body">
                <label className="field">
                  <span className="field-label">Target</span>
                  <select
                    className="select"
                    value={form.targetType}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      targetType: event.target.value as AgentTargetType,
                      agentName: event.target.value === "platform_assistant" ? "Assistant" : "Customer support",
                      responsibilities: event.target.value === "platform_assistant"
                        ? ["answer-questions"]
                        : ["answer-questions", "customer-support", "bookings"],
                    }))}
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
                {formError && <ErrorBox message={formError} />}
              </div>
              <div className="modal-actions">
                <button className="button ghost" type="button" onClick={() => setOpen(false)} disabled={creating}>Cancel</button>
                <button className="button" type="submit" disabled={creating}>
                  {creating ? "Saving…" : editingProfileId ? "Create version" : "Create profile"}
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
