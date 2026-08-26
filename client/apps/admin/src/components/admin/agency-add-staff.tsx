"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

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
        <Plus className="size-4" /> Add staff
      </button>

      <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) { setOpen(false); setError(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add staff user</DialogTitle>
            <DialogDescription className="sr-only">Create an internal staff account for this workspace.</DialogDescription>
          </DialogHeader>

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
                <Select
                  name="role"
                  value={form.role}
                  onChange={handleChange}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </Select>
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
        </DialogContent>
      </Dialog>
    </>
  );
}
