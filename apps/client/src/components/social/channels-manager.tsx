"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, RefreshCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  SOCIAL_PLATFORM_ORDER,
  type SocialChannelConnection,
  type SocialChannelStatus,
  type SocialPlatform,
  getChannelStatusMeta,
  getPlatformDescription,
  getPlatformIcon,
  getPlatformLabel,
  getPlatformTone,
  trimTrailingHandle,
} from "@/components/social/social-shared";

type FormState = {
  platform: SocialPlatform;
  displayName: string;
  handle: string;
  status: SocialChannelStatus;
};

const initialForm: FormState = {
  platform: "FACEBOOK",
  displayName: "",
  handle: "",
  status: "CONNECTED",
};

export function ChannelsManager() {
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<FormState>(initialForm);

  useEffect(() => {
    void loadChannels();
  }, []);

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

  async function createChannel(nextForm: FormState) {
    setSaving(true);
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
      setForm(initialForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect channel");
    } finally {
      setSaving(false);
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
    void createChannel({
      platform,
      displayName: `${getPlatformLabel(platform)} Workspace`,
      handle: "kasitek",
      status: "CONNECTED",
    });
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
              This is the control center for destination setup, OAuth placeholders, and channel-level publishing readiness.
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
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_380px]">
          <Card>
            <CardHeader>
              <CardTitle>Connected Channels</CardTitle>
              <CardDescription>
                The OAuth handoff is still a placeholder, but these records now drive posts, scheduling, and analytics views.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                <div className="rounded-md bg-secondary/40 p-4 text-sm text-muted-foreground">
                  Loading channel connections...
                </div>
              ) : channels.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
                  No channels connected yet. Use the quick-connect cards or the manual connection form.
                </div>
              ) : (
                channels.map((channel) => {
                  const Icon = getPlatformIcon(channel.platform);
                  const status = getChannelStatusMeta(channel.status);

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
                <CardDescription>Fast placeholders for the channels KasiSocial will support first.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {SOCIAL_PLATFORM_ORDER.map((platform) => {
                  const Icon = getPlatformIcon(platform);
                  const oauthHref =
                    platform === "X"
                      ? apiUrl("/api/social/oauth/x/start")
                      : platform === "LINKEDIN"
                        ? apiUrl("/api/social/oauth/linkedin/start")
                        : null;
                  return (
                    <div key={platform}>
                      {oauthHref ? (
                        <Link
                          href={oauthHref}
                          className="flex w-full flex-col gap-3 rounded-xl border border-border/70 bg-secondary/30 p-4 text-left no-underline transition-colors hover:border-primary/30 hover:bg-secondary/50 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex items-start gap-3">
                            <div className={`rounded-md border p-2 ${getPlatformTone(platform)}`}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <div>
                              <p className="font-medium text-foreground">{getPlatformLabel(platform)}</p>
                              <p className="mt-1 text-sm text-muted-foreground">{getPlatformDescription(platform)}</p>
                            </div>
                          </div>
                          <span className="text-xs uppercase tracking-[0.16em] text-primary">OAuth</span>
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleQuickConnect(platform)}
                          className="flex w-full flex-col gap-3 rounded-xl border border-border/70 bg-secondary/30 p-4 text-left transition-colors hover:border-primary/30 hover:bg-secondary/50 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex items-start gap-3">
                            <div className={`rounded-md border p-2 ${getPlatformTone(platform)}`}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <div>
                              <p className="font-medium text-foreground">{getPlatformLabel(platform)}</p>
                              <p className="mt-1 text-sm text-muted-foreground">{getPlatformDescription(platform)}</p>
                            </div>
                          </div>
                          <Plus className="h-4 w-4 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Manual Connection</CardTitle>
                <CardDescription>Useful for placeholder channels that do not have a live OAuth flow yet.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="block space-y-2">
                  <span className="text-sm text-muted-foreground">Platform</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={form.platform}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        platform: event.target.value as SocialPlatform,
                      }))
                    }
                  >
                    {SOCIAL_PLATFORM_ORDER.map((platform) => (
                      <option key={platform} value={platform}>
                        {getPlatformLabel(platform)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-2">
                  <span className="text-sm text-muted-foreground">Display name</span>
                  <Input
                    value={form.displayName}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        displayName: event.target.value,
                      }))
                    }
                    placeholder="KasiTek Social"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm text-muted-foreground">Handle</span>
                  <Input
                    value={form.handle}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        handle: event.target.value,
                      }))
                    }
                    placeholder="@kasitek"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm text-muted-foreground">Initial status</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={form.status}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        status: event.target.value as SocialChannelStatus,
                      }))
                    }
                  >
                    <option value="CONNECTED">Connected</option>
                    <option value="NEEDS_REAUTH">Needs reauth</option>
                    <option value="DISCONNECTED">Disconnected</option>
                  </select>
                </label>

                <Button
                  className="w-full"
                  disabled={saving || !form.displayName.trim()}
                  onClick={() => void createChannel(form)}
                >
                  {saving ? "Saving..." : "Save channel"}
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
