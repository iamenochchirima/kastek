"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AgencyAddApiKey({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await fetch(`/api/agencies/${workspaceId}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create API key");
      setLoading(false);
      return;
    }
    const data = await res.json();
    setCreatedKey(data.key ?? data.apiKey ?? null);
    router.refresh();
    setLoading(false);
  }

  async function copyKey() {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setOpen(false);
    setLabel("");
    setCreatedKey(null);
    setCopied(false);
    setError("");
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary hover:bg-primary-dark text-white transition-colors"
      >
        + New Key
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface-raised border border-border rounded-xl p-6 w-full max-w-md space-y-4 shadow-xl">
            {createdKey ? (
              <>
                <h2 className="text-lg font-semibold text-text">API Key Created</h2>
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
                  <p className="text-xs text-amber-400 font-medium mb-2">
                    Copy this key now — it will not be shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono text-text break-all">{createdKey}</code>
                    <button
                      onClick={copyKey}
                      className="shrink-0 px-2.5 py-1 rounded text-xs font-medium border border-border text-text-muted hover:text-text transition-colors"
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleClose}
                  className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-primary hover:bg-primary-dark text-white transition-colors"
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-text">New API Key</h2>

                {error && (
                  <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg border border-danger/20">
                    {error}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-1">Label</label>
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      required
                      placeholder="e.g. Production, CI/CD"
                      className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="flex-1 px-4 py-2 rounded-lg text-sm font-medium border border-border text-text-muted hover:text-text transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-primary hover:bg-primary-dark text-white transition-colors disabled:opacity-50"
                    >
                      {loading ? "Creating…" : "Create Key"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
