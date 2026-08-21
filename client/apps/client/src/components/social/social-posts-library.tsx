"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight, CalendarDays, FileImage, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { apiUrl } from "@/lib/server-api";
import {
  formatDateTime,
  getPlatformIcon,
  getPlatformIconClass,
  getPlatformLabel,
  getPlatformTone,
  getPostStatusMeta,
  type SocialPost,
} from "@/components/social/social-shared";

export type SocialPostsLibraryViewMode = "grid" | "table";

function mediaUrl(assetId: string) {
  return apiUrl(`/api/social/media/${encodeURIComponent(assetId)}`);
}

function excerpt(post: SocialPost) {
  const content = post.content.trim();
  return content || post.prompt?.trim() || "No post text saved yet.";
}

function SocialPostsTable({ posts }: { posts: SocialPost[] }) {
  return (
    <div className="rounded-xl border border-border/70">
      <div className="space-y-2 p-3 md:hidden">
        {posts.map((post) => {
          const status = getPostStatusMeta(post.status);
          const StatusIcon = status.icon;
          const publishedJobs = post.publishJobs?.filter((job) => job.status === "PUBLISHED").length || 0;

          return (
            <Link
              key={post.id}
              href={`/content/posts/${encodeURIComponent(post.id)}`}
              className="block rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/30 hover:bg-secondary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{post.title || "Untitled social post"}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{excerpt(post)}</p>
                </div>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge className={status.className}><StatusIcon className="mr-1 h-3.5 w-3.5" />{status.label}</Badge>
                <span className="text-xs text-muted-foreground">{post.publishedAt ? formatDateTime(post.publishedAt) : "Not published"}</span>
                {publishedJobs ? <span className="text-xs text-muted-foreground">{publishedJobs} published</span> : null}
              </div>
              {post.channels.length ? <div className="mt-2 flex flex-wrap gap-1.5">{post.channels.map((platform) => { const Icon = getPlatformIcon(platform); return <span key={platform} className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${getPlatformTone(platform)}`}><Icon className={`size-3 ${getPlatformIconClass(platform)}`} />{getPlatformLabel(platform)}</span>; })}</div> : null}
            </Link>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead className="bg-secondary/30 text-xs uppercase tracking-[0.12em] text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-semibold">Post</th>
            <th className="px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3 font-semibold">Channels</th>
            <th className="px-4 py-3 font-semibold">Published</th>
            <th className="w-12 px-4 py-3"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {posts.map((post) => {
            const status = getPostStatusMeta(post.status);
            const StatusIcon = status.icon;
            const publishedJobs = post.publishJobs?.filter((job) => job.status === "PUBLISHED").length || 0;
            return (
              <tr key={post.id} className="bg-card transition-colors hover:bg-secondary/20">
                <td className="max-w-[360px] px-4 py-3">
                  <Link href={`/content/posts/${encodeURIComponent(post.id)}`} className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground group-hover:underline">{post.title || "Untitled social post"}</span>
                      {post.media?.length ? <FileImage className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`${post.media.length} media assets`} /> : null}
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{excerpt(post)}</p>
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <Badge className={status.className}><StatusIcon className="mr-1 h-3.5 w-3.5" />{status.label}</Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {post.channels.map((platform) => {
                      const Icon = getPlatformIcon(platform);
                      return <span key={platform} className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${getPlatformTone(platform)}`}><Icon className={`h-3 w-3 ${getPlatformIconClass(platform)}`} />{getPlatformLabel(platform)}</span>;
                    })}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  <div>{post.publishedAt ? formatDateTime(post.publishedAt) : "Not published"}</div>
                  {publishedJobs ? <div className="mt-1">{publishedJobs} published</div> : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/content/posts/${encodeURIComponent(post.id)}`} className="inline-flex rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label={`Open ${post.title || "post"}`}>
                    <ArrowUpRight className="h-4 w-4" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export function SocialPostsLibrary({
  posts,
  viewMode = "grid",
}: {
  posts: SocialPost[];
  viewMode?: SocialPostsLibraryViewMode;
}) {
  if (viewMode === "table") return <SocialPostsTable posts={posts} />;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {posts.map((post) => {
        const status = getPostStatusMeta(post.status);
        const StatusIcon = status.icon;
        const firstMedia = post.media?.[0];
        const publishedJobs = post.publishJobs?.filter((job) => job.status === "PUBLISHED").length || 0;

        return (
          <Link
            key={post.id}
            href={`/content/posts/${encodeURIComponent(post.id)}`}
            className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Card className="h-full gap-0 overflow-hidden border-border/70 bg-secondary/20 py-0 transition-colors group-hover:border-foreground/30 group-hover:bg-secondary/35">
              {firstMedia ? (
                <div className="relative h-36 overflow-hidden border-b border-border/70 bg-background">
                  {firstMedia.kind === "VIDEO" ? (
                    <video
                      className="h-full w-full object-cover"
                      src={mediaUrl(firstMedia.assetId)}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <Image
                      unoptimized
                      width={640}
                      height={360}
                      className="h-full w-full object-cover"
                      src={mediaUrl(firstMedia.assetId)}
                      alt={firstMedia.altText || firstMedia.fileName || "Post media"}
                    />
                  )}
                  {firstMedia.kind === "VIDEO" ? (
                    <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                      <Play className="h-2.5 w-2.5" />
                      Video
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="line-clamp-2 min-w-0 text-base font-semibold text-foreground">
                    {post.title || "Untitled social post"}
                  </h2>
                  <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                </div>

                <p className="line-clamp-3 min-h-[4.5rem] whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {excerpt(post)}
                </p>

                <div className="flex flex-wrap gap-1.5">
                  <Badge className={status.className}>
                    <StatusIcon className="mr-1 h-3.5 w-3.5" />
                    {status.label}
                  </Badge>
                  {post.media?.length ? (
                    <Badge className="border-border bg-background text-muted-foreground">
                      <FileImage className="mr-1 h-3.5 w-3.5" />
                      {post.media.length} media
                    </Badge>
                  ) : null}
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 pt-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {post.publishedAt ? formatDateTime(post.publishedAt) : formatDateTime(post.createdAt)}
                  </span>
                  {publishedJobs ? <span>{publishedJobs} published</span> : null}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {post.channels.map((platform) => {
                    const Icon = getPlatformIcon(platform);
                    return (
                      <span key={platform} className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${getPlatformTone(platform)}`}>
                        <Icon className={`h-3 w-3 ${getPlatformIconClass(platform)}`} />
                        {getPlatformLabel(platform)}
                      </span>
                    );
                  })}
                </div>
              </div>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
