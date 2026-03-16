"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type ContactView = {
  id: string;
  phone: string;
  fullName: string | null;
  tags: string[];
  location: string | null;
  optIn: boolean;
  optInSource: string | null;
  optInDate: string | null;
  lastMarketingSent: string | null;
  excluded: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type ContactsManagerProps = {
  contacts: ContactView[];
  filters: {
    q: string;
    optIn: string;
    excluded: string;
    tag: string;
    location: string;
  };
  stats: {
    totalContacts: number;
    optedInContacts: number;
    excludedContacts: number;
  };
  tagOptions: string[];
};

type EditFormState = {
  fullName: string;
  phone: string;
  location: string;
  tags: string;
  notes: string;
  optIn: boolean;
  excluded: boolean;
};

function toEditForm(contact: ContactView): EditFormState {
  return {
    fullName: contact.fullName || "",
    phone: contact.phone,
    location: contact.location || "",
    tags: contact.tags.join(", "),
    notes: contact.notes || "",
    optIn: contact.optIn,
    excluded: contact.excluded,
  };
}

export default function ContactsManager({
  contacts,
  filters,
  stats,
  tagOptions,
}: ContactsManagerProps) {
  const router = useRouter();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [defaultOptIn, setDefaultOptIn] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditFormState | null>(null);

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === editingId) || null,
    [contacts, editingId]
  );

  async function onImportCsv() {
    if (!csvFile) {
      setError("Pick a CSV file first.");
      return;
    }

    setImporting(true);
    setError("");
    setNotice("");

    try {
      const formData = new FormData();
      formData.append("file", csvFile);
      formData.append("defaultOptIn", defaultOptIn ? "true" : "false");

      const res = await fetch("/api/whatsapp/contacts/import", {
        method: "POST",
        body: formData,
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Import failed");
      }

      setNotice(
        `Imported: ${body.summary.created} created, ${body.summary.updated} updated, ${body.summary.invalidRows} invalid rows.`
      );
      setCsvFile(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  function startEdit(contact: ContactView) {
    setEditingId(contact.id);
    setForm(toEditForm(contact));
    setError("");
    setNotice("");
  }

  async function saveEdit() {
    if (!editingId || !form) return;

    setSavingId(editingId);
    setError("");
    setNotice("");

    try {
      const res = await fetch(`/api/whatsapp/contacts/${editingId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fullName: form.fullName,
          phone: form.phone,
          location: form.location,
          tags: form.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          notes: form.notes,
          optIn: form.optIn,
          excluded: form.excluded,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to update contact");
      }

      setNotice("Contact updated.");
      setEditingId(null);
      setForm(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update contact");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight text-foreground">Contacts</h1>
          <p className="text-muted-foreground">
            Import WhatsApp recipients, manage opt-in, and keep your marketing list clean.
          </p>
        </div>

        {(error || notice) && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              error
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-green-500/30 bg-green-500/10 text-green-300"
            }`}
          >
            {error || notice}
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Total contacts" value={stats.totalContacts} />
          <StatCard label="Opted in" value={stats.optedInContacts} />
          <StatCard label="Excluded" value={stats.excludedContacts} />
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Import contacts (CSV)</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Import phone, name, tags, location, notes, and opt-in columns. Numbers are normalized to
            E.164.
          </p>

          <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setCsvFile(event.target.files?.[0] || null)}
              className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
            />

            <label className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={defaultOptIn}
                onChange={(event) => setDefaultOptIn(event.target.checked)}
              />
              Default opt-in true
            </label>

            <button
              type="button"
              onClick={onImportCsv}
              disabled={importing}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {importing ? "Importing..." : "Import CSV"}
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Search and filter</h2>
          <form className="grid gap-3 md:grid-cols-5">
            <input
              name="q"
              defaultValue={filters.q}
              placeholder="Search name, phone, tag"
              className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
            />
            <input
              name="location"
              defaultValue={filters.location}
              placeholder="Location"
              className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
            />
            <select
              name="tag"
              defaultValue={filters.tag}
              className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
            >
              <option value="">All tags</option>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
            <select
              name="optIn"
              defaultValue={filters.optIn}
              className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
            >
              <option value="all">All opt-in states</option>
              <option value="true">Opted in</option>
              <option value="false">Not opted in</option>
            </select>
            <div className="flex gap-3">
              <select
                name="excluded"
                defaultValue={filters.excluded}
                className="min-w-0 flex-1 rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
              >
                <option value="all">All exclusion states</option>
                <option value="false">Active only</option>
                <option value="true">Excluded only</option>
              </select>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                Apply
              </button>
            </div>
          </form>
        </section>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">Recipients ({contacts.length})</h2>
          </div>

          {contacts.length === 0 ? (
            <div className="px-5 py-10 text-sm text-muted-foreground">No contacts match the current filters.</div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="px-3 py-2 text-left">Phone</th>
                    <th className="px-3 py-2 text-left">Location</th>
                    <th className="px-3 py-2 text-left">Tags</th>
                    <th className="px-3 py-2 text-left">Opt-in</th>
                    <th className="px-3 py-2 text-left">Excluded</th>
                    <th className="px-3 py-2 text-left">Last marketing</th>
                    <th className="px-3 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((contact) => (
                    <tr key={contact.id} className="border-t border-border">
                      <td className="px-3 py-2 text-foreground">{contact.fullName || "-"}</td>
                      <td className="px-3 py-2 text-foreground">{contact.phone}</td>
                      <td className="px-3 py-2 text-muted-foreground">{contact.location || "-"}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {contact.tags.length ? contact.tags.join(", ") : "-"}
                      </td>
                      <td className="px-3 py-2 text-foreground">{contact.optIn ? "Yes" : "No"}</td>
                      <td className="px-3 py-2 text-foreground">{contact.excluded ? "Yes" : "No"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {contact.lastMarketingSent
                          ? new Date(contact.lastMarketingSent).toLocaleString("en-ZA")
                          : "Never"}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => startEdit(contact)}
                          className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {selectedContact && form ? (
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Edit contact</h2>
                <p className="text-xs text-muted-foreground">{selectedContact.phone}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(null);
                }}
                className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-secondary"
              >
                Close
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">Full name</span>
                <input
                  value={form.fullName}
                  onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">Phone</span>
                <input
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">Location</span>
                <input
                  value={form.location}
                  onChange={(event) => setForm({ ...form, location: event.target.value })}
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">Tags</span>
                <input
                  value={form.tags}
                  onChange={(event) => setForm({ ...form, tags: event.target.value })}
                  placeholder="vip, johannesburg, retail"
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                />
              </label>
            </div>

            <label className="mt-4 block space-y-2 text-sm">
              <span className="text-muted-foreground">Notes</span>
              <textarea
                rows={3}
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              />
            </label>

            <div className="mt-4 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.optIn}
                  onChange={(event) => setForm({ ...form, optIn: event.target.checked })}
                />
                Opted in
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.excluded}
                  onChange={(event) => setForm({ ...form, excluded: event.target.checked })}
                />
                Excluded
              </label>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={saveEdit}
                disabled={savingId === selectedContact.id}
                className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
              >
                {savingId === selectedContact.id ? "Saving..." : "Save changes"}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}
