"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type WebsiteCrawlPreview = {
  sourceId: string;
  crawlId: string;
  status: string;
  total?: number;
  completed?: number;
  pages?: number;
  preview?: string;
};

export function isWebsiteCrawlPreview(value: unknown): value is WebsiteCrawlPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const crawl = value as Partial<WebsiteCrawlPreview>;
  return typeof crawl.sourceId === "string" && typeof crawl.crawlId === "string" && typeof crawl.status === "string";
}

export function WebsiteSourcePreviewDialog({
  open,
  onOpenChange,
  url,
  pages,
  content,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  pages?: number;
  content: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-5xl gap-5 overflow-hidden p-5 sm:p-7">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>Website source preview</DialogTitle>
          <DialogDescription className="truncate" title={url}>
            {url}{pages ? ` · ${pages} pages indexed` : ""}
          </DialogDescription>
        </DialogHeader>
        <pre className="min-h-0 max-h-[calc(100dvh-11rem)] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background/70 p-4 font-mono text-xs leading-6 text-muted-foreground sm:p-5 sm:text-sm">
          {content}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
