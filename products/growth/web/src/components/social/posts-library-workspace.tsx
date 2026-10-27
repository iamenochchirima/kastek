import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AskGrowthAgent } from "@/components/dashboard/agents/agent-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  CalendarDays,
  ChevronDown,
  FileImage,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  X,
} from "@/components/ui/interface-icons";
import { SocialPostsLibrary } from "./social-posts-library";
import {
  SOCIAL_PLATFORM_ORDER,
  formatDateTime,
  getPlatformIcon,
  getPlatformIconClass,
  getPlatformLabel,
  getPostStatusMeta,
  type SocialChannelConnection,
  type SocialPost,
  type SocialPostMedia,
  type SocialPostStatus,
} from "./social-shared";
import { apiUrl } from "@/lib/server-api";
import "./posts-library-workspace.css";

type Props = {
  posts: SocialPost[];
  channels: SocialChannelConnection[];
  loading: boolean;
  refreshing: boolean;
  error: string;
  initialStatus: "ALL" | SocialPostStatus;
  onCreate(): void;
  onEdit(post: SocialPost): void;
  onRefresh(): void;
  onActivity(post: SocialPost): void;
  onDelete(post: SocialPost): void;
  renderPublishActions(post: SocialPost): ReactNode;
};
const statusIcons = {
  DRAFT: FileText,
  SCHEDULED: Clock,
  PUBLISHED: CheckCircle2,
  PROCESSING: RotateCcw,
  FAILED: AlertTriangle,
};
const statusTabs = [
  "ALL",
  "DRAFT",
  "SCHEDULED",
  "PUBLISHED",
  "FAILED",
  "PROCESSING",
] as const;
const postTitle = (post: SocialPost) => post.title || "Untitled post";
const mediaUrl = (assetId: string) =>
  apiUrl(`/api/social/media/${encodeURIComponent(assetId)}`);

function PostMedia({
  media,
  thumbnail = false,
}: {
  media?: SocialPostMedia;
  thumbnail?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!media || failed)
    return (
      <span className={thumbnail ? "" : "posts-no-media"}>
        <FileImage className="size-5 text-muted-foreground" />
        {thumbnail ? null : (
          <span>{failed ? "Media unavailable" : "No media"}</span>
        )}
      </span>
    );
  return media.kind === "VIDEO" ? (
    <video
      src={mediaUrl(media.assetId)}
      onError={() => setFailed(true)}
      controls={!thumbnail}
      muted={thumbnail}
      playsInline
      preload="metadata"
      aria-label={media.fileName || "Post video"}
    />
  ) : (
    <img
      src={mediaUrl(media.assetId)}
      onError={() => setFailed(true)}
      alt={thumbnail ? "" : media.altText || media.fileName || "Post media"}
      loading="lazy"
    />
  );
}

function PostThumbnail({ post }: { post: SocialPost }) {
  return (
    <span className="posts-thumbnail">
      <PostMedia
        key={post.media?.[0]?.assetId || post.id}
        media={post.media?.[0]}
        thumbnail
      />
    </span>
  );
}

