const statusTone: Record<string, string> = {
  new: "bg-status-info-soft text-status-info",
  contacted: "bg-status-info-soft text-status-info",
  interested: "bg-status-attention-soft text-status-attention",
  quoted: "bg-status-attention-soft text-status-attention",
  won: "bg-status-success-soft text-status-success",
  accepted: "bg-status-success-soft text-status-success",
  paid: "bg-status-success-soft text-status-success",
  active: "bg-status-success-soft text-status-success",
  sent: "bg-status-info-soft text-status-info",
  overdue: "bg-status-attention-soft text-status-attention",
  rejected: "bg-status-danger-soft text-status-danger",
  cancelled: "bg-status-danger-soft text-status-danger",
  lost: "bg-secondary text-muted-foreground",
  draft: "bg-secondary text-muted-foreground",
  expired: "bg-secondary text-muted-foreground",
};

export function StatusBadge({ value, className = "" }: { value: string; className?: string }) {
  const label = value.replace(/[_-]/g, " ");
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium capitalize ${statusTone[value.toLowerCase()] ?? "bg-secondary text-muted-foreground"} ${className}`}><span className="size-1 rounded-full bg-current" />{label}</span>;
}
