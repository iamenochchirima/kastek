import { cn } from "@/lib/utils";

const statusTone: Record<string, string> = {
  new: "bg-status-info-soft text-status-info",
  contacted: "bg-status-info-soft text-status-info",
  replied: "bg-status-info-soft text-status-info",
  qualified: "bg-status-info-soft text-status-info",
  pending: "bg-status-attention-soft text-status-attention",
  queued: "bg-status-attention-soft text-status-attention",
  running: "bg-status-info-soft text-status-info",
  in_progress: "bg-status-info-soft text-status-info",
  awaiting_approval: "bg-status-attention-soft text-status-attention",
  awaiting_human: "bg-status-attention-soft text-status-attention",
  awaiting_external_event: "bg-status-attention-soft text-status-attention",
  interested: "bg-status-attention-soft text-status-attention",
  quoted: "bg-status-attention-soft text-status-attention",
  won: "bg-status-success-soft text-status-success",
  accepted: "bg-status-success-soft text-status-success",
  paid: "bg-status-success-soft text-status-success",
  active: "bg-status-success-soft text-status-success",
  sent: "bg-status-info-soft text-status-info",
  overdue: "bg-status-attention-soft text-status-attention",
  rejected: "bg-status-danger-soft text-status-danger",
  failed: "bg-status-danger-soft text-status-danger",
  error: "bg-status-danger-soft text-status-danger",
  unavailable: "bg-status-danger-soft text-status-danger",
  cancelled: "bg-status-danger-soft text-status-danger",
  revoked: "bg-status-danger-soft text-status-danger",
  disabled: "bg-status-danger-soft text-status-danger",
  unknown: "bg-status-attention-soft text-status-attention",
  paused: "bg-status-attention-soft text-status-attention",
  enabled: "bg-status-success-soft text-status-success",
  partial: "bg-status-attention-soft text-status-attention",
  lost: "bg-secondary text-muted-foreground",
  draft: "bg-secondary text-muted-foreground",
  expired: "bg-secondary text-muted-foreground",
};

export function StatusBadge({ value, className = "" }: { value: string; className?: string }) {
  const label = value.replace(/[_-]/g, " ");
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-transparent px-2 py-1 text-xs font-medium capitalize", statusTone[value.toLowerCase()] ?? "bg-secondary text-muted-foreground", className)}><span className="size-1 rounded-full bg-current" />{label}</span>;
}
