"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SOCIAL_PLATFORM_ORDER,
  type SocialChannelConnection,
  type SocialChannelStatus,
  type SocialPlatform,
  getChannelCapabilities,
  getChannelStatusMeta,
  getPlatformIcon,
  getPlatformLabel,
  getPlatformTone,
  trimTrailingHandle,
} from "@/components/social/social-shared";

export function ChannelsManager() {
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadChannels();
  }, []);

  const connectedPlatforms = useMemo(() => {
    return new Set(
      channels
        .filter((channel) => channel.status === "CONNECTED")
        .map((channel) => channel.platform),
    );
  }, [channels]);

  async function loadChannels() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(apiUrl("/api/social/channels"), {
        cache: "no-store",
        credentials: "include",
      });
      const payload = (await response.json()) as {
        channels?: SocialChannelConnection[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to load channels");
      }

      setChannels(payload.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load channels");
    } finally {
      setLoading(false);
    }
  }

  async function updateChannel(id: string, status: SocialChannelStatus) {
    setError("");

    try {
      const response = await fetch(apiUrl(`/api/social/channels/${id}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

      const payload = (await response.json()) as {
        channel?: SocialChannelConnection;
        error?: string;
      };

      if (!response.ok || !payload.channel) {
        throw new Error(payload.error || "Failed to update channel");
      }

      setChannels((current) =>
        current.map((channel) => (channel.id === id ? payload.channel as SocialChannelConnection : channel)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update channel");
    }
  }

  async function deleteChannel(id: string) {
    const confirmed = window.confirm("Remove this connected channel?");
    if (!confirmed) return;

    setError("");

    try {
      const response = await fetch(apiUrl(`/api/social/channels/${id}`), {
        method: "DELETE",
        credentials: "include",
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to remove channel");
      }

      setChannels((current) => current.filter((channel) => channel.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove channel");
    }
  }

  function handleQuickConnect(platform: SocialPlatform) {
    void createQuickChannel({
      platform,
      displayName: `${getPlatformLabel(platform)} Workspace`,
      handle: "kasitek",
      status: "CONNECTED",
    });
  }

  async function createQuickChannel(nextForm: {
    platform: SocialPlatform;
    displayName: string;
    handle: string;
    status: SocialChannelStatus;
  }) {
    setError("");

    try {
      const response = await fetch(apiUrl("/api/social/channels"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: nextForm.platform,
          displayName: nextForm.displayName,
          handle: nextForm.handle ? `@${trimTrailingHandle(nextForm.handle)}` : null,
          status: nextForm.status,
          metadata: {
            source: "social-workspace-manual",
            oauthReady: false,
          },
        }),
      });

      const payload = (await response.json()) as {
        channel?: SocialChannelConnection;
        error?: string;
      };

      if (!response.ok || !payload.channel) {
        throw new Error(payload.error || "Failed to connect channel");
      }

      setChannels((current) => [payload.channel as SocialChannelConnection, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect channel");
    }
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Channels</Badge>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Connect and manage publishing destinations.
            </h1>
            <p className="mt-1 max-w-2xl text-muted-foreground">
              This is the control center for destination setup, provider OAuth, and channel-level publishing readiness.
            </p>
          </div>
          <Button
            variant="outline"
            className="w-full gap-2 sm:w-auto"
            onClick={() => void loadChannels()}
          >
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_380px]">
          <Card>
            <CardHeader>
              <CardTitle>Connected Channels</CardTitle>
              <CardDescription>
                Connected destinations here drive posts, scheduling, analytics, and the next messaging flows.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className="flex flex-col gap-4 rounded-xl border border-border/70 bg-secondary/30 p-4 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="flex items-start gap-3">
                      <Skeleton className="h-10 w-10 rounded-md" />
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-36" />
                        <Skeleton className="h-3 w-28" />
                        <Skeleton className="h-3 w-40" />
                      </div>
                    </div>
                    <div className="grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
                      <Skeleton className="h-9 w-full rounded-md sm:w-24" />
                      <Skeleton className="h-9 w-full rounded-md sm:w-9" />
                    </div>
                  </div>
                ))
              ) : channels.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
                  No channels connected yet. Use the quick-connect cards to add your destinations.
                </div>
              ) : (
                channels.map((channel) => {
                  const Icon = getPlatformIcon(channel.platform);
                  const status = getChannelStatusMeta(channel.status);
                  const capabilities = getChannelCapabilities(channel);

                  return (
                    <div
                      key={channel.id}
                      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-secondary/30 p-4 lg:flex-row lg:items-center lg:justify-between"
                    >
                      <div className="flex items-start gap-3">
                        <div className={`rounded-md border p-2 ${getPlatformTone(channel.platform)}`}>
                          <Icon className="h-5 w-5" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-foreground">{channel.displayName}</p>
                            <Badge className={status.className}>{status.label}</Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {getPlatformLabel(channel.platform)}
                            {channel.handle ? ` • ${channel.handle}` : ""}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Last updated {new Date(channel.updatedAt).toLocaleString("en-ZA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {capabilities.canPublish ? (
                              <Badge variant="secondary" className="text-[11px]">
                                Publish
                              </Badge>
                            ) : null}
                            {capabilities.supportsManualPublish ? (
                              <Badge variant="secondary" className="text-[11px]">
                                Manual Publish
                              </Badge>
                            ) : null}
                            {capabilities.supportsInbox ? (
                              <Badge variant="secondary" className="text-[11px]">
                                Inbox
                              </Badge>
                            ) : null}
                            {capabilities.supportsMediaUpload ? (
                              <Badge variant="secondary" className="text-[11px]">
                                Media
                              </Badge>
                            ) : null}
                            {capabilities.supportsAnalytics ? (
                              <Badge variant="secondary" className="text-[11px]">
                                Analytics
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={() =>
                            void updateChannel(
                              channel.id,
                              channel.status === "CONNECTED" ? "NEEDS_REAUTH" : "CONNECTED",
                            )
                          }
                        >
                          {status.actionLabel}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-full text-muted-foreground hover:text-foreground sm:h-10 sm:w-10"
                          onClick={() => void deleteChannel(channel.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Quick Connect</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {SOCIAL_PLATFORM_ORDER.map((platform) => {
                  const Icon = getPlatformIcon(platform);
                  const isConnected = connectedPlatforms.has(platform);
                  const isPlanned = platform === "THREADS";
                  const oauthHref =
                    platform === "FACEBOOK" || platform === "INSTAGRAM"
                      ? apiUrl("/api/social/oauth/meta/start")
                      : platform === "THREADS"
                        ? null
                      : platform === "X"
                        ? apiUrl("/api/social/oauth/x/start")
                        : platform === "LINKEDIN"
                        ? apiUrl("/api/social/oauth/linkedin/start")
                        : null;
                  return (
                    <div key={platform}>
                      {oauthHref && !isConnected ? (
                        <Link
                          href={oauthHref}
                          className="flex w-full items-center justify-between rounded-xl border border-border/70 bg-secondary/30 p-4 text-left no-underline transition-colors hover:border-primary/30 hover:bg-secondary/50"
                        >
                          <div className="flex items-center gap-3">
                            <div className={`rounded-md border p-2 ${getPlatformTone(platform)}`}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <p className="font-medium text-foreground">{getPlatformLabel(platform)}</p>
                          </div>
                          <span className="text-sm font-medium text-primary">
                            Connect
                          </span>
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (!isConnected && !isPlanned) {
                              handleQuickConnect(platform);
                            }
                          }}
                          className="flex w-full items-center justify-between rounded-xl border border-border/70 bg-secondary/30 p-4 text-left transition-colors hover:border-primary/30 hover:bg-secondary/50 disabled:pointer-events-none"
                          disabled={isConnected || isPlanned}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`rounded-md border p-2 ${getPlatformTone(platform)}`}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <p className="font-medium text-foreground">{getPlatformLabel(platform)}</p>
                          </div>
                          {isConnected ? (
                            <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-300">
                              <Check className="h-4 w-4" />
                              Connected
                            </span>
                          ) : isPlanned ? (
                            <span className="text-sm font-medium text-muted-foreground">Planned</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                              <Plus className="h-4 w-4" />
                              Connect
                            </span>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
