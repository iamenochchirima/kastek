import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CircleHelp, Clock, X } from "lucide-react";

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


export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Delete",
  confirmationText,
  busy = false,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmationText?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  const confirmed = !confirmationText || value.trim() === confirmationText;
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div className="modal-head">
          <div>
            <div className="eyebrow">Confirm</div>
            <h2 id="confirm-dialog-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onCancel} disabled={busy} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          {description && <p className="muted">{description}</p>}
          {children}
          {confirmationText && (
            <label className="field">
              <span className="field-label">Type {confirmationText} to confirm</span>
              <input
                className="input"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoFocus
                disabled={busy}
              />
            </label>
          )}
          {error && <ErrorBox message={error} />}
        </div>
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button destructive" type="button" onClick={onConfirm} disabled={busy || !confirmed}>
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
