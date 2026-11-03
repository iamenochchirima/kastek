import { Link } from "react-router";

function resourceId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}
export function ContentSourceLinks({
  metadata,
}: {
  metadata?: Record<string, unknown> | null;
}) {
  const sourcePostId = resourceId(metadata?.duplicatedFrom);
  const templateId = resourceId(metadata?.contentTemplateId);
  if (!sourcePostId && !templateId) return null;
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {sourcePostId ? (
        <Link
          className="underline underline-offset-4 hover:text-foreground"
          to={`/content/posts/${encodeURIComponent(sourcePostId)}`}
        >
          Source post
        </Link>
      ) : null}
      {templateId ? (
        <Link
          className="underline underline-offset-4 hover:text-foreground"
          to={`/content/templates?template=${encodeURIComponent(templateId)}`}
        >
          Template
        </Link>
      ) : null}
    </div>
  );
}
