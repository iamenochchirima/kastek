"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { copyAdminText } from "@/lib/format";

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
    setCopied(await copyAdminText(createdKey));
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
        className={buttonClassName({ size: "sm" })}
      >
        <Plus className="size-4" /> New key
      </button>

      <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) handleClose(); }}>
        <DialogContent className="max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{createdKey ? "API key created" : "New API key"}</DialogTitle>
            <DialogDescription className="sr-only">Manage an API key for this workspace.</DialogDescription>
          </DialogHeader>
            {createdKey ? (
              <>
                <div className="rounded-md border border-status-attention/25 bg-status-attention-soft px-4 py-3">
                  <p className="mb-2 text-xs font-medium text-status-attention">
                    Copy this key now — it will not be shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all font-mono text-xs text-foreground">{createdKey}</code>
                    <button
                      onClick={copyKey}
                      className={buttonClassName({ variant: "outline", size: "sm" })}
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleClose}
                  className={buttonClassName({ className: "w-full" })}
                >
                  Done
                </button>
              </>
            ) : (
              <>
                {error && (
                  <div role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
                    {error}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-foreground">Label</label>
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      required
                      placeholder="e.g. Production, CI/CD"
                    />
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleClose}
                      className={buttonClassName({ variant: "outline", size: "md", className: "flex-1" })}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className={buttonClassName({ size: "md", className: "flex-1" })}
                    >
                      {loading ? "Creating…" : "Create Key"}
                    </button>
                  </div>
                </form>
              </>
            )}
        </DialogContent>
      </Dialog>
    </>
  );
}
