import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type { SandboxDetail } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { EmptyState, ErrorBox, Loading, PageHeader, StatusBadge } from "../components";

export default function SandboxDetailPage() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<SandboxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const value = await api<SandboxDetail>(`/api/sandboxes/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setDetail(value);
        setError(null);
        if (value.sandbox.status === "provisioning") {
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

  if (error) return <ErrorBox message={error} />;
  if (!detail) return <Loading label="Loading sandbox" />;

  return (
    <>
      <PageHeader
        eyebrow="Sandbox"
        title={shortId(detail.sandbox.id)}
        description={`${detail.sandbox.product} · ${detail.sandbox.status}`}
        actions={<><Link className="button ghost" to="/"><ArrowLeft size={15} /> Sandboxes</Link><StatusBadge status={detail.sandbox.status} /></>}
      />
      <section className="meta-grid">
        <div className="meta-card"><span>Sandbox</span><strong className="mono">{detail.sandbox.id}</strong></div>
        <div className="meta-card"><span>Version</span><strong className="mono">{detail.version?.id ?? "—"}</strong></div>
        <div className="meta-card"><span>Code revision</span><strong className="mono">{detail.version?.codeRevision ?? "—"}</strong></div>
        <div className="meta-card"><span>Schema</span><strong className="mono">{detail.version?.schemaVersion ?? "—"}</strong></div>
        <div className="meta-card"><span>Runtime</span><strong className="mono">{detail.version?.runtimeVersion ?? "—"}</strong></div>
        <div className="meta-card"><span>Profile</span><strong>{detail.sandbox.profile}</strong></div>
        <div className="meta-card"><span>Created</span><strong>{formatDate(detail.sandbox.createdAt)}</strong></div>
        <div className="meta-card"><span>Provisioned</span><strong>{formatDate(detail.sandbox.provisionedAt)}</strong></div>
        {typeof detail.sandbox.runtime.productApiUrl === "string" && (
          <div className="meta-card"><span>Product API</span><strong className="mono">{detail.sandbox.runtime.productApiUrl}</strong></div>
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

      <section className="panel">
        <div className="panel-head">
          <div><h2>Agents</h2><p className="muted">Immutable product agent versions recorded in this sandbox.</p></div>
        </div>
        {detail.agents.length === 0 ? <EmptyState title="No agents" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Reference</th><th>Product agent</th><th>Version</th><th>Workspace</th><th>Created</th></tr></thead>
              <tbody>
                {detail.agents.map((agent) => (
                  <tr key={agent.id}>
                    <td className="mono">{shortId(agent.id)}</td>
                    <td className="mono">{agent.productAgentId}</td>
                    <td className="mono">{agent.productVersionId}</td>
                    <td className="mono">{shortId(agent.workspaceRefId)}</td>
                    <td className="muted">{formatDate(agent.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div><h2>Sessions</h2><p className="muted">Interactive conversations recorded for this sandbox.</p></div>
          <Link className="text-link" to="/sessions">All sessions</Link>
        </div>
        {detail.sessions.length === 0 ? <EmptyState title="No sessions" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Session</th><th>State</th><th>Turns</th><th>Conversation</th><th>Last activity</th></tr></thead>
              <tbody>
                {detail.sessions.map((session) => (
                  <tr key={session.id}>
                    <td><Link className="mono-link" to={`/sandboxes/${detail.sandbox.id}/sessions/${session.id}`}>{shortId(session.id)}</Link></td>
                    <td><StatusBadge status={session.state} /></td>
                    <td>{session.turnCount}</td>
                    <td className="mono muted">{shortId(session.productConversationId)}</td>
                    <td className="muted">{formatDate(session.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div><h2>Outcomes</h2><p className="muted">Saved business results linked to this sandbox.</p></div>
          <Link className="text-link" to="/outcomes">All outcomes</Link>
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
    </>
  );
}
