"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Pause, Plus, RefreshCw, Search, Square, Zap } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { MotionReveal } from "@/components/ui/motion-reveal";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  templateName: string;
  templateLanguage: string;
  status: string;
  scheduledAt: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  blockedCount: number;
  unsubscribedCount: number;
  createdAt: string;
  connectionLabel: string | null;
  templateStatus: string | null;
  listLabel: string | null;
  defaultBatchSize: number | null;
};

function campaignProgress(campaign: Campaign) {
  if (campaign.totalRecipients <= 0) return 0;
  const processed =
    campaign.sentCount +
    campaign.failedCount +
    campaign.blockedCount +
    campaign.unsubscribedCount;
  return Math.max(0, Math.min(100, Math.round((processed / campaign.totalRecipients) * 100)));
}

function statusTone(status: string) {
  switch (status) {
    case "SENDING":
      return "border-status-info/30 bg-status-info-soft text-status-info";
    case "SCHEDULED":
      return "border-status-info/30 bg-status-info-soft text-status-info";
    case "PAUSED":
      return "border-primary/30 bg-primary/10 text-primary";
    case "COMPLETED":
      return "border-status-success/30 bg-status-success-soft text-status-success";
    case "FAILED":
      return "border-destructive/30 bg-status-danger-soft text-destructive";
    default:
      return "border-border bg-secondary/60 text-foreground";
  }
}

function remainingRecipients(campaign: Campaign) {
  const processed =
    campaign.sentCount +
    campaign.failedCount +
    campaign.blockedCount +
    campaign.unsubscribedCount;
  return Math.max(campaign.totalRecipients - processed, 0);
}

