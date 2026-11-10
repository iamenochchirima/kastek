import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Boxes, ClipboardCheck, MessageSquare, Plus, Trash2, X } from "lucide-react";
import type { SandboxDetail, SandboxSummary } from "../../../shared/types";
import { api, errorMessage, formatDate, shortId } from "../api";
import { ConfirmDialog, EmptyState, ErrorBox, Loading, PageHeader, StatCard, StatusBadge } from "../components";

export default function SandboxesPage() {
  const navigate = useNavigate();
  const [sandboxes, setSandboxes] = useState<SandboxSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [product, setProduct] = useState<"agents" | "growth">("agents");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SandboxSummary | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    api<SandboxSummary[]>("/api/sandboxes").then(setSandboxes).catch((value) => setError(errorMessage(value)));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, creating]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceName.trim() || creating) return;
    setCreating(true);
    setFormError(null);
    try {
      const created = await api<SandboxDetail>("/api/sandboxes", {
        method: "POST",
        body: JSON.stringify({
          product,
          label: label.trim() || undefined,
          workspaceName: workspaceName.trim(),
        }),
      });
      setOpen(false);
      navigate(`/sandboxes/${created.sandbox.id}`);
    } catch (value) {
      setFormError(errorMessage(value));
    } finally {
      setCreating(false);
    }
  }

  async function deleteOne() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/api/sandboxes/${encodeURIComponent(deleteTarget.sandbox.id)}`, { method: "DELETE" });
      const refreshed = await api<SandboxSummary[]>("/api/sandboxes");
      setSandboxes(refreshed);
      setDeleteTarget(null);
    } catch (value) {
      setDeleteError(errorMessage(value));
    } finally {
      setDeleting(false);
    }
  }

  async function deleteAll() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>("/api/sandboxes", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const refreshed = await api<SandboxSummary[]>("/api/sandboxes");
      setSandboxes(refreshed);
      if (result.failed.length > 0) {
        setDeleteError(
          `${result.failed.length} sandbox${result.failed.length === 1 ? "" : "es"} could not be deleted: ${result.failed[0]!.error}`,
        );
        return;
      }
      setDeleteAllOpen(false);
    } catch (value) {
      setDeleteError(errorMessage(value));
    } finally {
      setDeleting(false);
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!sandboxes) return <Loading label="Loading sandboxes" />;

  const active = sandboxes.filter((item) => ["active", "ready"].includes(item.sandbox.status)).length;
  const sessions = sandboxes.reduce((total, item) => total + item.counts.sessions, 0);
  const outcomes = sandboxes.reduce((total, item) => total + item.counts.outcomes, 0);

  return (
    <>
      <PageHeader
        eyebrow="Control plane"
        title="Sandboxes"
        description="Persistent product environments recorded by the evaluation service."
        actions={
          <>
            {sandboxes.length > 0 && (
              <button
                className="button ghost destructive"
                onClick={() => { setDeleteAllOpen(true); setDeleteError(null); }}
              >
                <Trash2 size={15} /> Delete all
              </button>
            )}
            <button className="button" onClick={() => { setOpen(true); setFormError(null); }}><Plus size={15} /> Create sandbox</button>
          </>
        }
      />
      <section className="stat-grid">
        <StatCard label="Sandboxes" value={sandboxes.length} hint={`${active} ready`} icon={<Boxes size={16} />} />
        <StatCard label="Sessions" value={sessions} hint="Interactive conversations" icon={<MessageSquare size={16} />} />
        <StatCard label="Outcomes" value={outcomes} hint="Saved business results" icon={<ClipboardCheck size={16} />} />
      </section>
      {sandboxes.length === 0 ? (
        <section className="panel">
          <EmptyState title="No sandboxes yet" />
        </section>
      ) : (
        <div className="card-grid">
          {sandboxes.map((item) => (
            <div className="card card-link" key={item.sandbox.id}>
              <Link
                className="card-stretched-link"
                to={`/sandboxes/${item.sandbox.id}`}
                aria-label={`Open sandbox ${shortId(item.sandbox.id)}`}
              />
              <div className="card-head">
                <div className="card-icon"><Boxes size={18} /></div>
                <div className="card-head-actions">
                  <StatusBadge status={item.sandbox.status} />
                  <button
                    className="icon-button danger card-delete"
                    aria-label="Delete sandbox"
                    onClick={() => {
                      setDeleteTarget(item);
                      setDeleteError(null);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <h3 className="mono">{shortId(item.sandbox.id)}</h3>
              <p className="muted">{item.sandbox.product} · {item.sandbox.profile}</p>
              <div className="kv compact">
                <div><span>Version</span><code>{item.version ? shortId(item.version.id) : "none"}</code></div>
                <div><span>Workspaces</span><code>{item.workspaceRefs.length}</code></div>
                <div><span>Agents</span><code>{item.counts.agents}</code></div>
                <div><span>Sessions</span><code>{item.counts.sessions}</code></div>
                <div><span>Outcomes</span><code>{item.counts.outcomes}</code></div>
              </div>
              <div className="card-foot">
                <span className="muted small">Updated {formatDate(item.sandbox.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${shortId(deleteTarget.sandbox.id)}?`}
          description="This stops the sandbox, drops its database, removes its local files, and deletes any paired runtime. This cannot be undone."
          busy={deleting}
          busyLabel="Deleting…"
          error={deleteError}
          onConfirm={deleteOne}
          onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(null); } }}
        />
      )}

      {deleteAllOpen && (
        <ConfirmDialog
          title="Delete all sandboxes?"
          description={`This deletes ${sandboxes.length} sandbox${sandboxes.length === 0 ? "" : "es"}, including paired runtimes and their databases. This cannot be undone.`}
          confirmationText="DELETE"
          confirmLabel="Delete all"
          busy={deleting}
          busyLabel="Deleting…"
          error={deleteError}
          onConfirm={deleteAll}
          onCancel={() => { if (!deleting) { setDeleteAllOpen(false); setDeleteError(null); } }}
        />
      )}

      {open && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !creating) setOpen(false); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-sandbox-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Control plane</div>
                <h2 id="create-sandbox-title">Create sandbox</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)} disabled={creating} aria-label="Close">
                <X size={17} />
              </button>
            </div>
            <form onSubmit={create}>
              <div className="modal-body">
                <label className="field">
                  <span className="field-label">Product</span>
                  <select className="select" value={product} onChange={(event) => setProduct(event.target.value as "agents" | "growth")} disabled={creating}>
                    <option value="agents">Agents</option>
                    <option value="growth">Growth</option>
                  </select>
                  <span className="field-hint">
                    {product === "growth" ? "Creates a Growth sandbox and paired Agents runtime." : "Creates one Agents sandbox."}
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">{product === "growth" ? "Business name" : "Workspace name"}</span>
                  <input
                    className="input"
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder={product === "growth" ? "Acme business" : "Acme support"}
                    autoFocus
                    disabled={creating}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Sandbox label</span>
                  <input
                    className="input"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Support experiments"
                    disabled={creating}
                  />
                  <span className="field-hint">Optional. Used only in the client.</span>
                </label>
                {formError && <ErrorBox message={formError} />}
              </div>
              <div className="modal-actions">
                <button className="button ghost" type="button" onClick={() => setOpen(false)} disabled={creating}>Cancel</button>
                <button className="button" type="submit" disabled={creating || !workspaceName.trim()}>
                  {creating ? "Creating…" : "Create sandbox"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
