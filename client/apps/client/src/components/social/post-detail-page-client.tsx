"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowLeft, CheckCircle2, Clock3, Pencil, Play, RotateCcw, Trash2 } from "lucide-react";
import { apiUrl } from "@/lib/server-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import {
  SOCIAL_PLATFORM_ORDER,
  type SocialPlatform,
  type SocialPost,
  type SocialPublishJob,
  formatDateTime,
  getPlatformCapabilities,
  getPlatformIcon,
  getPlatformIconClass,
  getPlatformLabel,
  getPlatformTone,
  getPostStatusMeta,
  getPublishJobStatusMeta,
} from "@/components/social/social-shared";

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
  externalPostId?: string | null;
  status: "DELETED" | "FAILED";
  message?: string | null;
};

const supportedManualPublishPlatforms: SocialPlatform[] = SOCIAL_PLATFORM_ORDER.filter((platform) =>
  getPlatformCapabilities(platform).supportsManualPublish,
);

function mediaUrl(assetId: string) {
  return apiUrl(`/api/social/media/${encodeURIComponent(assetId)}`);
}

function eventLabel(event: SocialPostActivityEvent) {
  return event.type
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function PostDetailPageClient({ initialPost }: { initialPost: SocialPost }) {
  const router = useRouter();
  const [post, setPost] = useState(initialPost);
  const [events, setEvents] = useState<SocialPostActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteScope, setDeleteScope] = useState<"local" | "platforms">("local");
  const [deleteProviderResults, setDeleteProviderResults] = useState<PostDeleteProviderResult[]>([]);

  const status = getPostStatusMeta(post.status);
  const StatusIcon = status.icon;
  const publishedJobs = useMemo(
    () => post.publishJobs?.filter((job) => job.status === "PUBLISHED").length || 0,
    [post.publishJobs],
  );
  const publishedProviderJobs = useMemo(
    () => post.publishJobs?.filter((job) => job.status === "PUBLISHED" && job.externalPostId) || [],
    [post.publishJobs],
  );

  useEffect(() => {
    let cancelled = false;
    setActivityLoading(true);
    void fetch(apiUrl(`/api/social/posts/${post.id}/activity`), {
      credentials: "include",
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await response.json() as { events?: SocialPostActivityEvent[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to load post activity");
        if (!cancelled) setEvents(payload.events || []);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load post activity");
      })
      .finally(() => {
        if (!cancelled) setActivityLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [post.id]);

  async function publishPostToPlatform(platform: SocialPlatform) {
    const key = `publish:${platform}`;
    setBusyKey(key);
    setError("");
    try {
      const response = await fetch(apiUrl(`/api/social/posts/${post.id}/publish`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      const payload = await response.json() as { post?: SocialPost; error?: string };
      if (!response.ok || !payload.post) throw new Error(payload.error || "Failed to publish post");
      setPost(payload.post);
      await refreshPostActivity();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to publish post");
    } finally {
      setBusyKey(null);
    }
  }

  async function runPublishJobAction(job: SocialPublishJob, action: "retry" | "cancel" | "run_now") {
    const key = `job:${job.id}:${action}`;
    setBusyKey(key);
    setError("");
    try {
      const response = await fetch(apiUrl(`/api/social/publish-jobs/${job.id}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as { post?: SocialPost; error?: string };
      if (!response.ok || !payload.post) throw new Error(payload.error || "Failed to update publish job");
      setPost(payload.post);
      await refreshPostActivity();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update publish job");
    } finally {
      setBusyKey(null);
    }
  }

  async function refreshPostActivity() {
    try {
      const response = await fetch(apiUrl(`/api/social/posts/${post.id}/activity`), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = await response.json() as { events?: SocialPostActivityEvent[] };
      if (response.ok) setEvents(payload.events || []);
    } catch {
      // The post action result remains useful even if the activity refresh is unavailable.
    }
  }

  async function deletePost(deleteFromPlatforms: boolean) {
    setBusyKey("delete");
    setError("");
    setDeleteProviderResults([]);
    try {
      const response = await fetch(apiUrl(`/api/social/posts/${post.id}`), {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteFromPlatforms }),
      });
      const payload = await response.json() as {
        error?: string;
        providerResults?: PostDeleteProviderResult[];
      };
      if (!response.ok) {
        setDeleteProviderResults(payload.providerResults || []);
        throw new Error(payload.error || "Failed to delete post");
      }
      router.push("/content/posts");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to delete post");
      setBusyKey(null);
    }
  }

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <Link href="/content/posts" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to Posts
        </Link>

        <section className="rounded-lg border border-border bg-card p-5 sm:p-6">
          <PageHeader>
            <PageHeaderContent>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={status.className}>
                  <StatusIcon className="mr-1 h-3.5 w-3.5" />
                  {status.label}
                </Badge>
              </div>
              <PageHeaderTitle className="mt-2">{post.title || "Untitled social post"}</PageHeaderTitle>
              <PageHeaderDescription>Post details.</PageHeaderDescription>
              <div className="mt-3 flex flex-wrap gap-2">
                {post.channels.map((platform) => {
                  const Icon = getPlatformIcon(platform);
                  return (
                    <span key={platform} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${getPlatformTone(platform)}`}>
                      <Icon className={`h-3.5 w-3.5 ${getPlatformIconClass(platform)}`} />
                      {getPlatformLabel(platform)}
                    </span>
                  );
                })}
              </div>
            </PageHeaderContent>
            <PageHeaderActions>
              <Button variant="outline" className="gap-2" onClick={() => router.push(`/content?edit=${encodeURIComponent(post.id)}`)}>
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => { setError(""); setDeleteProviderResults([]); setDeleteModalOpen(true); }} disabled={busyKey === "delete"} aria-label="Delete post">
                <Trash2 className="h-4 w-4" />
              </Button>
            </PageHeaderActions>
          </PageHeader>
          {error ? <p className="mt-5 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Post content</CardTitle>
                <CardDescription>The shared content saved for this post.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">
                  {post.content || "No shared post text was saved."}
                </p>
                {post.prompt ? (
                  <div className="mt-5 rounded-xl border border-border bg-secondary/20 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Original prompt</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{post.prompt}</p>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {post.media?.length ? (
              <Card>
                <CardHeader>
                  <CardTitle>Media</CardTitle>
                  <CardDescription>{post.media.length} attached asset{post.media.length === 1 ? "" : "s"}.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  {post.media.map((item) => (
                    <div key={item.id} className="overflow-hidden rounded-xl border border-border bg-secondary/20">
                      {item.kind === "VIDEO" ? (
                        <div className="relative">
                          <video className="h-56 w-full object-cover" src={mediaUrl(item.assetId)} controls preload="metadata" />
                          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-[11px] text-white">
                            <Play className="h-3 w-3" />
                            Video
                          </span>
                        </div>
                      ) : (
                        <Image unoptimized width={960} height={560} className="h-56 w-full object-cover" src={mediaUrl(item.assetId)} alt={item.altText || item.fileName || "Attached image"} />
                      )}
                      <div className="flex items-center justify-between gap-3 p-3 text-xs text-muted-foreground">
                        <span className="min-w-0 truncate">{item.fileName || (item.kind === "VIDEO" ? "Video" : "Image")}</span>
                        <span className="shrink-0">{item.width && item.height ? `${item.width} × ${item.height}` : ""}</span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Destination versions</CardTitle>
                <CardDescription>Platform-specific text saved with this post.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {post.variants?.length ? post.variants.map((variant) => {
                  const Icon = getPlatformIcon(variant.platform);
                  return (
                    <div key={variant.id} className="rounded-xl border border-border bg-secondary/20 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                          <Icon className={`h-4 w-4 ${getPlatformIconClass(variant.platform)}`} />
                          {getPlatformLabel(variant.platform)}
                        </div>
                        <Badge className="border-border bg-background text-muted-foreground">{variant.status.replace("_", " ")}</Badge>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{variant.content || "No platform-specific text."}</p>
                    </div>
                  );
                }) : <p className="text-sm text-muted-foreground">No destination versions have been saved.</p>}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Overview</CardTitle>
                <CardDescription>Important dates and delivery totals.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">Created</span><span className="text-right text-foreground">{formatDateTime(post.createdAt)}</span></div>
                <div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">Updated</span><span className="text-right text-foreground">{formatDateTime(post.updatedAt)}</span></div>
                <div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">Scheduled</span><span className="text-right text-foreground">{formatDateTime(post.scheduledFor)}</span></div>
                <div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">Published</span><span className="text-right text-foreground">{formatDateTime(post.publishedAt)}</span></div>
                <div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">Destinations</span><span className="text-right text-foreground">{publishedJobs} of {post.publishJobs?.length || post.channels.length} published</span></div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Publishing destinations</CardTitle>
                <CardDescription>Provider delivery state and recovery actions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {post.publishJobs?.length ? post.publishJobs.map((job) => {
                  const meta = getPublishJobStatusMeta(job.status);
                  const JobIcon = meta.icon;
                  const PlatformIcon = getPlatformIcon(job.platform);
                  const canManualPublish = supportedManualPublishPlatforms.includes(job.platform);
                  const jobBusy = busyKey?.startsWith(`job:${job.id}:`) || busyKey === `publish:${job.platform}`;
                  return (
                    <div key={job.id} className="rounded-xl border border-border bg-secondary/20 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                          <PlatformIcon className={`h-4 w-4 shrink-0 ${getPlatformIconClass(job.platform)}`} />
                          <span className="truncate">{getPlatformLabel(job.platform)}</span>
                        </div>
                        <Badge className={`shrink-0 ${meta.className}`}><JobIcon className="mr-1 h-3.5 w-3.5" />{meta.label}</Badge>
                      </div>
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        {job.scheduledFor ? <p>Scheduled {formatDateTime(job.scheduledFor)}</p> : null}
                        {job.publishedAt ? <p>Published {formatDateTime(job.publishedAt)}</p> : null}
                        {job.externalPostId ? <p className="break-all">External ID: {job.externalPostId}</p> : null}
                        {job.errorMessage ? <p className="text-destructive">{job.errorMessage}</p> : null}
                      </div>
                      {canManualPublish && job.status !== "PUBLISHED" ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {job.status === "FAILED" ? (
                            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void runPublishJobAction(job, "retry")} disabled={Boolean(jobBusy)}>
                              <RotateCcw className="h-3.5 w-3.5" />
                              {jobBusy ? "Retrying..." : "Retry"}
                            </Button>
                          ) : job.status === "PENDING" || job.status === "QUEUED" ? (
                            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void runPublishJobAction(job, "run_now")} disabled={Boolean(jobBusy)}>
                              <Clock3 className="h-3.5 w-3.5" />
                              {jobBusy ? "Running..." : "Run now"}
                            </Button>
                          ) : null}
                          {job.status !== "PROCESSING" ? (
                            <Button size="sm" variant="ghost" onClick={() => void publishPostToPlatform(job.platform)} disabled={Boolean(jobBusy)}>
                              {busyKey === `publish:${job.platform}` ? "Publishing..." : "Publish now"}
                            </Button>
                          ) : null}
                          {job.status === "PENDING" || job.status === "QUEUED" || job.status === "FAILED" ? (
                            <Button size="sm" variant="ghost" onClick={() => void runPublishJobAction(job, "cancel")} disabled={Boolean(jobBusy)}>Cancel</Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                }) : <p className="text-sm text-muted-foreground">No provider jobs have been recorded.</p>}
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" />Activity</CardTitle>
            <CardDescription>Durable post and provider events for this post.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {activityLoading ? <p className="text-sm text-muted-foreground">Loading activity...</p> : events.length ? events.map((event) => (
              <div key={event.id} className="flex gap-3 rounded-xl border border-border p-3">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${event.status === "FAILED" ? "bg-destructive" : event.status === "PUBLISHED" ? "bg-status-success" : "bg-status-info"}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{eventLabel(event)}</p>
                    <time className="text-xs text-muted-foreground">{formatDateTime(event.occurredAt)}</time>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{event.platform ? getPlatformLabel(event.platform) : event.source === "provider" ? "Provider" : "Content"}{event.message ? ` · ${event.message}` : ""}</p>
                </div>
              </div>
            )) : <p className="text-sm text-muted-foreground">No activity has been recorded for this post yet.</p>}
          </CardContent>
        </Card>
      </div>

      <Dialog open={deleteModalOpen} onOpenChange={(open) => !open && busyKey !== "delete" && setDeleteModalOpen(false)}>
          <DialogContent className="max-w-lg">
            <div className="flex items-start justify-between gap-4">
              <DialogHeader>
                <div className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  <DialogTitle>Delete post?</DialogTitle>
                </div>
                <DialogDescription>
                  Choose whether this removes only the KasiTek record or also attempts to remove published copies from their platforms.
                </DialogDescription>
              </DialogHeader>
            </div>

            <div className="mt-5 space-y-3">
              <label className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${deleteScope === "local" ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/30"}`}>
                <input type="radio" name="delete-scope" value="local" checked={deleteScope === "local"} onChange={() => setDeleteScope("local")} className="mt-1 accent-primary" />
                <span>
                  <span className="block text-sm font-medium text-foreground">Remove from KasiTek only</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">The published copies on social platforms will remain online.</span>
                </span>
              </label>

              <label className={`flex gap-3 rounded-xl border p-4 transition-colors ${publishedProviderJobs.length ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${deleteScope === "platforms" ? "border-destructive bg-destructive/5" : "border-border"}`}>
                <input type="radio" name="delete-scope" value="platforms" checked={deleteScope === "platforms"} onChange={() => publishedProviderJobs.length && setDeleteScope("platforms")} disabled={!publishedProviderJobs.length} className="mt-1 accent-destructive" />
                <span>
                  <span className="block text-sm font-medium text-foreground">Remove from KasiTek and platforms</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {publishedProviderJobs.length
                      ? `Attempts deletion on ${publishedProviderJobs.map((job) => getPlatformLabel(job.platform)).join(", ")}. If one fails, the KasiTek record stays here so you can retry.`
                      : "There are no published platform copies recorded for this post."}
                  </span>
                </span>
              </label>
            </div>

            {deleteProviderResults.length ? (
              <div className="mt-4 rounded-xl border border-destructive/30 bg-status-danger-soft p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-destructive">Platform deletion results</p>
                <div className="mt-2 space-y-2">
                  {deleteProviderResults.map((result, index) => (
                    <div key={`${result.platform}-${index}`} className="flex items-start gap-2 text-xs">
                      {result.status === "DELETED" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-success" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
                      <span className="text-foreground"><strong>{getPlatformLabel(result.platform)}</strong>{result.message ? ` · ${result.message}` : ` · ${result.status.toLowerCase()}`}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {error ? <p className="mt-4 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}

            <DialogFooter className="mt-6">
              <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={busyKey === "delete"}>Cancel</Button>
              <Button variant="destructive" onClick={() => void deletePost(deleteScope === "platforms")} disabled={busyKey === "delete"}>
                {busyKey === "delete" ? "Deleting..." : deleteScope === "platforms" ? "Delete everywhere" : "Delete post"}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>
    </div>
  );
}
