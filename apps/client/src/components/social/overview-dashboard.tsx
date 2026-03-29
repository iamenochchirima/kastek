"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type SocialChannelConnection,
  type SocialPost,
  formatDateTime,
  getAnalyticsSnapshot,
  getPlatformLabel,
  postStatusSummaryCards,
} from "@/components/social/social-shared";

export function OverviewDashboard() {
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
        throw new Error(postsPayload.error || "Failed to load social overview");
      }

      if (!channelsResponse.ok) {
        throw new Error(channelsPayload.error || "Failed to load social overview");
      }

      setPosts(postsPayload.posts || []);
      setChannels(channelsPayload.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load social overview");
    } finally {
      setLoading(false);
    }
  }

  const snapshot = useMemo(() => getAnalyticsSnapshot(posts, channels), [channels, posts]);
  const upcoming = useMemo(
    () =>
      posts
        .filter((post) => post.scheduledFor)
        .sort((left, right) => new Date(left.scheduledFor as string).valueOf() - new Date(right.scheduledFor as string).valueOf())
        .slice(0, 5),
    [posts],
  );

  const statValues = {
    scheduled: snapshot.scheduledCount,
    published: snapshot.publishedCount,
    connected: snapshot.activeChannels,
    coverage: channels.length ? `${Math.round((snapshot.activeChannels / channels.length) * 100)}%` : "0%",
  };

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
            <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">KasiSocial</Badge>
            <h1 className="max-w-3xl text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Standalone social publishing for the KasiTek stack.
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Plan your month, write with AI, schedule across channels, and monitor publishing momentum from one dedicated workspace.
            </p>
            </div>
            <Link href="/social/posts" className="no-underline">
              <Button className="w-full gap-2 sm:w-auto">
                <Sparkles className="h-4 w-4" />
                New AI Draft
              </Button>
            </Link>
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {postStatusSummaryCards.map((stat) => (
            <Card key={stat.key}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                    <p className="text-2xl font-semibold text-foreground sm:text-3xl">
                      {statValues[stat.key]}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {stat.key === "coverage"
                        ? "of connected destinations are ready"
                        : stat.key === "connected"
                          ? "destinations currently publishing-ready"
                          : stat.key === "published"
                            ? "posts have reached published state"
                            : "posts are currently on the calendar"}
                    </p>
                  </div>
                  <div className="rounded-md bg-primary/10 p-2">
                    <stat.icon className="h-5 w-5 text-primary" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.2fr)_380px]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div>
                <CardTitle className="text-base">This Week&apos;s Queue</CardTitle>
                <CardDescription>The next scheduled items drawn from your real social post records.</CardDescription>
              </div>
              <Link href="/social/calendar" className="no-underline">
                <Button variant="link" className="p-0">Open calendar</Button>
              </Link>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="rounded-md bg-secondary/40 p-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-2 h-3 w-24" />
                  </div>
                ))
              ) : upcoming.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No scheduled posts yet. Create a draft and give it a schedule to populate this queue.
                </div>
              ) : (
                upcoming.map((item) => (
                  <div key={item.id} className="flex flex-col gap-3 rounded-md bg-secondary/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">{item.title || "Untitled post"}</p>
                      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {item.channels.map(getPlatformLabel).join(", ")}
                      </p>
                    </div>
                    <Badge className="w-fit border-accent/30 bg-accent/10 text-accent">
                      {formatDateTime(item.scheduledFor)}
                    </Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Publishing Snapshot</CardTitle>
              <CardDescription>Fast read of how the current workspace is being used.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                `${channels.length} total channels recorded in the workspace`,
                `${snapshot.activeChannels} channels are marked connected and ready to publish`,
                `${snapshot.scheduledCount} posts are scheduled across the calendar`,
                `Most-used platform right now: ${snapshot.topPlatform}`,
              ].map((item) => (
                <div key={item} className="rounded-md bg-secondary/50 p-4 text-sm text-muted-foreground">
                  {item}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
