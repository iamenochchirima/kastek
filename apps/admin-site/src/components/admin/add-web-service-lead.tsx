"use client";

import { adminRequest } from "@/lib/admin-request";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function AddWebServiceLead() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    businessName: "",
    category: "",
    website: "",
    address: "",
    bizbayUrl: "",
    phone: "",
    email: "",
    notes: "",
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.businessName || !form.category) return;

    setSaving(true);
    setError(null);
    try {
    await adminRequest("/api/web-services/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setOpen(false);
    setForm({ businessName: "", category: "", website: "", address: "", bizbayUrl: "", phone: "", email: "", notes: "" });
    router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to save lead"); }
    finally { setSaving(false); }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={buttonClassName({ variant: "outline", size: "sm" })}
      >
        <Plus className="size-4" /> Add lead
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add web service lead</DialogTitle>
            <DialogDescription className="sr-only">Add a lead to the web services pipeline.</DialogDescription>
          </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-3">
              {error ? <p role="alert" className="text-sm text-status-danger">{error}</p> : null}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Business Name *</label>
                <Input
                  type="text"
                  required
                  value={form.businessName}
                  onChange={(e) => setForm({ ...form, businessName: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Category *</label>
                <Input
                  type="text"
                  required
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="e.g. Hardware, Restaurants"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Website</label>
                <Input
                  type="url"
                  value={form.website}
                  onChange={(e) => setForm({ ...form, website: e.target.value })}
                  placeholder="https://"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Address</label>
                <Input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">BizBay URL</label>
                <Input
                  type="url"
                  value={form.bizbayUrl}
                  onChange={(e) => setForm({ ...form, bizbayUrl: e.target.value })}
                  placeholder="https://bizbay.co.za/Company/..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Phone</label>
                  <Input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Email</label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
                <Textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="resize-none"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg hover:bg-secondary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !form.businessName || !form.category}
                  className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-brand-strong rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving ? "Adding..." : "Add Lead"}
                </button>
              </div>
            </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
