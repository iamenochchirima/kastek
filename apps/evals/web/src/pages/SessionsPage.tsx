import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import type { SessionSummary } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { EmptyState, ErrorBox, Loading, PageHeader, StatCard, StatusBadge } from "../components";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SessionSummary[]>("/api/sessions").then(setSessions).catch((value) => setError(errorMessage(value)));
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!sessions) return <Loading label="Loading sessions" />;

  const completed = sessions.filter((session) => session.state === "completed").length;
  const turns = sessions.reduce((total, session) => total + session.turnCount, 0);

  return (
    <>
      <PageHeader
        eyebrow="Interactive"
        title="Sessions"
        description="Conversations recorded across sandboxes."
      />
      <section className="stat-grid">
        <StatCard label="Sessions" value={sessions.length} hint={`${completed} completed`} icon={<MessageSquare size={16} />} />
        <StatCard label="Turns" value={turns} hint="Recorded task references" icon={<MessageSquare size={16} />} />
      </section>
      <section className="panel">
        {sessions.length === 0 ? <EmptyState title="No sessions yet" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Session</th><th>Sandbox</th><th>State</th><th>Turns</th><th>Conversation</th><th>Last activity</th></tr></thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <Link className="mono-link" to={`/sandboxes/${session.sandboxId}/sessions/${session.id}`}>
                        {shortId(session.id)}
                      </Link>
                    </td>
                    <td><Link className="mono-link" to={`/sandboxes/${session.sandboxId}`}>{shortId(session.sandboxId)}</Link></td>
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
    </>
  );
}
