import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { FileImage, Search, Upload } from "@/components/ui/interface-icons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ContentWorkspaceNavigation } from "./content-workspace-navigation";
import {
  contentOperation,
  errorMessage,
  mediaSource,
  type LibraryPage,
  type MediaAsset,
  uploadLibraryMedia,
} from "@/lib/content-library";

export function MediaThumbnail({
  asset,
  className = "",
  controls = false,
}: {
  asset: MediaAsset;
  className?: string;
  controls?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`overflow-hidden bg-muted ${className}`}>
      {failed ? (
        <div className="flex h-full min-h-28 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FileImage className="h-8 w-8" />
          <span className="text-xs">Preview unavailable</span>
        </div>
      ) : asset.kind === "VIDEO" ? (
        <video
          src={mediaSource(asset.id)}
          className="h-full w-full object-cover"
          preload="metadata"
          controls={controls}
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          src={mediaSource(asset.id)}
          alt={
            asset.defaultAltText ||
            asset.displayName ||
            asset.fileName ||
            "Media"
          }
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
export function AssetPreview({
  assetId,
  className = "aspect-video rounded-lg",
}: {
  assetId: string;
  className?: string;
}) {
  const [asset, setAsset] = useState<MediaAsset | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setError(false);
    setAsset(null);
    void contentOperation<{ asset: MediaAsset }>("content.media.get", {
      assetId,
    })
      .then((result) => active && setAsset(result.asset))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [assetId]);
  return asset ? (
    <MediaThumbnail asset={asset} className={className} />
  ) : (
    <div
      className={`${className} flex items-center justify-center bg-muted text-xs text-muted-foreground ${error ? "" : "animate-pulse"}`}
    >
      {error ? "Preview unavailable" : null}
    </div>
  );
}
export function MediaBrowser({
  onSelect,
  selectedIds = [],
  archived = false,
  refreshKey = 0,
  readyOnly = false,
  disabled = false,
}: {
  onSelect: (asset: MediaAsset) => void;
  selectedIds?: string[];
  archived?: boolean;
  refreshKey?: number;
  readyOnly?: boolean;
  disabled?: boolean;
}) {
  const readVersion = useRef(0);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(
    async (cursor?: string) => {
      const version = ++readVersion.current;
      setLoading(true);
      setError("");
      try {
        const result = await contentOperation<
          LibraryPage<{ assets: MediaAsset[] }>
        >("content.media.list", {
          limit: 24,
          ...(search ? { search } : {}),
          archived,
          ...(kind ? { kind } : {}),
          ...(tagFilter
            ? {
                tags: tagFilter
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (version !== readVersion.current) return;
        setAssets((current) =>
          cursor ? [...current, ...result.assets] : result.assets,
        );
        setNext(result.pagination.nextCursor);
      } catch (e) {
        if (version === readVersion.current) setError(errorMessage(e));
      } finally {
        if (version === readVersion.current) setLoading(false);
      }
    },
    [search, kind, archived, tagFilter],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 200);
    return () => clearTimeout(timer);
  }, [load, refreshKey]);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search media"
            placeholder="Search media"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Input
          aria-label="Filter media tags"
          placeholder="Tags"
          className="w-32"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
        />
        <Select
          value={kind || "ALL"}
          onValueChange={(value) => setKind(value === "ALL" ? "" : value)}
        >
          <SelectTrigger aria-label="Media type" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All files</SelectItem>
            <SelectItem value="IMAGE">Images</SelectItem>
            <SelectItem value="VIDEO">Videos</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button variant="link" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 2xl:grid-cols-4">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            disabled={
              disabled ||
              (readyOnly &&
                (asset.processingStatus !== "READY" ||
                  asset.scanStatus !== "CLEAN"))
            }
            aria-pressed={selectedIds.includes(asset.id)}
            onClick={() => onSelect(asset)}
            className="min-w-0 text-left disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
          >
            <MediaThumbnail
              asset={asset}
              className={`aspect-square rounded-lg border-2 ${selectedIds.includes(asset.id) ? "border-primary" : "border-transparent"}`}
            />
            <span className="mt-2 block truncate text-sm font-medium">
              {asset.displayName || asset.fileName || "Untitled media"}
            </span>
            <span className="text-xs text-muted-foreground">
              {asset.processingStatus !== "READY" ||
              asset.scanStatus !== "CLEAN"
                ? "Not ready"
                : asset.kind === "VIDEO"
                  ? "Video"
                  : "Image"}
              {asset.width && asset.height
                ? ` · ${asset.width} × ${asset.height}`
                : ""}
            </span>
          </button>
        ))}
        {loading && !assets.length
          ? Array.from({ length: 8 }, (_, i) => (
              <div
                key={i}
                className="aspect-square animate-pulse rounded-lg bg-muted"
              />
            ))
          : null}
      </div>
      {!loading && !error && !assets.length ? (
        <div className="py-16 text-center text-muted-foreground">
          No media found
        </div>
      ) : null}
      {next ? (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load(next)}
        >
          {loading ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
export function MediaPicker({
  open,
  onOpenChange,
  onSelect,
  selectedIds,
  validateSelection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (asset: MediaAsset) => void;
  selectedIds?: string[];
  validateSelection?: (asset: MediaAsset) => string | null;
}) {
  const [selectionError, setSelectionError] = useState("");
  const [pendingAssetId, setPendingAssetId] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const selectionKey = selectedIds?.join(",") || "";
  const invalidateSelection = useCallback(() => {
    ++generation.current;
    pending.current = false;
  }, []);
  useEffect(() => {
    invalidateSelection();
    setPendingAssetId(null);
    setSelectionError("");
    return invalidateSelection;
  }, [open, selectionKey, invalidateSelection]);
  function changeOpen(next: boolean) {
    if (!next) {
      invalidateSelection();
      setPendingAssetId(null);
    }
    onOpenChange(next);
  }
  async function selectAsset(asset: MediaAsset) {
    if (pending.current) return;
    const error = validateSelection?.(asset);
    if (error) {
      setSelectionError(error);
      return;
    }
    const currentGeneration = generation.current;
    pending.current = true;
    setPendingAssetId(asset.id);
    setSelectionError("");
    try {
      const result = await contentOperation<{
        asset: MediaAsset;
        previewUrl: string;
      }>("content.media.preview", { assetId: asset.id });
      if (currentGeneration !== generation.current) return;
      if (
        result.asset.archivedAt ||
        result.asset.processingStatus !== "READY" ||
        result.asset.scanStatus !== "CLEAN"
      )
        throw new Error("This media is not ready to attach.");
      onSelect(result.asset);
      changeOpen(false);
    } catch (error) {
      if (currentGeneration === generation.current)
        setSelectionError(errorMessage(error));
    } finally {
      if (currentGeneration === generation.current) {
        pending.current = false;
        setPendingAssetId(null);
      }
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[min(56rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Choose media</DialogTitle>
          <DialogDescription className="sr-only">
            Select an asset from your library.
          </DialogDescription>
        </DialogHeader>
        <MediaBrowser
          readyOnly
          selectedIds={selectedIds}
          disabled={!!pendingAssetId}
          onSelect={(asset) => void selectAsset(asset)}
        />
        {pendingAssetId ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking media…
          </p>
        ) : null}
        {selectionError ? (
          <p role="alert" className="text-sm text-destructive">
            {selectionError}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
export function ContentMediaLibrary() {
  const detailRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  useEffect(() => {
    if (selected && window.innerWidth < 1024)
      detailRef.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }, [selected]);
  const [archived, setArchived] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [usage, setUsage] = useState<
    { type: string; id: string; title: string; status: string }[]
  >([]);
  const usageVersion = useRef(0);
  const [usageError, setUsageError] = useState("");
  const [usageNext, setUsageNext] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  async function loadMoreUsage() {
    if (!selected || !usageNext) return;
    const version = usageVersion.current;
    setUsageLoading(true);
    setUsageError("");
    try {
      const result = await contentOperation<
        LibraryPage<{ usage: typeof usage }>
      >("content.media.usage", {
        assetId: selected.id,
        limit: 24,
        cursor: usageNext,
      });
      if (version !== usageVersion.current) return;
      setUsage((current) => [...current, ...result.usage]);
      setUsageNext(result.pagination.nextCursor);
    } catch (error) {
      if (version === usageVersion.current) setUsageError(errorMessage(error));
    } finally {
      if (version === usageVersion.current) setUsageLoading(false);
    }
  }
  useEffect(() => {
    ++usageVersion.current;
    setUsage([]);
    setUsageError("");
    setUsageNext(null);
    if (!selected) return;
    setUsageLoading(true);
    let active = true;
    void contentOperation<LibraryPage<{ usage: typeof usage }>>(
      "content.media.usage",
      {
        assetId: selected.id,
        limit: 24,
      },
    )
      .then((result) => {
        if (active) {
          setUsage(result.usage);
          setUsageNext(result.pagination.nextCursor);
        }
      })
      .catch((error) => active && setUsageError(errorMessage(error)))
      .finally(() => active && setUsageLoading(false));
    return () => {
      active = false;
    };
  }, [selected]);
  const upload = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [alt, setAlt] = useState("");
  const [tags, setTags] = useState("");
  function select(asset: MediaAsset) {
    setSelected(asset);
    setName(asset.displayName || asset.fileName || "");
    setAlt(asset.defaultAltText || "");
    setTags(asset.tags.join(", "));
    setError("");
  }
  async function save(archive = false) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const { asset } = await contentOperation<{ asset: MediaAsset }>(
        archive
          ? `content.media.${selected.archivedAt ? "restore" : "archive"}`
          : "content.media.update",
        {
          assetId: selected.id,
          expectedRevision: selected.revision,
          ...(!archive
            ? {
                displayName: name,
                tags: tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                defaultAltText: alt,
              }
            : {}),
        },
        crypto.randomUUID(),
      );
      select(asset);
      setConfirm(false);
      setRefresh((v) => v + 1);
      toast.success(archive ? "Media updated" : "Changes saved");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function uploadFiles(files: File[]) {
    setBusy(true);
    setError("");
    try {
      for (const file of files) {
        await uploadLibraryMedia(file);
      }
      setRefresh((v) => v + 1);
      toast.success("Media uploaded");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  }
  return (
    <div className="min-h-full">
      <header className="space-y-5 border-b border-border px-4 pt-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Media library
          </h1>
          <Button disabled={busy} onClick={() => upload.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            {busy ? "Working…" : "Upload media"}
          </Button>
          <input
            type="file"
            multiple
            accept="image/*,video/*"
            className="hidden"
            ref={upload}
            onChange={(e) => void uploadFiles(Array.from(e.target.files || []))}
          />
        </div>
        <ContentWorkspaceNavigation active="media" />
      </header>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="space-y-5 p-4 sm:p-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Archived
          </label>
          <MediaBrowser
            onSelect={select}
            selectedIds={selected ? [selected.id] : []}
            archived={archived}
            refreshKey={refresh}
          />
        </main>
        {selected ? (
          <aside
            ref={detailRef}
            className="space-y-5 border-t border-border p-4 sm:p-6 lg:border-l lg:border-t-0"
          >
            <Button
              className="lg:hidden"
              variant="ghost"
              onClick={() => setSelected(null)}
            >
              Back to media
            </Button>
            <MediaThumbnail
              asset={selected}
              className="aspect-square rounded-xl"
              controls
            />
            <p className="text-xs text-muted-foreground">
              {selected.mimeType} ·{" "}
              {(Number(selected.byteSize) / 1024 / 1024).toFixed(1)} MB
            </p>
            <label className="block space-y-2 text-sm">
              Name
              <Input
                maxLength={240}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block space-y-2 text-sm">
              Alt text
              <Textarea
                maxLength={2000}
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
              />
            </label>
            <label className="block space-y-2 text-sm">
              Tags
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Comma-separated tags"
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => void save()}
            >
              Save changes
            </Button>
            <Button
              asChild
              className="w-full"
              variant="outline"
              disabled={!!selected.archivedAt}
            >
              <Link to={`/content?asset=${selected.id}`}>Use in post</Link>
            </Button>
            <div className="space-y-2 border-t border-border pt-4">
              <h3 className="text-sm font-medium">Used in</h3>
              {usage.map((item) => (
                <Link
                  key={`${item.type}:${item.id}`}
                  className="block truncate text-sm text-muted-foreground hover:text-foreground"
                  to={
                    item.type === "post"
                      ? `/content/posts/${item.id}`
                      : `/content/templates?template=${item.id}`
                  }
                >
                  {item.title || "Untitled"} · {item.status}
                </Link>
              ))}
              {usageNext ? (
                <Button
                  variant="link"
                  size="sm"
                  disabled={usageLoading}
                  onClick={() => void loadMoreUsage()}
                >
                  {usageLoading ? "Loading…" : "Load more"}
                </Button>
              ) : null}
              {usageLoading && !usage.length ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : null}
              {!usage.length && !usageError && !usageLoading ? (
                <p className="text-xs text-muted-foreground">No references</p>
              ) : null}
              {usageError ? (
                <p role="alert" className="text-xs text-destructive">
                  {usageError}
                </p>
              ) : null}
            </div>
            <Button
              className="w-full"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              {selected.archivedAt ? "Restore media" : "Archive media"}
            </Button>
          </aside>
        ) : null}
      </div>
      {error && !selected ? (
        <p role="alert" className="px-6 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selected?.archivedAt ? "Restore media?" : "Archive media?"}
            </DialogTitle>
            <DialogDescription>
              Existing posts and templates keep their attachments.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void save(true)}>
              {busy ? "Saving…" : selected?.archivedAt ? "Restore" : "Archive"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
