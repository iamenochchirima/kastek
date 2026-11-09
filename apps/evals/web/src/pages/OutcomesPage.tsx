import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardCheck } from "lucide-react";
import type { OutcomeSummary } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { EmptyState, ErrorBox, Loading, PageHeader, StatCard, StatusBadge } from "../components";

export default function OutcomesPage() {
  const [outcomes, setOutcomes] = useState<OutcomeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<OutcomeSummary[]>("/api/outcomes").then(setOutcomes).catch((value) => setError(errorMessage(value)));
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!outcomes) return <Loading label="Loading outcomes" />;

  const submitted = outcomes.filter((outcome) => outcome.status === "submitted").length;

  return (
    <>
      <PageHeader
        eyebrow="Business results"
        title="Outcomes"
        description="Saved product results linked to sandbox sessions."
      />
      <section className="stat-grid">
        <StatCard label="Outcomes" value={outcomes.length} hint={`${submitted} submitted`} icon={<ClipboardCheck size={16} />} />
      </section>
      <section className="panel">
        {outcomes.length === 0 ? <EmptyState title="No outcomes yet" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Outcome</th><th>Sandbox</th><th>Kind</th><th>Status</th><th>Product outcome</th><th>Record</th><th>Task</th><th>Created</th></tr></thead>
              <tbody>
                {outcomes.map((outcome) => (
                  <tr key={outcome.id}>
                    <td className="mono">{shortId(outcome.id)}</td>
                    <td><Link className="mono-link" to={`/sandboxes/${outcome.sandboxId}`}>{shortId(outcome.sandboxId)}</Link></td>
                    <td>{outcome.kind}</td>
                    <td><StatusBadge status={outcome.status} /></td>
                    <td className="mono">{outcome.productOutcomeId}</td>
                    <td className="mono muted">{outcome.productRecordId ? shortId(outcome.productRecordId) : "—"}</td>
                    <td className="mono muted">{outcome.taskId ? shortId(outcome.taskId) : "—"}</td>
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
