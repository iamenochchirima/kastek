"use client";

import { apiUrl } from "@/lib/server-api";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, BarChart3, CalendarDays, CalendarClock, Check, CircleAlert, FileClock, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  getPlatformCapabilities,
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
  channelSelections: Partial<Record<SocialPlatform, string>>;
  instagramImageUrl: string;
  variants: ComposerVariant[];
};

type ComposerStep = 1 | 2 | 3 | 4;

type GeneratedIdea = {
  title: string;
  angle: string;
  hook: string;
  draft: string;
  suggestedChannels?: SocialPlatform[];
};

const defaultChannels: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "THREADS", "LINKEDIN", "X"];
const COMPOSER_DRAFT_STORAGE_KEY = "kasitek:content-composer";
const supportedManualPublishPlatforms: SocialPlatform[] = SOCIAL_PLATFORM_ORDER.filter((platform) =>
  getPlatformCapabilities(platform).supportsManualPublish,
);

const emptyComposer: ComposerState = {
  id: null,
  title: "",
  prompt: "",
  content: "",
  channels: [],
  status: "DRAFT",
  scheduledFor: "",
  primaryChannelId: "",
  channelSelections: {},
  instagramImageUrl: "",
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

type PostsWorkspaceProps = {
  view?: "posts" | "history";
};

const workspaceNavigation: Array<{ href: string; label: string; icon: typeof Pencil; view?: "posts" | "history" }> = [
  { href: "/content", label: "Posts", icon: Pencil, view: "posts" },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/content/history", label: "History", icon: FileClock, view: "history" },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

export function PostsWorkspace({ view = "posts" }: PostsWorkspaceProps) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeFilter, setActiveFilter] = useState<"ALL" | SocialPostStatus>(view === "history" ? "PUBLISHED" : "ALL");
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState<"ALL" | SocialPlatform>("ALL");
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);
  const [publishingKey, setPublishingKey] = useState<string | null>(null);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [generatingCaption, setGeneratingCaption] = useState(false);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  const [ideaTopic, setIdeaTopic] = useState("");
  const [ideaObjective, setIdeaObjective] = useState("");
  const [generatedIdeas, setGeneratedIdeas] = useState<GeneratedIdea[]>([]);
  const [isIdeasOpen, setIsIdeasOpen] = useState(false);
  const [activeVariantPlatform, setActiveVariantPlatform] = useState<SocialPlatform>("FACEBOOK");
  const [composerStep, setComposerStep] = useState<ComposerStep>(1);

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!saved) return;

    try {
      const parsed = JSON.parse(saved) as {
        composer?: ComposerState;
        step?: ComposerStep;
        activeVariantPlatform?: SocialPlatform;
      };
      if (parsed.composer) {
        setComposer({ ...emptyComposer, ...parsed.composer });
        setComposerStep(parsed.step && parsed.step >= 1 && parsed.step <= 4 ? parsed.step : 1);
        setActiveVariantPlatform(parsed.activeVariantPlatform || parsed.composer.channels[0] || "FACEBOOK");
        setIsComposerOpen(true);
      }
    } catch {
      // A stale local composer should never block access to Content.
    } finally {
      window.sessionStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    }
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
    const allowedStatuses = view === "history" ? ["PUBLISHED", "FAILED"] : ["DRAFT", "SCHEDULED", "PROCESSING"];
    return posts.filter((post) => {
      if (!allowedStatuses.includes(post.status)) return false;
      if (activeFilter !== "ALL" && post.status !== activeFilter) return false;
      if (platformFilter !== "ALL" && !post.channels.includes(platformFilter)) return false;
      const needle = search.trim().toLowerCase();
      return !needle || `${post.title || ""} ${post.content || ""}`.toLowerCase().includes(needle);
    });
  }, [activeFilter, platformFilter, posts, search, view]);

  const filters = view === "history" ? ["ALL", "PUBLISHED", "FAILED"] as const : ["ALL", "DRAFT", "SCHEDULED", "PROCESSING"] as const;

  const connectedChannels = useMemo(
    () => channels.filter((channel) => channel.status === "CONNECTED"),
    [channels],
  );

  const connectedChannelsByPlatform = useMemo(() => {
    const grouped = new Map<SocialPlatform, SocialChannelConnection[]>();
    for (const channel of connectedChannels) {
      grouped.set(channel.platform, [...(grouped.get(channel.platform) || []), channel]);
    }
    return grouped;
  }, [connectedChannels]);

  const activeComposerVariants = useMemo(
    () => composer.variants.filter((variant) => composer.channels.includes(variant.platform)),
    [composer.channels, composer.variants],
  );

  function openNewComposer() {
    setComposer(emptyComposer);
    setActiveVariantPlatform("FACEBOOK");
    setComposerStep(1);
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
      channelSelections: {},
      instagramImageUrl: "",
      variants: nextVariants.map((variant) => ({
        ...variant,
        status: variant.platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT",
      })),
    });
    setActiveVariantPlatform(nextChannels[0] || "FACEBOOK");
    setComposerStep(1);
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
      channelSelections: post.publishJobs?.reduce<Partial<Record<SocialPlatform, string>>>((current, job) => {
        if (job.channelConnectionId) current[job.platform] = job.channelConnectionId;
        return current;
      }, post.primaryChannelId && post.channels.length === 1 ? { [post.channels[0]]: post.primaryChannelId } : {}) || {},
      instagramImageUrl:
        typeof post.metadata?.instagramImageUrl === "string"
          ? post.metadata.instagramImageUrl
          : "",
      variants: buildComposerVariants(post.channels, post.variants, post.content),
    });
    setActiveVariantPlatform(post.channels[0] || "FACEBOOK");
    setComposerStep(1);
    setIsComposerOpen(true);
  }

  function selectChannel(channel: SocialChannelConnection) {
    setComposer((current) => {
      const platform = channel.platform;
      const nextChannels = current.channels.includes(platform)
        ? current.channels
        : [...current.channels, platform];
      const existingVariant = current.variants.find((variant) => variant.platform === platform);
      const nextVariants = existingVariant
        ? current.variants
        : [...current.variants, {
            platform,
            content: current.content,
            status: (platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT") as SocialVariantStatus,
            aiGenerated: false,
          }];

      return {
        ...current,
        channels: nextChannels,
        variants: nextVariants,
        primaryChannelId: current.primaryChannelId || channel.id,
        channelSelections: { ...current.channelSelections, [platform]: channel.id },
      };
    });
    setActiveVariantPlatform(channel.platform);
  }

  function removeChannel(platform: SocialPlatform) {
    setComposer((current) => {
      const channelSelections = { ...current.channelSelections };
      delete channelSelections[platform];
      const nextChannels = current.channels.filter((channel) => channel !== platform);
      const primaryChannelId = current.primaryChannelId === current.channelSelections[platform]
        ? Object.values(channelSelections).find(Boolean) || ""
        : current.primaryChannelId;
      return {
        ...current,
        channels: nextChannels,
        variants: current.variants.filter((variant) => variant.platform !== platform),
        channelSelections,
        primaryChannelId,
      };
    });
    if (activeVariantPlatform === platform) setActiveVariantPlatform("FACEBOOK");
  }

  function beginConnection(platform: SocialPlatform) {
    const endpoint: Partial<Record<SocialPlatform, string>> = {
      FACEBOOK: "/api/social/oauth/meta/start?target=facebook",
      INSTAGRAM: "/api/social/oauth/instagram/start",
      LINKEDIN: "/api/social/oauth/linkedin/start",
      X: "/api/social/oauth/x/start",
    };
    const href = endpoint[platform];
    if (!href) return;

    window.sessionStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({
      composer,
      step: composerStep,
      activeVariantPlatform,
    }));
    window.location.assign(apiUrl(href));
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

      const nextChannels = composer.channels;

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
    if (!composer.channels.length) {
      setError("Choose at least one connected destination first.");
      setComposerStep(1);
      return;
    }

    if (composer.channels.some((platform) => !composer.channelSelections[platform])) {
      setError("Choose an account for every selected destination.");
      setComposerStep(1);
      return;
    }

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
            primaryChannelId: composer.primaryChannelId || Object.values(composer.channelSelections).find(Boolean) || null,
            channelSelections: composer.channelSelections,
            variants: activeVariants,
            metadata: {
              createdFrom: "social-posts-workspace",
              aiAssistUsed: activeVariants.some((variant) => variant.aiGenerated),
              instagramImageUrl: composer.instagramImageUrl.trim() || null,
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
      setComposerStep(1);
      setIsComposerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save post");
    } finally {
      setSaving(false);
    }
  }

  function advanceComposerStep() {
    if (composerStep === 1) {
      if (!composer.channels.length) {
        setError("Choose at least one connected destination first.");
        return;
      }
      if (composer.channels.some((platform) => !composer.channelSelections[platform])) {
        setError("Choose an account for every selected destination.");
        return;
      }
    }
    if (composerStep === 2 && !composer.content.trim()) {
      setError("Add the post copy before continuing.");
      return;
    }
    setError("");
    setComposerStep((current) => Math.min(current + 1, 4) as ComposerStep);
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
        <div className="space-y-4 border-b border-border pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{view === "history" ? "Post history" : "Posts"}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {view === "history" ? "Published posts and items that need attention." : "Create, review, and schedule posts."}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {view === "posts" ? (
                <Button variant="outline" className="gap-2" onClick={() => setIsIdeasOpen(true)}>
                  <Sparkles className="h-4 w-4" />
                  Generate ideas
                </Button>
              ) : null}
              <Button className="gap-2" onClick={openNewComposer}>
                <Plus className="h-4 w-4" />
                Create post
              </Button>
            </div>
          </div>

          <nav aria-label="Content navigation" className="flex gap-1 overflow-x-auto">
            {workspaceNavigation.map((item) => {
              const Icon = item.icon;
              const active = item.view === view;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Card>
          <CardHeader className="flex flex-col gap-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>{view === "history" ? "Publishing history" : "Your posts"}</CardTitle>
              <CardDescription>{view === "history" ? "Review outcomes, failures, and retry work." : "Drafts and scheduled posts ready for review."}</CardDescription>
            </div>
            <Tabs value={activeFilter} onValueChange={(value) => setActiveFilter(value as "ALL" | SocialPostStatus)}>
              <TabsList className="bg-secondary/50">
                {filters.map((status) => (
                  status === "ALL" ? <TabsTrigger key={status} value="ALL">All</TabsTrigger> :
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
            <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search posts" />
              </div>
              <select
                className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
                value={platformFilter}
                onChange={(event) => setPlatformFilter(event.target.value as "ALL" | SocialPlatform)}
              >
                <option value="ALL">All channels</option>
                {SOCIAL_PLATFORM_ORDER.map((platform) => <option key={platform} value={platform}>{getPlatformLabel(platform)}</option>)}
              </select>
              <Button variant="outline" size="icon" onClick={() => void loadData()} aria-label="Refresh posts">
                <CalendarClock className="h-4 w-4" />
              </Button>
            </div>
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
                                    <p className="mt-2 text-xs text-destructive">{job.errorMessage}</p>
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
                          const connectedChannel = connectedChannelsByPlatform.get(platform)?.[0];

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

      {isIdeasOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button type="button" className="absolute inset-0 bg-overlay" onClick={() => setIsIdeasOpen(false)} aria-label="Close idea generator" />
          <div className="relative max-h-[min(760px,calc(100vh-2rem))] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <p className="text-lg font-semibold text-foreground">Generate ideas</p>
                <p className="mt-1 text-sm text-muted-foreground">Start with a topic and an objective, then turn an idea into a post.</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setIsIdeasOpen(false)} aria-label="Close idea generator">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input value={ideaTopic} onChange={(event) => setIdeaTopic(event.target.value)} placeholder="Topic or offer" />
                <Input value={ideaObjective} onChange={(event) => setIdeaObjective(event.target.value)} placeholder="Objective" />
              </div>
              <Button className="gap-2" disabled={generatingIdeas} onClick={() => void generateIdeas()}>
                <Sparkles className="h-4 w-4" />
                {generatingIdeas ? "Generating..." : "Generate ideas"}
              </Button>
              {generatedIdeas.length ? (
                <div className="space-y-3">
                  {generatedIdeas.map((idea, index) => (
                    <div key={`${idea.title}-${index}`} className="rounded-lg border border-border p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="font-medium text-foreground">{idea.title}</p>
                          <p className="mt-1 text-sm text-muted-foreground">{idea.angle}</p>
                        </div>
                        <Button size="sm" onClick={() => { openIdeaAsDraft(idea); setIsIdeasOpen(false); }}>
                          Use idea
                        </Button>
                      </div>
                      <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{idea.draft}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {isComposerOpen ? (
        <div className="fixed inset-0 z-50">
          <button type="button" className="absolute inset-0 bg-overlay" onClick={() => setIsComposerOpen(false)} aria-label="Close composer" />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-[760px] flex-col border-l border-border bg-card shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6">
              <div>
                <p className="text-lg font-semibold text-foreground">{composer.id ? "Edit post" : "New post"}</p>
                <p className="mt-1 text-sm text-muted-foreground">Step {composerStep} of 4</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setIsComposerOpen(false)} aria-label="Close composer">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex gap-1 border-b border-border px-4 sm:px-6">
              {["Destinations", "Post", "Versions", "Review"].map((label, index) => {
                const step = (index + 1) as ComposerStep;
                return <div key={label} className={`flex-1 border-b-2 px-1 py-3 text-center text-xs font-medium ${composerStep === step ? "border-foreground text-foreground" : composerStep > step ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{label}</div>;
              })}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
              {composerStep === 1 ? (
                <section className="space-y-5">
                  <div>
                    <h2 className="text-xl font-semibold text-foreground">Choose destinations</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Select the exact connected account for each platform.</p>
                  </div>
                  <div className="space-y-3">
                    {defaultChannels.map((platform) => {
                      const Icon = getPlatformIcon(platform);
                      const options = connectedChannelsByPlatform.get(platform) || [];
                      const selectedId = composer.channelSelections[platform];
                      const selected = composer.channels.includes(platform);
                      return (
                        <div key={platform} className={`rounded-xl border p-4 ${selected ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                          <div className="flex items-center gap-3">
                            <div className={`rounded-md border p-2 ${getPlatformTone(platform)}`}><Icon className="h-4 w-4" /></div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-foreground">{getPlatformLabel(platform)}</p>
                              <p className="text-sm text-muted-foreground">{options.length ? `${options.length} connected` : "Not connected"}</p>
                            </div>
                            {selected ? <Button variant="ghost" size="sm" onClick={() => removeChannel(platform)}>Remove</Button> : null}
                          </div>
                          {options.length ? (
                            <div className="mt-3 grid gap-2">
                              {options.map((channel) => {
                                const isSelected = selectedId === channel.id;
                                return (
                                  <button type="button" key={channel.id} onClick={() => selectChannel(channel)} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${isSelected ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background hover:border-primary/50"}`}>
                                    <span className="min-w-0"><span className="block truncate font-medium">{channel.displayName}</span>{channel.handle ? <span className="block truncate text-xs text-muted-foreground">@{channel.handle.replace(/^@/, "")}</span> : null}</span>
                                    {isSelected ? <Check className="ml-3 h-4 w-4 shrink-0 text-primary" /> : null}
                                  </button>
                                );
                              })}
                            </div>
                          ) : platform === "THREADS" ? (
                            <p className="mt-3 text-sm text-muted-foreground">Connection is not available yet.</p>
                          ) : (
                            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-secondary/40 px-3 py-2">
                              <span className="text-sm text-muted-foreground">Connect an account to use this platform.</span>
                              <Button size="sm" variant="outline" onClick={() => beginConnection(platform)}>Connect</Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {composerStep === 2 ? (
                <section className="space-y-5">
                  <div><h2 className="text-xl font-semibold text-foreground">Write the post</h2><p className="mt-1 text-sm text-muted-foreground">Start with the shared copy. You can tailor it next.</p></div>
                  <label className="block space-y-2"><span className="text-sm text-muted-foreground">Title</span><Input value={composer.title} onChange={(event) => setComposer((current) => ({ ...current, title: event.target.value }))} placeholder="Post title" /></label>
                  <label className="block space-y-2"><span className="text-sm text-muted-foreground">Post copy</span><textarea value={composer.content} onChange={(event) => setComposer((current) => ({ ...current, content: event.target.value }))} placeholder="Write your post..." className="min-h-[180px] w-full rounded-md border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary" /></label>
                  <div className="rounded-xl border border-border bg-secondary/20 p-4"><label className="block space-y-2"><span className="text-sm font-medium text-foreground">Generate a draft</span><textarea value={composer.prompt} onChange={(event) => setComposer((current) => ({ ...current, prompt: event.target.value }))} placeholder="Optional prompt" className="min-h-[86px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary" /></label><Button variant="outline" className="mt-3 gap-2" disabled={generatingCaption} onClick={() => void generateWithAi()}><Sparkles className="h-4 w-4" />{generatingCaption ? "Generating..." : "Generate versions"}</Button></div>
                  {composer.channels.includes("INSTAGRAM") ? <label className="block space-y-2"><span className="text-sm text-muted-foreground">Instagram image URL</span><Input type="url" value={composer.instagramImageUrl} onChange={(event) => setComposer((current) => ({ ...current, instagramImageUrl: event.target.value }))} placeholder="https://example.com/image.jpg" /><span className="block text-xs text-muted-foreground">Required when publishing to Instagram.</span></label> : null}
                </section>
              ) : null}

              {composerStep === 3 ? (
                <section className="space-y-5">
                  <div><h2 className="text-xl font-semibold text-foreground">Tailor versions</h2><p className="mt-1 text-sm text-muted-foreground">Adjust the copy for each selected destination.</p></div>
                  <Tabs value={activeVariantPlatform} onValueChange={(value) => setActiveVariantPlatform(value as SocialPlatform)}>
                    <TabsList className="flex w-full flex-wrap bg-secondary/50">{activeComposerVariants.map((variant) => <TabsTrigger key={variant.platform} value={variant.platform}>{getPlatformLabel(variant.platform)}</TabsTrigger>)}</TabsList>
                    {activeComposerVariants.map((variant) => <TabsContent key={variant.platform} value={variant.platform}><div className="space-y-3 rounded-xl border border-border p-4"><label className="block space-y-2"><span className="text-sm text-muted-foreground">{getPlatformLabel(variant.platform)} copy</span><textarea value={variant.content} onChange={(event) => updateVariant(variant.platform, { content: event.target.value })} placeholder={`Write the ${getPlatformLabel(variant.platform)} version...`} className="min-h-[260px] w-full rounded-md border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:border-primary" /></label><label className="block space-y-2"><span className="text-sm text-muted-foreground">Status</span><select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={variant.status} onChange={(event) => updateVariant(variant.platform, { status: event.target.value as SocialVariantStatus })}><option value="DRAFT">Draft</option><option value="APPROVED">Approved</option><option value="NEEDS_EDITS">Needs edits</option></select></label></div></TabsContent>)}
                  </Tabs>
                </section>
              ) : null}

              {composerStep === 4 ? (
                <section className="space-y-5">
                  <div><h2 className="text-xl font-semibold text-foreground">Review and schedule</h2><p className="mt-1 text-sm text-muted-foreground">Save as a draft or schedule the selected versions.</p></div>
                  <div className="rounded-xl border border-border p-4"><p className="text-sm font-medium text-foreground">Destinations</p><div className="mt-3 space-y-2">{composer.channels.map((platform) => { const channel = connectedChannels.find((item) => item.id === composer.channelSelections[platform]); return <div key={platform} className="flex items-center justify-between gap-3 text-sm"><span>{getPlatformLabel(platform)}</span><span className="text-muted-foreground">{channel?.displayName || "Not selected"}</span></div>; })}</div></div>
                  <div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2"><span className="text-sm text-muted-foreground">Save as</span><select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={composer.status} onChange={(event) => setComposer((current) => ({ ...current, status: event.target.value as SocialPostStatus }))}>{SOCIAL_POST_STATUSES.filter((status) => status === "DRAFT" || status === "SCHEDULED").map((status) => <option key={status} value={status}>{getPostStatusMeta(status).label}</option>)}</select></label><label className="block space-y-2"><span className="text-sm text-muted-foreground">Schedule</span><Input type="datetime-local" disabled={composer.status !== "SCHEDULED"} value={composer.scheduledFor} onChange={(event) => setComposer((current) => ({ ...current, scheduledFor: event.target.value }))} /></label></div>
                  {composer.status === "SCHEDULED" && !composer.scheduledFor ? <div className="flex gap-2 rounded-md border border-status-warning/30 bg-status-warning-soft p-3 text-sm text-status-warning"><CircleAlert className="h-4 w-4 shrink-0" />Choose a date and time before scheduling.</div> : null}
                </section>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
              <Button variant="ghost" onClick={() => composerStep === 1 ? setIsComposerOpen(false) : setComposerStep((current) => (current - 1) as ComposerStep)}>{composerStep === 1 ? "Cancel" : <><ArrowLeft className="mr-2 h-4 w-4" />Back</>}</Button>
              {composerStep < 4 ? <Button onClick={advanceComposerStep}>Continue<ArrowRight className="ml-2 h-4 w-4" /></Button> : <Button disabled={saving || (composer.status === "SCHEDULED" && !composer.scheduledFor)} onClick={() => void savePost()}>{saving ? "Saving..." : composer.id ? "Update post" : composer.status === "SCHEDULED" ? "Schedule post" : "Save draft"}</Button>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
