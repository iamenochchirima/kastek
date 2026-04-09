"use client";

import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Pencil, RotateCcw, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SOCIAL_PLATFORM_ORDER,
  SOCIAL_POST_STATUSES,
  type SocialChannelConnection,
  type SocialPlatform,
  type SocialPost,
  type SocialPostStatus,
  type SocialPostVariant,
  type SocialPublishJob,
  type SocialVariantStatus,
  formatDateInputValue,
  formatDateTime,
  getPlatformIcon,
  getPlatformLabel,
  getPlatformTone,
  getPostStatusMeta,
  getPublishJobStatusMeta,
} from "@/components/social/social-shared";

type ComposerVariant = {
  platform: SocialPlatform;
  content: string;
  status: SocialVariantStatus;
  aiGenerated: boolean;
};

type ComposerState = {
  id: string | null;
  title: string;
  prompt: string;
  content: string;
  channels: SocialPlatform[];
  status: SocialPostStatus;
  scheduledFor: string;
  primaryChannelId: string;
  variants: ComposerVariant[];
};

type GeneratedIdea = {
  title: string;
  angle: string;
  hook: string;
  draft: string;
  suggestedChannels?: SocialPlatform[];
};

const defaultChannels: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"];
const supportedManualPublishPlatforms: SocialPlatform[] = ["LINKEDIN", "X"];

const emptyComposer: ComposerState = {
  id: null,
  title: "",
  prompt: "",
  content: "",
  channels: defaultChannels,
  status: "DRAFT",
  scheduledFor: "",
  primaryChannelId: "",
  variants: defaultChannels.map((platform) => ({
    platform,
    content: "",
    status: platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT",
    aiGenerated: false,
  })),
};

