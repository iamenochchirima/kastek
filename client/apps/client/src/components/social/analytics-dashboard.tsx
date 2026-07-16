"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SOCIAL_PLATFORM_ORDER,
  type SocialChannelConnection,
  type SocialPost,
  getPlatformLabel,
} from "@/components/social/social-shared";

export function AnalyticsDashboard() {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError("");

    try {
      const [postsResponse, channelsResponse] = await Promise.all([
        fetch(apiUrl("/api/social/posts"), { cache: "no-store", credentials: "include" }),
        fetch(apiUrl("/api/social/channels"), { cache: "no-store", credentials: "include" }),
      ]);

      const postsPayload = (await postsResponse.json()) as { posts?: SocialPost[]; error?: string };
      const channelsPayload = (await channelsResponse.json()) as {
        channels?: SocialChannelConnection[];
        error?: string;
      };

      if (!postsResponse.ok) {
        throw new Error(postsPayload.error || "Failed to load analytics");
      }

      if (!channelsResponse.ok) {
        throw new Error(channelsPayload.error || "Failed to load analytics");
      }

      setPosts(postsPayload.posts || []);
      setChannels(channelsPayload.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }

  const metrics = useMemo(() => {
    const published = posts.filter((post) => post.status === "PUBLISHED");
    const scheduled = posts.filter((post) => post.status === "SCHEDULED");
    const failed = posts.filter((post) => post.status === "FAILED");
    const topPlatform =
      SOCIAL_PLATFORM_ORDER.map((platform) => ({
        platform,
        count: posts.filter((post) => post.channels.includes(platform)).length,
      })).sort((left, right) => right.count - left.count)[0];

    return {
      publishedCount: published.length,
      queueCount: scheduled.length,
      failureCount: failed.length,
      topPlatform: topPlatform?.count ? getPlatformLabel(topPlatform.platform) : "No activity yet",
    };
  }, [posts]);

  const channelSnapshot = useMemo(
    () =>
      SOCIAL_PLATFORM_ORDER.map((platform) => {
        const connected = channels.filter((channel) => channel.platform === platform && channel.status === "CONNECTED").length;
        const contentCount = posts.filter((post) => post.channels.includes(platform)).length;
        const scheduledCount = posts.filter((post) => post.status === "SCHEDULED" && post.channels.includes(platform)).length;

        return {
          platform,
          connected,
          contentCount,
          scheduledCount,
        };
      }),
    [channels, posts],
  );

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div>
          <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Analytics</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">Measure what content actually performs.</h1>
          <p className="mt-1 text-muted-foreground">
            This first version is operational analytics: publishing volume, channel readiness, queue health, and coverage by destination.
          </p>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[
            ["Posts Published", String(metrics.publishedCount), "Posts already marked as published in the workspace"],
            ["Queued Posts", String(metrics.queueCount), "Posts currently scheduled and waiting to go out"],
            ["Failed Jobs", String(metrics.failureCount), "Posts that need edits or retry handling"],
            ["Top Channel", metrics.topPlatform, "Most-used destination based on saved post coverage"],
          ].map(([label, value, helper]) => (
            <Card key={label}>
              <CardContent className="p-5">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className="mt-3 text-3xl font-semibold">{loading ? "--" : value}</div>
                <div className="mt-2 text-sm text-muted-foreground">{helper}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Channel Snapshot</CardTitle>
              <CardDescription>See which destinations are connected and how much content is flowing to each.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {channelSnapshot.map((channel) => (
                <div key={channel.platform} className="flex items-center justify-between rounded-md bg-secondary/50 p-4 text-sm">
                  <span className="font-semibold">{getPlatformLabel(channel.platform)}</span>
                  <span className="text-muted-foreground">{channel.contentCount} posts</span>
                  <span className="text-muted-foreground">{channel.connected} connected</span>
                  <span className="text-accent">{channel.scheduledCount} scheduled</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Insights Queue</CardTitle>
              <CardDescription>Simple product-facing observations based on the current dataset.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              {[
                `${metrics.queueCount} posts are already placed on the calendar.`,
                `${channels.filter((channel) => channel.status === "CONNECTED").length} channels are ready for publish jobs once workers are added.`,
                metrics.failureCount
                  ? `${metrics.failureCount} posts have failed status and should be reviewed first.`
                  : "No failed posts right now, which keeps the publishing queue clean.",
              ].map((insight) => (
                <div key={insight} className="rounded-md bg-secondary/50 p-4 leading-6">
                  {insight}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
