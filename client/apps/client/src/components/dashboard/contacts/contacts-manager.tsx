"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiUrl } from "@/lib/server-api";
import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type ContactView = {
  id: string;
  contactId: string;
  phone: string;
  fullName: string | null;
  tags: string[];
  location: string | null;
  listLabel: string;
  metadata: Record<string, string> | null;
  optIn: boolean;
  optInSource: string | null;
  optInDate: string | null;
  lastMarketingSent: string | null;
  excluded: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type ContactListSummary = {
  label: string;
  totalContacts: number;
  primaryLocation: string | null;
  metadataKeys: string[];
};

type ContactsManagerProps = {
  contacts: ContactView[];
  lists: ContactListSummary[];
  searchResults: ContactView[];
  filters: {
    q: string;
    optIn: string;
    excluded: string;
    tag: string;
    location: string;
    listLabel: string;
  };
  stats: {
    totalContacts: number;
    optedInContacts: number;
    excludedContacts: number;
  };
};

type EditFormState = {
  fullName: string;
  phone: string;
  location: string;
  tags: string;
  notes: string;
  listLabel: string;
  optIn: boolean;
  excluded: boolean;
};

type ImportProgressState = {
  phase: "idle" | "reading" | "uploading" | "processing" | "done";
  totalRows: number;
  uploadedRows: number;
  percent: number;
};

function toEditForm(contact: ContactView): EditFormState {
  return {
    fullName: contact.fullName || "",
    phone: contact.phone,
    location: contact.location || "",
    tags: contact.tags.join(", "),
    notes: contact.notes || "",
    listLabel: contact.listLabel,
    optIn: contact.optIn,
    excluded: contact.excluded,
  };
}

function buildSearchParams(filters: ContactsManagerProps["filters"]) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.location) params.set("location", filters.location);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.optIn && filters.optIn !== "all") params.set("optIn", filters.optIn);
  if (filters.excluded && filters.excluded !== "all") params.set("excluded", filters.excluded);
  if (filters.listLabel) params.set("listLabel", filters.listLabel);
  return params;
}

function truncateValue(value: string, max = 20) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function renderMetadataValue(value: unknown) {
  if (typeof value !== "string") return "-";
  if (/^https?:\/\//i.test(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="inline-block max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap text-sky-300 underline-offset-2 hover:underline"
        title={value}
      >
        {truncateValue(value)}
      </a>
    );
  }

  return (
    <span className="inline-block max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap" title={value}>
      {truncateValue(value)}
    </span>
  );
}

