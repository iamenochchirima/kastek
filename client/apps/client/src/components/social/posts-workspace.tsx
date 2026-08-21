"use client";

import { apiUrl } from "@/lib/server-api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, FileImage, LayoutGrid, List, Pencil, Play, Plus, RotateCcw, Search, Smartphone, Sparkles, Trash2, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContentWorkspaceNavigation } from "@/components/social/content-workspace-navigation";
import { SocialPostsLibrary } from "@/components/social/social-posts-library";
import {
  SOCIAL_PLATFORM_ORDER,
  type SocialChannelConnection,
  type SocialPlatform,
  type SocialPost,
  type SocialPostMedia,
  type SocialPostStatus,
  type SocialPostVariant,
  type SocialPublishJob,
  type SocialVariantStatus,
  formatDateInputValue,
  formatDateTime,
  getPlatformCapabilities,
  getPlatformIcon,
  getPlatformIconClass,
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

type ComposerMedia = Pick<SocialPostMedia, "assetId" | "kind" | "mimeType" | "fileName" | "byteSize" | "width" | "height" | "durationMs" | "altText"> & {
  id?: string;
  sortOrder: number;
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
  tiktokMediaUrl: string;
  tiktokMediaType: "VIDEO" | "PHOTO";
  tiktokPrivacyLevel: "SELF_ONLY" | "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR";
  tiktokConsent: boolean;
  media: ComposerMedia[];
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

type SocialPostActivityEvent = {
  id: string;
  type: string;
  status?: string;
  platform?: SocialPlatform;
  message?: string;
  occurredAt: string;
  source: "content" | "provider";
};

type PostDeleteProviderResult = {
  platform: SocialPlatform;
  status: "DELETED" | "FAILED";
  message?: string | null;
};

type AiGenerationTarget =
  | { kind: "shared" }
  | { kind: "variant"; platform: SocialPlatform };

const defaultChannels: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "THREADS", "TIKTOK", "BLUESKY", "LINKEDIN", "X"];
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
  tiktokMediaUrl: "",
  tiktokMediaType: "VIDEO",
  tiktokPrivacyLevel: "SELF_ONLY",
  tiktokConsent: false,
  media: [],
  variants: defaultChannels.map((platform) => ({
    platform,
    content: "",
    status: platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT",
    aiGenerated: false,
  })),
};

