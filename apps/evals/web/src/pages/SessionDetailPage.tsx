import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type { SessionDetail } from "../../../shared/types";
import { api, errorMessage, formatDate, shortDigest, shortId } from "../api";
import { EmptyState, ErrorBox, Loading, PageHeader, StatusBadge } from "../components";

export default function SessionDetailPage() {
  const { id = "", sessionId = "" } = useParams();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SessionDetail>(`/api/sandboxes/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`)
      .then(setDetail)
      .catch((value) => setError(errorMessage(value)));
  }, [id, sessionId]);

  if (error) return <ErrorBox message={error} />;
  if (!detail) return <Loading label="Loading session" />;

  const { session } = detail;

  return (
    <>
      <PageHeader
        eyebrow="Session"
        title={shortId(session.id)}
        description={`Sandbox ${shortId(session.sandboxId)} · ${session.turnCount} turns`}
        actions={<><Link className="button ghost" to={`/sandboxes/${session.sandboxId}`}><ArrowLeft size={15} /> Sandbox</Link><StatusBadge status={session.state} /></>}
      />
      <section className="meta-grid">
        <div className="meta-card"><span>Session</span><strong className="mono">{session.id}</strong></div>
        <div className="meta-card"><span>Agent reference</span><strong className="mono">{session.agentRefId}</strong></div>
        <div className="meta-card"><span>Workspace</span><strong className="mono">{session.workspaceRefId}</strong></div>
        <div className="meta-card"><span>Conversation</span><strong className="mono">{session.productConversationId}</strong></div>
        <div className="meta-card"><span>First task</span><strong className="mono">{session.firstTaskId}</strong></div>
        <div className="meta-card"><span>Latest task</span><strong className="mono">{session.latestTaskId}</strong></div>
        <div className="meta-card"><span>Created</span><strong>{formatDate(session.createdAt)}</strong></div>
        <div className="meta-card"><span>Last activity</span><strong>{formatDate(session.lastActivityAt)}</strong></div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div><h2>Turns</h2><p className="muted">Task references and digests recorded by the control plane.</p></div>
        </div>
        {detail.turns.length === 0 ? <EmptyState title="No turns" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Task</th><th>State</th><th>Input digest</th><th>Output digest</th><th>Updated</th></tr></thead>
              <tbody>
                {detail.turns.map((turn) => (
                  <tr key={turn.id}>
                    <td>{turn.sequence}</td>
                    <td className="mono">{turn.productTaskId}</td>
                    <td><StatusBadge status={turn.state} /></td>
                    <td className="mono muted" title={turn.inputDigest}>{shortDigest(turn.inputDigest)}</td>
                    <td className="mono muted" title={turn.outputDigest ?? ""}>{shortDigest(turn.outputDigest)}</td>
                    <td className="muted">{formatDate(turn.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small transcript-note">Transcript text stays in the product runtime.</p>
      </section>
    </>
  );
}