function formatDate(value: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CampaignsPageClient({
  campaigns,
}: {
  campaigns: Campaign[];
}) {
  const [query, setQuery] = useState("");

  const filteredCampaigns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return campaigns;
    return campaigns.filter((campaign) =>
      [
        campaign.name,
        campaign.templateName,
        campaign.status,
        campaign.connectionLabel || "",
        campaign.description || "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [campaigns, query]);

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Campaigns</h1>
            <p className="mt-1 text-muted-foreground">
              Browse your WhatsApp campaigns and open one to control sends, batches, and delivery state.
            </p>
          </div>
          <Link href="/campaigns/create" className="no-underline">
            <Button className="w-full sm:w-auto">
              <Plus className="h-4 w-4" />
              Create Campaign
            </Button>
          </Link>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search campaigns..."
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {filteredCampaigns.length === 0 ? (
          <MotionReveal delay={0.08}><Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              {campaigns.length === 0
                ? "No campaigns yet. Create your first outbound WhatsApp campaign."
                : "No campaigns match the current search."}
            </CardContent>
          </Card></MotionReveal>
        ) : (
          <MotionReveal delay={0.08}><Card>
            <CardContent className="p-0">
              <div className="space-y-3 p-4 md:hidden">
                {filteredCampaigns.map((campaign) => {
                  const progress = campaignProgress(campaign);
                  const remaining = remainingRecipients(campaign);

                  return (
                    <button
                      key={campaign.id}
                      type="button"
                      onClick={() => {
                        window.location.href = `/campaigns/${campaign.id}`;
                      }}
                      className="w-full rounded-xl border border-border bg-secondary/30 p-4 text-left transition-colors hover:bg-secondary/45"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold text-foreground">{campaign.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {campaign.templateName} · {campaign.connectionLabel || "No connection"}
                          </div>
                        </div>
                        <Badge className={statusTone(campaign.status)}>
                          {campaign.status === "SENDING" ? (
                            <Zap className="h-3 w-3" />
                          ) : campaign.status === "PAUSED" ? (
                            <Pause className="h-3 w-3" />
                          ) : campaign.status === "COMPLETED" ? (
                            <RefreshCw className="h-3 w-3" />
                          ) : (
                            <Square className="h-3 w-3" />
                          )}
                          {campaign.status}
                        </Badge>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <MiniMetric label="Recipients" value={campaign.totalRecipients.toLocaleString("en-ZA")} />
                        <MiniMetric label="Sent" value={campaign.sentCount.toLocaleString("en-ZA")} />
                        <MiniMetric label="Delivered" value={campaign.deliveredCount.toLocaleString("en-ZA")} />
                        <MiniMetric label="Read" value={campaign.readCount.toLocaleString("en-ZA")} />
                        <MiniMetric label="Failed" value={(campaign.failedCount + campaign.blockedCount).toLocaleString("en-ZA")} />
                        <MiniMetric label="Remaining" value={remaining.toLocaleString("en-ZA")} />
                      </div>

                      <div className="mt-4 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Progress</span>
                          <span className="font-medium text-foreground">{progress}%</span>
                        </div>
                        <Progress value={progress} />
                        <p className="text-xs text-muted-foreground">
                          {campaign.scheduledAt ? formatDate(campaign.scheduledAt) : "No schedule"}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="hidden overflow-x-auto rounded-xl md:block">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/40 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-left">Campaign</th>
                      <th className="px-4 py-3 text-left">Status</th>
                      <th className="px-4 py-3 text-left">Recipients</th>
                      <th className="px-4 py-3 text-left">Sent</th>
                      <th className="px-4 py-3 text-left">Delivered</th>
                      <th className="px-4 py-3 text-left">Read</th>
                      <th className="px-4 py-3 text-left">Failed</th>
                      <th className="px-4 py-3 text-left">Remaining</th>
                      <th className="px-4 py-3 text-left">Progress</th>
                      <th className="px-4 py-3 text-left">Schedule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCampaigns.map((campaign) => {
                      const progress = campaignProgress(campaign);
                      const remaining = remainingRecipients(campaign);

                      return (
                        <tr
                          key={campaign.id}
                          onClick={() => {
                            window.location.href = `/campaigns/${campaign.id}`;
                          }}
                          className="cursor-pointer border-t border-border transition-colors hover:bg-secondary/40"
                        >
                          <td className="px-4 py-3">
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-foreground">{campaign.name}</div>
                              <div className="mt-1 truncate text-xs text-muted-foreground">
                                {campaign.templateName} · {campaign.connectionLabel || "No connection"}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge className={statusTone(campaign.status)}>
                              {campaign.status === "SENDING" ? (
                                <Zap className="h-3 w-3" />
                              ) : campaign.status === "PAUSED" ? (
                                <Pause className="h-3 w-3" />
                              ) : campaign.status === "COMPLETED" ? (
                                <RefreshCw className="h-3 w-3" />
                              ) : (
                                <Square className="h-3 w-3" />
                              )}
                              {campaign.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 font-medium text-foreground">
                            {campaign.totalRecipients.toLocaleString("en-ZA")}
                          </td>
                          <td className="px-4 py-3 text-foreground">{campaign.sentCount.toLocaleString("en-ZA")}</td>
                          <td className="px-4 py-3 text-foreground">
                            {campaign.deliveredCount.toLocaleString("en-ZA")}
                          </td>
                          <td className="px-4 py-3 text-foreground">{campaign.readCount.toLocaleString("en-ZA")}</td>
                          <td className="px-4 py-3 text-foreground">
                            {(campaign.failedCount + campaign.blockedCount).toLocaleString("en-ZA")}
                          </td>
                          <td className="px-4 py-3 text-foreground">{remaining.toLocaleString("en-ZA")}</td>
                          <td className="px-4 py-3">
                            <div className="min-w-[140px] space-y-2">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">Progress</span>
                                <span className="font-medium text-foreground">{progress}%</span>
                              </div>
                              <Progress value={progress} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {campaign.scheduledAt ? formatDate(campaign.scheduledAt) : "No schedule"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card></MotionReveal>
        )}
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/30 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium text-foreground">{value}</div>
    </div>
  );
}