function channelAvatarUrl(channel: SocialChannelConnection) {
  const metadata = channel.metadata;
  if (!metadata) return null;

  for (const key of ["profilePictureUrl", "pictureUrl", "avatarUrl", "picture"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  return null;
}

function channelLabel(channel: SocialChannelConnection) {
  return channel.displayName?.trim() || channel.handle?.replace(/^@/, "") || `${getPlatformLabel(channel.platform)} account`;
}

function channelInitials(channel: SocialChannelConnection) {
  const label = channelLabel(channel).trim();
  return label.slice(0, 2).toUpperCase();
}

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

function mediaUrl(assetId: string) {
  return apiUrl(`/api/social/media/${encodeURIComponent(assetId)}`);
}

function formatMediaSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number | null) {
  if (!durationMs) return "";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

type PostsWorkspaceProps = { view?: "posts" | "history" };

export function PostsWorkspace({ view = "posts" }: PostsWorkspaceProps) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeFilter, setActiveFilter] = useState<"ALL" | SocialPostStatus>(view === "history" ? "PUBLISHED" : "ALL");
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState<"ALL" | SocialPlatform>("ALL");
  const [historyViewMode, setHistoryViewMode] = useState<"grid" | "table">("grid");
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);
  const [publishingKey, setPublishingKey] = useState<string | null>(null);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [generatingCaption, setGeneratingCaption] = useState(false);
  const [generatingVariantPlatform, setGeneratingVariantPlatform] = useState<SocialPlatform | null>(null);
  const [aiGenerationTarget, setAiGenerationTarget] = useState<AiGenerationTarget | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  const [ideaTopic, setIdeaTopic] = useState("");
  const [ideaObjective, setIdeaObjective] = useState("");
  const [generatedIdeas, setGeneratedIdeas] = useState<GeneratedIdea[]>([]);
  const [isIdeasOpen, setIsIdeasOpen] = useState(false);
  const [activeVariantPlatform, setActiveVariantPlatform] = useState<SocialPlatform>("FACEBOOK");
  const [composerStep, setComposerStep] = useState<ComposerStep>(1);
  const [tiktokPrivacyOptions, setTiktokPrivacyOptions] = useState<ComposerState["tiktokPrivacyLevel"][]>([]);
  const [activityPost, setActivityPost] = useState<{ post: SocialPost; events: SocialPostActivityEvent[] } | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SocialPost | null>(null);
  const [deleteScope, setDeleteScope] = useState<"local" | "platforms">("local");
  const [deleteProviderResults, setDeleteProviderResults] = useState<PostDeleteProviderResult[]>([]);
  const [deletingPost, setDeletingPost] = useState(false);
  const refreshedChannelIdentities = useRef(new Set<string>());
  const mediaInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    const channelId = composer.channelSelections.TIKTOK;
    if (!channelId) { setTiktokPrivacyOptions([]); return; }
    let cancelled = false;
    void fetch(apiUrl(`/api/social/channels/${channelId}/tiktok-creator-info`), { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { creator?: { privacy_level_options?: string[] }; error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to load TikTok creator settings");
        const options = (payload.creator?.privacy_level_options || []) as ComposerState["tiktokPrivacyLevel"][];
        if (!cancelled) {
          setTiktokPrivacyOptions(options);
          setComposer((current) => options.includes(current.tiktokPrivacyLevel) ? current : { ...current, tiktokPrivacyLevel: options[0] || "SELF_ONLY", tiktokConsent: false });
        }
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load TikTok creator settings"); });
    return () => { cancelled = true; };
  }, [composer.channelSelections.TIKTOK]);

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

  async function loadData({ showLoading = true, clearError = true } = {}) {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    if (clearError) setError("");

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
      if (showLoading) setLoading(false);
      else setRefreshing(false);
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

  useEffect(() => {
    const missingProfileImages = connectedChannels.filter((channel) => {
      if (channel.platform === "THREADS" || channelAvatarUrl(channel)) return false;
      if (refreshedChannelIdentities.current.has(channel.id)) return false;
      refreshedChannelIdentities.current.add(channel.id);
      return true;
    });
    if (!missingProfileImages.length) return;

    let cancelled = false;
    void Promise.all(
      missingProfileImages.map(async (channel) => {
        try {
          const response = await fetch(apiUrl(`/api/social/channels/${channel.id}/identity`), {
            method: "POST",
            credentials: "include",
          });
          if (!response.ok) return null;
          const payload = (await response.json()) as { channel?: SocialChannelConnection };
          return payload.channel || null;
        } catch {
          return null;
        }
      }),
    ).then((refreshed) => {
      if (cancelled) return;
      const byId = new Map(refreshed.filter((channel): channel is SocialChannelConnection => Boolean(channel)).map((channel) => [channel.id, channel]));
      if (!byId.size) return;
      setChannels((current) => current.map((channel) => byId.get(channel.id) || channel));
    });

    return () => {
      cancelled = true;
    };
  }, [connectedChannels]);

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

  const mediaPublishIssues = useMemo(() => {
    if (!composer.media.length) return [];
    return composer.channels.flatMap((platform) => {
      const capabilities = getPlatformCapabilities(platform).media;
      const images = composer.media.filter((item) => item.kind === "IMAGE").length;
      const videos = composer.media.filter((item) => item.kind === "VIDEO").length;
      const issues: string[] = [];
      if (images && (!capabilities.images.supported || images > capabilities.images.maxCount)) {
        issues.push(`${getPlatformLabel(platform)} does not accept ${images > capabilities.images.maxCount ? `that many images (maximum ${capabilities.images.maxCount})` : "these uploaded images"}`);
      }
      if (videos && (!capabilities.videos.supported || videos > capabilities.videos.maxCount)) {
        issues.push(`${getPlatformLabel(platform)} does not accept ${videos > capabilities.videos.maxCount ? `that many videos (maximum ${capabilities.videos.maxCount})` : "uploaded videos"}`);
      }
      return issues;
    });
  }, [composer.channels, composer.media]);

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
      tiktokMediaUrl: "",
      tiktokMediaType: "VIDEO",
      tiktokPrivacyLevel: "SELF_ONLY",
      tiktokConsent: false,
      media: [],
      variants: nextVariants.map((variant) => ({
        ...variant,
        status: variant.platform === "LINKEDIN" ? "NEEDS_EDITS" : "DRAFT",
      })),
    });
    setActiveVariantPlatform(nextChannels[0] || "FACEBOOK");
    setComposerStep(1);
    setIsComposerOpen(true);
  }

  const openEditComposer = useCallback((post: SocialPost) => {
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
      tiktokMediaUrl: typeof post.metadata?.tiktokMediaUrl === "string" ? post.metadata.tiktokMediaUrl : "",
      tiktokMediaType: post.metadata?.tiktokMediaType === "PHOTO" ? "PHOTO" : "VIDEO",
      tiktokPrivacyLevel: typeof post.metadata?.tiktokPrivacyLevel === "string"
        ? post.metadata.tiktokPrivacyLevel as ComposerState["tiktokPrivacyLevel"] : "SELF_ONLY",
      tiktokConsent: post.metadata?.tiktokConsent === true,
      media: (post.media || []).map((item) => ({
        id: item.id,
        assetId: item.assetId,
        kind: item.kind,
        mimeType: item.mimeType,
        fileName: item.fileName,
        byteSize: item.byteSize,
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
        altText: item.altText,
        sortOrder: item.sortOrder,
      })),
      variants: buildComposerVariants(post.channels, post.variants, post.content),
    });
    setActiveVariantPlatform(post.channels[0] || "FACEBOOK");
    setComposerStep(1);
    setIsComposerOpen(true);
  }, []);

  useEffect(() => {
    const editPostId = new URLSearchParams(window.location.search).get("edit");
    if (view !== "posts" || !editPostId || loading) return;
    const post = posts.find((candidate) => candidate.id === editPostId);
    if (!post) return;
    openEditComposer(post);
    window.history.replaceState(null, "", "/content");
  }, [loading, openEditComposer, posts, view]);

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
      THREADS: "/api/social/oauth/threads/start",
      TIKTOK: "/api/social/oauth/tiktok/start",
      BLUESKY: "/connections",
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
    window.location.assign(platform === "BLUESKY" ? href : apiUrl(href));
  }

  function updateVariant(platform: SocialPlatform, patch: Partial<ComposerVariant>) {
    setComposer((current) => ({
      ...current,
      variants: current.variants.map((variant) =>
        variant.platform === platform ? { ...variant, ...patch } : variant,
      ),
    }));
  }

  async function uploadMedia(file: File) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      setError("Choose an image or video file.");
      return;
    }
    const isVideo = file.type.startsWith("video/");
    if ((!isVideo && file.size > 20 * 1024 * 1024) || (isVideo && file.size > 512 * 1024 * 1024)) {
      setError(isVideo ? "Videos must be 512 MB or smaller." : "Images must be 20 MB or smaller.");
      return;
    }

    let width: number | undefined;
    let height: number | undefined;
    let durationMs: number | undefined;
    const objectUrl = URL.createObjectURL(file);
    try {
      if (isVideo) {
        const metadata = await new Promise<{ width: number; height: number; durationMs: number }>((resolve, reject) => {
          const element = document.createElement("video");
          element.preload = "metadata";
          element.onloadedmetadata = () => resolve({ width: element.videoWidth, height: element.videoHeight, durationMs: Math.round(element.duration * 1000) });
          element.onerror = () => reject(new Error("Could not read video metadata"));
          element.src = objectUrl;
        });
        width = metadata.width;
        height = metadata.height;
        durationMs = metadata.durationMs;
      } else {
        const metadata = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
          element.onerror = () => reject(new Error("Could not read image metadata"));
          element.src = objectUrl;
        });
        width = metadata.width;
        height = metadata.height;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read media metadata");
      URL.revokeObjectURL(objectUrl);
      return;
    }
    URL.revokeObjectURL(objectUrl);

    const formData = new FormData();
    formData.append("file", file);
    if (width) formData.append("width", String(width));
    if (height) formData.append("height", String(height));
    if (durationMs) formData.append("durationMs", String(durationMs));
    setSaving(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/social/media"), {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const payload = await response.json() as { asset?: { id: string; kind: "IMAGE" | "VIDEO"; mimeType: string; fileName: string | null; byteSize: number; width: number | null; height: number | null; durationMs: number | null }; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error || "Failed to upload media");
      setComposer((current) => ({
        ...current,
        media: [...current.media, { ...payload.asset!, assetId: payload.asset!.id, altText: null, sortOrder: current.media.length }],
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to upload media");
    } finally {
      setSaving(false);
      if (mediaInputRef.current) mediaInputRef.current.value = "";
    }
  }

  function removeMedia(assetId: string) {
    setComposer((current) => ({
      ...current,
      media: current.media.filter((item) => item.assetId !== assetId).map((item, index) => ({ ...item, sortOrder: index })),
    }));
  }

  function openAiGenerator(target: AiGenerationTarget) {
    setAiPrompt(target.kind === "shared" ? composer.prompt : "");
    setAiGenerationTarget(target);
  }

  async function generateWithAi(promptOverride = composer.prompt): Promise<boolean> {
    const prompt = promptOverride.trim();
    if (!prompt && !composer.content.trim()) {
      setError("Add a prompt or rough draft before generating.");
      return false;
    }

    setGeneratingCaption(true);
    setError("");

    try {
      const response = await fetch(apiUrl("/api/social/ai/caption"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
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
        prompt,
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
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate caption");
      return false;
    } finally {
      setGeneratingCaption(false);
    }
  }

  async function generateVariantWithAi(platform: SocialPlatform, promptOverride: string): Promise<boolean> {
    const variant = composer.variants.find((item) => item.platform === platform);
    const prompt = promptOverride.trim();
    const currentContent = variant?.content.trim() || composer.content.trim();
    if (!prompt && !currentContent) {
      setError("Add a prompt or shared post text before generating this version.");
      return false;
    }

    setGeneratingVariantPlatform(platform);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/social/ai/caption"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          currentContent,
          channels: [platform],
        }),
      });
      const payload = (await response.json()) as {
        draft?: {
          content?: string;
          variants?: Array<{ platform: SocialPlatform; content: string }>;
        };
        error?: string;
      };
      const generated = payload.draft?.variants?.find((item) => item.platform === platform)?.content
        || payload.draft?.content;
      if (!response.ok || !generated?.trim()) {
        throw new Error(payload.error || `Failed to generate the ${getPlatformLabel(platform)} version`);
      }
      updateVariant(platform, { content: generated.trim(), aiGenerated: true });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to generate the ${getPlatformLabel(platform)} version`);
      return false;
    } finally {
      setGeneratingVariantPlatform(null);
    }
  }

  async function runAiGeneration() {
    if (!aiGenerationTarget) return;
    const target = aiGenerationTarget;
    const generated = target.kind === "shared"
      ? await generateWithAi(aiPrompt)
      : await generateVariantWithAi(target.platform, aiPrompt);
    if (generated) {
      setAiGenerationTarget(null);
      setAiPrompt("");
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

  async function savePost(publishNow = false, requestedStatus?: "DRAFT" | "SCHEDULED") {
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

    if ((publishNow || requestedStatus === "SCHEDULED") && mediaPublishIssues.length) {
      setError(`${mediaPublishIssues.join(". ")}. Save a draft or adjust the selected media.`);
      setComposerStep(4);
      return;
    }

    if (!composer.content.trim() && !composer.media.length) {
      setError("Add post text or attach at least one image or video before saving.");
      return;
    }
    const hasTikTokMedia = Boolean(composer.tiktokMediaUrl.trim() || composer.media.some((item) => item.kind === "VIDEO" || item.kind === "IMAGE"));
    if (composer.channels.includes("TIKTOK") && (!hasTikTokMedia || !composer.tiktokConsent)) {
      setError("TikTok requires an attached image/video or verified media URL and explicit publishing consent.");
      setComposerStep(2);
      return;
    }

    const activeVariants = composer.variants.filter((variant) =>
      composer.channels.includes(variant.platform),
    );
    // An immediate post starts in-flight. It becomes PUBLISHED when a destination
    // succeeds, rather than being persisted as a draft while provider jobs run.
    const postStatus = publishNow ? "PROCESSING" : requestedStatus ?? composer.status;

    if (!composer.media.length && activeVariants.some((variant) => !variant.content.trim())) {
      setError("Each selected platform needs its own variant content.");
      return;
    }

    setSaving(true);
    setError("");

    let savedPost: SocialPost | null = null;

    try {
      const response = await fetch(
        apiUrl(composer.id ? `/api/social/posts/${composer.id}` : "/api/social/posts"),
        {
          method: composer.id ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: composer.prompt || null,
            content: composer.content,
            channels: composer.channels,
            status: postStatus,
            scheduledFor: postStatus === "SCHEDULED" ? composer.scheduledFor || "" : "",
            primaryChannelId: composer.primaryChannelId || Object.values(composer.channelSelections).find(Boolean) || null,
            channelSelections: composer.channelSelections,
            variants: activeVariants,
            media: composer.media.map((item) => ({
              assetId: item.assetId,
              sortOrder: item.sortOrder,
              altText: item.altText,
            })),
            metadata: {
              createdFrom: "social-posts-workspace",
              aiAssistUsed: activeVariants.some((variant) => variant.aiGenerated),
              instagramImageUrl: composer.instagramImageUrl.trim() || null,
              tiktokMediaUrl: composer.tiktokMediaUrl.trim() || null,
              tiktokMediaType: composer.tiktokMediaType,
              tiktokPrivacyLevel: composer.tiktokPrivacyLevel,
              tiktokConsent: composer.tiktokConsent,
            },
          }),
        },
      );

      const payload = (await response.json()) as { post?: SocialPost; error?: string };

      if (!response.ok || !payload.post) {
        throw new Error(payload.error || "Failed to save post");
      }

      savedPost = payload.post;

      setPosts((current) => {
        if (composer.id) {
          return current.map((post) => (post.id === payload.post?.id ? payload.post : post));
        }

        return [payload.post as SocialPost, ...current];
      });

      if (publishNow) {
        const failedPlatforms: string[] = [];
        for (const platform of composer.channels) {
          try {
            const publishResponse = await fetch(apiUrl(`/api/social/posts/${savedPost.id}/publish`), {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ platform }),
            });
            const publishPayload = (await publishResponse.json()) as { post?: SocialPost; error?: string };
            if (!publishResponse.ok || !publishPayload.post) {
              failedPlatforms.push(getPlatformLabel(platform));
              continue;
            }
            const publishedPost = publishPayload.post;
            savedPost = publishedPost;
            setPosts((current) => current.map((post) => (post.id === publishedPost.id ? publishedPost : post)));
          } catch {
            failedPlatforms.push(getPlatformLabel(platform));
          }
        }

        if (failedPlatforms.length) {
          setError(`Could not publish to ${failedPlatforms.join(", ")}. The post is saved; retry those destinations from Posts.`);
        }
      }

      await loadData({ showLoading: false, clearError: !publishNow });

      setComposer(emptyComposer);
      setActiveVariantPlatform("FACEBOOK");
      setComposerStep(1);
      setIsComposerOpen(false);
    } catch (err) {
      if (savedPost) {
        setComposer(emptyComposer);
        setActiveVariantPlatform("FACEBOOK");
        setComposerStep(1);
        setIsComposerOpen(false);
      }
      const message = err instanceof Error ? err.message : "Failed to save post";
      setError(savedPost ? `${message}. The post was saved; retry any failed destination from Posts.` : message);
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
    if (composerStep === 2 && !composer.content.trim() && !composer.media.length) {
      setError("Add post text or attach at least one image or video before continuing.");
      return;
    }
    if (composerStep === 2) {
      setComposer((current) => ({
        ...current,
        variants: current.variants.map((variant) =>
          current.channels.includes(variant.platform) && !variant.content.trim()
            ? { ...variant, content: current.content }
            : variant,
        ),
      }));
    }
    setError("");
    setComposerStep((current) => Math.min(current + 1, 4) as ComposerStep);
  }

  function openDeleteModal(post: SocialPost) {
    setDeleteTarget(post);
    setDeleteScope("local");
    setDeleteProviderResults([]);
    setError("");
  }

  async function deletePost(id: string, deleteFromPlatforms: boolean) {
    setDeletingPost(true);
    setError("");
    setDeleteProviderResults([]);

    try {
      const response = await fetch(apiUrl(`/api/social/posts/${id}`), {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteFromPlatforms }),
      });
      const payload = (await response.json()) as { error?: string; providerResults?: PostDeleteProviderResult[] };

      if (!response.ok) {
        setDeleteProviderResults(payload.providerResults || []);
        throw new Error(payload.error || "Failed to delete post");
      }

      setPosts((current) => current.filter((post) => post.id !== id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete post");
    } finally {
      setDeletingPost(false);
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
      setActivityPost((current) => current && current.post.id === payload.post?.id
        ? { ...current, post: payload.post }
        : current);
      await loadData({ showLoading: false, clearError: false });
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
      setActivityPost((current) => current && current.post.id === payload.post?.id
        ? { ...current, post: payload.post }
        : current);
      await loadData({ showLoading: false, clearError: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update publish job");
    } finally {
      setJobActionId(null);
    }
  }

  async function openActivity(post: SocialPost) {
    setActivityPost({ post, events: [] });
    setActivityLoading(true);
    setActivityError(null);
    try {
      const response = await fetch(apiUrl(`/api/social/posts/${post.id}/activity`), { credentials: "include", cache: "no-store" });
      const payload = await response.json() as { events?: SocialPostActivityEvent[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Failed to load post activity");
      setActivityPost({ post, events: payload.events || [] });
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : "Failed to load post activity");
    } finally {
      setActivityLoading(false);
    }
  }

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <div className="space-y-4 border-b border-border pb-4">
          <PageHeader>
            <PageHeaderContent>
              <PageHeaderTitle>{view === "history" ? "Posts" : "Create"}</PageHeaderTitle>
              <PageHeaderDescription>{view === "history" ? "Published posts and retries." : "Draft and schedule posts."}</PageHeaderDescription>
            </PageHeaderContent>
            <PageHeaderActions>
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
            </PageHeaderActions>
          </PageHeader>

          <ContentWorkspaceNavigation active={view} />
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-status-danger-soft px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Card>
          <CardHeader className="flex flex-col gap-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>{view === "history" ? "Published posts" : "Drafts and scheduled posts"}</CardTitle>
              <CardDescription>{view === "history" ? "Review outcomes, failures, and retry work." : "Posts ready for review and publishing."}</CardDescription>
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
              {view === "history" ? (
                <div className="inline-flex h-10 items-center rounded-md border border-border bg-card p-1" role="group" aria-label="Posts display options">
                  <Button
                    type="button"
                    variant={historyViewMode === "grid" ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Show posts as cards"
                    aria-pressed={historyViewMode === "grid"}
                    title="Card view"
                    onClick={() => setHistoryViewMode("grid")}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant={historyViewMode === "table" ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Show posts as table rows"
                    aria-pressed={historyViewMode === "table"}
                    title="Table view"
                    onClick={() => setHistoryViewMode("table")}
                  >
                    <List className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
              <Button variant="outline" className="gap-2" onClick={() => void loadData({ showLoading: false })} disabled={refreshing} aria-label="Refresh posts">
                <RotateCcw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing..." : "Refresh"}
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
            ) : view === "history" ? (
              <SocialPostsLibrary posts={filteredPosts} viewMode={historyViewMode} />
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
                        {post.media?.length ? <div className="flex flex-wrap gap-2">{post.media.slice(0, 4).map((item) => item.kind === "VIDEO" ? <div key={item.id} className="relative overflow-hidden rounded-lg border border-border"><video className="h-20 w-28 object-cover" src={mediaUrl(item.assetId)} muted playsInline preload="metadata" /><span className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white"><Play className="h-2.5 w-2.5" />{formatDuration(item.durationMs)}</span></div> : <img key={item.id} className="h-20 w-28 rounded-lg border border-border object-cover" src={mediaUrl(item.assetId)} alt={item.altText || item.fileName || "Attached image"} />)}</div> : null}
                        <div className="flex flex-wrap gap-2">
                          {post.variants?.map((variant) => {
                            const Icon = getPlatformIcon(variant.platform);
                            return (
                              <Badge key={variant.id} className={getPlatformTone(variant.platform)}>
                                <Icon className={`mr-1 h-3.5 w-3.5 ${getPlatformIconClass(variant.platform)}`} />
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
                          <div className="space-y-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Destinations</p>
                            <div className="grid gap-2 md:grid-cols-2">
                            {publishJobs.map((job) => {
                              const jobMeta = getPublishJobStatusMeta(job.status);
                              const JobIcon = jobMeta.icon;
                              const PlatformIcon = getPlatformIcon(job.platform);
                              return (
                                <div key={job.id} className="rounded-lg border border-border/60 bg-background/45 px-3 py-2.5">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                                      <PlatformIcon className={`h-4 w-4 shrink-0 ${getPlatformIconClass(job.platform)}`} />
                                      <span className="truncate">{getPlatformLabel(job.platform)}</span>
                                    </div>
                                    <Badge className={`shrink-0 ${jobMeta.className}`}>
                                      {JobIcon ? <JobIcon className="mr-1 h-3.5 w-3.5" /> : null}
                                      {jobMeta.label}
                                    </Badge>
                                  </div>
                                  {job.scheduledFor ? (
                                    <p className="mt-2 text-xs text-muted-foreground">{formatDateTime(job.scheduledFor)}</p>
                                  ) : null}
                                  {job.errorMessage ? (
                                    <p className="mt-2 text-xs text-destructive">{job.errorMessage}</p>
                                  ) : null}
                                </div>
                              );
                            })}
                            </div>
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
                          const alreadyPublished = platformJob?.status === "PUBLISHED";

                          return (
                            <div key={`${post.id}-${platform}`} className="flex items-center gap-2">
                              {!alreadyPublished ? (
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
                              ) : null}
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
                        <Button variant="outline" size="sm" className="gap-2" onClick={() => void openActivity(post)}>
                          <Activity className="h-4 w-4" />
                          Activity
                        </Button>
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" onClick={() => openDeleteModal(post)} disabled={deletingPost}>
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

      <Dialog open={isIdeasOpen} onOpenChange={setIsIdeasOpen}>
          <DialogContent className="max-h-[calc(100svh-2rem)] max-w-2xl overflow-y-auto p-0">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <DialogHeader><DialogTitle>Generate ideas</DialogTitle><DialogDescription>Start with a topic and objective.</DialogDescription></DialogHeader>
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
          </DialogContent>
      </Dialog>

      <Dialog open={Boolean(aiGenerationTarget)} onOpenChange={(open) => { if (!open && !generatingCaption && !generatingVariantPlatform) setAiGenerationTarget(null); }}>
        {aiGenerationTarget ? (
          <DialogContent className="max-w-lg p-0">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <DialogHeader>
                <DialogTitle>
                  {aiGenerationTarget.kind === "shared" ? "Generate post text" : `Generate ${getPlatformLabel(aiGenerationTarget.platform)} text`}
                </DialogTitle>
                <DialogDescription>
                  {aiGenerationTarget.kind === "shared" ? "Describe what you want, or ask AI to improve the current post." : "Describe the angle or change you want for this destination."}
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="space-y-4 p-5">
              {error ? <p className="rounded-md border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
              <label className="block space-y-2">
                <span className="text-sm font-medium text-foreground">Prompt <span className="font-normal text-muted-foreground">(optional)</span></span>
                <Textarea autoFocus value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="For example: make it warmer, clearer, and more concise" className="min-h-[130px]" />
              </label>
              <p className="text-xs text-muted-foreground">The result will be added to the editor so you can change it before saving or publishing.</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAiGenerationTarget(null)} disabled={Boolean(generatingCaption || generatingVariantPlatform)}>Cancel</Button>
                <Button className="gap-2" onClick={() => void runAiGeneration()} disabled={Boolean(generatingCaption || generatingVariantPlatform || (!aiPrompt.trim() && !composer.content.trim() && aiGenerationTarget.kind === "shared"))}>
                  <Sparkles className="h-4 w-4" />
                  {generatingCaption || generatingVariantPlatform ? "Generating..." : "Generate"}
                </Button>
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(activityPost)} onOpenChange={(open) => { if (!open) setActivityPost(null); }}>
        {activityPost ? (
          <DialogContent className="max-h-[calc(100svh-2rem)] max-w-2xl overflow-y-auto p-0">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <DialogHeader><DialogTitle>Post activity</DialogTitle><DialogDescription>{activityPost.post.title || "Untitled social post"} · durable content and provider job state</DialogDescription></DialogHeader>
            </div>
            <div className="space-y-3 px-5 py-5">
              {activityError ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{activityError}</p> : null}
              {activityPost.post.publishJobs?.length ? <div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider recovery</p>{activityPost.post.publishJobs.map((job) => { const meta = getPublishJobStatusMeta(job.status); const JobIcon = meta.icon; const actionable = job.status === "FAILED" || job.status === "QUEUED" || job.status === "PENDING"; return <div key={job.id} className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge className={meta.className}>{JobIcon ? <JobIcon className="mr-1 h-3.5 w-3.5" /> : null}{getPlatformLabel(job.platform)}: {meta.label}</Badge>{job.scheduledFor ? <span className="text-xs text-muted-foreground">{formatDateTime(job.scheduledFor)}</span> : null}</div>{job.errorMessage ? <p className="mt-1 text-xs text-destructive">{job.errorMessage}</p> : null}</div>{actionable ? <div className="flex shrink-0 flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={jobActionId === job.id} onClick={() => void runPublishJobAction(job, job.status === "FAILED" ? "retry" : "run_now")}>{jobActionId === job.id ? "Working…" : job.status === "FAILED" ? <><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Retry</> : "Run now"}</Button><Button type="button" size="sm" variant="ghost" disabled={jobActionId === job.id} onClick={() => void runPublishJobAction(job, "cancel")}>Cancel</Button></div> : null}</div>; })}</div> : null}
              {activityLoading ? <p className="text-sm text-muted-foreground">Loading durable activity…</p> : activityPost.events.length ? activityPost.events.map((event) => (
                <div key={event.id} className="flex gap-3 rounded-lg border border-border p-3">
                  <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${event.status === "FAILED" ? "bg-destructive" : event.status === "PUBLISHED" ? "bg-status-success" : "bg-status-info"}`} aria-hidden="true" />
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium capitalize text-foreground">{event.type.replaceAll(".", " ")}</p>{event.platform ? <Badge className="border-border bg-secondary text-muted-foreground">{getPlatformLabel(event.platform)}</Badge> : null}{event.status ? <span className="text-xs text-muted-foreground">{event.status}</span> : null}</div><p className="mt-1 text-xs text-muted-foreground">{formatDateTime(event.occurredAt)}</p>{event.message ? <p className="mt-1 text-xs text-destructive">{event.message}</p> : null}</div>
                </div>
              )) : <p className="text-sm text-muted-foreground">No activity has been recorded for this post yet.</p>}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deletingPost) setDeleteTarget(null); }}>
        {deleteTarget ? (
          <DialogContent className="max-w-lg p-5">
            <div className="flex items-start justify-between gap-4">
              <DialogHeader>
                <div className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  <DialogTitle>Delete post?</DialogTitle>
                </div>
                <DialogDescription>Choose where this post should be removed.</DialogDescription>
              </DialogHeader>
            </div>
            <div className="mt-5 space-y-3">
              <label className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${deleteScope === "local" ? "border-primary bg-primary/5" : "border-border"}`}>
                <input type="radio" name="workspace-delete-scope" checked={deleteScope === "local"} onChange={() => setDeleteScope("local")} className="mt-1 accent-primary" />
                <span><span className="block text-sm font-medium text-foreground">Remove from KasiTek only</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Published copies on social platforms remain online.</span></span>
              </label>
              {(() => {
                const publishedJobs = deleteTarget.publishJobs?.filter((job) => job.status === "PUBLISHED" && job.externalPostId) || [];
                return (
                  <label className={`flex gap-3 rounded-xl border p-4 ${publishedJobs.length ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${deleteScope === "platforms" ? "border-destructive bg-destructive/5" : "border-border"}`}>
                    <input type="radio" name="workspace-delete-scope" checked={deleteScope === "platforms"} onChange={() => publishedJobs.length && setDeleteScope("platforms")} disabled={!publishedJobs.length} className="mt-1 accent-destructive" />
                    <span><span className="block text-sm font-medium text-foreground">Remove from KasiTek and platforms</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{publishedJobs.length ? `Attempts deletion on ${publishedJobs.map((job) => getPlatformLabel(job.platform)).join(", ")}. Failed platform deletions keep this record available for retry.` : "There are no published platform copies recorded for this post."}</span></span>
                  </label>
                );
              })()}
            </div>
            {deleteProviderResults.length ? <div className="mt-4 rounded-xl border border-destructive/30 bg-status-danger-soft p-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-destructive">Platform deletion results</p><div className="mt-2 space-y-2">{deleteProviderResults.map((result, index) => <div key={`${result.platform}-${index}`} className="flex items-start gap-2 text-xs">{result.status === "DELETED" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-success" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}<span className="text-foreground"><strong>{getPlatformLabel(result.platform)}</strong>{result.message ? ` · ${result.message}` : ` · ${result.status.toLowerCase()}`}</span></div>)}</div></div> : null}
            {error ? <p className="mt-4 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
            <div className="mt-6 flex justify-end gap-2"><Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deletingPost}>Cancel</Button><Button variant="destructive" onClick={() => void deletePost(deleteTarget.id, deleteScope === "platforms")} disabled={deletingPost}>{deletingPost ? "Deleting..." : deleteScope === "platforms" ? "Delete everywhere" : "Delete post"}</Button></div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Sheet open={isComposerOpen} onOpenChange={setIsComposerOpen}>
        {isComposerOpen ? (
          <SheetContent className="w-full max-w-[760px] gap-0 border-l border-border bg-card p-0 sm:max-w-[760px]">
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
                        <div key={platform} className={`rounded-xl border px-4 py-3.5 ${selected ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                          <div className="flex items-center gap-3">
                            <div className={`rounded-md border p-2 ${getPlatformTone(platform)}`}><Icon className={`h-4 w-4 ${getPlatformIconClass(platform)}`} /></div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-foreground">{getPlatformLabel(platform)}</p>
                              <p className="text-sm text-muted-foreground">{options.length ? `${options.length} connected` : "Not connected"}</p>
                            </div>
                            {getPlatformCapabilities(platform).supportsManualPublish ? (
                              <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" onClick={() => beginConnection(platform)}>
                                <Plus className="h-3.5 w-3.5" />
                                {options.length ? "Connect another" : "Connect"}
                              </Button>
                            ) : null}
                            {selected ? <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={() => removeChannel(platform)}>Remove</Button> : null}
                          </div>
                          {options.length ? (
                            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(190px,240px))] gap-2">
                              {options.map((channel) => {
                                const isSelected = selectedId === channel.id;
                                return (
                                  <button type="button" key={channel.id} onClick={() => isSelected ? removeChannel(platform) : selectChannel(channel)} className={`flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors ${isSelected ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background hover:border-primary/50"}`}>
                                    <Avatar className="h-8 w-8 border border-border bg-muted">
                                      <AvatarImage src={channelAvatarUrl(channel) || undefined} alt="" referrerPolicy="no-referrer" />
                                      <AvatarFallback className="text-[10px] font-semibold text-muted-foreground">{channelInitials(channel)}</AvatarFallback>
                                    </Avatar>
                                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{channelLabel(channel)}</span>{channel.handle ? <span className="block truncate text-xs text-muted-foreground">@{channel.handle.replace(/^@/, "")}</span> : null}</span>
                                    {isSelected ? <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-3 w-3" /></span> : null}
                                  </button>
                                );
                              })}
                            </div>
                          ) : !getPlatformCapabilities(platform).supportsManualPublish ? (
                            <p className="mt-3 text-sm text-muted-foreground">Account connection is not available yet.</p>
                          ) : (
                            <p className="mt-3 text-sm text-muted-foreground">No accounts connected yet.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {composerStep === 2 ? (
                <section className="space-y-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-xl font-semibold text-foreground">Write the post</h2><p className="mt-1 text-sm text-muted-foreground">Add text or media. You can tailor each destination next.</p></div><Button type="button" variant="outline" className="shrink-0 gap-2" onClick={() => openAiGenerator({ kind: "shared" })}><Sparkles className="h-4 w-4" />Generate with AI</Button></div>
                  <label className="block space-y-2"><span className="text-sm text-muted-foreground">Post text (optional)</span><textarea value={composer.content} onChange={(event) => setComposer((current) => ({ ...current, content: event.target.value }))} placeholder="Write your post..." className="min-h-[180px] w-full rounded-md border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary" /></label>
                  <div className="space-y-3 rounded-xl border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div><p className="text-sm font-medium text-foreground">Media (optional)</p><p className="text-xs text-muted-foreground">Attach images or videos to this post.</p></div>
                      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => mediaInputRef.current?.click()} disabled={saving}><Upload className="h-3.5 w-3.5" />Add media</Button>
                      <input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); void files.reduce((chain, file) => chain.then(() => uploadMedia(file)), Promise.resolve()); }} />
                    </div>
                    {composer.media.length ? <div className="grid gap-3 sm:grid-cols-2">{composer.media.map((item) => <div key={item.assetId} className="group relative overflow-hidden rounded-lg border border-border bg-secondary/20">{item.kind === "VIDEO" ? <video className="h-32 w-full object-cover" src={mediaUrl(item.assetId)} muted playsInline preload="metadata" /> : <img className="h-32 w-full object-cover" src={mediaUrl(item.assetId)} alt={item.altText || item.fileName || "Attached image"} />}{item.kind === "VIDEO" ? <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[11px] text-white"><Play className="h-3 w-3" />{formatDuration(item.durationMs)}</span> : null}<div className="flex items-center gap-2 p-2"><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.fileName || (item.kind === "VIDEO" ? "Video" : "Image")} · {formatMediaSize(item.byteSize)}</span><Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeMedia(item.assetId)} aria-label="Remove media"><X className="h-3.5 w-3.5" /></Button></div></div>)}</div> : null}
                  </div>
                  {composer.channels.includes("INSTAGRAM") ? <label className="block space-y-2"><span className="text-sm text-muted-foreground">Instagram image URL</span><Input type="url" value={composer.instagramImageUrl} onChange={(event) => setComposer((current) => ({ ...current, instagramImageUrl: event.target.value }))} placeholder="https://example.com/image.jpg" /><span className="block text-xs text-muted-foreground">Required when publishing to Instagram.</span></label> : null}
                  {composer.channels.includes("TIKTOK") ? <div className="space-y-3 rounded-xl border border-border p-4"><p className="text-sm font-medium">TikTok publishing</p><label className="block space-y-2"><span className="text-sm text-muted-foreground">Optional verified media URL</span><Input type="url" value={composer.tiktokMediaUrl} onChange={(event) => setComposer((current) => ({ ...current, tiktokMediaUrl: event.target.value, tiktokConsent: false }))} placeholder="https://media.your-domain.com/post.mp4" /><span className="block text-xs text-muted-foreground">Use this only when the media is hosted on a TikTok-verified HTTPS domain. Uploaded media can be used instead.</span></label><div className="grid gap-3 sm:grid-cols-2"><label className="block space-y-2"><span className="text-sm text-muted-foreground">Media type for URL</span><select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={composer.tiktokMediaType} onChange={(event) => setComposer((current) => ({ ...current, tiktokMediaType: event.target.value as ComposerState["tiktokMediaType"], tiktokConsent: false }))}><option value="VIDEO">Video</option><option value="PHOTO">Photo</option></select></label><label className="block space-y-2"><span className="text-sm text-muted-foreground">Privacy</span><select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={composer.tiktokPrivacyLevel} disabled={!tiktokPrivacyOptions.length} onChange={(event) => setComposer((current) => ({ ...current, tiktokPrivacyLevel: event.target.value as ComposerState["tiktokPrivacyLevel"], tiktokConsent: false }))}>{tiktokPrivacyOptions.map((option) => <option key={option} value={option}>{option === "SELF_ONLY" ? "Only me" : option === "PUBLIC_TO_EVERYONE" ? "Public" : option === "MUTUAL_FOLLOW_FRIENDS" ? "Friends" : "Followers"}</option>)}</select><span className="block text-xs text-muted-foreground">Options are loaded from the connected TikTok creator account.</span></label></div><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={composer.tiktokConsent} onChange={(event) => setComposer((current) => ({ ...current, tiktokConsent: event.target.checked }))} /><span>I consent to send the selected media and caption to TikTok for direct publishing.</span></label></div> : null}
                </section>
              ) : null}

              {composerStep === 3 ? (
                <section className="space-y-5">
                  <div><h2 className="text-xl font-semibold text-foreground">Tailor versions</h2><p className="mt-1 text-sm text-muted-foreground">Adjust the text for each selected destination.</p></div>
                  <Tabs value={activeVariantPlatform} onValueChange={(value) => setActiveVariantPlatform(value as SocialPlatform)}>
                    <TabsList className="flex w-full flex-wrap bg-secondary/50">{activeComposerVariants.map((variant) => <TabsTrigger key={variant.platform} value={variant.platform}>{getPlatformLabel(variant.platform)}</TabsTrigger>)}</TabsList>
                    {activeComposerVariants.map((variant) => <TabsContent key={variant.platform} value={variant.platform}><div className="space-y-3 rounded-xl border border-border p-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><span className="text-sm text-muted-foreground">{getPlatformLabel(variant.platform)} text</span><Button type="button" variant="outline" size="sm" className="w-fit gap-2" onClick={() => openAiGenerator({ kind: "variant", platform: variant.platform })} disabled={Boolean(generatingCaption || generatingVariantPlatform)}><Sparkles className="h-3.5 w-3.5" />{generatingVariantPlatform === variant.platform ? "Generating..." : "Generate with AI"}</Button></div><textarea value={variant.content} onChange={(event) => updateVariant(variant.platform, { content: event.target.value })} placeholder={`Write the ${getPlatformLabel(variant.platform)} version...`} className="min-h-[260px] w-full rounded-md border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:border-primary" /><label className="block space-y-2"><span className="text-sm text-muted-foreground">Status</span><select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={variant.status} onChange={(event) => updateVariant(variant.platform, { status: event.target.value as SocialVariantStatus })}><option value="DRAFT">Draft</option><option value="APPROVED">Approved</option><option value="NEEDS_EDITS">Needs edits</option></select></label></div></TabsContent>)}
                  </Tabs>
                  <div className="rounded-xl border border-border bg-secondary/20 p-4"><div className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-muted-foreground" /><div><p className="text-sm font-medium text-foreground">Mobile composition preview</p><p className="text-xs text-muted-foreground">A layout preview using the exact copy and media. Provider UI may differ.</p></div></div><div className="mt-4 flex justify-center"><div className="w-[250px] overflow-hidden rounded-[2rem] border-[6px] border-foreground/80 bg-background shadow-xl"><div className="flex items-center justify-between border-b border-border px-4 py-2 text-[10px] text-muted-foreground"><span>9:41</span><span>{getPlatformLabel(activeVariantPlatform)}</span><span>•••</span></div><div className="p-3"><div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold text-primary">KT</span><span className="text-[11px] font-medium">KasiTek</span></div><p className="mt-3 whitespace-pre-wrap break-words text-[11px] leading-4 text-foreground">{activeComposerVariants.find((variant) => variant.platform === activeVariantPlatform)?.content || composer.content}</p>{composer.media.length ? <div className="mt-3 space-y-2">{composer.media.slice(0, 4).map((item) => item.kind === "VIDEO" ? <div key={item.assetId} className="relative overflow-hidden rounded-lg bg-black"><video className="h-36 w-full object-cover" src={mediaUrl(item.assetId)} muted playsInline preload="metadata" /><span className="absolute inset-0 flex items-center justify-center"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white"><Play className="h-4 w-4 fill-current" /></span></span></div> : <img key={item.assetId} className="max-h-40 w-full rounded-lg object-cover" src={mediaUrl(item.assetId)} alt={item.altText || "Attached image"} />)}</div> : <div className="mt-3 flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-[10px] text-muted-foreground"><FileImage className="mr-1.5 h-3.5 w-3.5" />No media</div>}<div className="mt-3 flex gap-4 text-[10px] text-muted-foreground"><span>♡ 24</span><span>◌ 8</span><span>↗ Share</span></div></div></div></div></div>
                </section>
              ) : null}

              {composerStep === 4 ? (
                <section className="space-y-5">
                  <div><h2 className="text-xl font-semibold text-foreground">Review and publish</h2><p className="mt-1 text-sm text-muted-foreground">Save as a draft, schedule, or publish the selected versions now.</p></div>
                  <div className="rounded-xl border border-border p-4"><p className="text-sm font-medium text-foreground">Destinations</p><div className="mt-3 space-y-2">{composer.channels.map((platform) => { const channel = connectedChannels.find((item) => item.id === composer.channelSelections[platform]); return <div key={platform} className="flex items-center justify-between gap-3 text-sm"><span>{getPlatformLabel(platform)}</span><span className="text-muted-foreground">{channel?.displayName || "Not selected"}</span></div>; })}</div></div>
                  {mediaPublishIssues.length ? <div className="rounded-xl border border-status-warning/30 bg-status-warning-soft px-3 py-2 text-sm text-status-warning"><p className="font-medium">Media needs an adjustment before publishing</p><ul className="mt-1 list-disc space-y-1 pl-4 text-xs">{mediaPublishIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul><p className="mt-2 text-xs">You can still save this as a draft.</p></div> : null}
                  <label className="block space-y-2"><span className="text-sm text-muted-foreground">Schedule for</span><Input type="datetime-local" value={composer.scheduledFor} onChange={(event) => setComposer((current) => ({ ...current, scheduledFor: event.target.value }))} /><span className="block text-xs text-muted-foreground">Choose a date and time only when scheduling this post.</span></label>
                </section>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
              <Button variant="ghost" onClick={() => composerStep === 1 ? setIsComposerOpen(false) : setComposerStep((current) => (current - 1) as ComposerStep)}>{composerStep === 1 ? "Cancel" : <><ArrowLeft className="mr-2 h-4 w-4" />Back</>}</Button>
              {composerStep < 4 ? <Button onClick={advanceComposerStep}>Continue<ArrowRight className="ml-2 h-4 w-4" /></Button> : (
                <div className="flex items-center gap-2">
                  <Button variant="outline" disabled={saving} onClick={() => void savePost(false, "DRAFT")}>{saving ? "Saving..." : "Save draft"}</Button>
                  <Button variant="outline" disabled={saving || !composer.scheduledFor || mediaPublishIssues.length > 0} onClick={() => void savePost(false, "SCHEDULED")}>{saving ? "Saving..." : "Schedule post"}</Button>
                  <Button disabled={saving || mediaPublishIssues.length > 0} onClick={() => void savePost(true)}>{saving ? "Publishing..." : "Post now"}</Button>
                </div>
              )}
            </div>
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  );
}