function parseDownloadFilename(contentDisposition: string | null, fallbackLabel: string) {
  const match =
    contentDisposition?.match(/filename\\*=UTF-8''([^;]+)/i) ||
    contentDisposition?.match(/filename=\"?([^\";]+)\"?/i);
  if (!match?.[1]) return `${fallbackLabel}.csv`;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export default function ContactsManager({
  contacts,
  lists,
  searchResults,
  filters,
  stats,
}: ContactsManagerProps) {
  const router = useRouter();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [defaultOptIn, setDefaultOptIn] = useState(true);
  const [importListLabel, setImportListLabel] = useState(filters.listLabel || "default");
  const [importing, setImporting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgressState>({
    phase: "idle",
    totalRows: 0,
    uploadedRows: 0,
    percent: 0,
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditFormState | null>(null);
  const [renamingListLabel, setRenamingListLabel] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTargetLabel, setDeleteTargetLabel] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");
  const allKnownContacts = useMemo(() => {
    const byId = new Map<string, ContactView>();
    for (const contact of contacts) {
      byId.set(contact.id, contact);
    }
    for (const contact of searchResults) {
      if (!byId.has(contact.id)) {
        byId.set(contact.id, contact);
      }
    }
    return [...byId.values()];
  }, [contacts, searchResults]);

  const selectedContact = useMemo(
    () => allKnownContacts.find((contact) => contact.id === editingId) || null,
    [allKnownContacts, editingId],
  );

  const activeList = useMemo(
    () => lists.find((list) => list.label === filters.listLabel) || null,
    [filters.listLabel, lists],
  );

  const sortedLists = useMemo(() => [...lists].sort((a, b) => a.label.localeCompare(b.label)), [lists]);
  const metadataColumns = useMemo(() => activeList?.metadataKeys || [], [activeList]);
  const filteredListContacts = useMemo(() => {
    const normalizedQuery = listSearch.trim().toLowerCase();
    if (!normalizedQuery) return contacts;

    return contacts.filter((contact) => {
      const metadataValues = Object.values(contact.metadata || {});
      return [
        contact.fullName || "",
        contact.phone,
        contact.location || "",
        contact.tags.join(" "),
        ...metadataValues,
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [contacts, listSearch]);

  useEffect(() => {
    setListSearch("");
  }, [filters.listLabel]);

  function navigate(next: Partial<ContactsManagerProps["filters"]>) {
    const params = buildSearchParams({ ...filters, ...next });
    const query = params.toString();
    router.push(`/contacts${query ? `?${query}` : ""}`);
  }

  async function estimateCsvRows(file: File) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return Math.max(lines.length - 1, 0);
  }

  async function onImportCsv() {
    if (!csvFile) {
      setError("Pick a CSV file first.");
      return;
    }

    setImporting(true);
    setError("");
    setNotice("");
    setImportProgress({
      phase: "reading",
      totalRows: 0,
      uploadedRows: 0,
      percent: 0,
    });

    try {
      const estimatedRows = await estimateCsvRows(csvFile);
      const formData = new FormData();
      formData.append("file", csvFile);
      formData.append("defaultOptIn", defaultOptIn ? "true" : "false");
      formData.append("listLabel", importListLabel.trim() || "default");
      setImportProgress({
        phase: "uploading",
        totalRows: estimatedRows,
        uploadedRows: 0,
        percent: 0,
      });

      const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", apiUrl("/api/whatsapp/contacts/import"));
        request.withCredentials = true;

        request.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const rawPercent = Math.max(0, Math.min(100, (event.loaded / event.total) * 100));
          const percent = Math.min(94, Math.round(rawPercent));
          const uploadedRows = estimatedRows > 0 ? Math.min(estimatedRows, Math.round((percent / 100) * estimatedRows)) : 0;
          setImportProgress({
            phase: "uploading",
            totalRows: estimatedRows,
            uploadedRows,
            percent,
          });
        };

        request.onload = () => {
          let payload: Record<string, unknown> = {};
          try {
            payload = request.responseText ? JSON.parse(request.responseText) : {};
          } catch {
            payload = {};
          }

          if (request.status >= 200 && request.status < 300) {
            setImportProgress({
              phase: "done",
              totalRows: estimatedRows,
              uploadedRows: estimatedRows,
              percent: 100,
            });
            resolve(payload);
            return;
          }

          reject(new Error((payload.error as string) || "Import failed"));
        };

        request.onerror = () => reject(new Error("Import failed"));
        request.onloadstart = () => {
          setImportProgress({
            phase: "uploading",
            totalRows: estimatedRows,
            uploadedRows: 0,
            percent: 1,
          });
        };
        request.onreadystatechange = () => {
          if (request.readyState === XMLHttpRequest.HEADERS_RECEIVED || request.readyState === XMLHttpRequest.LOADING) {
            setImportProgress((current) => ({
              phase: "processing",
              totalRows: estimatedRows,
              uploadedRows: current.uploadedRows || estimatedRows,
              percent: Math.max(current.percent, 95),
            }));
          }
        };

        request.send(formData);
      });

      setNotice(
        `Imported into ${importListLabel || "default"}: ${(body.summary as { created?: number }).created ?? 0} created, ${(body.summary as { updated?: number }).updated ?? 0} updated, ${(body.summary as { invalidRows?: number }).invalidRows ?? 0} invalid rows.`,
      );
      setCsvFile(null);
      setListSearch("");
      setShowImportModal(false);
      navigate({
        q: "",
        location: "",
        tag: "",
        optIn: "all",
        excluded: "all",
        listLabel: importListLabel.trim() || "default",
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setImportProgress({
        phase: "idle",
        totalRows: 0,
        uploadedRows: 0,
        percent: 0,
      });
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
      const res = await fetch(apiUrl(`/api/whatsapp/contacts/${editingId}`), {
        method: "PATCH",
        credentials: "include",
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
          listLabel: form.listLabel,
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

  async function renameList(label: string, nextLabel: string) {
    const normalizedNextLabel = nextLabel.trim();
    if (!normalizedNextLabel || normalizedNextLabel === label) {
      setRenamingListLabel(null);
      return;
    }

    setError("");
    setNotice("");
    const res = await fetch(apiUrl(`/api/whatsapp/contacts/lists/${encodeURIComponent(label)}`), {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nextLabel: normalizedNextLabel }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || "Failed to rename list");
      return;
    }

    const normalizedLabel = body.label || normalizedNextLabel;
    setNotice(`Renamed list to ${normalizedLabel}.`);
    setRenamingListLabel(null);
    setRenameValue("");
    navigate({ listLabel: filters.listLabel === label ? normalizedLabel : filters.listLabel });
    router.refresh();
  }

  async function deleteList(label: string) {
    setError("");
    setNotice("");
    const res = await fetch(apiUrl(`/api/whatsapp/contacts/lists/${encodeURIComponent(label)}`), {
      method: "DELETE",
      credentials: "include",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || "Failed to delete list");
      return;
    }

    setNotice(`Deleted list ${label}.`);
    setDeleteTargetLabel(null);
    navigate({ listLabel: filters.listLabel === label ? "" : filters.listLabel });
    router.refresh();
  }

  function prepareAddContacts(label: string) {
    setImportListLabel(label);
    setCsvFile(null);
    setShowImportModal(true);
  }

  async function downloadListCsv(label: string) {
    setError("");
    setNotice("");

    try {
      const response = await fetch(apiUrl(`/api/whatsapp/contacts/lists/${encodeURIComponent(label)}/export`), {
        credentials: "include",
      });

      if (!response.ok) {
        let message = "Failed to download contacts CSV";
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // Ignore malformed error bodies and use the fallback message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const filename = parseDownloadFilename(response.headers.get("content-disposition"), label);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setNotice(`Downloaded ${filename}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download contacts CSV");
    }
  }

  function openRenameModal(label: string) {
    setRenamingListLabel(label);
    setRenameValue(label);
  }

  function openDeleteModal(label: string) {
    setDeleteTargetLabel(label);
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Contacts</h1>
          <p className="text-muted-foreground">
            Manage named contact lists, upload CSVs with arbitrary fields, and keep campaign targeting clean.
          </p>
        </div>

        {(error || notice) && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              error
                ? "border-destructive/30 bg-status-danger-soft text-destructive"
                : "border-status-success/30 bg-status-success-soft text-status-success"
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
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Contact lists</h2>
              <p className="text-sm text-muted-foreground">
                Search lists quickly, then open one to work with its contacts and custom fields.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const formData = new FormData(event.currentTarget);
                  navigate({
                    q: String(formData.get("q") || ""),
                    listLabel: "",
                    location: "",
                    tag: "",
                    optIn: "all",
                    excluded: "all",
                  });
                }}
                className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
              >
                <input
                  name="q"
                  defaultValue={filters.q}
                  placeholder="Search list, phone, name, field"
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground sm:w-[360px]"
                />
                <button
                  type="submit"
                  className="rounded-lg border border-border bg-secondary/50 px-4 py-2 text-sm font-medium text-foreground"
                >
                  Search
                </button>
              </form>
              <button
                type="button"
                onClick={() => {
                  setImportListLabel(filters.listLabel || "default");
                  setCsvFile(null);
                  setShowImportModal(true);
                }}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Create
              </button>
            </div>
          </div>
          {(importing || importProgress.phase === "done") && !showImportModal ? (
            <ImportProgressPanel progress={importProgress} />
          ) : null}
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-foreground">Contact lists</h2>
            <p className="text-sm text-muted-foreground">
              Open a list to see its contacts with the fields for that list format.
            </p>
          </div>
          {lists.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-sm text-muted-foreground">
              No contact lists yet. Use <span className="font-medium text-foreground">Create</span> to import your first one.
            </div>
          ) : (
            <>
            <div className="space-y-3 md:hidden">
              {sortedLists.map((list) => (
                <button
                  key={list.label}
                  type="button"
                  onClick={() => navigate({ listLabel: list.label })}
                  className="w-full rounded-xl border border-border bg-secondary/30 p-4 text-left transition-colors hover:bg-secondary/45"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-foreground">{list.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {list.primaryLocation || "No shared location"}
                      </div>
                    </div>
                    <div className="rounded-full border border-border bg-background/40 px-2.5 py-1 text-xs font-medium text-foreground">
                      {list.totalContacts}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {list.metadataKeys.length > 0 ? (
                      list.metadataKeys.map((key) => (
                        <span
                          key={key}
                          className="rounded-full border border-border bg-background/40 px-2.5 py-1 text-xs text-muted-foreground"
                        >
                          {key}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">No extra fields</span>
                    )}
                  </div>
                  <div className="mt-4 flex justify-end">
                    <ListActionsMenu
                      label={list.label}
                      onAddContacts={prepareAddContacts}
                      onDownload={downloadListCsv}
                      onRename={openRenameModal}
                      onDelete={openDeleteModal}
                    />
                  </div>
                </button>
              ))}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left">List</th>
                    <th className="px-4 py-3 text-left">Contacts</th>
                    <th className="px-4 py-3 text-left">Primary location</th>
                    <th className="px-4 py-3 text-left">Fields</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLists.map((list) => (
                    <tr
                      key={list.label}
                      onClick={() => navigate({ listLabel: list.label })}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-secondary/60"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{list.label}</div>
                        <div className="mt-1 text-xs text-muted-foreground">Open list</div>
                      </td>
                      <td className="px-4 py-3 text-foreground">{list.totalContacts}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {list.primaryLocation || "No shared location"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <div className="flex flex-wrap gap-2">
                          {list.metadataKeys.length > 0 ? (
                            list.metadataKeys.map((key) => (
                              <span
                                key={key}
                                className="rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs"
                              >
                                {key}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs">No extra fields</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <ListActionsMenu
                            label={list.label}
                            onAddContacts={prepareAddContacts}
                            onDownload={downloadListCsv}
                            onRename={openRenameModal}
                            onDelete={openDeleteModal}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
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
                className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
              >
                Close
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
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
                <span className="text-muted-foreground">List label</span>
                <input
                  list="contact-list-labels"
                  value={form.listLabel}
                  onChange={(event) => setForm({ ...form, listLabel: event.target.value })}
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

              <label className="space-y-2 text-sm md:col-span-2">
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

        {showImportModal ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/70 px-4 py-8">
            <div className="w-full max-w-2xl rounded-2xl border border-border bg-background p-4 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold text-foreground">Create or import contacts</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Import a CSV into <span className="font-semibold text-foreground">{importListLabel || "default"}</span>.
                    Use a new label to create a new list, or pick an existing one to add more contacts.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
                >
                  Close
                </button>
              </div>

              <div className="mt-5 grid gap-4">
                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Target list</span>
                  <input
                    list="contact-list-labels"
                    value={importListLabel}
                    onChange={(event) => setImportListLabel(event.target.value)}
                    placeholder="websites-reachout"
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                  />
                </label>

                <datalist id="contact-list-labels">
                  {lists.map((list) => (
                    <option key={list.label} value={list.label} />
                  ))}
                </datalist>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">CSV file</span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => setCsvFile(event.target.files?.[0] || null)}
                    className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
                  />
                </label>

                <label className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-3 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={defaultOptIn}
                    onChange={(event) => setDefaultOptIn(event.target.checked)}
                  />
                  Default imported contacts to opted-in
                </label>
              </div>
              {importing || importProgress.phase === "done" ? (
                <div className="mt-4">
                  <ImportProgressPanel progress={importProgress} />
                </div>
              ) : null}

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="rounded-lg border border-border bg-secondary/50 px-4 py-2 text-sm text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onImportCsv}
                  disabled={importing}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {importing ? "Importing..." : "Import into list"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {filters.q ? (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/70 px-4 py-6">
            <div className="flex h-[min(84vh,860px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
                <div>
                  <h2 className="text-2xl font-semibold text-foreground">Search results</h2>
                  <p className="text-sm text-muted-foreground">
                    Results for <span className="font-semibold text-foreground">{filters.q}</span>.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate({ q: "" })}
                  className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
                >
                  Close
                </button>
              </div>

              {searchResults.length === 0 ? (
                <div className="px-6 py-10 text-sm text-muted-foreground">No contacts matched that search.</div>
              ) : (
                <div className="flex-1 overflow-auto">
                  <div className="space-y-3 p-4 md:hidden">
                    {searchResults.map((contact) => (
                      <div key={contact.id} className="rounded-xl border border-border bg-secondary/20 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-foreground">{contact.fullName || "-"}</div>
                            <div className="mt-1 text-sm text-foreground">{contact.phone}</div>
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            <div>{contact.listLabel}</div>
                            <div className="mt-1">{contact.location || "-"}</div>
                          </div>
                        </div>
                        <div className="mt-3 text-xs text-muted-foreground">
                          {contact.tags.length ? contact.tags.join(", ") : "No tags"}
                        </div>
                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => navigate({ q: "", listLabel: contact.listLabel })}
                            className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
                          >
                            Open list
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(contact)}
                            className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-secondary/80 text-muted-foreground backdrop-blur">
                      <tr>
                        <th className="px-4 py-3 text-left">Name</th>
                        <th className="px-4 py-3 text-left">Phone</th>
                        <th className="px-4 py-3 text-left">List</th>
                        <th className="px-4 py-3 text-left">Location</th>
                        <th className="px-4 py-3 text-left">Tags</th>
                        <th className="px-4 py-3 text-left">Last marketing</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchResults.map((contact) => (
                        <tr key={contact.id} className="border-t border-border">
                          <td className="px-4 py-3 text-foreground">{contact.fullName || "-"}</td>
                          <td className="px-4 py-3 text-foreground">{contact.phone}</td>
                          <td className="px-4 py-3 text-foreground">{contact.listLabel}</td>
                          <td className="px-4 py-3 text-muted-foreground">{contact.location || "-"}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {contact.tags.length ? contact.tags.join(", ") : "-"}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {contact.lastMarketingSent
                              ? new Date(contact.lastMarketingSent).toLocaleString("en-ZA")
                              : "Never"}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => navigate({ q: "", listLabel: contact.listLabel })}
                                className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
                              >
                                Open list
                              </button>
                              <button
                                type="button"
                                onClick={() => startEdit(contact)}
                                className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
                              >
                                Edit
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {filters.listLabel && !filters.q ? (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/70 px-4 py-6">
            <div className="flex h-[min(88vh,920px)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
                <div>
                  <h2 className="text-2xl font-semibold text-foreground">
                    {filters.listLabel} ({contacts.length})
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Viewing one contact list with its own field layout.
                  </p>
                  <div className="mt-4 flex flex-wrap items-end gap-3">
                    <label className="w-full space-y-2 text-sm sm:max-w-[280px]">
                      <span className="block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Switch list
                      </span>
                      <select
                        value={filters.listLabel}
                        onChange={(event) => navigate({ listLabel: event.target.value })}
                        className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
                      >
                        <option value="">All contact lists</option>
                        {sortedLists.map((list) => (
                          <option key={list.label} value={list.label}>
                            {list.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {activeList ? (
                      <p className="pb-2 text-xs text-muted-foreground">
                        {activeList.totalContacts} contacts in this list
                      </p>
                    ) : null}
                    <label className="w-full space-y-2 text-sm sm:max-w-[320px]">
                      <span className="block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Search this list
                      </span>
                      <input
                        value={listSearch}
                        onChange={(event) => setListSearch(event.target.value)}
                        placeholder="Search name, phone, tag, field"
                        className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
                      />
                    </label>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ListActionsMenu
                    label={filters.listLabel}
                    onAddContacts={prepareAddContacts}
                    onDownload={downloadListCsv}
                    onRename={openRenameModal}
                    onDelete={openDeleteModal}
                  />
                  <button
                    type="button"
                    onClick={() => navigate({ listLabel: "" })}
                    className="rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-foreground"
                  >
                    Close
                  </button>
                </div>
              </div>

              {filteredListContacts.length === 0 ? (
                <div className="px-6 py-10 text-sm text-muted-foreground">
                  No contacts match this list search.
                </div>
              ) : (
                <div className="flex-1 overflow-auto">
                  <div className="space-y-3 p-4 md:hidden">
                    {filteredListContacts.map((contact) => (
                      <div key={contact.id} className="rounded-xl border border-border bg-secondary/20 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-foreground">{contact.fullName || "-"}</div>
                            <div className="mt-1 text-sm text-foreground">{contact.phone}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{contact.location || "-"}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => startEdit(contact)}
                            className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-foreground"
                          >
                            Edit
                          </button>
                        </div>
                        {metadataColumns.length > 0 ? (
                          <div className="mt-3 grid gap-2">
                            {metadataColumns.map((key) => (
                              <div key={key} className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">{key}: </span>
                                {typeof contact.metadata?.[key] === "string" ? contact.metadata[key] : "-"}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-3 text-xs text-muted-foreground">
                          Tags: {contact.tags.length ? contact.tags.join(", ") : "-"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Excluded: {contact.excluded ? "Yes" : "No"}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-secondary/80 text-muted-foreground backdrop-blur">
                      <tr>
                        <th className="px-4 py-3 text-left">Name</th>
                        <th className="px-4 py-3 text-left">Phone</th>
                        <th className="px-4 py-3 text-left">Location</th>
                        {metadataColumns.map((key) => (
                          <th key={key} className="px-4 py-3 text-left">
                            {key}
                          </th>
                        ))}
                        <th className="px-4 py-3 text-left">Tags</th>
                        <th className="px-4 py-3 text-left">Excluded</th>
                        <th className="px-4 py-3 text-left">Last marketing</th>
                        <th className="px-4 py-3 text-left">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredListContacts.map((contact) => (
                        <tr key={contact.id} className="border-t border-border">
                          <td className="px-4 py-3 text-foreground">{contact.fullName || "-"}</td>
                          <td className="px-4 py-3 text-foreground">{contact.phone}</td>
                          <td className="px-4 py-3 text-muted-foreground">{contact.location || "-"}</td>
                          {metadataColumns.map((key) => (
                            <td key={key} className="px-4 py-3 text-muted-foreground">
                              {renderMetadataValue(contact.metadata?.[key])}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-muted-foreground">
                            {contact.tags.length ? contact.tags.join(", ") : "-"}
                          </td>
                          <td className="px-4 py-3 text-foreground">{contact.excluded ? "Yes" : "No"}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {contact.lastMarketingSent
                              ? new Date(contact.lastMarketingSent).toLocaleString("en-ZA")
                              : "Never"}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              onClick={() => startEdit(contact)}
                              className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-foreground"
                            >
                              Edit
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {renamingListLabel ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/70 px-4 py-8">
            <div className="w-full max-w-md rounded-2xl border border-border bg-background p-6">
              <div>
                <h2 className="text-xl font-semibold text-foreground">Rename list</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Update the label for <span className="font-semibold text-foreground">{renamingListLabel}</span>.
                </p>
              </div>

              <label className="mt-5 block space-y-2 text-sm">
                <span className="text-muted-foreground">New label</span>
                <input
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                />
              </label>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setRenamingListLabel(null);
                    setRenameValue("");
                  }}
                  className="rounded-lg border border-border bg-secondary/50 px-4 py-2 text-sm text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => renameList(renamingListLabel, renameValue)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {deleteTargetLabel ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/70 px-4 py-8">
            <div className="w-full max-w-md rounded-2xl border border-border bg-background p-6">
              <div>
                <h2 className="text-xl font-semibold text-foreground">Delete list</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Delete <span className="font-semibold text-foreground">{deleteTargetLabel}</span> and its contacts. This cannot be undone.
                </p>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDeleteTargetLabel(null)}
                  className="rounded-lg border border-border bg-secondary/50 px-4 py-2 text-sm text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => deleteList(deleteTargetLabel)}
                  className="rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground hover:opacity-90"
                >
                  Delete list
                </button>
              </div>
            </div>
          </div>
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

function ImportProgressPanel({ progress }: { progress: ImportProgressState }) {
  const label =
    progress.phase === "reading"
      ? "Reading CSV..."
      : progress.phase === "uploading"
        ? "Uploading contacts..."
        : progress.phase === "processing"
          ? "Processing imported contacts..."
          : progress.phase === "done"
            ? "Import complete."
            : "";

  return (
    <div className="mt-4 rounded-xl border border-border bg-secondary/20 p-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{progress.percent}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${Math.max(2, progress.percent)}%` }}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>Estimated rows: {progress.totalRows}</span>
        <span>Rows uploaded: {progress.uploadedRows}</span>
        <span>
          Status:{" "}
          {progress.phase === "processing"
            ? "Server is finalizing the import"
            : progress.phase === "done"
              ? "Completed"
              : "In progress"}
        </span>
      </div>
    </div>
  );
}

function ListActionsMenu({
  label,
  onAddContacts,
  onDownload,
  onRename,
  onDelete,
}: {
  label: string;
  onAddContacts: (label: string) => void;
  onDownload: (label: string) => void;
  onRename: (label: string) => void;
  onDelete: (label: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Open actions for ${label}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-secondary/50 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => onAddContacts(label)}>Add contacts</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDownload(label)}>Download CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onRename(label)}>Rename</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDelete(label)} className="text-destructive focus:text-destructive">
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
