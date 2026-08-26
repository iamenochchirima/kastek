"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Campaign = {
  id: string;
  name: string;
  category: string;
};

export default function AddOutreachLead({ campaigns }: { campaigns: Campaign[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    campaignId: "",
    businessName: "",
    website: "",
    address: "",
    bizbayUrl: "",
    phone: "",
    emailAddress: "",
    notes: "",
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.campaignId || !form.businessName) return;

    setSaving(true);
    await fetch(`/api/outreach/${form.campaignId}/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listings: [
          {
            name: form.businessName,
            website: form.website || null,
            address: form.address || null,
            bizbayUrl: form.bizbayUrl || null,
            phone: form.phone || null,
            email: form.emailAddress || null,
          },
        ],
      }),
    });
    setSaving(false);
    setOpen(false);
    setForm({ campaignId: "", businessName: "", website: "", address: "", bizbayUrl: "", phone: "", emailAddress: "", notes: "" });
    router.refresh();
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
            <DialogTitle>Add AI service lead</DialogTitle>
            <DialogDescription className="sr-only">Add a lead to an outreach campaign.</DialogDescription>
          </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Campaign *</label>
                <Select
                  required
                  value={form.campaignId}
                  onChange={(e) => setForm({ ...form, campaignId: e.target.value })}
                >
                  <option value="">Select a campaign...</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.category})
                    </option>
                  ))}
                </Select>
              </div>
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
                    value={form.emailAddress}
                    onChange={(e) => setForm({ ...form, emailAddress: e.target.value })}
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
                  disabled={saving || !form.businessName || !form.campaignId}
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
