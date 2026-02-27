const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-white/10 text-text-muted border border-border",
  SCHEDULED: "bg-blue-500/15 text-blue-300 border border-blue-500/25",
  SENDING: "bg-amber-500/15 text-amber-300 border border-amber-500/25",
  PAUSED: "bg-zinc-500/20 text-zinc-300 border border-zinc-500/25",
  COMPLETED: "bg-green-500/15 text-green-300 border border-green-500/25",
  FAILED: "bg-red-500/15 text-red-300 border border-red-500/25",
};

export default function CampaignStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[status] || STATUS_STYLES.DRAFT}`}
    >
      {status.toLowerCase()}
    </span>
  );
}
