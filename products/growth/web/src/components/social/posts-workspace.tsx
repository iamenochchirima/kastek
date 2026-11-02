import { useGrowthAgents } from "@/components/dashboard/agents/agent-provider";

import { apiUrl } from "@/lib/server-api";
import { toast } from "sonner";
import { scheduledPostTimestamp } from "@/lib/content-schedule";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, FileImage, Play, Plus, RotateCcw, Smartphone, Sparkles, Upload, X } from "@/components/ui/interface-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PostsLibraryWorkspace } from "@/components/social/posts-library-workspace";
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
  revision: string | null;
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

type PublishBatchPreflight = {
  postId: string;
  status: string;
  snapshotHash: string;
  mediaCount: number;
  targets: Array<{
    platform: string;
    accountName: string;
    handle?: string | null;
    state: string;
    status: string;
    reasonCode?: string | null;
    message?: string | null;
  }>;
};

const defaultChannels: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "THREADS", "TIKTOK", "BLUESKY", "LINKEDIN", "X"];
const COMPOSER_DRAFT_STORAGE_KEY = "kasitek:content-composer";
const supportedManualPublishPlatforms: SocialPlatform[] = SOCIAL_PLATFORM_ORDER.filter((platform) =>
  getPlatformCapabilities(platform).supportsManualPublish,
);

