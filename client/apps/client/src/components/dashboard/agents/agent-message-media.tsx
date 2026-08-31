import type { AgentMessage } from "@/lib/agent-platform";
import { apiUrl } from "@/lib/server-api";

type AgentMediaItem = {
  assetId: string;
  kind: string;
  fileName?: string;
  altText?: string;
  caption?: string;
};

function mediaItems(message: AgentMessage): AgentMediaItem[] {
  const content = message.content ?? {};
  if (Array.isArray(content.media)) {
    return content.media.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({
        assetId: typeof item.assetId === "string" ? item.assetId : "",
        kind: typeof item.kind === "string" ? item.kind.toLowerCase() : "file",
        fileName: typeof item.fileName === "string" ? item.fileName : undefined,
        altText: typeof item.altText === "string" ? item.altText : undefined,
        caption: typeof item.caption === "string" ? item.caption : undefined,
      }))
      .filter((item) => item.assetId);
  }
  if (typeof content.assetId === "string" && content.assetId) {
    return [{
      assetId: content.assetId,
      kind: typeof content.mediaKind === "string" ? content.mediaKind.toLowerCase() : "file",
      fileName: typeof content.fileName === "string" ? content.fileName : undefined,
    }];
  }
  return [];
}

export function agentMessageHasMedia(message: AgentMessage) {
  return mediaItems(message).length > 0;
}

export function AgentMessageMedia({ message }: { message: AgentMessage }) {
  const items = mediaItems(message);
  if (!items.length) return null;
  return (
    <div className="mb-2 space-y-2">
      {items.map((item) => {
        const src = apiUrl(`/api/social/media/${encodeURIComponent(item.assetId)}`);
        const label = item.altText || item.fileName || "Attachment";
        if (item.kind === "image") {
          return <figure key={item.assetId}><img src={src} alt={label} loading="lazy" className="max-h-80 w-full rounded-lg border border-border/60 object-contain" />{item.caption ? <figcaption className="mt-1 text-xs text-muted-foreground">{item.caption}</figcaption> : null}</figure>;
        }
        if (item.kind === "video") {
          return <figure key={item.assetId}><video controls preload="metadata" src={src} className="max-h-80 w-full rounded-lg border border-border/60 object-contain" />{item.caption ? <figcaption className="mt-1 text-xs text-muted-foreground">{item.caption}</figcaption> : null}</figure>;
        }
        if (item.kind === "audio") {
          return <figure key={item.assetId}><audio controls preload="metadata" src={src} className="w-full" />{item.caption ? <figcaption className="mt-1 text-xs text-muted-foreground">{item.caption}</figcaption> : null}</figure>;
        }
        return <a key={item.assetId} href={src} target="_blank" rel="noopener noreferrer" className="block truncate rounded-md border border-border/60 px-3 py-2 text-sm text-primary underline-offset-4 hover:underline">{label}</a>;
      })}
    </div>
  );
}