export function PostsLibraryWorkspace(props: Props) {
  const [status, setStatus] = useState<"ALL" | SocialPostStatus>(
    props.initialStatus,
  );
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("ALL");
  const [ascending, setAscending] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null | undefined>(
    undefined,
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [grid, setGrid] = useState(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1279px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const filtered = props.posts
    .filter(
      (post) =>
        (status === "ALL" || post.status === status) &&
        (platform === "ALL" ||
          post.channels.some((channel) => channel === platform)) &&
        `${post.title || ""} ${post.content} ${post.prompt || ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => {
      const left = Date.parse(a.scheduledFor || a.publishedAt || a.createdAt);
      const right = Date.parse(b.scheduledFor || b.publishedAt || b.createdAt);
      return (left - right) * (ascending ? 1 : -1);
    });
  const selected =
    selectedId === undefined
      ? filtered[0]
      : filtered.find((post) => post.id === selectedId);
  const visibleChecked = filtered.filter((post) => checked.has(post.id));
  const allChecked =
    filtered.length > 0 && visibleChecked.length === filtered.length;
  function toggleChecked(id: string, enabled: boolean) {
    setChecked((current) => {
      const next = new Set(current);
      if (enabled) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const preview = selected ? (
    <PostPreview
      post={selected}
      {...props}
      onEdit={(post) => {
        setSelectedId(null);
        props.onEdit(post);
      }}
      onClose={() => setSelectedId(null)}
    />
  ) : null;
  return (
    <section className="posts-library" aria-label="Posts library">
      <div className="posts-library-main">
        <header className="posts-library-header">
          <h1>Posts</h1>
          <div className="flex flex-wrap items-center gap-2">
            <AskGrowthAgent featureId="content" context={{ kind: "workspace" }}>
              Draft with agent
            </AskGrowthAgent>
            <Button onClick={props.onCreate}>
              <Plus className="size-4" />
              Create post
            </Button>
          </div>
        </header>
        <div
          className="posts-library-tabs"
          role="tablist"
          aria-label="Post status"
        >
          {statusTabs.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={status === value}
              tabIndex={status === value ? 0 : -1}
              onKeyDown={(event) => {
                if (
                  !["ArrowRight", "ArrowLeft", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const index = statusTabs.indexOf(value);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? statusTabs.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          statusTabs.length) %
                        statusTabs.length;
                setStatus(statusTabs[next]);
                (
                  event.currentTarget.parentElement?.children[
                    next
                  ] as HTMLButtonElement
                )?.focus();
              }}
              onClick={() => setStatus(value)}
            >
              {value === "ALL"
                ? "All posts"
                : value === "DRAFT"
                  ? "Drafts"
                  : getPostStatusMeta(value).label}
              <span>
                {value === "ALL"
                  ? props.posts.length
                  : props.posts.filter((post) => post.status === value).length}
              </span>
            </button>
          ))}
        </div>
        <div className="posts-library-toolbar">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search posts"
              placeholder="Search posts..."
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger aria-label="Filter platforms">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All platforms</SelectItem>
              {SOCIAL_PLATFORM_ORDER.map((value) => (
                <SelectItem key={value} value={value}>
                  {getPlatformLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) =>
              setStatus(value as "ALL" | SocialPostStatus)
            }
          >
            <SelectTrigger aria-label="Filter status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusTabs.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "ALL"
                    ? "All statuses"
                    : getPostStatusMeta(value).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setGrid((value) => !value)}
            aria-label={
              grid ? "Show posts as table rows" : "Show posts as cards"
            }
            aria-pressed={grid}
          >
            <LayoutGrid className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onRefresh}
            disabled={props.refreshing}
            aria-label="Refresh posts"
          >
            <RotateCcw
              className={`size-4 ${props.refreshing ? "animate-spin" : ""}`}
            />
          </Button>
          <Button variant="ghost" asChild className="posts-calendar-link">
            <Link to="/content/calendar">
              <CalendarDays className="size-4" />
              View calendar
            </Link>
          </Button>
        </div>
        {props.error ? (
          <div
            role="alert"
            className="mx-6 mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive"
          >
            {props.error}
            <Button variant="ghost" size="sm" onClick={props.onRefresh}>
              Retry
            </Button>
          </div>
        ) : null}
        {visibleChecked.length ? (
          <div className="posts-selection">
            <span>{visibleChecked.length} selected on this view</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChecked(new Set())}
            >
              Clear selection
            </Button>
          </div>
        ) : null}
        {props.loading ? (
          <div aria-label="Loading posts" className="space-y-1 px-6">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-20 w-full rounded-none" />
            ))}
          </div>
        ) : !filtered.length ? (
          <div className="posts-library-empty">
            <FileImage className="size-7 text-muted-foreground" />
            <h2>{props.posts.length ? "No matching posts" : "No posts yet"}</h2>
            {props.posts.length ? (
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setStatus("ALL");
                  setPlatform("ALL");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button onClick={props.onCreate}>Create post</Button>
            )}
          </div>
        ) : grid ? (
          <div className="px-6">
            <SocialPostsLibrary posts={filtered} viewMode="grid" />
          </div>
        ) : (
          <div
            className="posts-table-scroll"
            role="region"
            aria-label="Posts"
            tabIndex={0}
          >
            <table className="posts-library-table">
              <thead>
                <tr>
                  <th className="posts-select-cell">
                    <Checkbox
                      aria-label="Select all filtered posts"
                      checked={
                        allChecked
                          ? true
                          : visibleChecked.length
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(value) => {
                        const enabled = value === true;
                        setChecked((current) => {
                          const next = new Set(current);
                          filtered.forEach((post) =>
                            enabled ? next.add(post.id) : next.delete(post.id),
                          );
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th>Post</th>
                  <th className="posts-platform-cell">Platforms</th>
                  <th>Status</th>
                  <th className="posts-date-cell">
                    <button
                      type="button"
                      onClick={() => setAscending((value) => !value)}
                      aria-label={`Sort by date ${ascending ? "descending" : "ascending"}`}
                    >
                      Date
                      <ChevronDown
                        className={`size-3 ${ascending ? "rotate-180" : ""}`}
                      />
                    </button>
                  </th>
                  <th className="posts-author-cell">Author</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((post) => {
                  const meta = getPostStatusMeta(post.status);
                  const StatusIcon = statusIcons[post.status];
                  const date =
                    post.scheduledFor || post.publishedAt || post.createdAt;
                  return (
                    <tr key={post.id} data-selected={selected?.id === post.id}>
                      <td className="posts-select-cell">
                        <Checkbox
                          aria-label={`Select ${postTitle(post)}`}
                          checked={checked.has(post.id)}
                          onCheckedChange={(value) =>
                            toggleChecked(post.id, value === true)
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="posts-title-button"
                          onClick={() => setSelectedId(post.id)}
                          aria-label={`Preview ${postTitle(post)}`}
                        >
                          <PostThumbnail post={post} />
                          <span className="min-w-0">
                            <strong>{postTitle(post)}</strong>
                            <span className="posts-caption">
                              {post.content || post.prompt || "No caption"}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="posts-platform-cell">
                        <div className="flex gap-2">
                          {post.channels.map((channel) => {
                            const Icon = getPlatformIcon(channel);
                            return (
                              <span
                                key={channel}
                                title={getPlatformLabel(channel)}
                              >
                                <Icon
                                  className={`size-4 ${getPlatformIconClass(channel)}`}
                                  aria-label={getPlatformLabel(channel)}
                                />
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td>
                        <Badge
                          data-status={post.status}
                          className={`posts-status ${meta.className}`}
                        >
                          <StatusIcon className="size-3" />
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="posts-date-cell">
                        <time dateTime={date} title={formatDateTime(date)}>
                          {new Date(date).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          <span>
                            {new Date(date).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZoneName: "short",
                            })}
                          </span>
                        </time>
                      </td>
                      <td
                        className="posts-author-cell text-muted-foreground"
                        title="Author profile unavailable"
                      >
                        —
                      </td>
                      <td>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${postTitle(post)}`}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => setSelectedId(post.id)}
                            >
                              Preview
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => props.onEdit(post)}
                            >
                              Edit post
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link
                                to={`/content/posts/${encodeURIComponent(post.id)}`}
                              >
                                Post details
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => props.onActivity(post)}
                            >
                              Activity and retries
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onSelect={() => props.onDelete(post)}
                            >
                              Delete post
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <footer className="posts-library-footer">
          <span>
            {filtered.length} {filtered.length === 1 ? "post" : "posts"}
          </span>
          <Link to="/content/posts">Publishing history</Link>
          <Link to="/content/analytics">Analytics</Link>
        </footer>
      </div>
      {preview ? (
        <aside className="posts-desktop-preview" aria-label="Post preview">
          {preview}
        </aside>
      ) : null}
      <Sheet
        open={Boolean(narrow && selected && selectedId !== undefined)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent className="posts-mobile-preview w-full overflow-y-auto sm:max-w-md">
          <SheetHeader className="sr-only">
            <SheetTitle>Post preview</SheetTitle>
          </SheetHeader>
          {preview}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function PostPreview({
  post,
  channels,
  onClose,
  onEdit,
  onActivity,
  onDelete,
  renderPublishActions,
}: Props & { post: SocialPost; onClose(): void }) {
  const [activePlatform, setActivePlatform] = useState<string | null>(null);
  const platform =
    post.channels.find((value) => value === activePlatform) || post.channels[0];
  const Icon = platform ? getPlatformIcon(platform) : FileImage;
  const account =
    channels.find(
      (channel) =>
        channel.id ===
        post.publishJobs?.find((job) => job.platform === platform)
          ?.channelConnectionId,
    ) ||
    (post.primaryChannel?.platform === platform ? post.primaryChannel : null);
  const caption =
    post.variants?.find((variant) => variant.platform === platform)?.content ||
    post.content;
  const status = getPostStatusMeta(post.status);
  return (
    <div className="posts-preview-content">
      <header>
        <h2>Post preview</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close post preview"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="posts-preview-body">
        <div className="flex items-center gap-3">
          <Icon
            className={`size-5 ${platform ? getPlatformIconClass(platform) : ""}`}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {account?.displayName ||
              account?.handle ||
              (platform ? getPlatformLabel(platform) : "Post")}
          </span>
        </div>
        {post.channels.length > 1 ? (
          <div
            className="mt-3 flex flex-wrap gap-1"
            role="group"
            aria-label="Preview platform"
          >
            {post.channels.map((value) => (
              <Button
                key={value}
                size="sm"
                variant={platform === value ? "secondary" : "ghost"}
                aria-pressed={platform === value}
                onClick={() => setActivePlatform(value)}
              >
                {getPlatformLabel(value)}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="posts-preview-media">
          {post.media?.length ? (
            post.media.map((media) => (
              <PostMedia key={media.assetId} media={media} />
            ))
          ) : (
            <PostMedia />
          )}
        </div>
        <p className="posts-preview-caption">{caption || "No caption"}</p>
        <div className="posts-preview-schedule">
          <CalendarDays className="size-5 text-muted-foreground" />
          <div>
            <span className="text-sm">{status.label}</span>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatDateTime(
                post.scheduledFor || post.publishedAt || post.createdAt,
              )}{" "}
              · {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => onEdit(post)}
        >
          Edit post
        </Button>
        <details className="posts-publishing-details">
          <summary>Publishing and actions</summary>
          {post.publishJobs?.map((job) => (
            <div
              key={job.id}
              className="space-y-1 border-b border-border py-3 text-xs"
            >
              <p>
                {getPlatformLabel(job.platform)} · {job.status}
              </p>
              {job.errorMessage ? (
                <p className="text-destructive">{job.errorMessage}</p>
              ) : null}
            </div>
          ))}
          <div className="mt-3">{renderPublishActions(post)}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onActivity(post)}
            >
              Activity
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to={`/content/posts/${encodeURIComponent(post.id)}`}>
                Post details
              </Link>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => onDelete(post)}
            >
              Delete post
            </Button>
          </div>
        </details>
      </div>
    </div>
  );
}