const emptyComposer: ComposerState = {
  id: null,
  revision: null,
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

function formatBatchPreflightError(preflight: PublishBatchPreflight) {
  const blocked = preflight.targets
    .filter((target) => !["READY", "ALREADY_PUBLISHED"].includes(target.state))
    .map((target) => {
      const platform = getPlatformLabel(target.platform.toUpperCase() as SocialPlatform);
      return `${platform}${target.accountName ? ` (${target.accountName})` : ""}${target.message ? `: ${target.message}` : ""}`;
    });
  return blocked.length
    ? `Publishing is blocked for ${blocked.join("; ")}. The post is saved; resolve these destinations before retrying.`
    : "Publishing is blocked for one or more destinations. The post is saved; resolve the destination issues before retrying.";
}

type PostsWorkspaceProps = { view?: "posts" | "history" };

export function PostsWorkspace({ view = "posts" }: PostsWorkspaceProps) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [channels, setChannels] = useState<SocialChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const agents = useGrowthAgents();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [statusRefreshError, setStatusRefreshError] = useState("");
  const postsReadVersion = useRef(0);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SocialPost | null>(null);
  const [removePublishedPhoto, setRemovePublishedPhoto] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);
  const saveIntent = useRef<{ body: string; key: string } | null>(null);
  const publishIntent = useRef<{ postId: string; key: string } | null>(null);
  const [publishingKey, setPublishingKey] = useState<string | null>(null);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
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
  const [batchPreflight, setBatchPreflight] = useState<PublishBatchPreflight | null>(null);
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
    const readVersion = ++postsReadVersion.current;
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

      if (readVersion === postsReadVersion.current) {
        setPosts(postsPayload.posts || []);
        setStatusRefreshError("");
      }
      setChannels(channelsPayload.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load posts");
    } finally {
      if (showLoading) setLoading(false);
      else setRefreshing(false);
    }
  }

  const statusPollDelay = posts.some(post =>
    post.status !== "SCHEDULED" && post.metadata?.publishOutcome !== "UNKNOWN" && (
      post.status === "PROCESSING" || post.publishJobs?.some(job => job.status === "PROCESSING" || job.status === "QUEUED")
    ),
  ) ? 3_000 : posts.some(post => post.status === "SCHEDULED") ? 30_000 : null;

  useEffect(() => {
    if (saving || deletingPost || jobActionId || publishingKey) return;
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const schedule = () => {
      if (!cancelled && statusPollDelay !== null && document.visibilityState !== "hidden")
        timer = setTimeout(() => void refreshStatus(), statusPollDelay);
    };
    const refreshStatus = async () => {
      if (cancelled || running || document.visibilityState === "hidden") return;
      if (timer !== undefined) clearTimeout(timer);
      running = true;
      const readVersion = ++postsReadVersion.current;
      try {
        const response = await fetch(apiUrl("/api/social/posts"), {
          cache: "no-store", credentials: "include", signal: controller.signal,
        });
        const payload = await response.json() as { posts?: SocialPost[]; error?: string };
        if (!response.ok || !Array.isArray(payload.posts)) throw new Error("Status refresh failed");
        if (!cancelled && readVersion === postsReadVersion.current) {
          setPosts(payload.posts);
          setActivityPost(current => current ? { ...current, post: payload.posts!.find(post => post.id === current.post.id) ?? current.post } : current);
          setStatusRefreshError("");
        }
      } catch {
        if (!cancelled) setStatusRefreshError("Unable to refresh post status.");
      } finally {
        running = false;
        schedule();
      }
    };
    const resume = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) clearTimeout(timer);
      } else void refreshStatus();
    };
    schedule();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [statusPollDelay, saving, deletingPost, jobActionId, publishingKey]);

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
    setEditTarget(null);
    setError("");
    saveIntent.current = null;
    publishIntent.current = null;
    setComposer(emptyComposer);
    setBatchPreflight(null);
    setActiveVariantPlatform("FACEBOOK");
    setComposerStep(1);
    setIsComposerOpen(true);
  }

  const openEditComposer = useCallback((post: SocialPost) => {
    setRemovePublishedPhoto(false);
    const published = post.status === "PUBLISHED";
    if (!["DRAFT", "SCHEDULED", "PUBLISHED"].includes(post.status)) {
      setError("This post cannot be edited while delivery is unresolved.");
      return;
    }
    if (published && (post.channels.length !== 1 || post.channels[0] !== "FACEBOOK" || !post.publishJobs?.some(job => job.platform === "FACEBOOK" && job.status === "PUBLISHED" && job.externalPostId))) {
      setError("Published editing is available for confirmed Facebook posts only.");
      return;
    }
    saveIntent.current = null;
    setError("");
    setComposer({
      id: post.id,
      revision: post.updatedAt,
      title: post.title || "",
      prompt: post.prompt || "",
      content: published ? post.variants?.find(variant => variant.platform === "FACEBOOK")?.content ?? post.content : post.content,
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
    setBatchPreflight(null);
    setActiveVariantPlatform(post.channels[0] || "FACEBOOK");
    setComposerStep(1);
    setIsComposerOpen(false);
    setEditTarget(post);
  }, []);

  useEffect(() => {
    if (view !== "posts" || loading) return;

    const params = new URLSearchParams(window.location.search);
    const editPostId = params.get("edit");
    const scheduleDate = params.get("scheduleDate");

    if (editPostId) {
      const post = posts.find((candidate) => candidate.id === editPostId);
      if (!post) return;
      openEditComposer(post);
      window.history.replaceState(null, "", "/content");
      return;
    }

    if (!scheduleDate || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate)) return;
    const [year, month, day] = scheduleDate.split("-").map(Number);
    const scheduledDate = new Date(year, month - 1, day);
    if (
      scheduledDate.getFullYear() !== year ||
      scheduledDate.getMonth() !== month - 1 ||
      scheduledDate.getDate() !== day
    ) {
      return;
    }

    setComposer({ ...emptyComposer, scheduledFor: `${scheduleDate}T09:00` });
    setBatchPreflight(null);
    setActiveVariantPlatform("FACEBOOK");
    setComposerStep(1);
    setIsComposerOpen(true);
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

  function selectDraftPlatform(platform: SocialPlatform) {
    setComposer((current) => ({
      ...current,
      channels: current.channels.includes(platform) ? current.channels : [...current.channels, platform],
      variants: current.variants.some((variant) => variant.platform === platform)
        ? current.variants
        : [...current.variants, { platform, content: current.content, status: "DRAFT", aiGenerated: false }],
    }));
    setActiveVariantPlatform(platform);
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

  function openContentAgent(platform?: SocialPlatform) {
    setIsComposerOpen(false);
    const content = platform ? composer.variants.find((variant) => variant.platform === platform)?.content || composer.content : composer.content;
    const brief = [platform ? `Improve this ${getPlatformLabel(platform)} draft.` : "Help me draft content.", composer.title, content, composer.prompt].filter(Boolean).join("\n\n");
    void agents.start("content", composer.id ? { kind: "content_post", resourceId: composer.id } : { kind: "workspace" }, brief);
  }

  async function savePost(publishNow = false, requestedStatus?: "DRAFT" | "SCHEDULED") {
    const requiresDestination = publishNow || (requestedStatus ?? composer.status) === "SCHEDULED";
    if (!composer.channels.length) {
      setError("Choose at least one platform.");
      setComposerStep(1);
      return;
    }

    if (requiresDestination && composer.channels.some((platform) => !composer.channelSelections[platform])) {
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
    if ((publishNow || requestedStatus === "SCHEDULED") && composer.channels.includes("TIKTOK") && (!hasTikTokMedia || !composer.tiktokConsent)) {
      setError("TikTok requires an attached image/video or verified media URL and explicit publishing consent.");
      setComposerStep(2);
      return;
    }

    const activeVariants = composer.variants.filter((variant) =>
      composer.channels.includes(variant.platform),
    );
    // Keep the draft state until Core preflight accepts the batch. Core changes
    // it to PROCESSING atomically with the durable batch admission.
    const postStatus = publishNow ? "DRAFT" : requestedStatus ?? composer.status;

    if (!composer.media.length && activeVariants.some((variant) => !variant.content.trim())) {
      setError("Each selected platform needs its own variant content.");
      return;
    }

    setSaving(true);
    setError("");

    let savedPost: SocialPost | null = null;

    try {
      const scheduledFor = postStatus === "SCHEDULED" ? scheduledPostTimestamp(composer.scheduledFor) : "";
      const body = JSON.stringify({
            prompt: composer.prompt || null,
            content: composer.content,
            channels: composer.channels,
            status: postStatus,
            scheduledFor,
            primaryChannelId: composer.primaryChannelId || Object.values(composer.channelSelections).find(Boolean) || null,
            channelSelections: composer.channelSelections,
            variants: activeVariants,
            media: composer.media.map(item => ({ assetId: item.assetId, sortOrder: item.sortOrder, altText: item.altText })),
            metadata: {
              createdFrom: "social-posts-workspace",
              aiAssistUsed: activeVariants.some(variant => variant.aiGenerated),
              instagramImageUrl: composer.instagramImageUrl.trim() || null,
              tiktokMediaUrl: composer.tiktokMediaUrl.trim() || null,
              tiktokMediaType: composer.tiktokMediaType,
              tiktokPrivacyLevel: composer.tiktokPrivacyLevel,
              tiktokConsent: composer.tiktokConsent,
            },
      });
      if (!saveIntent.current || saveIntent.current.body !== body)
        saveIntent.current = { body, key: `manual-content-save:${crypto.randomUUID()}` };
      const response = await fetch(
        apiUrl(composer.id ? `/api/social/posts/${composer.id}` : "/api/social/posts"),
        {
          method: composer.id ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "Idempotency-Key": saveIntent.current.key, ...(composer.revision ? { "If-Match": composer.revision } : {}) },
          body,
        },
      );

      const payload = (await response.json()) as { post?: SocialPost; error?: string };

      if (!response.ok || !payload.post) {
        throw new Error(payload.error || "Failed to save post");
      }

      savedPost = payload.post;
      setComposer(current => ({ ...current, id: payload.post!.id, revision: payload.post!.updatedAt, status: postStatus }));

      setPosts((current) => {
        if (composer.id) {
          return current.map((post) => (post.id === payload.post?.id ? payload.post : post));
        }

        return [payload.post as SocialPost, ...current];
      });

      if (publishNow) {
        if (!publishIntent.current || publishIntent.current.postId !== savedPost.id)
          publishIntent.current = { postId: savedPost.id, key: `manual-content-publish-batch:${savedPost.id}:${crypto.randomUUID()}` };
        const preflightResponse = await fetch(apiUrl(`/api/social/posts/${savedPost.id}/publish-batch/preflight`), {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        });
        const preflightPayload = await preflightResponse.json() as PublishBatchPreflight & { error?: string };
        if (!preflightResponse.ok || !preflightPayload.postId) {
          throw new Error(preflightPayload.error || "Failed to check publishing destinations");
        }
        setBatchPreflight(preflightPayload);
        if (preflightPayload.status !== "READY") {
          setComposer((current) => ({ ...current, id: savedPost!.id, status: "DRAFT" }));
          setError(formatBatchPreflightError(preflightPayload));
          return;
        }

        const publishResponse = await fetch(apiUrl(`/api/social/posts/${savedPost.id}/publish-batch`), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": publishIntent.current.key,
          },
          body: JSON.stringify({}),
        });
        const publishPayload = (await publishResponse.json().catch(() => ({
          error: "Unable to read the publishing response. Check the post status before retrying",
        }))) as {
          post?: SocialPost;
          batch?: { status?: string; targets?: Array<{ platform?: string; state?: string; message?: string }> };
          error?: string;
        };
        if (!publishResponse.ok || !publishPayload.post || !publishPayload.batch) {
          throw new Error(publishPayload.error || "Failed to start batch publish");
        }
        savedPost = publishPayload.post;
        setPosts((current) => current.map((post) => (post.id === savedPost?.id ? savedPost as SocialPost : post)));

      }

      await loadData({ showLoading: false, clearError: !publishNow });

      setComposer(emptyComposer);
      saveIntent.current = null;
      publishIntent.current = null;
      setBatchPreflight(null);
      setActiveVariantPlatform("FACEBOOK");
      setComposerStep(1);
      setIsComposerOpen(false);
      if (editTarget) { setEditTarget(null); toast.success("Post updated"); }
    } catch (err) {
      if (savedPost) setComposer(current => ({ ...current, id: savedPost!.id, revision: savedPost!.updatedAt, status: savedPost!.status }));
      const message = err instanceof Error ? err.message : "Failed to save post";
      setError(savedPost ? `${message}. The post was saved; retry any failed destination from Posts.` : message);
    } finally {
      setSaving(false);
    }
  }

  async function updatePublishedPost() {
    if (!editTarget || !composer.content.trim()) { setError("Add post text."); return; }
    setSaving(true);
    setError("");
    const body = JSON.stringify({ content: composer.content, expectedUpdatedAt: editTarget.updatedAt, ...(removePublishedPhoto ? { removePhoto: true } : {}) });
    if (!saveIntent.current || saveIntent.current.body !== body)
      saveIntent.current = { body, key: `manual-content-update-published:${crypto.randomUUID()}` };
    try {
      const response = await fetch(apiUrl(`/api/social/posts/${editTarget.id}/update-published`), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": saveIntent.current.key }, body,
      });
      const payload = await response.json().catch(() => ({ error: "Unable to read the update result. Check the post before retrying." })) as { post?: SocialPost; error?: string };
      if (!response.ok || !payload.post) throw new Error(payload.error || "Failed to update Facebook post");
      ++postsReadVersion.current;
      setPosts(current => current.map(post => post.id === payload.post!.id ? payload.post! : post));
      setEditTarget(null);
      setComposer(emptyComposer);
      saveIntent.current = null;
      toast.success("Facebook post updated");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update Facebook post");
    } finally { setSaving(false); }
  }

  function advanceComposerStep() {
    if (composerStep === 1) {
      if (!composer.channels.length) {
        setError("Choose at least one platform.");
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
    <div className="min-w-0">
      <PostsLibraryWorkspace key={view}
        posts={posts} channels={channels} loading={loading} refreshing={refreshing} error={error || statusRefreshError}
        initialStatus={view === "history" ? "PUBLISHED" : "ALL"}
        onCreate={openNewComposer} onEdit={openEditComposer}
        onRefresh={() => void loadData({ showLoading: false })}
        onActivity={(post) => void openActivity(post)} onDelete={openDeleteModal}
        renderPublishActions={(post) => <div className="flex flex-wrap gap-2">
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
        </div>}
      />

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
            <RadioGroup value={deleteScope} onValueChange={(value) => setDeleteScope(value as "local" | "platforms")} className="mt-5 space-y-3">
              <label className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${deleteScope === "local" ? "border-primary bg-primary/5" : "border-border"}`}>
                <RadioGroupItem value="local" className="mt-1" />
                <span><span className="block text-sm font-medium text-foreground">Remove from KasiTek only</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Published copies on social platforms remain online.</span></span>
              </label>
              {(() => {
                const publishedJobs = deleteTarget.publishJobs?.filter((job) => job.status === "PUBLISHED" && job.externalPostId) || [];
                return (
                  <label className={`flex gap-3 rounded-xl border p-4 ${publishedJobs.length ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${deleteScope === "platforms" ? "border-destructive bg-destructive/5" : "border-border"}`}>
                    <RadioGroupItem value="platforms" disabled={!publishedJobs.length} className="mt-1 text-destructive" />
                    <span><span className="block text-sm font-medium text-foreground">Remove from KasiTek and platforms</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{publishedJobs.length ? `Attempts deletion on ${publishedJobs.map((job) => getPlatformLabel(job.platform)).join(", ")}. Failed platform deletions keep this record available for retry.` : "There are no published platform copies recorded for this post."}</span></span>
                  </label>
                );
              })()}
            </RadioGroup>
            {deleteProviderResults.length ? <div className="mt-4 rounded-xl border border-destructive/30 bg-status-danger-soft p-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-destructive">Platform deletion results</p><div className="mt-2 space-y-2">{deleteProviderResults.map((result, index) => <div key={`${result.platform}-${index}`} className="flex items-start gap-2 text-xs">{result.status === "DELETED" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-success" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}<span className="text-foreground"><strong>{getPlatformLabel(result.platform)}</strong>{result.message ? ` · ${result.message}` : ` · ${result.status.toLowerCase()}`}</span></div>)}</div></div> : null}
            {error ? <p className="mt-4 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
            <div className="mt-6 flex justify-end gap-2"><Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deletingPost}>Cancel</Button><Button variant="destructive" onClick={() => void deletePost(deleteTarget.id, deleteScope === "platforms")} disabled={deletingPost}>{deletingPost ? "Deleting..." : deleteScope === "platforms" ? "Delete everywhere" : "Delete post"}</Button></div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(editTarget)} onOpenChange={open => { if (!open && !saving) { setEditTarget(null); setComposer(emptyComposer); setError(""); } }}>
        {editTarget ? <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
            <DialogTitle>{editTarget.status === "PUBLISHED" ? "Edit Facebook post" : "Edit post"}</DialogTitle>
            <DialogDescription>{composer.channels.map(platform => {
              const channel = channels.find(item => item.id === composer.channelSelections[platform]);
              return channel ? channelLabel(channel) : getPlatformLabel(platform);
            }).join(" · ")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
            {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive">{error}</p> : null}
            <label className="block space-y-2"><span className="text-sm text-muted-foreground">{editTarget.status === "PUBLISHED" ? "Facebook text" : "Post text"}</span><Textarea value={composer.content} onChange={event => setComposer(current => ({ ...current, content: event.target.value, variants: current.variants.map(variant => variant.content === current.content ? { ...variant, content: event.target.value } : variant) }))} placeholder="Write your post..." className="min-h-[160px] resize-y leading-6" disabled={saving} /></label>
            {editTarget.status !== "PUBLISHED" ? activeComposerVariants.map(variant => <label key={variant.platform} className="block space-y-2"><span className="text-sm text-muted-foreground">{getPlatformLabel(variant.platform)} version</span><Textarea value={variant.content} onChange={event => updateVariant(variant.platform, { content: event.target.value })} placeholder={`Write the ${getPlatformLabel(variant.platform)} version...`} className="min-h-[100px] resize-y" disabled={saving} /></label>) : null}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3"><span className="text-sm text-muted-foreground">Media</span>{editTarget.status !== "PUBLISHED" ? <><Button type="button" variant="outline" size="sm" onClick={() => mediaInputRef.current?.click()} disabled={saving}><Upload className="mr-1.5 h-3.5 w-3.5" />Add media</Button><input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple className="hidden" onChange={event => { const files = Array.from(event.target.files || []); void files.reduce((chain, file) => chain.then(() => uploadMedia(file)), Promise.resolve()); }} /></> : null}</div>
              {editTarget.status === "PUBLISHED" && removePublishedPhoto ? <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border p-3"><p className="text-sm text-muted-foreground">Photo will be removed</p><Button variant="outline" size="sm" disabled={saving} onClick={() => setRemovePublishedPhoto(false)} aria-label="Undo photo removal">Undo</Button></div> : composer.media.length ? <div className="grid gap-3 sm:grid-cols-2">{composer.media.map(item => <div key={item.assetId} className="overflow-hidden rounded-lg border border-border">{item.kind === "VIDEO" ? <video className="max-h-44 w-full object-contain" src={mediaUrl(item.assetId)} controls preload="metadata" /> : <img className="max-h-44 w-full object-contain" src={mediaUrl(item.assetId)} alt={item.altText || item.fileName || "Attached image"} />}<div className="flex items-center gap-2 p-2"><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.fileName || "Media"}</span>{editTarget.status !== "PUBLISHED" ? <Button variant="ghost" size="icon" disabled={saving} onClick={() => removeMedia(item.assetId)} aria-label="Remove media"><X className="h-4 w-4" /></Button> : composer.media.length === 1 && item.kind === "IMAGE" ? <Button variant="ghost" size="icon" disabled={saving} onClick={() => setRemovePublishedPhoto(true)} aria-label="Remove photo"><X className="h-4 w-4" /></Button> : null}</div></div>)}</div> : <p className="text-sm text-muted-foreground">No media</p>}
            </div>
            {editTarget.status === "SCHEDULED" ? <label className="block space-y-2"><span className="text-sm text-muted-foreground">Schedule for</span><Input type="datetime-local" value={composer.scheduledFor} onChange={event => setComposer(current => ({ ...current, scheduledFor: event.target.value }))} disabled={saving} /></label> : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-4 py-4 sm:px-6"><Button variant="outline" disabled={saving} onClick={() => { setEditTarget(null); setComposer(emptyComposer); setError(""); }}>Cancel</Button><Button disabled={saving} onClick={() => void (editTarget.status === "PUBLISHED" ? updatePublishedPost() : savePost(false, editTarget.status === "SCHEDULED" ? "SCHEDULED" : "DRAFT"))}>{saving ? "Saving..." : editTarget.status === "PUBLISHED" ? "Update on Facebook" : "Save changes"}</Button></div>
        </DialogContent> : null}
      </Dialog>

      <Sheet open={isComposerOpen} onOpenChange={setIsComposerOpen}>
        {isComposerOpen ? (
          <SheetContent className="w-full max-w-[760px] gap-0 border-l border-border bg-card p-0 sm:max-w-[760px]">
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6">
              <div>
                <SheetTitle className="text-lg font-semibold text-foreground">{composer.id ? "Edit post" : "New post"}</SheetTitle>
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
              {error ? <p className="mb-4 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
              {composerStep === 1 ? (
                <section className="space-y-5">
                  <div>
                    <h2 className="text-xl font-semibold text-foreground">Choose destinations</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Choose platforms for a draft. Connect an account to publish.</p>
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
                            {!options.length && !selected ? <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={() => selectDraftPlatform(platform)} aria-label={`Draft for ${getPlatformLabel(platform)}`}>Draft</Button> : null}
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
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-xl font-semibold text-foreground">Write the post</h2><p className="mt-1 text-sm text-muted-foreground">Add text or media. You can tailor each destination next.</p></div><Button type="button" variant="outline" className="shrink-0 gap-2" onClick={() => openContentAgent()}><Sparkles className="h-4 w-4" />Draft with agent</Button></div>
                  <label className="block space-y-2"><span className="text-sm text-muted-foreground">Post text (optional)</span><Textarea value={composer.content} onChange={(event) => setComposer((current) => ({ ...current, content: event.target.value }))} placeholder="Write your post..." className="min-h-[180px] resize-y leading-6" /></label>
                  <div className="space-y-3 rounded-xl border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div><p className="text-sm font-medium text-foreground">Media (optional)</p><p className="text-xs text-muted-foreground">Attach images or videos to this post.</p></div>
                      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => mediaInputRef.current?.click()} disabled={saving}><Upload className="h-3.5 w-3.5" />Add media</Button>
                      <input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); void files.reduce((chain, file) => chain.then(() => uploadMedia(file)), Promise.resolve()); }} />
                    </div>
                  {composer.media.length ? <div className="grid gap-3 sm:grid-cols-2">{composer.media.map((item) => <div key={item.assetId} className="group relative overflow-hidden rounded-lg border border-border bg-secondary/20">{item.kind === "VIDEO" ? <video className="h-32 w-full object-cover" src={mediaUrl(item.assetId)} muted playsInline preload="metadata" /> : <img width={640} height={320} className="h-32 w-full object-cover" src={mediaUrl(item.assetId)} alt={item.altText || item.fileName || "Attached image"} />}{item.kind === "VIDEO" ? <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[11px] text-white"><Play className="h-3 w-3" />{formatDuration(item.durationMs)}</span> : null}<div className="flex items-center gap-2 p-2"><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.fileName || (item.kind === "VIDEO" ? "Video" : "Image")} · {formatMediaSize(item.byteSize)}</span><Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeMedia(item.assetId)} aria-label="Remove media"><X className="h-3.5 w-3.5" /></Button></div></div>)}</div> : null}
                  </div>
                  {composer.channels.includes("INSTAGRAM") ? <label className="block space-y-2"><span className="text-sm text-muted-foreground">Instagram image URL</span><Input type="url" value={composer.instagramImageUrl} onChange={(event) => setComposer((current) => ({ ...current, instagramImageUrl: event.target.value }))} placeholder="https://example.com/image.jpg" /><span className="block text-xs text-muted-foreground">Required when publishing to Instagram.</span></label> : null}
                  {composer.channels.includes("TIKTOK") ? <div className="space-y-3 rounded-xl border border-border p-4"><p className="text-sm font-medium">TikTok publishing</p><label className="block space-y-2"><span className="text-sm text-muted-foreground">Optional verified media URL</span><Input type="url" value={composer.tiktokMediaUrl} onChange={(event) => setComposer((current) => ({ ...current, tiktokMediaUrl: event.target.value, tiktokConsent: false }))} placeholder="https://media.your-domain.com/post.mp4" /><span className="block text-xs text-muted-foreground">Use this only when the media is hosted on a TikTok-verified HTTPS domain. Uploaded media can be used instead.</span></label><div className="grid gap-3 sm:grid-cols-2"><label className="block space-y-2"><span className="text-sm text-muted-foreground">Media type for URL</span><Select value={composer.tiktokMediaType} onValueChange={(value) => setComposer((current) => ({ ...current, tiktokMediaType: value as ComposerState["tiktokMediaType"], tiktokConsent: false }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="VIDEO">Video</SelectItem><SelectItem value="PHOTO">Photo</SelectItem></SelectContent></Select></label><label className="block space-y-2"><span className="text-sm text-muted-foreground">Privacy</span><Select value={composer.tiktokPrivacyLevel} disabled={!tiktokPrivacyOptions.length} onValueChange={(value) => setComposer((current) => ({ ...current, tiktokPrivacyLevel: value as ComposerState["tiktokPrivacyLevel"], tiktokConsent: false }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{tiktokPrivacyOptions.map((option) => <SelectItem key={option} value={option}>{option === "SELF_ONLY" ? "Only me" : option === "PUBLIC_TO_EVERYONE" ? "Public" : option === "MUTUAL_FOLLOW_FRIENDS" ? "Friends" : "Followers"}</SelectItem>)}</SelectContent></Select><span className="block text-xs text-muted-foreground">Options are loaded from the connected TikTok creator account.</span></label></div><label className="flex items-start gap-2 text-sm"><Checkbox className="mt-1" checked={composer.tiktokConsent} onCheckedChange={(checked) => setComposer((current) => ({ ...current, tiktokConsent: checked === true }))} /><span>I consent to send the selected media and caption to TikTok for direct publishing.</span></label></div> : null}
                </section>
              ) : null}

              {composerStep === 3 ? (
                <section className="space-y-5">
                  <div><h2 className="text-xl font-semibold text-foreground">Tailor versions</h2><p className="mt-1 text-sm text-muted-foreground">Adjust the text for each selected destination.</p></div>
                  <Tabs value={activeVariantPlatform} onValueChange={(value) => setActiveVariantPlatform(value as SocialPlatform)}>
                    <TabsList className="flex w-full flex-wrap bg-secondary/50">{activeComposerVariants.map((variant) => <TabsTrigger key={variant.platform} value={variant.platform}>{getPlatformLabel(variant.platform)}</TabsTrigger>)}</TabsList>
                    {activeComposerVariants.map((variant) => <TabsContent key={variant.platform} value={variant.platform}><div className="space-y-3 rounded-xl border border-border p-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><span className="text-sm text-muted-foreground">{getPlatformLabel(variant.platform)} text</span><Button type="button" variant="outline" size="sm" className="w-fit gap-2" onClick={() => openContentAgent(variant.platform)}><Sparkles className="h-3.5 w-3.5" />Improve with agent</Button></div><Textarea value={variant.content} onChange={(event) => updateVariant(variant.platform, { content: event.target.value })} placeholder={`Write the ${getPlatformLabel(variant.platform)} version...`} className="min-h-[260px] resize-y leading-6" /><label className="block space-y-2"><span className="text-sm text-muted-foreground">Status</span><Select value={variant.status} onValueChange={(value) => updateVariant(variant.platform, { status: value as SocialVariantStatus })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="DRAFT">Draft</SelectItem><SelectItem value="APPROVED">Approved</SelectItem><SelectItem value="NEEDS_EDITS">Needs edits</SelectItem></SelectContent></Select></label></div></TabsContent>)}
                  </Tabs>
                  <div className="rounded-xl border border-border bg-secondary/20 p-4"><div className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-muted-foreground" /><div><p className="text-sm font-medium text-foreground">Mobile composition preview</p><p className="text-xs text-muted-foreground">A layout preview using the exact copy and media. Provider UI may differ.</p></div></div><div className="mt-4 flex justify-center"><div className="w-[250px] overflow-hidden rounded-[2rem] border-[6px] border-foreground/80 bg-background shadow-xl"><div className="flex items-center justify-between border-b border-border px-4 py-2 text-[10px] text-muted-foreground"><span>9:41</span><span>{getPlatformLabel(activeVariantPlatform)}</span><span>•••</span></div><div className="p-3"><div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold text-primary">KT</span><span className="text-[11px] font-medium">KasiTek</span></div><p className="mt-3 whitespace-pre-wrap break-words text-[11px] leading-4 text-foreground">{activeComposerVariants.find((variant) => variant.platform === activeVariantPlatform)?.content || composer.content}</p>{composer.media.length ? <div className="mt-3 space-y-2">{composer.media.slice(0, 4).map((item) => item.kind === "VIDEO" ? <div key={item.assetId} className="relative overflow-hidden rounded-lg bg-black"><video className="h-36 w-full object-cover" src={mediaUrl(item.assetId)} muted playsInline preload="metadata" /><span className="absolute inset-0 flex items-center justify-center"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white"><Play className="h-4 w-4 fill-current" /></span></span></div> : <img width={640} height={360} key={item.assetId} className="max-h-40 w-full rounded-lg object-cover" src={mediaUrl(item.assetId)} alt={item.altText || "Attached image"} />)}</div> : <div className="mt-3 flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-[10px] text-muted-foreground"><FileImage className="mr-1.5 h-3.5 w-3.5" />No media</div>}<div className="mt-3 flex gap-4 text-[10px] text-muted-foreground"><span>♡ 24</span><span>◌ 8</span><span>↗ Share</span></div></div></div></div></div>
                </section>
              ) : null}

              {composerStep === 4 ? (
                <section className="space-y-5">
                  <div><h2 className="text-xl font-semibold text-foreground">Review and publish</h2><p className="mt-1 text-sm text-muted-foreground">Save as a draft, schedule, or publish the selected versions now.</p></div>
                  <div className="rounded-xl border border-border p-4"><p className="text-sm font-medium text-foreground">Destinations</p><div className="mt-3 space-y-2">{composer.channels.map((platform) => { const channel = connectedChannels.find((item) => item.id === composer.channelSelections[platform]); return <div key={platform} className="flex items-center justify-between gap-3 text-sm"><span>{getPlatformLabel(platform)}</span><span className="text-muted-foreground">{channel ? channelLabel(channel) : "Not selected"}</span></div>; })}</div></div>
                  {batchPreflight ? (
                    <div className={`rounded-xl border p-4 ${batchPreflight.status === "READY" ? "border-status-success/30 bg-status-success-soft" : "border-destructive/30 bg-status-danger-soft"}`}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-foreground">Destination check</p>
                        <Badge className={batchPreflight.status === "READY" ? "bg-status-success-soft text-status-success" : "bg-status-danger-soft text-destructive"}>{batchPreflight.status}</Badge>
                      </div>
                      <div className="mt-3 space-y-2">
                        {batchPreflight.targets.map((target, index) => {
                          const ready = ["READY", "ALREADY_PUBLISHED"].includes(target.state);
                          return <div key={`${target.platform}-${target.accountName}-${index}`} className="flex items-start gap-2 text-xs"><span className={ready ? "text-status-success" : "text-destructive"}>{ready ? "✓" : "!"}</span><span className="text-foreground"><strong>{getPlatformLabel(target.platform.toUpperCase() as SocialPlatform)}</strong> · {target.accountName}{target.message ? <span className="block text-muted-foreground">{target.message}</span> : null}</span></div>;
                        })}
                      </div>
                    </div>
                  ) : null}
                  {mediaPublishIssues.length ? <div className="rounded-xl border border-status-warning/30 bg-status-warning-soft px-3 py-2 text-sm text-status-warning"><p className="font-medium">Media needs an adjustment before publishing</p><ul className="mt-1 list-disc space-y-1 pl-4 text-xs">{mediaPublishIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul><p className="mt-2 text-xs">You can still save this as a draft.</p></div> : null}
                  <label className="block space-y-2"><span className="text-sm text-muted-foreground">Schedule for</span><Input type="datetime-local" value={composer.scheduledFor} onChange={(event) => setComposer((current) => ({ ...current, scheduledFor: event.target.value }))} /><span className="block text-xs text-muted-foreground">Choose a date and time only when scheduling this post.</span></label>
                </section>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
              <Button variant="ghost" onClick={() => composerStep === 1 ? setIsComposerOpen(false) : setComposerStep((current) => (current - 1) as ComposerStep)}>{composerStep === 1 ? "Cancel" : <><ArrowLeft className="mr-2 h-4 w-4" />Back</>}</Button>
              {composerStep < 4 ? <Button onClick={advanceComposerStep}>Continue<ArrowRight className="ml-2 h-4 w-4" /></Button> : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" disabled={saving} onClick={() => void savePost(false, "DRAFT")}>{saving ? "Saving..." : "Save draft"}</Button>
                  <Button variant="outline" disabled={saving || !composer.scheduledFor || mediaPublishIssues.length > 0 || composer.channels.some((platform) => !composer.channelSelections[platform])} onClick={() => void savePost(false, "SCHEDULED")}>{saving ? "Saving..." : "Schedule post"}</Button>
                  <Button disabled={saving || mediaPublishIssues.length > 0 || composer.channels.some((platform) => !composer.channelSelections[platform])} onClick={() => void savePost(true)}>{saving ? "Publishing..." : "Post now"}</Button>
                </div>
              )}
            </div>
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  );
}
