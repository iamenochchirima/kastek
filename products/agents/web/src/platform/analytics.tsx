import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
  Calendar01Icon,
  Chatting01Icon,
  CheckmarkCircle02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { api, ApiError, message, organizationPath } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { ConversationChart, channelIcon, channelName } from "./overview";
import "./overview.css";

type InboxAnalytics = {
  period: { days: number };
  counts: {
    handoffsRequested: number;
    resolvedConversations: number;
    unassignedConversations: number;
    firstResponseSamples: number;
  };
  medianFirstResponseSeconds: number | null;
  handoffTrend: { date: string; count: number }[];
  channels: { channel: string; count: number }[];
};

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function InboxAnalyticsPage() {
  const { organizationId } = useWorkspace();
  const [days, setDays] = useState<"7" | "30">("7");
  const [data, setData] = useState<InboxAnalytics | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    api<InboxAnalytics>(`${organizationPath(organizationId)}/analytics/inbox?days=${days}`)
      .then((result) => { if (live) setData(result); })
      .catch((cause) => {
        if (!live) return;
        if (cause instanceof ApiError && cause.status === 403) {
          window.location.assign("/app/upgrade");
          return;
        }
        setError(message(cause));
      });
    return () => { live = false; };
  }, [organizationId, days, revision]);

  const metrics = data ? [
    {
      label: "Handoffs requested",
      value: data.counts.handoffsRequested.toLocaleString(),
      detail: "Human support requests",
      icon: Chatting01Icon,
      tone: "warning",
    },
    {
      label: "Median first response",
      value: duration(data.medianFirstResponseSeconds),
      detail: data.counts.firstResponseSamples
        ? `From ${data.counts.firstResponseSamples.toLocaleString()} handoffs`
        : "No human replies yet",
      icon: Analytics01Icon,
      tone: "success",
    },
    {
      label: "Resolved conversations",
      value: data.counts.resolvedConversations.toLocaleString(),
      detail: "Marked resolved in this period",
      icon: CheckmarkCircle02Icon,
      tone: "success",
    },
    {
      label: "Unassigned now",
      value: data.counts.unassignedConversations.toLocaleString(),
      detail: "Waiting for a teammate",
      icon: UserGroupIcon,
      tone: data.counts.unassignedConversations ? "warning" : undefined,
    },
  ] : [];

  return (
    <section className="workspace-page overview-page">
      <header className="overview-top">
        <div>
          <h1>Inbox analytics</h1>
          <p>Handoffs and response performance · UTC dates</p>
        </div>
        <div className="overview-actions">
          <span className="overview-period-wrap">
            <HugeiconsIcon icon={Calendar01Icon} size={16} aria-hidden="true" />
            <select
              className="overview-period"
              aria-label="Analytics time period"
              value={days}
              onChange={(event) => setDays(event.target.value as "7" | "30")}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </span>
        </div>
      </header>

      {error ? (
        <div className="space-y-3">
          <ErrorMessage value={error} />
          <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>Retry</Button>
        </div>
      ) : !data ? <Loading /> : (
        <>
          <div className="overview-metrics">
            {metrics.map(({ label, value, detail, icon, tone }) => (
              <div className="overview-metric" data-tone={tone} key={label}>
                <span className="overview-metric-icon">
                  <HugeiconsIcon icon={icon} size={24} aria-hidden="true" />
                </span>
                <div>
                  <p className="overview-metric-label">{label}</p>
                  <p className="overview-metric-value">{value}</p>
                  <p className="overview-panel-subtitle">{detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="overview-layout">
            <div className="overview-column">
              <section className="overview-panel">
                <div className="overview-panel-header">
                  <div>
                    <h2>Handoff activity</h2>
                    <p className="overview-panel-subtitle">Human handoffs requested · UTC</p>
                  </div>
                </div>
                <ConversationChart points={data.handoffTrend} />
              </section>
            </div>
            <div className="overview-column">
              <section className="overview-panel">
                <div className="overview-panel-header">
                  <div>
                    <h2>Handoffs by channel</h2>
                    <p className="overview-panel-subtitle">Where customers requested a person</p>
                  </div>
                </div>
                {data.channels.length ? data.channels.map((item) => (
                  <div className="overview-channel" key={item.channel}>
                    <span className="overview-channel-icon" data-channel={item.channel}>
                      <HugeiconsIcon icon={channelIcon(item.channel)} size={21} aria-hidden="true" />
                    </span>
                    <div className="overview-channel-main">
                      <div className="overview-channel-label">
                        <span>{channelName(item.channel)}</span>
                        <span>{item.count.toLocaleString()}</span>
                      </div>
                      <div className="overview-channel-track">
                        <span style={{ width: `${data.counts.handoffsRequested ? item.count / data.counts.handoffsRequested * 100 : 0}%` }} />
                      </div>
                    </div>
                  </div>
                )) : <p className="overview-empty">No handoffs in this period</p>}
              </section>
              <section className="overview-panel">
                <div className="overview-panel-header">
                  <div>
                    <h2>What this measures</h2>
                  </div>
                </div>
                <div className="overview-empty">
                  <p>First response is measured from a human handoff request to the first staff reply in that conversation.</p>
                  <p className="mt-2">Unassigned counts conversations currently waiting for a teammate.</p>
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
