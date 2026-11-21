import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Boxes, ClipboardCheck, MessageSquare, Plug, Plus, Trash2, X } from "lucide-react";
import type { SandboxDetail, SandboxSummary } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { ConfirmDialog, EmptyState, ErrorBox, Loading, PageHeader, StatCard, StatusBadge } from "../components";

export default function SandboxesPage() {
  const navigate = useNavigate();
  const [sandboxes, setSandboxes] = useState<SandboxSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [product, setProduct] = useState<"agents" | "growth">("agents");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SandboxSummary | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [apiOpen, setApiOpen] = useState(false);
  const [apiBusy, setApiBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiMode, setApiMode] = useState<"test" | "existing">("test");
  const [apiForm, setApiForm] = useState({
    name: "",
    baseUrl: "http://127.0.0.1:4100",
    organizationName: "",
    organizationId: "",
    applicationId: "",
    credential: "",
  });

  useEffect(() => {
    api<SandboxSummary[]>("/api/sandboxes").then(setSandboxes).catch((value) => setError(errorMessage(value)));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, creating]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceName.trim() || creating) return;
    setCreating(true);
    setFormError(null);
    try {
      const created = await api<SandboxDetail>("/api/sandboxes", {
        method: "POST",
        body: JSON.stringify({
          product,
          label: label.trim() || undefined,
          workspaceName: workspaceName.trim(),
        }),
      });
      setOpen(false);
      navigate(`/sandboxes/${created.sandbox.id}`);
    } catch (value) {
      setFormError(errorMessage(value));
    } finally {
      setCreating(false);
    }
  }

  async function connectApi(event: React.FormEvent) {
    event.preventDefault();
    if (apiBusy) return;
    setApiBusy(true);
    setApiError(null);
    try {
      const endpoint = apiMode === "test"
        ? "/api/api-environments/test"
        : "/api/api-environments";
      const body = apiMode === "test"
        ? {
            name: apiForm.name.trim(),
            baseUrl: apiForm.baseUrl.trim(),
            ...(apiForm.organizationName.trim()
              ? { organizationName: apiForm.organizationName.trim() }
              : {}),
          }
        : {
            name: apiForm.name.trim(),
            baseUrl: apiForm.baseUrl.trim(),
            organizationId: apiForm.organizationId.trim(),
            applicationId: apiForm.applicationId.trim(),
            credential: apiForm.credential.trim(),
          };
      const result = await api<{ environment: SandboxDetail }>(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setApiOpen(false);
      setApiForm((current) => ({
        ...current,
        name: "",
        organizationName: "",
        organizationId: "",
        applicationId: "",
        credential: "",
      }));
      navigate(`/sandboxes/${result.environment.sandbox.id}`);
    } catch (value) {
      setApiError(errorMessage(value));
    } finally {
      setApiBusy(false);
    }
  }

  async function deleteOne() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/api/sandboxes/${encodeURIComponent(deleteTarget.sandbox.id)}`, { method: "DELETE" });
      const refreshed = await api<SandboxSummary[]>("/api/sandboxes");
      setSandboxes(refreshed);
      setDeleteTarget(null);
    } catch (value) {
      setDeleteError(errorMessage(value));
    } finally {
      setDeleting(false);
    }
  }

  async function deleteAll() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>("/api/sandboxes", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const refreshed = await api<SandboxSummary[]>("/api/sandboxes");
      setSandboxes(refreshed);
      if (result.failed.length > 0) {
        setDeleteError(
          `${result.failed.length} sandbox${result.failed.length === 1 ? "" : "es"} could not be deleted: ${result.failed[0]!.error}`,
        );
        return;
      }
      setDeleteAllOpen(false);
    } catch (value) {
      setDeleteError(errorMessage(value));
    } finally {
      setDeleting(false);
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!sandboxes) return <Loading label="Loading sandboxes" />;

  const active = sandboxes.filter((item) => ["active", "ready"].includes(item.sandbox.status)).length;
  const sessions = sandboxes.reduce((total, item) => total + item.counts.sessions, 0);
  const outcomes = sandboxes.reduce((total, item) => total + item.counts.outcomes, 0);

  return (
    <>
      <PageHeader
        eyebrow="Control plane"
        title="Environments"
        description="Sandboxes and deployed products recorded by the evaluation service."
        actions={
          <>
            {sandboxes.length > 0 && (
              <button
                className="button ghost destructive"
                onClick={() => { setDeleteAllOpen(true); setDeleteError(null); }}
              >
                <Trash2 size={15} /> Delete all
              </button>
            )}
            <button className="button ghost" onClick={() => { setApiOpen(true); setApiError(null); }}>
              <Plug size={15} /> Connect API
            </button>
            <button className="button" onClick={() => { setOpen(true); setFormError(null); }}><Plus size={15} /> Create sandbox</button>
          </>
        }
      />
      <section className="stat-grid">
        <StatCard label="Environments" value={sandboxes.length} hint={`${active} ready`} icon={<Boxes size={16} />} />
        <StatCard label="Sessions" value={sessions} hint="Interactive conversations" icon={<MessageSquare size={16} />} />
        <StatCard label="Outcomes" value={outcomes} hint="Saved business results" icon={<ClipboardCheck size={16} />} />
      </section>
      {sandboxes.length === 0 ? (
        <section className="panel">
          <EmptyState title="No sandboxes yet" />
        </section>
      ) : (
        <div className="card-grid">
          {sandboxes.map((item) => (
            <div className="card card-link" key={item.sandbox.id}>
              <Link
                className="card-stretched-link"
                to={`/sandboxes/${item.sandbox.id}`}
                aria-label={`Open sandbox ${shortId(item.sandbox.id)}`}
              />
              <div className="card-head">
                <div className="card-icon"><Boxes size={18} /></div>
                <div className="card-head-actions">
                  <StatusBadge status={item.sandbox.status} />
                  <button
                    className="icon-button danger card-delete"
                    aria-label="Delete sandbox"
                    onClick={() => {
                      setDeleteTarget(item);
                      setDeleteError(null);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <h3 className={item.sandbox.profile === "api" ? "" : "mono"}>
                {item.sandbox.profile === "api" && typeof item.sandbox.runtime.name === "string"
                  ? item.sandbox.runtime.name
                  : shortId(item.sandbox.id)}
              </h3>
              {item.sandbox.profile === "api" && typeof item.sandbox.runtime.name === "string" && (
                <p className="muted small mono">{shortId(item.sandbox.id)}</p>
              )}
              <p className="muted">{item.sandbox.profile === "api" ? "API environment" : `${item.sandbox.product} · ${item.sandbox.profile}`}</p>
              <div className="kv compact">
                <div><span>Version</span><code>{item.version ? shortId(item.version.id) : "none"}</code></div>
                <div><span>Workspaces</span><code>{item.workspaceRefs.length}</code></div>
                <div><span>Agents</span><code>{item.counts.agents}</code></div>
                <div><span>Sessions</span><code>{item.counts.sessions}</code></div>
                <div><span>Outcomes</span><code>{item.counts.outcomes}</code></div>
              </div>
              <div className="card-foot">
                <span className="muted small">Updated {formatDate(item.sandbox.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${shortId(deleteTarget.sandbox.id)}?`}
          description={
            deleteTarget.sandbox.profile === "api"
              ? "This removes the stored credential and retires the environment. The deployment and its agents are not changed."
              : "This stops the sandbox, drops its database, removes its local files, and deletes any paired runtime. This cannot be undone."
          }
          busy={deleting}
          busyLabel="Deleting…"
          error={deleteError}
          onConfirm={deleteOne}
          onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(null); } }}
        />
      )}

      {deleteAllOpen && (
        <ConfirmDialog
          title="Delete all sandboxes?"
          description={`This deletes ${sandboxes.length} sandbox${sandboxes.length === 0 ? "" : "es"}, including paired runtimes and their databases. This cannot be undone.`}
          confirmationText="DELETE"
          confirmLabel="Delete all"
          busy={deleting}
          busyLabel="Deleting…"
          error={deleteError}
          onConfirm={deleteAll}
          onCancel={() => { if (!deleting) { setDeleteAllOpen(false); setDeleteError(null); } }}
        />
      )}

      {open && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !creating) setOpen(false); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-sandbox-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Control plane</div>
                <h2 id="create-sandbox-title">Create sandbox</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)} disabled={creating} aria-label="Close">
                <X size={17} />
              </button>
            </div>
            <form onSubmit={create}>
              <div className="modal-body">
                <label className="field">
                  <span className="field-label">Product</span>
                  <select className="select" value={product} onChange={(event) => setProduct(event.target.value as "agents" | "growth")} disabled={creating}>
                    <option value="agents">Agents</option>
                    <option value="growth">Growth</option>
                  </select>
                  <span className="field-hint">
                    {product === "growth" ? "Creates a Growth sandbox and paired Agents runtime." : "Creates one Agents sandbox."}
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">{product === "growth" ? "Business name" : "Workspace name"}</span>
                  <input
                    className="input"
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder={product === "growth" ? "Acme business" : "Acme support"}
                    autoFocus
                    disabled={creating}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Sandbox label</span>
                  <input
                    className="input"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Support experiments"
                    disabled={creating}
                  />
                  <span className="field-hint">Optional. Used only in the client.</span>
                </label>
                {formError && <ErrorBox message={formError} />}
              </div>
              <div className="modal-actions">
                <button className="button ghost" type="button" onClick={() => setOpen(false)} disabled={creating}>Cancel</button>
                <button className="button" type="submit" disabled={creating || !workspaceName.trim()}>
                  {creating ? "Creating…" : "Create sandbox"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {apiOpen && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !apiBusy) setApiOpen(false); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-api-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Application API</div>
                <h2 id="connect-api-title">Connect API environment</h2>
              </div>
              <button className="icon-button" onClick={() => setApiOpen(false)} disabled={apiBusy} aria-label="Close">
                <X size={17} />
              </button>
            </div>
            <form onSubmit={connectApi}>
              <div className="modal-body">
                <label className="field">
                  <span className="field-label">Method</span>
                  <select
                    className="select"
                    value={apiMode}
                    onChange={(event) => setApiMode(event.target.value as "test" | "existing")}
                    disabled={apiBusy}
                  >
                    <option value="test">Create test org</option>
                    <option value="existing">Use existing credential</option>
                  </select>
                  <span className="field-hint">
                    {apiMode === "test"
                      ? "Creates an organization, agent and application in the deployment. Requires a connected sandbox owner session."
                      : "Connects an application credential issued by the deployment."}
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    className="input"
                    value={apiForm.name}
                    onChange={(event) => setApiForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Agents staging"
                    autoFocus
                    disabled={apiBusy}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Base URL</span>
                  <input
                    className="input mono"
                    value={apiForm.baseUrl}
                    onChange={(event) => setApiForm((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder="https://agents.example.com"
                    disabled={apiBusy}
                  />
                </label>
                {apiMode === "test" ? (
                  <label className="field">
                    <span className="field-label">Organization name</span>
                    <input
                      className="input"
                      value={apiForm.organizationName}
                      onChange={(event) => setApiForm((current) => ({ ...current, organizationName: event.target.value }))}
                      placeholder="Evals test org"
                      disabled={apiBusy}
                    />
                    <span className="field-hint">Optional. Defaults to the environment name.</span>
                  </label>
                ) : (
                  <>
                    <label className="field">
                      <span className="field-label">Organization ID</span>
                      <input
                        className="input mono"
                        value={apiForm.organizationId}
                        onChange={(event) => setApiForm((current) => ({ ...current, organizationId: event.target.value }))}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        disabled={apiBusy}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Application ID</span>
                      <input
                        className="input mono"
                        value={apiForm.applicationId}
                        onChange={(event) => setApiForm((current) => ({ ...current, applicationId: event.target.value }))}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        disabled={apiBusy}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Credential</span>
                      <input
                        className="input mono"
                        type="password"
                        value={apiForm.credential}
                        onChange={(event) => setApiForm((current) => ({ ...current, credential: event.target.value }))}
                        placeholder="kat_…"
                        autoComplete="off"
                        disabled={apiBusy}
                      />
                      <span className="field-hint">Needs agents:read, agents:manage and agents:publish.</span>
                    </label>
                  </>
                )}
                {apiError && <ErrorBox message={apiError} />}
              </div>
              <div className="modal-actions">
                <button className="button ghost" type="button" onClick={() => setApiOpen(false)} disabled={apiBusy}>Cancel</button>
                <button
                  className="button"
                  type="submit"
                  disabled={apiBusy || !apiForm.name.trim() || !apiForm.baseUrl.trim() ||
                    (apiMode === "existing" && (!apiForm.organizationId.trim() || !apiForm.applicationId.trim() || !apiForm.credential.trim()))}
                >
                  {apiBusy ? "Connecting…" : apiMode === "test" ? "Create environment" : "Connect"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
