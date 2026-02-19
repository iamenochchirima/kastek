const statusStyles: Record<string, string> = {
  draft: "bg-text-dim/10 text-text-muted",
  active: "bg-accent/10 text-accent",
  paused: "bg-warm/10 text-warm",
};

const statusLabels: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
};

export default function BotStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles[status] || statusStyles.draft}`}
    >
      {statusLabels[status] || status}
    </span>
  );
}
