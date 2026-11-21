import { useEffect, useState } from "react";
import { Bot, Plus, X } from "lucide-react";
import type { ApiAgent } from "../../../shared/types";
import { api, errorMessage, shortId } from "../api";
import { EmptyState, ErrorBox, Loading } from "../components";

const defaultConfiguration = {
  program: { id: "tool-directed", version: "1" },
  executionKind: "business",
  instructions: "Answer from approved knowledge only. Do not invent business facts.",
  model: {
    selection: { kind: "organization_default" },
    maxCostMicros: null,
    maxInputBytes: 16384,
    maxOutputTokens: 4096,
    maxDurationSeconds: 120,
  },
  sourceRevisionIds: [],
  connectedToolBindingIds: [],
  productBindings: [],
  retrievalProfile: { kind: "lexical-v1" },
  memory: { enabled: false },
  context: { mode: "automatic" },
  tools: [],
  skillIds: [],
  capabilities: {
    delegation: { enabled: false },
    sandbox: { enabled: false },
    businessActions: { enabled: false },
    workflows: { enabled: false },
    schedules: { enabled: false },
  },
};

export function ApiAgentsPanel({
  sandboxId,
  onAgentChanged,
}: {
  sandboxId: string;
  onAgentChanged: () => void;
}) {
  const [agents, setAgents] = useState<ApiAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    purpose: "",
    instructions: "Answer from approved knowledge only. Do not invent business facts.",
    configuration: JSON.stringify(defaultConfiguration, null, 2),
  });

  useEffect(() => {
    let cancelled = false;
    api<{ agents: ApiAgent[] }>(`/api/sandboxes/${encodeURIComponent(sandboxId)}/api-agents`)
      .then((value) => { if (!cancelled) { setAgents(value.agents); setError(null); } })
      .catch((value) => { if (!cancelled) setError(errorMessage(value)); });
    return () => { cancelled = true; };
  }, [sandboxId, refresh]);

  function openCreate() {
    setForm({
      name: "",
      purpose: "",
      instructions: "Answer from approved knowledge only. Do not invent business facts.",
      configuration: JSON.stringify(defaultConfiguration, null, 2),
    });
    setFormError(null);
    setOpen(true);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    if (!form.name.trim() || !form.instructions.trim()) {
      setFormError("Name and instructions are required");
      return;
    }
    let configuration: unknown;
    try {
      configuration = JSON.parse(form.configuration || "{}") as unknown;
      if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
        throw new Error("configuration must be a JSON object");
      }
    } catch (value) {
      setFormError(errorMessage(value));
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      await api(`/api/sandboxes/${encodeURIComponent(sandboxId)}/api-agents`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          purpose: form.purpose.trim() || undefined,
          instructions: form.instructions.trim(),
          configuration,
          publish: true,
        }),
      });
      setOpen(false);
      setRefresh((value) => value + 1);
      onAgentChanged();
    } catch (value) {
      setFormError(errorMessage(value));
    } finally {
      setCreating(false);
    }
  }

  if (error && !agents) return <ErrorBox message={error} />;
  if (!agents) return <Loading label="Loading API agents" />;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>API agents</h2>
            <p className="muted">Created and configured through the application API.</p>
          </div>
          <button className="button" onClick={openCreate}><Plus size={15} /> New agent</button>
        </div>
        {error && <ErrorBox message={error} />}
        {agents.length === 0 ? (
          <EmptyState
            title="No API agents yet"
            action={<button className="button" onClick={openCreate}><Plus size={15} /> New agent</button>}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Agent</th><th>Version</th><th>Draft</th><th>Ref</th></tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <div className="agent-cell"><Bot size={15} /><span>{agent.name}</span></div>
                      <span className="muted small mono">{shortId(agent.id)}</span>
                    </td>
                    <td className="mono">{agent.version ? `v${agent.version.number}` : "—"}</td>
                    <td className="mono">{agent.draftRevision || "—"}</td>
                    <td className="mono muted">{agent.agentRefId ? shortId(agent.agentRefId) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {open && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !creating) setOpen(false); }}>
          <section className="modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="api-agent-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Application API</div>
                <h2 id="api-agent-title">New API agent</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)} disabled={creating} aria-label="Close"><X size={17} /></button>
            </div>
            <form onSubmit={create}>
              <div className="modal-body">
                <label className="field">
                  <span className="field-label">Name</span>
                  <input className="input" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Support API agent" autoFocus disabled={creating} />
                </label>
                <label className="field">
                  <span className="field-label">Purpose</span>
                  <input className="input" value={form.purpose} onChange={(event) => setForm((current) => ({ ...current, purpose: event.target.value }))} placeholder="Answer customer questions" disabled={creating} />
                  <span className="field-hint">Optional. Shown to the agent as identity context.</span>
                </label>
                <label className="field">
                  <span className="field-label">Instructions</span>
                  <textarea className="textarea" value={form.instructions} onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))} rows={3} disabled={creating} />
                </label>
                <label className="field">
                  <span className="field-label">Configuration</span>
                  <textarea className="textarea mono json-editor" value={form.configuration} onChange={(event) => setForm((current) => ({ ...current, configuration: event.target.value }))} rows={14} spellCheck={false} disabled={creating} />
                  <span className="field-hint">Tools, model, source revisions, memory and capabilities. Validated by the product before publish.</span>
                </label>
                {formError && <ErrorBox message={formError} />}
              </div>
              <div className="modal-actions">
                <button className="button ghost" type="button" onClick={() => setOpen(false)} disabled={creating}>Cancel</button>
                <button className="button" type="submit" disabled={creating || !form.name.trim() || !form.instructions.trim()}>
                  {creating ? "Creating…" : "Create agent"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