function buildComposerVariants(channels: SocialPlatform[], variants?: SocialPostVariant[], fallbackContent = "") {
  return channels.map((platform) => {
    const existing = variants?.find((variant) => variant.platform === platform);

    return {
      platform,
      content: existing?.content || fallbackContent,
      status: existing?.status || (platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT"),
      aiGenerated: Boolean(existing?.aiGenerated),
    } satisfies ComposerVariant;
  });
}

export function PostsWorkspace() {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeFilter, setActiveFilter] = useState<"ALL" | SocialPostStatus>("ALL");
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);
  const [publishingKey, setPublishingKey] = useState<string | null>(null);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [generatingCaption, setGeneratingCaption] = useState(false);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  const [ideaTopic, setIdeaTopic] = useState("");
  const [ideaObjective, setIdeaObjective] = useState("");
  const [generatedIdeas, setGeneratedIdeas] = useState<GeneratedIdea[]>([]);
  const [activeVariantPlatform, setActiveVariantPlatform] = useState<SocialPlatform>("FACEBOOK");

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

      const postsPayload = (await postsResponse.json()) as {
        posts?: SocialPost[];
        error?: string;
      };
      const channelsPayload = (await channelsResponse.json()) as {
        channels?: SocialChannelConnection[];
        error?: string;
      };

      if (!postsResponse.ok) {
        throw new Error(postsPayload.error || "Failed to load posts");
      }

      if (!channelsResponse.ok) {
        throw new Error(channelsPayload.error || "Failed to load channels");
      }

      setPosts(postsPayload.posts || []);
      setChannels(channelsPayload.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load posts");
    } finally {
      setLoading(false);
    }
  }

  const filteredPosts = useMemo(() => {
    if (activeFilter === "ALL") return posts;
    return posts.filter((post) => post.status === activeFilter);
  }, [activeFilter, posts]);

  const queueCounts = useMemo(
    () => ({
      ideas: posts.filter((post) => post.prompt?.trim() && post.status === "DRAFT").length,
      drafting: posts.filter((post) => post.status === "DRAFT").length,
      approved: posts.filter((post) => post.status === "SCHEDULED").length,
    }),
    [posts],
  );

  const connectedChannelsByPlatform = useMemo(
    () =>
      new Map(
        channels
          .filter((channel) => channel.status === "CONNECTED")
          .map((channel) => [channel.platform, channel] as const),
      ),
    [channels],
  );

  const activeComposerVariants = useMemo(
    () => composer.variants.filter((variant) => composer.channels.includes(variant.platform)),
    [composer.channels, composer.variants],
  );

  function openNewComposer() {
    setComposer(emptyComposer);
    setActiveVariantPlatform("FACEBOOK");
    setIsComposerOpen(true);
  }

  function openIdeaAsDraft(idea: GeneratedIdea) {
    const requestedChannels =
      idea.suggestedChannels?.length
        ? idea.suggestedChannels.filter((platform) => defaultChannels.includes(platform))
        : defaultChannels;
    const nextChannels = requestedChannels.length ? requestedChannels : defaultChannels;
    const nextVariants = buildComposerVariants(nextChannels, undefined, idea.draft);

    setComposer({
      id: null,
      title: idea.title,
      prompt: [idea.angle, idea.hook].filter(Boolean).join(" | "),
      content: idea.draft,
      channels: nextChannels,
      status: "DRAFT",
      scheduledFor: "",
      primaryChannelId: "",
      variants: nextVariants.map((variant) => ({
        ...variant,
        status: variant.platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT",
      })),
    });
    setActiveVariantPlatform(nextChannels[0] || "FACEBOOK");
    setIsComposerOpen(true);
  }

  function openEditComposer(post: SocialPost) {
    setComposer({
      id: post.id,
      title: post.title || "",
      prompt: post.prompt || "",
      content: post.content,
      channels: post.channels,
      status: post.status,
      scheduledFor: formatDateInputValue(post.scheduledFor),
      primaryChannelId: post.primaryChannelId || "",
      variants: buildComposerVariants(post.channels, post.variants, post.content),
    });
    setActiveVariantPlatform(post.channels[0] || "FACEBOOK");
    setIsComposerOpen(true);
  }

  function toggleChannel(platform: SocialPlatform, checked: boolean) {
    setComposer((current) => {
      const nextChannels = checked
        ? [...new Set([...current.channels, platform])]
        : current.channels.filter((channel) => channel !== platform);
      const existingVariant = current.variants.find((variant) => variant.platform === platform);

      const nextVariants = checked
        ? existingVariant
          ? current.variants
          : [
              ...current.variants,
              {
                platform,
                content: current.content,
                status: (platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT") as SocialVariantStatus,
                aiGenerated: false,
              },
            ]
        : current.variants.filter((variant) => variant.platform !== platform);

      return {
        ...current,
        channels: nextChannels,
        variants: nextVariants,
      };
    });

    if (checked) {
      setActiveVariantPlatform(platform);
    } else if (activeVariantPlatform === platform) {
      setActiveVariantPlatform(
        composer.channels.find((channel) => channel !== platform) || "FACEBOOK",
      );
    }
  }

  function updateVariant(platform: SocialPlatform, patch: Partial<ComposerVariant>) {
    setComposer((current) => ({
      ...current,
      variants: current.variants.map((variant) =>
        variant.platform === platform ? { ...variant, ...patch } : variant,
      ),
    }));
  }

  async function generateWithAi() {
    if (!composer.prompt.trim() && !composer.title.trim() && !composer.content.trim()) {
      setError("Add a prompt, working title, or rough draft before generating.");
      return;
    }

    setGeneratingCaption(true);
    setError("");

    try {
      const response = await fetch(apiUrl("/api/social/ai/caption"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: composer.prompt,
          title: composer.title,
          currentContent: composer.content,
          channels: composer.channels,
        }),
      });

      const payload = (await response.json()) as {
        draft?: {
          title?: string;
          content?: string;
          suggestedChannels?: SocialPlatform[];
          variants?: Array<{
            platform: SocialPlatform;
            content: string;
          }>;
        };
        error?: string;
      };

      if (!response.ok || !payload.draft?.content) {
        throw new Error(payload.error || "Failed to generate caption");
      }

      const nextChannels =
        payload.draft?.suggestedChannels?.length
          ? payload.draft.suggestedChannels
          : composer.channels;

      setComposer((current) => ({
        ...current,
        title: payload.draft?.title || current.title,
        content: payload.draft?.content || current.content,
        channels: nextChannels,
        variants: buildComposerVariants(
          nextChannels,
          payload.draft?.variants?.map((variant) => ({
            id: `${variant.platform}`,
            postId: current.id || "draft",
            platform: variant.platform,
            content: variant.content,
            status: (variant.platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT") as SocialVariantStatus,
            aiGenerated: true,
            metadata: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })),
          payload.draft?.content || current.content,
        ),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate caption");
    } finally {
      setGeneratingCaption(false);
    }
  }

  async function generateIdeas() {
    if (!ideaTopic.trim() && !ideaObjective.trim()) {
      setError("Add a topic or objective before generating ideas.");
      return;
    }

    setGeneratingIdeas(true);
    setError("");

    try {
      const response = await fetch(apiUrl("/api/social/ai/ideas"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: ideaTopic,
          objective: ideaObjective,
          channels: composer.channels,
        }),
      });

      const payload = (await response.json()) as {
        ideas?: GeneratedIdea[];
        error?: string;
      };

      if (!response.ok || !payload.ideas?.length) {
        throw new Error(payload.error || "Failed to generate ideas");
      }

      setGeneratedIdeas(payload.ideas);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate ideas");
    } finally {
      setGeneratingIdeas(false);
    }
  }

  async function savePost() {
    if (!composer.content.trim()) {
      setError("Add a master post summary before saving.");
      return;
    }

    const activeVariants = composer.variants.filter((variant) =>
      composer.channels.includes(variant.platform),
    );

    if (activeVariants.some((variant) => !variant.content.trim())) {
      setError("Each selected platform needs its own variant content.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch(
        apiUrl(composer.id ? `/api/social/posts/${composer.id}` : "/api/social/posts"),
        {
          method: composer.id ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: composer.title || null,
            prompt: composer.prompt || null,
            content: composer.content,
            channels: composer.channels,
            status: composer.status,
            scheduledFor: composer.scheduledFor || null,
            primaryChannelId: composer.primaryChannelId || null,
            variants: activeVariants,
            metadata: {
              createdFrom: "social-posts-workspace",
              aiAssistUsed: activeVariants.some((variant) => variant.aiGenerated),
            },
          }),
        },
      );

      const payload = (await response.json()) as { post?: SocialPost; error?: string };

      if (!response.ok || !payload.post) {
        throw new Error(payload.error || "Failed to save post");
      }

      setPosts((current) => {
        if (composer.id) {
          return current.map((post) => (post.id === payload.post?.id ? payload.post : post));
        }

        return [payload.post as SocialPost, ...current];
      });

      setComposer(emptyComposer);
      setActiveVariantPlatform("FACEBOOK");
      setIsComposerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save post");
    } finally {
      setSaving(false);
    }
  }

  async function deletePost(id: string) {
    const confirmed = window.confirm("Delete this post?");
    if (!confirmed) return;

    setError("");

    try {
      const response = await fetch(apiUrl(`/api/social/posts/${id}`), {
        method: "DELETE",
        credentials: "include",
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to delete post");
      }

      setPosts((current) => current.filter((post) => post.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete post");
    }
  }

  async function publishPostToPlatform(postId: string, platform: SocialPlatform) {
    const publishTargetKey = `${postId}:${platform}`;
    setPublishingKey(publishTargetKey);
    setError("");

    try {
      const response = await fetch(apiUrl(`/api/social/posts/${postId}/publish`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      const payload = (await response.json()) as { post?: SocialPost; error?: string };

      if (!response.ok || !payload.post) {
        throw new Error(payload.error || "Failed to publish post");
      }

      setPosts((current) =>
        current.map((post) => (post.id === payload.post?.id ? payload.post : post)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish post");
    } finally {
      setPublishingKey(null);
    }
  }

  async function runPublishJobAction(job: SocialPublishJob, action: "retry" | "cancel" | "run_now") {
    setJobActionId(job.id);
    setError("");

    try {
      const response = await fetch(apiUrl(`/api/social/publish-jobs/${job.id}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { post?: SocialPost; error?: string };

      if (!response.ok || !payload.post) {
        throw new Error(payload.error || "Failed to update publish job");
      }

      setPosts((current) =>
        current.map((post) => (post.id === payload.post?.id ? payload.post : post)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update publish job");
    } finally {
      setJobActionId(null);
    }
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1520px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Badge className="mb-2 border-primary/30 bg-primary/5 text-primary">Posts</Badge>
            <h1 className="text-3xl font-semibold tracking-tight">Create once, tailor per platform, publish once.</h1>
            <p className="mt-1 max-w-3xl text-muted-foreground">
              Each post now has a master draft plus editable platform variants, so LinkedIn can be more developed while X stays compact.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={() => void loadData()}>
              <CalendarClock className="h-4 w-4" />
              Refresh
            </Button>
            <Button className="w-full gap-2 sm:w-auto" onClick={openNewComposer}>
              <Wand2 className="h-4 w-4" />
              New AI Draft
            </Button>
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_400px]">
          <Card>
            <CardHeader>
              <CardTitle>Draft Queue</CardTitle>
              <CardDescription>Track ideas, drafts, and approved variant-driven posts.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              {[
                { title: "Ideas", count: queueCounts.ideas, helper: "Prompt-led concepts waiting for polish" },
                { title: "Drafting", count: queueCounts.drafting, helper: "Platform variants still being refined" },
                { title: "Approved", count: queueCounts.approved, helper: "Ready for scheduling and fan-out publish" },
              ].map((column) => (
                <div key={column.title} className="rounded-xl border border-border/60 bg-secondary/35 p-4">
                  <div className="text-sm font-semibold">{column.title}</div>
                  <div className="mt-3 text-3xl font-semibold">{column.count}</div>
                  <div className="mt-2 text-sm text-muted-foreground">{column.helper}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>AI Idea Generator</CardTitle>
                <CardDescription>Generate post ideas you can turn into editable drafts immediately.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  value={ideaTopic}
                  onChange={(event) => setIdeaTopic(event.target.value)}
                  placeholder="Topic, offer, campaign, update, or audience..."
                />
                <Input
                  value={ideaObjective}
                  onChange={(event) => setIdeaObjective(event.target.value)}
                  placeholder="Objective: leads, credibility, launch, engagement..."
                />
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  disabled={generatingIdeas}
                  onClick={() => void generateIdeas()}
                >
                  <Sparkles className="h-4 w-4" />
                  {generatingIdeas ? "Generating..." : "Generate Ideas"}
                </Button>

                <div className="space-y-3">
                  {generatedIdeas.length === 0 ? (
                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6 text-foreground">
                      Generate a batch of usable post ideas, then open the strongest one as a draft and tailor variants before scheduling.
                    </div>
                  ) : (
                    generatedIdeas.map((idea, index) => (
                      <div key={`${idea.title}-${index}`} className="rounded-xl border border-border/70 bg-secondary/20 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-foreground">{idea.title}</p>
                            <p className="mt-1 text-sm text-muted-foreground">{idea.angle}</p>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => openIdeaAsDraft(idea)}>
                            Use draft
                          </Button>
                        </div>
                        <p className="mt-3 text-sm font-medium text-foreground">{idea.hook}</p>
                        <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {idea.draft}
                        </p>
                        {idea.suggestedChannels?.length ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {idea.suggestedChannels.map((platform) => {
                              const Icon = getPlatformIcon(platform);
                              return (
                                <Badge key={`${idea.title}-${platform}`} className={getPlatformTone(platform)}>
                                  <Icon className="mr-1 h-3.5 w-3.5" />
                                  {getPlatformLabel(platform)}
                                </Badge>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>AI Variants</CardTitle>
                <CardDescription>Generate a master draft plus platform-specific variants in one step.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  value={composer.prompt}
                  onChange={(event) =>
                    setComposer((current) => ({ ...current, prompt: event.target.value }))
                  }
                  placeholder="Describe the offer, tone, CTA, and audience..."
                />
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6 text-foreground">
                  {composer.content.trim()
                    ? composer.content
                    : "The AI route will produce a master draft and channel-specific variants once your OpenRouter key is configured."}
                </div>
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  disabled={generatingCaption}
                  onClick={() => void generateWithAi()}
                >
                  <Sparkles className="h-4 w-4" />
                  {generatingCaption ? "Generating..." : "Generate Variants"}
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Post Library</CardTitle>
              <CardDescription>Each post carries its own variant set and publish jobs.</CardDescription>
            </div>
            <Tabs value={activeFilter} onValueChange={(value) => setActiveFilter(value as "ALL" | SocialPostStatus)}>
              <TabsList className="bg-secondary/50">
                <TabsTrigger value="ALL">All</TabsTrigger>
                {SOCIAL_POST_STATUSES.map((status) => (
                  <TabsTrigger key={status} value={status}>
                    {getPostStatusMeta(status).label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value={activeFilter}>
                <span />
              </TabsContent>
            </Tabs>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="rounded-xl border border-border/70 bg-secondary/30 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-6 w-24 rounded-full" />
                      </div>
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                      <div className="flex flex-wrap gap-2">
                        {Array.from({ length: 3 }).map((__, badgeIndex) => (
                          <Skeleton key={badgeIndex} className="h-6 w-20 rounded-full" />
                        ))}
                      </div>
                    </div>
                    <div className="grid w-full gap-2 sm:flex sm:flex-wrap lg:w-auto">
                      <Skeleton className="h-9 w-full rounded-md sm:w-24" />
                      <Skeleton className="h-9 w-full rounded-md sm:w-24" />
                    </div>
                  </div>
                </div>
              ))
            ) : filteredPosts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
                No posts match the current filter yet.
              </div>
            ) : (
              filteredPosts.map((post) => {
                const status = getPostStatusMeta(post.status);
                const StatusIcon = status.icon;
                const publishJobs =
                  post.publishJobs?.filter((job) => supportedManualPublishPlatforms.includes(job.platform)) || [];

                return (
                  <div key={post.id} className="rounded-xl border border-border/70 bg-secondary/30 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-semibold text-foreground">
                            {post.title || "Untitled social post"}
                          </h3>
                          <Badge className={status.className}>
                            <StatusIcon className="mr-1 h-3.5 w-3.5" />
                            {status.label}
                          </Badge>
                        </div>
                        <p className="max-w-3xl whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {post.content}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {post.variants?.map((variant) => {
                            const Icon = getPlatformIcon(variant.platform);
                            return (
                              <Badge key={variant.id} className={getPlatformTone(variant.platform)}>
                                <Icon className="mr-1 h-3.5 w-3.5" />
                                {getPlatformLabel(variant.platform)}
                              </Badge>
                            );
                          })}
                        </div>
                        <div className="grid gap-2 md:grid-cols-2">
                          {post.variants?.map((variant) => (
                            <div key={variant.id} className="rounded-lg border border-border/60 bg-background/30 p-3">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                  {getPlatformLabel(variant.platform)}
                                </span>
                                <Badge className="border-border bg-background text-muted-foreground">
                                  {variant.status}
                                </Badge>
                              </div>
                              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                                {variant.content}
                              </p>
                            </div>
                          ))}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {post.scheduledFor
                            ? `Scheduled for ${formatDateTime(post.scheduledFor)}`
                            : `Saved ${formatDateTime(post.createdAt)}`}
                        </div>
                        {publishJobs.length ? (
                          <div className="grid gap-2 md:grid-cols-2">
                            {publishJobs.map((job) => {
                              const jobMeta = getPublishJobStatusMeta(job.status);
                              const JobIcon = jobMeta.icon;
                              return (
                                <div key={job.id} className="rounded-xl border border-border/60 bg-background/30 p-3">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge className={jobMeta.className}>
                                      {JobIcon ? <JobIcon className="mr-1 h-3.5 w-3.5" /> : null}
                                      {getPlatformLabel(job.platform)}: {jobMeta.label}
                                    </Badge>
                                    {job.scheduledFor ? (
                                      <span className="text-xs text-muted-foreground">
                                        {formatDateTime(job.scheduledFor)}
                                      </span>
                                    ) : null}
                                  </div>
                                  {job.errorMessage ? (
                                    <p className="mt-2 text-xs text-red-200">{job.errorMessage}</p>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                      <div className="grid w-full gap-2 sm:flex sm:flex-wrap sm:items-center lg:w-auto">
                        {supportedManualPublishPlatforms.map((platform) => {
                          if (!post.channels.includes(platform)) return null;

                          const platformJob =
                            post.publishJobs?.find((job) => job.platform === platform) || null;
                          const platformKey = `${post.id}:${platform}`;
                          const connectedChannel = connectedChannelsByPlatform.get(platform);

                          return (
                            <div key={`${post.id}-${platform}`} className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-2"
                                disabled={!connectedChannel || publishingKey === platformKey}
                                onClick={() => void publishPostToPlatform(post.id, platform)}
                              >
                                <Sparkles className="h-4 w-4" />
                                {publishingKey === platformKey
                                  ? "Publishing..."
                                  : `Publish to ${getPlatformLabel(platform)}`}
                              </Button>
                              {platformJob?.status === "FAILED" ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="gap-2"
                                  disabled={jobActionId === platformJob.id}
                                  onClick={() => void runPublishJobAction(platformJob, "retry")}
                                >
                                  <RotateCcw className="h-4 w-4" />
                                  {jobActionId === platformJob.id ? "Retrying..." : "Retry"}
                                </Button>
                              ) : null}
                              {platformJob && (platformJob.status === "QUEUED" || platformJob.status === "PENDING") ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={jobActionId === platformJob.id}
                                  onClick={() => void runPublishJobAction(platformJob, "run_now")}
                                >
                                  {jobActionId === platformJob.id ? "Running..." : "Run now"}
                                </Button>
                              ) : null}
                              {platformJob &&
                              (platformJob.status === "QUEUED" ||
                                platformJob.status === "PENDING" ||
                                platformJob.status === "FAILED") ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={jobActionId === platformJob.id}
                                  onClick={() => void runPublishJobAction(platformJob, "cancel")}
                                >
                                  Cancel
                                </Button>
                              ) : null}
                            </div>
                          );
                        })}
                        <Button variant="outline" size="sm" className="gap-2" onClick={() => openEditComposer(post)}>
                          <Pencil className="h-4 w-4" />
                          Edit
                        </Button>
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" onClick={() => void deletePost(post.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      {isComposerOpen ? (
        <div className="fixed inset-0 z-50">
          <button type="button" className="absolute inset-0 bg-black/55" onClick={() => setIsComposerOpen(false)} aria-label="Close composer" />
          <div className="absolute inset-y-0 right-0 w-full max-w-[760px] overflow-y-auto border-l border-border bg-card shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6">
              <div>
                <p className="text-lg font-semibold text-foreground">{composer.id ? "Edit Post" : "New Post"}</p>
                <p className="text-sm text-muted-foreground">Build the master post, then refine each platform variant before one-click publishing.</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setIsComposerOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-5 px-4 py-5 sm:px-6 sm:py-6">
              <label className="block space-y-2">
                <span className="text-sm text-muted-foreground">Title</span>
                <Input value={composer.title} onChange={(event) => setComposer((current) => ({ ...current, title: event.target.value }))} placeholder="Sunday special launch" />
              </label>

              <label className="block space-y-2">
                <span className="text-sm text-muted-foreground">AI prompt</span>
                <div className="space-y-3">
                  <textarea
                    value={composer.prompt}
                    onChange={(event) => setComposer((current) => ({ ...current, prompt: event.target.value }))}
                    placeholder="Describe the offer, tone, CTA, and what should differ by platform."
                    className="min-h-[96px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                  />
                  <Button variant="outline" className="gap-2" disabled={generatingCaption} onClick={() => void generateWithAi()}>
                    <Sparkles className="h-4 w-4" />
                    {generatingCaption ? "Generating..." : "Generate Variants"}
                  </Button>
                </div>
              </label>

              <label className="block space-y-2">
                <span className="text-sm text-muted-foreground">Master post summary</span>
                <textarea
                  value={composer.content}
                  onChange={(event) => setComposer((current) => ({ ...current, content: event.target.value }))}
                  placeholder="This is the shared campaign idea or master summary."
                  className="min-h-[120px] w-full rounded-md border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
              </label>

              <div className="space-y-3">
                <span className="text-sm text-muted-foreground">Publishing channels</span>
                <div className="grid gap-3 sm:grid-cols-2">
                  {SOCIAL_PLATFORM_ORDER.map((platform) => {
                    const Icon = getPlatformIcon(platform);
                    const active = composer.channels.includes(platform);
                    return (
                      <label
                        key={platform}
                        className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${
                          active ? "border-primary/30 bg-primary/5" : "border-border/70 bg-secondary/20"
                        }`}
                      >
                        <Checkbox checked={active} onCheckedChange={(checked) => toggleChannel(platform, checked)} />
                        <div className={`rounded-md border p-2 ${getPlatformTone(platform)}`}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <span className="text-sm text-foreground">{getPlatformLabel(platform)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-sm text-muted-foreground">Status</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={composer.status}
                    onChange={(event) =>
                      setComposer((current) => ({ ...current, status: event.target.value as SocialPostStatus }))
                    }
                  >
                    {SOCIAL_POST_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {getPostStatusMeta(status).label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-2">
                  <span className="text-sm text-muted-foreground">Schedule</span>
                  <Input type="datetime-local" value={composer.scheduledFor} onChange={(event) => setComposer((current) => ({ ...current, scheduledFor: event.target.value }))} />
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-sm text-muted-foreground">Primary connected channel</span>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                  value={composer.primaryChannelId}
                  onChange={(event) => setComposer((current) => ({ ...current, primaryChannelId: event.target.value }))}
                >
                  <option value="">None selected</option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.displayName} • {getPlatformLabel(channel.platform)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Platform variants</span>
                  <span className="text-xs text-muted-foreground">Each selected channel gets its own editable version.</span>
                </div>

                <Tabs value={activeVariantPlatform} onValueChange={(value) => setActiveVariantPlatform(value as SocialPlatform)}>
                  <TabsList className="flex w-full flex-wrap bg-secondary/50">
                    {activeComposerVariants.map((variant) => (
                      <TabsTrigger key={variant.platform} value={variant.platform}>
                        {getPlatformLabel(variant.platform)}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  {activeComposerVariants.map((variant) => (
                    <TabsContent key={variant.platform} value={variant.platform}>
                      <div className="space-y-4 rounded-xl border border-border/70 bg-secondary/20 p-4">
                        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                          <label className="block space-y-2">
                            <span className="text-sm text-muted-foreground">
                              {getPlatformLabel(variant.platform)} copy
                            </span>
                            <textarea
                              value={variant.content}
                              onChange={(event) =>
                                updateVariant(variant.platform, { content: event.target.value })
                              }
                              placeholder={`Write the ${getPlatformLabel(variant.platform)} version here...`}
                              className="min-h-[220px] w-full rounded-md border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                            />
                          </label>

                          <div className="space-y-4">
                            <label className="block space-y-2">
                              <span className="text-sm text-muted-foreground">Variant status</span>
                              <select
                                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                                value={variant.status}
                                onChange={(event) =>
                                  updateVariant(variant.platform, {
                                    status: event.target.value as SocialVariantStatus,
                                  })
                                }
                              >
                                <option value="DRAFT">Draft</option>
                                <option value="APPROVED">Approved</option>
                                <option value="NEEDS_EDITS">Needs edits</option>
                              </select>
                            </label>

                            <div className="rounded-md border border-border/70 bg-background/40 p-3 text-xs text-muted-foreground">
                              {variant.platform === "LINKEDIN"
                                ? "LinkedIn variants should usually be more developed, more professional, and easier to scan in paragraphs."
                                : variant.platform === "X"
                                  ? "Keep X variants compact and tight."
                                  : variant.platform === "WHATSAPP_STATUS"
                                    ? "WhatsApp Status should stay short and direct."
                                    : "Adjust tone, hook, and CTA for this channel."}
                            </div>
                          </div>
                        </div>
                      </div>
                    </TabsContent>
                  ))}
                </Tabs>
              </div>

              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setIsComposerOpen(false)}>
                  Cancel
                </Button>
                <Button className="flex-1" disabled={saving} onClick={() => void savePost()}>
                  {saving ? "Saving..." : composer.id ? "Update Post" : "Create Post"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
