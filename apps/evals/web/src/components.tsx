import type { ReactNode } from "react";
import { AlertTriangle, CircleHelp, Clock } from "lucide-react";

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "passed" || status === "completed" || status === "submitted" || status === "ready" || status === "complete" ? "passed" :
    status === "failed" || status === "error" || status === "cancelled" || status === "unreachable" ? "failed" :
    status === "partial" || status === "waiting_review" ? "partial" :
    status === "running" || status === "active" || status === "provisioning" ? "running" : "neutral";
  return <span className={`badge ${tone}`}>{status.replaceAll("_", " ")}</span>;
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

export function StatCard({ label, value, hint, icon }: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon">{icon}</span>}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, description, action }: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <CircleHelp size={22} strokeWidth={1.6} />
      <div className="empty-title">{title}</div>
      {description && <div className="muted">{description}</div>}
      {action}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="error-box">
      <AlertTriangle size={16} />
      <span>{message}</span>
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="loading"><Clock size={16} /> {label}…</div>;
}
