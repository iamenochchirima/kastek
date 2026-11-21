import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Bot, MessageSquare, RefreshCw, Trash2 } from "lucide-react";
import type { MountedSyncResult, ProductAgent, SandboxDetail } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { ConfirmDialog, EmptyState, ErrorBox, Loading, PageHeader, StatusBadge } from "../components";
import { AgentProfilesPanel } from "../panels/AgentProfilesPanel";
import { ApiAgentsPanel } from "../panels/ApiAgentsPanel";

type Tab = "overview" | "agents" | "profiles" | "sessions" | "outcomes";

export default function SandboxDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<SandboxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("agents");
  const [productAgents, setProductAgents] = useState<ProductAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [agentsRefresh, setAgentsRefresh] = useState(0);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [mountedOpen, setMountedOpen] = useState(false);
  const [mountedBusy, setMountedBusy] = useState(false);
  const [mountedError, setMountedError] = useState<string | null>(null);
  const [mountedResult, setMountedResult] = useState<MountedSyncResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const value = await api<SandboxDetail>(`/api/sandboxes/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setDetail(value);
        setError(null);
        if ((value.sandbox.runtime as Record<string, unknown>).kind === "api") {
          setTab("overview");
        }
        if (value.sandbox.status === "provisioning") {
          setTab("overview");
          timer = setTimeout(load, 1_000);
        }
      } catch (value) {
        if (!cancelled) setError(errorMessage(value));
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!detail || detail.sandbox.status === "provisioning") return;
    if ((detail.sandbox.runtime as Record<string, unknown>).kind === "api") {
      setProductAgents([]);
      setAgentsError(null);
      return;
    }
    let cancelled = false;
    setProductAgents(null);
    setAgentsError(null);
    api<{ agents: ProductAgent[] }>(`/api/sandboxes/${encodeURIComponent(id)}/product-agents`)
      .then((value) => { if (!cancelled) setProductAgents(value.agents); })
      .catch((value) => { if (!cancelled) setAgentsError(errorMessage(value)); });
    return () => { cancelled = true; };
  }, [detail?.sandbox.status, id, agentsRefresh]);

  async function syncSandbox() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await api(`/api/sandboxes/${encodeURIComponent(id)}/sync`, {
        method: "POST",
        body: JSON.stringify({ confirm: "UPDATE" }),
      });
      const refreshed = await api<SandboxDetail>(`/api/sandboxes/${encodeURIComponent(id)}`);
      setDetail(refreshed);
      setAgentsRefresh((value) => value + 1);
      setSyncOpen(false);
      setTab("overview");
    } catch (value) {
      setSyncError(errorMessage(value));
    } finally {
      setSyncing(false);
    }
  }

  async function syncMountedSandbox() {
    if (mountedBusy) return;
    setMountedBusy(true);
    setMountedError(null);
    try {
      const result = await api<MountedSyncResult>(
        `/api/sandboxes/${encodeURIComponent(id)}/mounted-sync`,
        { method: "POST" },
      );
      const refreshed = await api<SandboxDetail>(`/api/sandboxes/${encodeURIComponent(id)}`);
      setDetail(refreshed);
      setAgentsRefresh((value) => value + 1);
      setMountedResult(result);
      setMountedOpen(false);
      setTab("overview");
    } catch (value) {
      setMountedError(errorMessage(value));
    } finally {
      setMountedBusy(false);
    }
  }

  async function restartRuntime() {
    if (restarting) return;
    setRestarting(true);
    setRestartError(null);
    try {
      await api(`/api/sandboxes/${encodeURIComponent(id)}/runtime/restart`, { method: "POST" });
      const refreshed = await api<SandboxDetail>(`/api/sandboxes/${encodeURIComponent(id)}`);
      setDetail(refreshed);
      const agents = await api<{ agents: ProductAgent[] }>(
        `/api/sandboxes/${encodeURIComponent(id)}/product-agents`,
      );
      setProductAgents(agents.agents);
      setAgentsError(null);
    } catch (value) {
      setRestartError(errorMessage(value));
    } finally {
      setRestarting(false);
    }
  }

  async function deleteSandbox() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/api/sandboxes/${encodeURIComponent(detail!.sandbox.id)}`, { method: "DELETE" });
      navigate("/");
    } catch (value) {
      setDeleteError(errorMessage(value));
    } finally {
      setDeleting(false);
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!detail) return <Loading label="Loading sandbox" />;

  const runtime = detail.sandbox.runtime as Record<string, unknown>;
  const isApi = runtime.kind === "api";
  const isMounted = !isApi && (typeof runtime.sessionFile === "string" ||
    (typeof runtime.apiUrl === "string" && runtime.productDatabase == null));
  const agentName = (refId: string) =>
    productAgents?.find((agent) => agent.refId === refId)?.name ?? shortId(refId);
  const tabs: Array<{ id: Tab; label: string; count?: number }> = isApi
    ? [
        { id: "overview", label: "Overview" },
        { id: "profiles", label: "Agents" },
      ]
    : [
        { id: "overview", label: "Overview" },
        { id: "agents", label: "Published", count: productAgents?.length },
        ...(detail.sandbox.product === "agents"
          ? [{ id: "profiles" as const, label: "Agents" }]
          : []),
        { id: "sessions", label: "Sessions", count: detail.sessions.length },
        { id: "outcomes", label: "Outcomes", count: detail.outcomes.length },
      ];

  return (
    <>
      <PageHeader
        eyebrow={isApi ? "Application API" : "Sandbox"}
        title={isApi && typeof runtime.name === "string" ? runtime.name : shortId(detail.sandbox.id)}
        description={`${isApi ? "API environment" : detail.sandbox.product} · ${detail.sandbox.status}`}
        actions={
          <>
            <Link className="button ghost" to="/"><ArrowLeft size={15} /> Environments</Link>
            {isApi ? null : isMounted ? (
              <button
                className="button ghost"
                onClick={() => { setMountedOpen(true); setMountedError(null); }}
                disabled={mountedBusy || detail.sandbox.status === "provisioning" || detail.sandbox.status === "retired"}
              >
                <RefreshCw size={15} /> {mountedBusy ? "Syncing…" : "Sync mounted sandbox"}
              </button>
            ) : (
              <>
                <button
                  className="button ghost"
                  onClick={() => { setSyncOpen(true); setSyncError(null); }}
                  disabled={syncing || detail.sandbox.status === "provisioning" || detail.sandbox.status === "retired"}
                >
                  <RefreshCw size={15} /> {syncing ? "Updating…" : "Update sandbox"}
                </button>
                <button
                  className="button ghost"
                  onClick={restartRuntime}
                  disabled={restarting || syncing || detail.sandbox.status === "provisioning" || detail.sandbox.status === "retired"}
                >
                  <RefreshCw size={15} /> {restarting ? "Restarting…" : "Restart runtime"}
                </button>
              </>
            )}
            <button
              className="button ghost destructive"
              onClick={() => { setDeleteOpen(true); setDeleteError(null); }}
              disabled={detail.sandbox.status === "provisioning" || detail.sandbox.status === "retired"}
            >
              <Trash2 size={15} /> Delete
            </button>
            <StatusBadge status={detail.sandbox.status} />
          </>
        }
      />

      {mountedOpen && (
        <ConfirmDialog
          title="Sync mounted sandbox?"
          description="Refresh the owner session check, current agent versions, model catalogue and sandbox version metadata from the mounted workspace. No runtime is restarted and no product data is copied."
          confirmLabel="Sync sandbox"
          busyLabel="Syncing…"
          busy={mountedBusy}
          error={mountedError}
          onConfirm={syncMountedSandbox}
          onCancel={() => { if (!mountedBusy) { setMountedOpen(false); setMountedError(null); } }}
        />
      )}

      {mountedResult && (
        <section className="card">
          <div className="card-head"><h3>Mounted sandbox synced</h3></div>
          <div className="kv compact">
            <div><span>Version</span><code>{shortId(mountedResult.version.id)}</code></div>
            <div><span>Code revision</span><code>{mountedResult.version.codeRevision}</code></div>
            <div><span>Schema</span><code>{mountedResult.schema.version}</code></div>
            <div><span>Latest migration</span><code>{mountedResult.schema.latestMigration ?? "unknown"}</code></div>
            <div><span>Active agents</span><code>{mountedResult.agents.active}</code></div>
            <div><span>Retired refs</span><code>{mountedResult.agents.retired}</code></div>
            <div><span>Models refreshed</span><code>{mountedResult.models.refreshed}</code></div>
          </div>
          {mountedResult.models.warnings.length > 0 && (
            <p className="muted small">{mountedResult.models.warnings.join(" · ")}</p>
          )}
        </section>
      )}

      {syncOpen && (
        <ConfirmDialog
          title="Update sandbox?"
          description="Apply the current product code and schema migrations, restart the runtime, run smoke checks and record a new sandbox version. Workspace data and existing sessions are preserved. Active conversations block the update."
          confirmationText="UPDATE"
          confirmLabel="Update sandbox"
          busyLabel="Updating…"
          busy={syncing}
          error={syncError}
          onConfirm={syncSandbox}
          onCancel={() => { if (!syncing) { setSyncOpen(false); setSyncError(null); } }}
        />
      )}

      {deleteOpen && (
        <ConfirmDialog
          title={`Delete ${shortId(detail.sandbox.id)}?`}
          description={
            detail.pair
              ? "This stops both the sandbox and its paired runtime, drops their databases, removes local files, and hides them from the list. This cannot be undone."
              : "This stops the sandbox, drops its database, removes its local files, and hides it from the list. This cannot be undone."
          }
          busy={deleting}
          busyLabel="Deleting…"
          error={deleteError}
          onConfirm={deleteSandbox}
          onCancel={() => { if (!deleting) { setDeleteOpen(false); setDeleteError(null); } }}
        />
      )}

      {restartError && <ErrorBox message={restartError} />}

      <div className="tabs">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={`tab${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.count != null && <span className="tab-count">{item.count}</span>}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <section className="meta-grid">
            <div className="meta-card"><span>Sandbox</span><strong className="mono">{detail.sandbox.id}</strong></div>
            <div className="meta-card"><span>Version</span><strong className="mono">{detail.version?.id ?? "—"}</strong></div>
            <div className="meta-card"><span>Code revision</span><strong className="mono">{detail.version?.codeRevision ?? "—"}</strong></div>
            <div className="meta-card"><span>Schema</span><strong className="mono">{detail.version?.schemaVersion ?? "—"}</strong></div>
            <div className="meta-card"><span>Runtime</span><strong className="mono">{detail.version?.runtimeVersion ?? "—"}</strong></div>
            <div className="meta-card"><span>Runtime</span><strong>{detail.sandbox.profile}</strong></div>
            <div className="meta-card"><span>Created</span><strong>{formatDate(detail.sandbox.createdAt)}</strong></div>
            <div className="meta-card"><span>{isApi ? "Connected" : "Provisioned"}</span><strong>{formatDate(detail.sandbox.provisionedAt)}</strong></div>
            {typeof detail.sandbox.runtime.productApiUrl === "string" && (
              <div className="meta-card"><span>Product API</span><strong className="mono">{detail.sandbox.runtime.productApiUrl}</strong></div>
            )}
            {isApi && typeof runtime.baseUrl === "string" && (
              <div className="meta-card"><span>Base URL</span><strong className="mono">{runtime.baseUrl}</strong></div>
            )}
            {isApi && typeof runtime.organizationId === "string" && (
              <div className="meta-card"><span>Organization</span><strong className="mono">{runtime.organizationId}</strong></div>
            )}
            {isApi && typeof runtime.applicationId === "string" && (
              <div className="meta-card"><span>Application</span><strong className="mono">{runtime.applicationId}</strong></div>
            )}
            {detail.pair && (
              <div className="meta-card">
                <span>Paired sandbox</span>
                <strong>
                  <Link to={`/sandboxes/${detail.pair.growthSandboxId === detail.sandbox.id ? detail.pair.agentsSandboxId : detail.pair.growthSandboxId}`}>
                    {shortId(detail.pair.growthSandboxId === detail.sandbox.id ? detail.pair.agentsSandboxId : detail.pair.growthSandboxId)}
                  </Link>
                </strong>
              </div>
            )}
          </section>

          {detail.sandbox.provisioningSteps.length > 0 && detail.sandbox.status !== "ready" && (
            <section className="panel">
              <div className="panel-head">
                <div><h2>Provisioning</h2><p className="muted">Environment setup progress.</p></div>
                <StatusBadge status={detail.sandbox.status} />
              </div>
              {detail.sandbox.provisioningError && <ErrorBox message={detail.sandbox.provisioningError} />}
              <div className="step-list">
                {detail.sandbox.provisioningSteps.map((step) => (
                  <div className={`step ${step.status}`} key={step.name}>
                    <StatusBadge status={step.status} />
                    <div>
                      <strong>{step.name.replace(/^./, (letter) => letter.toUpperCase())}</strong>
                      {step.message && <div className="muted small">{step.message}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <div><h2>Workspaces</h2><p className="muted">Product tenants attached to this sandbox.</p></div>
            </div>
            {detail.workspaceRefs.length === 0 ? <EmptyState title="No workspaces" /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Reference</th><th>Product workspace</th><th>Label</th><th>Created</th></tr></thead>
                  <tbody>
                    {detail.workspaceRefs.map((workspace) => (
                      <tr key={workspace.id}>
                        <td className="mono">{shortId(workspace.id)}</td>
                        <td className="mono">{workspace.productWorkspaceId}</td>
                        <td>{workspace.label ?? "—"}</td>
                        <td className="muted">{formatDate(workspace.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {tab === "agents" && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Published agents</h2>
              <p className="muted">Published agents in this workspace.</p>
            </div>
            {detail.sandbox.product === "growth" && <span className="ref-chip">Growth default agents</span>}
          </div>
          {agentsError ? <ErrorBox message={agentsError} /> : productAgents === null ? (
            <Loading label="Loading product agents" />
          ) : productAgents.length === 0 ? (
            <EmptyState title="No product agents" description="This workspace has no agents yet." />
          ) : (
            <div className="card-grid">
              {productAgents.map((agent) => (
                <article className="card product-agent-card" key={agent.refId}>
                  <div className="card-head">
                    <div className="card-icon"><Bot size={18} /></div>
                    <StatusBadge status={agent.ready ? "ready" : "draft"} />
                  </div>
                  <h3>{agent.name}</h3>
                  <p className="muted">{agent.description || "No description"}</p>
                  <div className="kv compact">
                    <div><span>Model</span><code>{agent.model?.label ?? "Workspace default"}</code></div>
                    <div><span>Revision</span><code>{agent.revision ?? "—"}</code></div>
                    <div><span>Specialists</span><code>{agent.specialists.length || "—"}</code></div>
                  </div>
                  <div className="card-foot">
                    {agent.ready ? (
                      <Link className="button ghost" to={`/sandboxes/${detail.sandbox.id}/chat/${agent.refId}`}>
                        <MessageSquare size={15} /> Chat
                      </Link>
                    ) : (
                      <span className="ref-chip">Publish before chat</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "profiles" && detail.sandbox.product === "agents" && (
        detail.workspaceRefs[0] ? (
          isApi ? (
            <ApiAgentsPanel
              sandboxId={detail.sandbox.id}
              onAgentChanged={() => setAgentsRefresh((value) => value + 1)}
            />
          ) : (
            <AgentProfilesPanel
              sandboxId={detail.sandbox.id}
              workspaceRefId={detail.workspaceRefs[0].id}
              onAgentChanged={() => setAgentsRefresh((value) => value + 1)}
            />
          )
        ) : (
          <section className="panel"><EmptyState title="No workspace" description="Agent setup requires a workspace reference." /></section>
        )
      )}

      {tab === "sessions" && (
        <section className="panel">
          <div className="panel-head">
            <div><h2>Sessions</h2><p className="muted">Interactive conversations recorded for this sandbox.</p></div>
          </div>
          {detail.sessions.length === 0 ? <EmptyState title="No sessions" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Session</th><th>Agent</th><th>State</th><th>Turns</th><th>Last activity</th><th /></tr></thead>
                <tbody>
                  {detail.sessions.map((session) => (
                    <tr key={session.id}>
                      <td className="mono">{shortId(session.id)}</td>
                      <td>{agentName(session.agentRefId)}</td>
                      <td><StatusBadge status={session.state} /></td>
                      <td>{session.turnCount}</td>
                      <td className="muted">{formatDate(session.lastActivityAt)}</td>
                      <td>
                        <Link className="text-link" to={`/sandboxes/${detail.sandbox.id}/chat/${session.agentRefId}?session=${session.id}`}>
                          Open chat
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "outcomes" && (
        <section className="panel">
          <div className="panel-head">
            <div><h2>Outcomes</h2><p className="muted">Saved business results linked to this sandbox.</p></div>
          </div>
          {detail.outcomes.length === 0 ? <EmptyState title="No outcomes" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Outcome</th><th>Kind</th><th>Status</th><th>Product outcome</th><th>Record</th><th>Created</th></tr></thead>
                <tbody>
                  {detail.outcomes.map((outcome) => (
                    <tr key={outcome.id}>
                      <td className="mono">{shortId(outcome.id)}</td>
                      <td>{outcome.kind}</td>
                      <td><StatusBadge status={outcome.status} /></td>
                      <td className="mono">{outcome.productOutcomeId}</td>
                      <td className="mono muted">{outcome.productRecordId ? shortId(outcome.productRecordId) : "—"}</td>
                      <td className="muted">{formatDate(outcome.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
