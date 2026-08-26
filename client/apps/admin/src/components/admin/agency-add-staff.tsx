"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function AgencyAddStaff({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ email: "", password: "", role: "admin" });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await fetch(`/api/agencies/${workspaceId}/staff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to add staff user");
      setLoading(false);
      return;
    }
    setOpen(false);
    setForm({ email: "", password: "", role: "admin" });
    router.refresh();
    setLoading(false);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={buttonClassName({ size: "sm" })}
      >
        + Add Staff
      </button>

      {open && (
        <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-overlay/70 p-4 backdrop-blur-sm" role="presentation">
          <div role="dialog" aria-modal="true" className="v-card w-full max-w-md space-y-4 p-[var(--density-card-padding)]">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Add staff user</h2>

            {error && (
              <div role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Email</label>
                <Input
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={handleChange}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Password</label>
                <Input
                  name="password"
                  type="password"
                  value={form.password}
                  onChange={handleChange}
                  required
                  minLength={8}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Role</label>
                <select
                  name="role"
                  value={form.role}
                  onChange={handleChange}
                  className="h-[var(--density-control-height)] w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setOpen(false); setError(""); }}
                  className={buttonClassName({ variant: "outline", className: "flex-1" })}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className={buttonClassName({ className: "flex-1" })}
                >
                  {loading ? "Adding…" : "Add Staff"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
