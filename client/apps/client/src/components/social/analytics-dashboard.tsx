"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContentWorkspaceNavigation } from "@/components/social/content-workspace-navigation";
import { MotionReveal } from "@/components/ui/motion-reveal";
import {
  SOCIAL_PLATFORM_ORDER,
  type SocialChannelConnection,
  type SocialPost,
  getPlatformLabel,
} from "@/components/social/social-shared";

type Campaign = {
  id: string;
  name: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
};

export function AnalyticsDashboard() {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [view, setView] = useState<"content" | "campaigns">("content");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError("");

    try {
      const [postsResponse, channelsResponse, campaignsResponse] = await Promise.all([
        fetch(apiUrl("/api/social/posts"), { cache: "no-store", credentials: "include" }),
        fetch(apiUrl("/api/social/channels"), { cache: "no-store", credentials: "include" }),
        fetch(apiUrl("/api/whatsapp/campaigns"), { cache: "no-store", credentials: "include" }),
      ]);

      const postsPayload = (await postsResponse.json()) as { posts?: SocialPost[]; error?: string };
      const channelsPayload = (await channelsResponse.json()) as {
        channels?: SocialChannelConnection[];
        error?: string;
      };
      const campaignsPayload = (await campaignsResponse.json()) as { campaigns?: Campaign[]; error?: string };

      if (!postsResponse.ok) {
        throw new Error(postsPayload.error || "Failed to load analytics");
      }

      if (!channelsResponse.ok) {
        throw new Error(channelsPayload.error || "Failed to load analytics");
      }
      if (!campaignsResponse.ok) throw new Error(campaignsPayload.error || "Failed to load campaign analytics");

      setPosts(postsPayload.posts || []);
      setChannels(channelsPayload.channels || []);
      setCampaigns(campaignsPayload.campaigns || []);
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

  const campaignMetrics = useMemo(
    () => campaigns.reduce(
      (totals, campaign) => ({
        recipients: totals.recipients + campaign.totalRecipients,
        sent: totals.sent + campaign.sentCount,
        delivered: totals.delivered + campaign.deliveredCount,
        read: totals.read + campaign.readCount,
        failed: totals.failed + campaign.failedCount,
      }),
      { recipients: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
    ),
    [campaigns],
  );

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Analytics</PageHeaderTitle>
            <PageHeaderDescription>Content and campaign performance.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

        <ContentWorkspaceNavigation active="analytics" />

        <Tabs value={view} onValueChange={(value) => setView(value as "content" | "campaigns")}>
          <TabsList>
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          </TabsList>
        </Tabs>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {view === "content" ? <>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[
            ["Posts Published", String(metrics.publishedCount), "Posts already marked as published in the workspace"],
            ["Queued Posts", String(metrics.queueCount), "Posts currently scheduled and waiting to go out"],
            ["Failed Jobs", String(metrics.failureCount), "Posts that need edits or retry handling"],
            ["Top Channel", metrics.topPlatform, "Most-used destination based on saved post coverage"],
          ].map(([label, value, helper], index) => (
            <MotionReveal key={label} delay={0.08 + index * 0.06} hoverLift className="h-full">
            <Card className="h-full">
              <CardContent className="p-5">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className="mt-3 text-3xl font-semibold">{loading ? "--" : value}</div>
                <div className="mt-2 text-sm text-muted-foreground">{helper}</div>
              </CardContent>
            </Card>
            </MotionReveal>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <MotionReveal delay={0.16} className="h-full">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Channel Snapshot</CardTitle>
              <CardDescription>See which destinations are connected and how much content is flowing to each.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {channelSnapshot.map((channel) => (
                <div key={channel.platform} className="grid gap-2 rounded-md bg-secondary/50 p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
                  <span className="font-semibold">{getPlatformLabel(channel.platform)}</span>
                  <span className="text-muted-foreground">{channel.contentCount} posts</span>
                  <span className="text-muted-foreground">{channel.connected} connected</span>
                  <span className="text-status-info">{channel.scheduledCount} scheduled</span>
                </div>
              ))}
            </CardContent>
          </Card>
          </MotionReveal>

          <MotionReveal delay={0.22} className="h-full">
          <Card className="h-full">
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
          </MotionReveal>
        </div>
        </> : <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[["Recipients", campaignMetrics.recipients], ["Sent", campaignMetrics.sent], ["Delivered", campaignMetrics.delivered], ["Read", campaignMetrics.read]].map(([label, value], index) => (
              <MotionReveal key={String(label)} delay={0.08 + index * 0.06} hoverLift className="h-full"><Card className="h-full"><CardContent className="p-5"><div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div><div className="mt-3 text-3xl font-semibold">{loading ? "--" : Number(value).toLocaleString("en-ZA")}</div></CardContent></Card></MotionReveal>
            ))}
          </div>
          <MotionReveal delay={0.16}><Card><CardHeader><CardTitle>Campaign delivery</CardTitle><CardDescription>WhatsApp delivery and read totals are separate from social publishing metrics.</CardDescription></CardHeader><CardContent className="space-y-3">
            {campaigns.length ? campaigns.slice(0, 10).map((campaign) => <Link key={campaign.id} href={`/campaigns/${campaign.id}`} className="flex flex-col gap-2 rounded-md bg-secondary/50 p-4 text-sm transition-colors duration-[150ms] hover:bg-secondary sm:flex-row sm:items-center sm:justify-between"><span className="min-w-0 truncate font-semibold">{campaign.name}</span><span className="text-muted-foreground sm:shrink-0">{campaign.deliveredCount} delivered · {campaign.readCount} read · {campaign.failedCount} failed</span></Link>) : <p className="text-sm text-muted-foreground">No campaigns have been created yet.</p>}
          </CardContent></Card></MotionReveal>
        </>}
      </div>
    </div>
  );
}
