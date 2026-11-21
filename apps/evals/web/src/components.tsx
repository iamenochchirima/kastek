import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, CircleHelp, Clock, Search, X } from "lucide-react";
import type { AgentModelCatalogue } from "../../shared/types";

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
};

export function providerName(id: string) {
  return PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

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
  busyLabel = "Working…",
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
  busyLabel?: string;
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
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}


export function ModelPickerDialog({
  catalogue,
  selected,
  saving,
  error,
  onSave,
  onClose,
}: {
  catalogue: AgentModelCatalogue;
  selected: string;
  saving: boolean;
  error?: string | null;
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(selected);
  const [provider, setProvider] = useState("all");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);
  const optionValue = (connectionId: string, modelId: string) => JSON.stringify([connectionId, modelId]);
  const term = search.trim().toLowerCase();
  const matches = (label: string, detail: string) =>
    !term || `${label} ${detail}`.toLowerCase().includes(term);
  const providers = [...new Set(catalogue.models.map((model) => model.provider))].sort();
  const activeProvider = providers.includes(provider) ? provider : "all";
  const defaultLabel = catalogue.defaultModel?.label ?? "Default";
  const defaultVisible = matches(`${defaultLabel} default`, "organization default")
    && (activeProvider === "all" || catalogue.defaultModel?.provider === activeProvider);
  const visibleProviders = activeProvider === "all" ? providers : [activeProvider];
  const groups = visibleProviders
    .map((id) => {
      const models = catalogue.models.filter(
        (model) => model.provider === id && matches(model.label, `${model.modelId} ${id}`),
      );
      const connectionIds = [...new Set(models.map((model) => model.connectionId))];
      return {
        provider: id,
        models,
        connections: connectionIds.map((connectionId) => ({
          connectionId,
          label: models.find((model) => model.connectionId === connectionId)?.connectionLabel ?? connectionId,
          models: models.filter((model) => model.connectionId === connectionId),
        })),
      };
    })
    .filter((group) => group.models.length > 0);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="modal model-picker-modal" role="dialog" aria-modal="true" aria-labelledby="model-picker-title">
        <div className="modal-head">
          <div>
            <div className="eyebrow">Agent model</div>
            <h2 id="model-picker-title">Choose model</h2>
            <p className="muted small">Applies to new messages for this agent.</p>
          </div>
          <button className="icon-button" onClick={onClose} disabled={saving} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          <div className="search model-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search models"
              aria-label="Search models"
              autoFocus
              disabled={saving}
            />
          </div>
          <div className="provider-chips" role="group" aria-label="Filter by provider">
            <button
              type="button"
              className={`provider-chip${activeProvider === "all" ? " selected" : ""}`}
              aria-pressed={activeProvider === "all"}
              onClick={() => setProvider("all")}
              disabled={saving}
            >
              All
            </button>
            {providers.map((id) => (
              <button
                type="button"
                key={id}
                className={`provider-chip${activeProvider === id ? " selected" : ""}`}
                aria-pressed={activeProvider === id}
                onClick={() => setProvider(id)}
                disabled={saving}
              >
                {providerName(id)}
                <span className="provider-chip-count">
                  {catalogue.models.filter((model) => model.provider === id).length}
                </span>
              </button>
            ))}
          </div>
          <div className="model-list">
            {defaultVisible && (
              <button
                type="button"
                className={`model-option${pending === "organization_default" ? " selected" : ""}`}
                onClick={() => setPending("organization_default")}
                disabled={saving}
              >
                <span className="model-option-main">
                  <strong>Organization default</strong>
                  {catalogue.defaultModel && (
                    <span className="model-option-detail">{catalogue.defaultModel.label}</span>
                  )}
                </span>
                {pending === "organization_default" && <Check size={16} />}
              </button>
            )}
            {groups.map((group) => (
              <div className="model-group" key={group.provider}>
                <div className="model-group-label">{providerName(group.provider)}</div>
                {group.connections.map((connection) => (
                  <div className="model-connection" key={connection.connectionId}>
                    {group.connections.length > 1 && (
                      <div className="model-connection-label">{connection.label}</div>
                    )}
                    {connection.models.map((model) => {
                      const value = optionValue(model.connectionId, model.modelId);
                      return (
                        <button
                          type="button"
                          className={`model-option${pending === value ? " selected" : ""}`}
                          key={value}
                          onClick={() => setPending(value)}
                          disabled={saving}
                        >
                          <span className="model-option-main">
                            <strong>{model.label}</strong>
                          </span>
                          {pending === value && <Check size={16} />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
            {!defaultVisible && groups.length === 0 && (
              <div className="muted small model-empty">No matching models</div>
            )}
          </div>
          {error && <ErrorBox message={error} />}
        </div>
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="button"
            type="button"
            onClick={() => onSave(pending)}
            disabled={saving || pending === selected}
          >
            {saving ? "Saving…" : "Save model"}
          </button>
        </div>
      </section>
    </div>
  );
}
