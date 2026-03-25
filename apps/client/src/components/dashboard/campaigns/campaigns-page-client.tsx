"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Pause, Plus, RefreshCw, Search, Square, Zap } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

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
      return "border-accent/30 bg-accent/10 text-accent";
    case "SCHEDULED":
      return "border-blue-500/30 bg-blue-500/10 text-blue-300";
    case "PAUSED":
      return "border-primary/30 bg-primary/10 text-primary";
    case "COMPLETED":
      return "border-green-500/30 bg-green-500/10 text-green-300";
    case "FAILED":
      return "border-red-500/30 bg-red-500/10 text-red-300";
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
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Campaigns</h1>
            <p className="mt-1 text-muted-foreground">
              Browse your WhatsApp campaigns and open one to control sends, batches, and delivery state.
            </p>
          </div>
          <Link href="/reach/campaigns/create" className="no-underline">
            <Button>
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
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              {campaigns.length === 0
                ? "No campaigns yet. Create your first outbound WhatsApp campaign."
                : "No campaigns match the current search."}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredCampaigns.map((campaign) => {
              const progress = campaignProgress(campaign);
              const remaining = remainingRecipients(campaign);

              return (
                <Link key={campaign.id} href={`/reach/campaigns/${campaign.id}`} className="no-underline">
                  <Card className="h-full transition-colors hover:border-primary/40 hover:bg-secondary/20">
                    <CardContent className="space-y-4 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-foreground">{campaign.name}</h3>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {campaign.templateName} · {campaign.connectionLabel || "No connection"}
                          </p>
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

                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Progress</span>
                          <span className="font-medium text-foreground">{progress}%</span>
                        </div>
                        <Progress value={progress} />
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <CompactStat label="Recipients" value={campaign.totalRecipients} />
                        <CompactStat label="Sent" value={campaign.sentCount} />
                        <CompactStat label="Remaining" value={remaining} />
                      </div>

                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{campaign.deliveredCount.toLocaleString()} delivered</span>
                        <span>{campaign.readCount.toLocaleString()} read</span>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        {campaign.scheduledAt ? formatDate(campaign.scheduledAt) : "No schedule"}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CompactStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value.toLocaleString("en-ZA")}</div>
    </div>
  );
}
