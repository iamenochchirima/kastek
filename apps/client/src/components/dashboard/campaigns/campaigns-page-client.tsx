"use client";

import { apiUrl } from "@/lib/server-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Pause, Play, Plus, RefreshCw, Search, Square, Trash2, UserPlus, Zap } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(searchParams.get("notice") || "");
  const [isPending, startTransition] = useTransition();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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

  async function runAction(
    campaignId: string,
    kind: "launch" | "pause" | "resume" | "cancel" | "retry_failed" | "send_more" | "delete",
  ) {
    setLoadingAction(`${campaignId}:${kind}`);
    setError("");
    setNotice("");

    try {
      if (kind === "delete") {
        const res = await fetch(apiUrl(`/api/whatsapp/campaigns/${campaignId}`), {
          method: "DELETE",
          credentials: "include",
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Failed to delete campaign");
        }
        setNotice("Campaign deleted.");
        setConfirmDelete(null);
        startTransition(() => {
          router.refresh();
        });
        return;
      }
      const endpoint =
        kind === "launch"
          ? apiUrl(`/api/whatsapp/campaigns/${campaignId}/launch`)
          : apiUrl(`/api/whatsapp/campaigns/${campaignId}`);
      const res = await fetch(endpoint, {
        method: kind === "launch" ? "POST" : "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body:
          kind === "launch"
            ? JSON.stringify({})
            : JSON.stringify({
                action: kind,
              }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Failed to ${kind.replace("_", " ")} campaign`);
      }

      setNotice(`Campaign ${kind.replace("_", " ")} completed.`);
      startTransition(() => {
        router.refresh();
      });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Campaign action failed");
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Campaigns</h1>
            <p className="mt-1 text-muted-foreground">
              Launch, pause, resume, and monitor your WhatsApp marketing campaigns.
            </p>
          </div>
          <Link href="/reach/campaigns/create" className="no-underline">
            <Button>
              <Plus className="h-4 w-4" />
              Create Campaign
            </Button>
          </Link>
        </div>

        {(error || notice) && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              error
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-green-500/30 bg-green-500/10 text-green-300"
            }`}
          >
            {error || notice}
          </div>
        )}

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
          <div className="space-y-4">
            {filteredCampaigns.map((campaign) => {
              const progress = campaignProgress(campaign);
              const launchable = campaign.status === "DRAFT";
              const pausable = campaign.status === "SENDING" || campaign.status === "SCHEDULED";
              const resumable = campaign.status === "PAUSED";
              const retryable = campaign.status === "FAILED";
              const sendMoreable = campaign.status === "COMPLETED" || campaign.status === "FAILED" || campaign.status === "PAUSED";
              const deletable = campaign.status === "DRAFT" || campaign.status === "COMPLETED" || campaign.status === "FAILED";
              const cancellable =
                campaign.status === "DRAFT" ||
                campaign.status === "PAUSED" ||
                campaign.status === "SENDING" ||
                campaign.status === "SCHEDULED" ||
                campaign.status === "FAILED";

              return (
                <Card key={campaign.id}>
                  <CardContent className="space-y-4 p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h3 className="text-lg font-semibold">{campaign.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          Template: {campaign.templateName} ·{" "}
                          {campaign.connectionLabel || "No connection"} · {campaign.templateLanguage}
                        </p>
                        {campaign.description ? (
                          <p className="mt-2 text-sm text-muted-foreground">{campaign.description}</p>
                        ) : null}
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

                    <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
                      <div className="rounded-lg bg-secondary/50 p-3">
                        <div className="text-muted-foreground">Recipients</div>
                        <div className="mt-1 font-semibold">
                          {campaign.totalRecipients.toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-secondary/50 p-3">
                        <div className="text-muted-foreground">Sent</div>
                        <div className="mt-1 font-semibold">
                          {campaign.sentCount.toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-secondary/50 p-3">
                        <div className="text-muted-foreground">Delivered</div>
                        <div className="mt-1 font-semibold">
                          {campaign.deliveredCount.toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-secondary/50 p-3">
                        <div className="text-muted-foreground">Read</div>
                        <div className="mt-1 font-semibold">
                          {campaign.readCount.toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-secondary/50 p-3">
                        <div className="text-muted-foreground">Failed</div>
                        <div className="mt-1 font-semibold">
                          {(campaign.failedCount + campaign.blockedCount).toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-secondary/50 p-3">
                        <div className="text-muted-foreground">Scheduled</div>
                        <div className="mt-1 font-semibold">{formatDate(campaign.scheduledAt)}</div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Progress</span>
                        <span className="font-medium">{progress}%</span>
                      </div>
                      <Progress value={progress} />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {launchable ? (
                        <Button
                          size="sm"
                          disabled={isPending || loadingAction === `${campaign.id}:launch`}
                          onClick={() => void runAction(campaign.id, "launch")}
                        >
                          <Play className="h-4 w-4" />
                          Launch
                        </Button>
                      ) : null}
                      {pausable ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isPending || loadingAction === `${campaign.id}:pause`}
                          onClick={() => void runAction(campaign.id, "pause")}
                        >
                          <Pause className="h-4 w-4" />
                          Pause
                        </Button>
                      ) : null}
                      {resumable ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isPending || loadingAction === `${campaign.id}:resume`}
                          onClick={() => void runAction(campaign.id, "resume")}
                        >
                          <Play className="h-4 w-4" />
                          Resume
                        </Button>
                      ) : null}
                      {retryable ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isPending || loadingAction === `${campaign.id}:retry_failed`}
                          onClick={() => void runAction(campaign.id, "retry_failed")}
                        >
                          <RefreshCw className="h-4 w-4" />
                          Retry failed
                        </Button>
                      ) : null}
                      {cancellable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isPending || loadingAction === `${campaign.id}:cancel`}
                          onClick={() => void runAction(campaign.id, "cancel")}
                        >
                          <Square className="h-4 w-4" />
                          Cancel
                        </Button>
                      ) : null}
                      {sendMoreable ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isPending || loadingAction === `${campaign.id}:send_more`}
                          onClick={() => void runAction(campaign.id, "send_more")}
                        >
                          <UserPlus className="h-4 w-4" />
                          Send More
                        </Button>
                      ) : null}
                      {deletable ? (
                        confirmDelete === campaign.id ? (
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={isPending || loadingAction === `${campaign.id}:delete`}
                              onClick={() => void runAction(campaign.id, "delete")}
                            >
                              Confirm Delete
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setConfirmDelete(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-400 hover:text-red-300"
                            onClick={() => setConfirmDelete(campaign.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </Button>
                        )
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
