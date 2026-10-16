type ApprovalPreviewProps = {
  snapshot?: Record<string, unknown>;
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function list(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function AgentApprovalPreview({ snapshot }: ApprovalPreviewProps) {
  if (!snapshot || Object.keys(snapshot).length === 0) return null;
  const resource = snapshot.resource && typeof snapshot.resource === "object" && !Array.isArray(snapshot.resource)
    ? snapshot.resource as Record<string, unknown>
    : null;
  const request = snapshot.request && typeof snapshot.request === "object" ? snapshot.request as Record<string, unknown> : {};
  const calendar = text(snapshot.capability).startsWith("kasitek.calendar.");
  const variants = resource?.variants && Array.isArray(resource.variants)
    ? resource.variants.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
  const channels = list(resource?.channels);

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">Resource preview</p>
          <p className="mt-1 text-xs text-muted-foreground">This is the immutable projection captured when the action was proposed.</p>
        </div>
        {resource?.status ? <span className="rounded-full border border-border bg-background px-2 py-1 text-[11px] font-medium capitalize text-muted-foreground">{text(resource.status).replaceAll("_", " ")}</span> : null}
      </div>
      {calendar ? <dl className="mt-3 grid gap-3 sm:grid-cols-2">{[["Title", request.title], ["Calendar", request.source], ["Starts", request.start], ["Ends", request.end], ["Timezone", request.timezone], ["Location", request.location]].filter(([, value]) => typeof value === "string" && value).map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{String(label)}</dt><dd className="mt-1 break-words text-sm text-foreground">{String(value)}</dd></div>)}</dl> : resource?.kind === "content_post" ? (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Post</p><p className="mt-1 break-all text-sm font-medium text-foreground">{text(resource.postId, "Unknown post")}</p></div>
            {resource.title ? <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Title</p><p className="mt-1 text-sm text-foreground">{text(resource.title)}</p></div> : null}
          </div>
          {resource.contentPreview ? <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Copy</p><p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-background/70 p-3 text-sm leading-6 text-foreground">{text(resource.contentPreview)}</p></div> : null}
          {channels.length ? <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Destinations</p><div className="mt-1 flex flex-wrap gap-1.5">{channels.map((channel) => <span key={channel} className="rounded-full bg-background px-2 py-1 text-xs text-muted-foreground">{channel}</span>)}</div></div> : null}
          {variants.length ? <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Platform variants</p><div className="mt-2 space-y-2">{variants.map((variant, index) => <div key={`${text(variant.platform, "variant")}-${index}`} className="rounded-md border border-border bg-background/70 p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-foreground">{text(variant.platform, "Variant")}</span>{variant.status ? <span className="text-[11px] capitalize text-muted-foreground">{text(variant.status).replaceAll("_", " ")}</span> : null}</div>{variant.contentPreview ? <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{text(variant.contentPreview)}</p> : null}</div>)}</div></div> : null}
          {resource.scheduledFor ? <p className="text-xs text-muted-foreground">Scheduled for {text(resource.scheduledFor)}</p> : null}
        </div>
      ) : (
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(snapshot, null, 2)}</pre>
      )}
    </div>
  );
}
