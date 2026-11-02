import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiUrl } from "@/lib/server-api";
import { MoreHorizontal, Search, Download, X, Users, Phone, ArrowLeft, ChevronRight } from "@/components/ui/interface-icons";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import "./contacts-workspace.css";
import { Link } from "react-router";
import { useNavigate, useRevalidator } from "react-router";
import { useEffect, useMemo, useState } from "react";

type ContactView = {
  id: string;
  contactId: string;
  customerId: string | null;
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
    page?: number;
  };
  stats: {
    totalContacts: number;
    optedInContacts: number;
    excludedContacts: number;
    filteredTotal?: number;
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
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
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
        className="inline-block max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap text-primary underline-offset-2 hover:underline"
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

function CustomerDetailsLink({ customerId }: { customerId: string | null }) {
  if (!customerId) return null;

  return (
    <Button asChild size="sm" variant="outline">
      <Link to={`/contacts/${customerId}`}>View customer</Link>
    </Button>
  );
}

export default function ContactsManager({
  contacts,
  lists,
  searchResults,
  filters,
  stats,
}: ContactsManagerProps) {
  const navigateTo = useNavigate();
  const revalidator = useRevalidator();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [defaultOptIn, setDefaultOptIn] = useState(false);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
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
  const [view, setView] = useState<"contacts" | "lists">("contacts");
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState<"name" | "phone" | "added">("added");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [showAddContact, setShowAddContact] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [addContactError, setAddContactError] = useState("");
  const [addContactForm, setAddContactForm] = useState({ fullName: "", phone: "", listLabel: "default", location: "", tags: "", notes: "", optIn: false, consentConfirmed: false });
  const selectionScope = buildSearchParams(filters).toString();
  useEffect(() => { setCheckedIds(new Set()); }, [selectionScope]);
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [wideDetails, setWideDetails] = useState(false);
  const [searchInput, setSearchInput] = useState(filters.q);
  useEffect(() => { setSearchInput(filters.q); }, [filters.q]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const apply = () => setWideDetails(media.matches);
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
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
  const displayedContacts = useMemo(() => {
    const source = filters.q ? searchResults : contacts;
    return source.filter(contact =>
      (!filters.listLabel || contact.listLabel === filters.listLabel) &&
      (filters.optIn === "all" || !filters.optIn || contact.optIn === (filters.optIn === "true")) &&
      (filters.excluded === "all" || !filters.excluded || contact.excluded === (filters.excluded === "true")) &&
      (!filters.tag || contact.tags.some(tag => tag.toLowerCase() === filters.tag.toLowerCase())) &&
      (!filters.location || (contact.location || "").toLowerCase().includes(filters.location.toLowerCase()))
    );
  }, [contacts, searchResults, filters]);
  const pageContacts = useMemo(() => [...displayedContacts].sort((a, b) => {
    const comparison = sortField === "added"
      ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      : (sortField === "name" ? a.fullName || "" : a.phone).localeCompare(sortField === "name" ? b.fullName || "" : b.phone, undefined, { numeric: true, sensitivity: "base" });
    const directed = sortDirection === "asc" ? comparison : -comparison;
    return directed || a.id.localeCompare(b.id);
  }), [displayedContacts, sortField, sortDirection]);
  const checkedContacts = pageContacts.filter(contact => checkedIds.has(contact.id));
  const contactColumns = [
    { id: "phone", label: "Phone" }, { id: "list", label: "List" },
    { id: "location", label: "Location" }, { id: "tags", label: "Tags" },
    { id: "consent", label: "Consent" }, { id: "marketing", label: "Last marketing" },
    ...metadataColumns.map(key => ({ id: `metadata:${key}`, label: key })),
  ];
  const visibleContactColumns = contactColumns.filter(column => !hiddenColumns.has(column.id));

  const inspectedContact = allKnownContacts.find(contact => contact.id === inspectingId) || null;
  const currentPage = filters.page || 1;
  const filteredTotal = stats.filteredTotal ?? displayedContacts.length;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / 50));

  function navigate(next: Partial<ContactsManagerProps["filters"]>) {
    const params = buildSearchParams({ ...filters, ...next, page: next.page ?? 1 });
    const query = params.toString();
    navigateTo(`/contacts${query ? `?${query}` : ""}`);
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
      formData.append("consentConfirmed", consentConfirmed ? "true" : "false");
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
      setShowImportModal(false);
      navigate({
        q: "",
        location: "",
        tag: "",
        optIn: "all",
        excluded: "all",
        listLabel: importListLabel.trim() || "default",
      });
      revalidator.revalidate();
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
      revalidator.revalidate();
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
    revalidator.revalidate();
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
      setError(body.error || "Failed to remove list");
      return;
    }

    setNotice(`Removed list ${label}.`);
    setDeleteTargetLabel(null);
    navigate({ listLabel: filters.listLabel === label ? "" : filters.listLabel });
    revalidator.revalidate();
  }

  function prepareAddContacts(label: string) {
    setImportListLabel(label);
    setCsvFile(null);
    setDefaultOptIn(false);
    setConsentConfirmed(false);
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
      downloadContactFile(blob, filename);
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

  function contactCell(contact: ContactView, columnId: string) {
    switch (columnId) {
      case "phone": return contact.phone;
      case "list": return <span className="contacts-list-label">{contact.listLabel}</span>;
      case "location": return contact.location || "—";
      case "tags": return <div className="contacts-tags">{contact.tags.map(tag => <span key={tag}>{tag}</span>)}</div>;
      case "consent": return <span className={contact.excluded ? "contacts-consent is-excluded" : contact.optIn ? "contacts-consent is-opted-in" : "contacts-consent"}>{contact.excluded ? "Excluded" : contact.optIn ? "Opted in" : "Not opted in"}</span>;
      case "marketing": return contact.lastMarketingSent ? recordDate(contact.lastMarketingSent) : "Never";
      default: return renderMetadataValue(contact.metadata?.[columnId.slice("metadata:".length)]);
    }
  }

  function exportCheckedContacts() {
    const metadataKeys = [...new Set(checkedContacts.flatMap(contact => Object.keys(contact.metadata || {})))].sort();
    const rows = [["phone", "fullName", "location", "tags", "notes", "optIn", "excluded", "listLabel", ...metadataKeys],
      ...checkedContacts.map(contact => [contact.phone, contact.fullName || "", contact.location || "", contact.tags.join(", "), contact.notes || "", String(contact.optIn), String(contact.excluded), contact.listLabel, ...metadataKeys.map(key => contact.metadata?.[key] || "")])];
    downloadContactFile(new Blob([contactCsv(rows, true)], { type: "text/csv;charset=utf-8" }), "selected-contacts.csv");
    setNotice(`Exported ${checkedContacts.length} ${checkedContacts.length === 1 ? "contact" : "contacts"}.`);
  }

  async function addContact() {
    if (!addContactForm.phone.trim()) { setAddContactError("Enter a phone number."); return; }
    if (addContactForm.optIn && !addContactForm.consentConfirmed) { setAddContactError("Confirm permission to record consent."); return; }
    setAddingContact(true); setAddContactError("");
    try {
      const csv = contactCsv([["phone", "fullName", "location", "tags", "notes", "optIn"], [addContactForm.phone.trim(), addContactForm.fullName.trim(), addContactForm.location.trim(), addContactForm.tags, addContactForm.notes, String(addContactForm.optIn)]]);
      const payload = new FormData();
      payload.append("file", new File([csv], "contact.csv", { type: "text/csv" }));
      payload.append("listLabel", addContactForm.listLabel.trim() || "default");
      payload.append("defaultOptIn", "false");
      payload.append("consentConfirmed", String(addContactForm.consentConfirmed));
      const response = await fetch(apiUrl("/api/whatsapp/contacts/import"), { method: "POST", credentials: "include", body: payload });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to add contact");
      if (result.summary?.invalidRows) throw new Error(result.invalid?.[0]?.error || "Check the contact's phone number.");
      setShowAddContact(false); setNotice("Contact saved.");
      setAddContactForm({ fullName: "", phone: "", listLabel: "default", location: "", tags: "", notes: "", optIn: false, consentConfirmed: false });
      setView("contacts"); navigate({ listLabel: addContactForm.listLabel.trim() || "default", q: "", optIn: "all", excluded: "all", tag: "", location: "" });
      revalidator.revalidate();
    } catch (error) { setAddContactError(error instanceof Error ? error.message : "Failed to add contact"); }
    finally { setAddingContact(false); }
  }

  function openImport() {
    setImportListLabel(filters.listLabel || "default");
    setCsvFile(null); setDefaultOptIn(false); setConsentConfirmed(false); setShowImportModal(true);
  }

  function closeInspector() { setInspectingId(null); }

  function contactDetails(contact: ContactView) {
    return <div className="contacts-record-content">
      <div className="contacts-record-heading">
        <div className="contacts-person-avatar" data-tone={avatarTone(contact.fullName || contact.phone)}>{initials(contact.fullName, contact.phone)}</div>
        <h2>{contact.fullName || contact.phone}</h2>
        <p><Phone className="size-4" />{contact.phone}</p>
        <div className="contacts-tags">{contact.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
      </div>
      <section>
        <div className="contacts-record-section-heading"><h3>Contact details</h3><Button variant="ghost" size="sm" onClick={() => { closeInspector(); startEdit(contact); }}>Edit</Button></div>
        <dl>
          <div><dt>Full name</dt><dd>{contact.fullName || "—"}</dd></div>
          <div><dt>Phone</dt><dd>{contact.phone}</dd></div>
          <div><dt>List</dt><dd>{contact.listLabel}</dd></div>
          <div><dt>Location</dt><dd>{contact.location || "—"}</dd></div>
          <div><dt>Consent</dt><dd><span className={contact.optIn ? "contacts-consent is-opted-in" : "contacts-consent"}>{contact.optIn ? "Opted in" : "Not opted in"}</span></dd></div>
          <div><dt>Excluded</dt><dd>{contact.excluded ? "Yes" : "No"}</dd></div>
          {contact.optInSource ? <div><dt>Consent source</dt><dd>{contact.optInSource}</dd></div> : null}
          {contact.optInDate ? <div><dt>Consent recorded</dt><dd>{recordDate(contact.optInDate)}</dd></div> : null}
        </dl>
      </section>
      {Object.keys(contact.metadata || {}).length ? <section><h3>Custom fields</h3><dl>{Object.entries(contact.metadata || {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{renderMetadataValue(value)}</dd></div>)}</dl></section> : null}
      {contact.notes ? <section><h3>Notes</h3><p className="contacts-record-notes">{contact.notes}</p></section> : null}
      <section><h3>Record activity</h3><dl><div><dt>Added</dt><dd>{recordDate(contact.createdAt)}</dd></div><div><dt>Updated</dt><dd>{recordDate(contact.updatedAt)}</dd></div><div><dt>Last marketing</dt><dd>{contact.lastMarketingSent ? recordDate(contact.lastMarketingSent) : "Never"}</dd></div></dl></section>
      {contact.customerId ? <section><CustomerDetailsLink customerId={contact.customerId} /></section> : null}
    </div>;
  }

  return (
    <div className="contacts-workspace" data-record-open={Boolean(inspectedContact)}>
      <div className="contacts-main">
        <PageHeader className="contacts-page-header">
          <PageHeaderContent><PageHeaderTitle>Contacts</PageHeaderTitle></PageHeaderContent>
          <PageHeaderActions><Button variant="outline" onClick={openImport}><Download className="size-4 rotate-180" />Import contacts</Button><Button onClick={() => { setAddContactError(""); setAddContactForm(current => ({ ...current, listLabel: filters.listLabel || "default" })); setShowAddContact(true); }}>Add contact</Button></PageHeaderActions>
        </PageHeader>

        <div className="contacts-view-tabs" aria-label="Contact views">
          <button type="button" aria-current={view === "contacts" && filters.optIn === "all" && filters.excluded === "all" ? "page" : undefined} onClick={() => { setView("contacts"); navigate({ optIn: "all", excluded: "all" }); }}>All contacts <span>{stats.totalContacts}</span></button>
          <button type="button" aria-current={view === "contacts" && filters.optIn === "true" ? "page" : undefined} onClick={() => { setView("contacts"); navigate({ optIn: "true", excluded: "all" }); }}>Opted in <span>{stats.optedInContacts}</span></button>
          <button type="button" aria-current={view === "contacts" && filters.excluded === "true" ? "page" : undefined} onClick={() => { setView("contacts"); navigate({ excluded: "true", optIn: "all" }); }}>Excluded <span>{stats.excludedContacts}</span></button>
          <button type="button" aria-current={view === "lists" ? "page" : undefined} onClick={() => setView("lists")}>Lists <span>{lists.length}</span></button>
        </div>

        {(error || notice) ? <div className={`contacts-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</div> : null}
        {(importing || importProgress.phase === "done") && !showImportModal ? <ImportProgressPanel progress={importProgress} /> : null}

        <div className="contacts-toolbar">
          <form onSubmit={event => { event.preventDefault(); setView("contacts"); navigate({ q: searchInput.trim() }); }} className="contacts-search">
            <Search className="size-4" />
            <Input name="q" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Search contacts..." aria-label="Search contacts" />
            <Button type="submit" variant="ghost" size="sm">Search</Button>
          </form>
          <Select value={filters.listLabel || "all"} onValueChange={value => { setView("contacts"); navigate({ listLabel: value === "all" ? "" : value }); }}>
            <SelectTrigger aria-label="Contact list"><SelectValue placeholder="All lists" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All lists</SelectItem>{sortedLists.map(list => <SelectItem key={list.label} value={list.label}>{list.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setShowFilters(true)}>Filters</Button>
          {view === "contacts" ? <>
            <Select value={sortField} onValueChange={value => setSortField(value as typeof sortField)}><SelectTrigger aria-label="Sort current page"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="name">Name · this page</SelectItem><SelectItem value="phone">Phone · this page</SelectItem><SelectItem value="added">Added · this page</SelectItem></SelectContent></Select>
            <Button size="sm" variant="outline" aria-label={`Sort current page ${sortDirection === "asc" ? "descending" : "ascending"}`} onClick={() => setSortDirection(direction => direction === "asc" ? "desc" : "asc")}>{sortDirection === "asc" ? "Ascending" : "Descending"}</Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="outline">Columns</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuCheckboxItem checked disabled>Contact</DropdownMenuCheckboxItem>{contactColumns.map(column => <DropdownMenuCheckboxItem key={column.id} checked={!hiddenColumns.has(column.id)} onSelect={event => event.preventDefault()} onCheckedChange={checked => setHiddenColumns(current => { const next = new Set(current); if (checked) next.delete(column.id); else next.add(column.id); return next; })}>{column.label}</DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu>
          </> : null}
          <Dialog open={showFilters} onOpenChange={setShowFilters}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Contact filters</DialogTitle><DialogDescription className="sr-only">Filter contacts by consent, exclusion, tag or location.</DialogDescription></DialogHeader>
            <div className="contacts-filter-fields">
              <label>Consent<Select value={filters.optIn || "all"} onValueChange={value => navigate({ optIn: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any consent</SelectItem><SelectItem value="true">Opted in</SelectItem><SelectItem value="false">Not opted in</SelectItem></SelectContent></Select></label>
              <label>Exclusion<Select value={filters.excluded || "all"} onValueChange={value => navigate({ excluded: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any exclusion</SelectItem><SelectItem value="true">Excluded</SelectItem><SelectItem value="false">Not excluded</SelectItem></SelectContent></Select></label>
              <form onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); navigate({ tag: String(values.get("tag") || ""), location: String(values.get("location") || "") }); setShowFilters(false); }}><label>Tag<Input name="tag" defaultValue={filters.tag} /></label><label>Location<Input name="location" defaultValue={filters.location} /></label><Button type="submit" size="sm">Apply filters</Button></form>
            </div>
          </DialogContent></Dialog>
          {filters.listLabel ? <ListActionsMenu label={filters.listLabel} onAddContacts={prepareAddContacts} onDownload={downloadListCsv} onRename={openRenameModal} onDelete={openDeleteModal} /> : null}
          {(filters.q || filters.listLabel || filters.tag || filters.location || filters.optIn !== "all" || filters.excluded !== "all") ? <Button variant="ghost" size="sm" onClick={() => { setSearchInput(""); navigate({ q: "", listLabel: "", tag: "", location: "", optIn: "all", excluded: "all" }); }}>Clear filters</Button> : null}
        </div>

        {view === "contacts" && checkedContacts.length ? <div className="contacts-selection-bar" role="status"><span>{checkedContacts.length} selected on this page</span><Button size="sm" variant="outline" onClick={exportCheckedContacts}>Export selected CSV</Button><Button size="sm" variant="ghost" onClick={() => setCheckedIds(new Set())}>Clear selection</Button></div> : null}
        {view === "lists" ? <div className="contacts-table-scroll" role="region" aria-label="Contact lists table" tabIndex={0}><table className="contacts-table"><caption className="sr-only">Contact lists</caption><thead><tr><th>List</th><th>Contacts</th><th>Location</th><th>Custom fields</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{sortedLists.map(list => <tr key={list.label}><td><button className="contacts-name-button" onClick={() => { setView("contacts"); navigate({ listLabel: list.label }); }}>{list.label}</button></td><td>{list.totalContacts}</td><td>{list.primaryLocation || "—"}</td><td><div className="contacts-tags">{list.metadataKeys.map(key => <span key={key}>{key}</span>)}</div></td><td><ListActionsMenu label={list.label} onAddContacts={prepareAddContacts} onDownload={downloadListCsv} onRename={openRenameModal} onDelete={openDeleteModal} /></td></tr>)}</tbody></table>{!lists.length ? <div className="contacts-empty"><Users className="size-6" /><p>No lists yet</p><Button size="sm" onClick={openImport}>Import contacts</Button></div> : null}</div> : <>
          <div className="contacts-table-scroll" role="region" aria-label="Contacts table" tabIndex={0}>
            <table className="contacts-table"><caption className="sr-only">Contacts</caption><thead><tr><th className="contacts-checkbox-cell"><Checkbox aria-label="Select contacts on this page" disabled={!pageContacts.length} checked={checkedContacts.length === pageContacts.length && pageContacts.length > 0 ? true : checkedContacts.length ? "indeterminate" : false} onCheckedChange={checked => setCheckedIds(checked ? new Set(pageContacts.map(contact => contact.id)) : new Set())} /></th><th>Contact</th>{visibleContactColumns.map(column => <th key={column.id}>{column.label}</th>)}<th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{pageContacts.map(contact => <tr key={contact.id} data-selected={checkedIds.has(contact.id) || contact.id === inspectingId}><td className="contacts-checkbox-cell"><Checkbox aria-label={`Select contact ${contact.fullName || contact.phone}`} checked={checkedIds.has(contact.id)} onCheckedChange={checked => setCheckedIds(current => { const next = new Set(current); if (checked) next.add(contact.id); else next.delete(contact.id); return next; })} /></td><td><button type="button" className="contacts-name-button" aria-label={`View contact ${contact.fullName || contact.phone}`} onClick={() => setInspectingId(contact.id)}><span className="contacts-person-avatar" data-tone={avatarTone(contact.fullName || contact.phone)}>{initials(contact.fullName, contact.phone)}</span><span>{contact.fullName || "Unnamed contact"}</span></button></td>{visibleContactColumns.map(column => <td key={column.id}>{contactCell(contact, column.id)}</td>)}<td><Button size="sm" variant="ghost" onClick={() => startEdit(contact)}>Edit</Button></td></tr>)}</tbody>
            </table>
            {!displayedContacts.length ? <div className="contacts-empty"><Users className="size-6" /><p>{contacts.length || filters.q ? "No matching contacts" : "No contacts yet"}</p><Button size="sm" onClick={openImport}>Import contacts</Button></div> : null}
          </div>
          <footer className="contacts-table-footer"><span>{filteredTotal ? `${(currentPage - 1) * 50 + 1}–${(currentPage - 1) * 50 + displayedContacts.length} of ${filteredTotal}` : "0"} {filteredTotal === 1 ? "contact" : "contacts"}</span><nav aria-label="Contacts pagination"><Button variant="outline" size="icon-sm" aria-label="Previous contacts page" disabled={currentPage <= 1} onClick={() => navigate({ page: currentPage - 1 })}><ArrowLeft className="size-4" /></Button><span>Page {currentPage} of {pageCount}</span><Button variant="outline" size="icon-sm" aria-label="Next contacts page" disabled={currentPage >= pageCount} onClick={() => navigate({ page: currentPage + 1 })}><ChevronRight className="size-4" /></Button></nav></footer>
        </>}

        {inspectedContact && wideDetails ? <aside className="contacts-record-panel" aria-label="Contact details"><Button variant="ghost" size="icon" aria-label="Close contact details" className="contacts-record-close" onClick={closeInspector}><X className="size-4" /></Button>{contactDetails(inspectedContact)}</aside> : null}
        <Sheet open={Boolean(inspectedContact && !wideDetails)} onOpenChange={open => { if (!open) closeInspector(); }}><SheetContent className="contacts-record-sheet w-[min(360px,100vw)] overflow-y-auto p-0"><SheetHeader className="sr-only"><SheetTitle>Contact details</SheetTitle><SheetDescription>Contact record and consent</SheetDescription></SheetHeader>{inspectedContact ? contactDetails(inspectedContact) : null}</SheetContent></Sheet>
        <Dialog open={Boolean(selectedContact && form)} onOpenChange={open => { if (!open && !savingId) { setEditingId(null); setForm(null); } }}>
          <DialogContent className="contacts-edit-dialog max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          {selectedContact && form ? <div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <DialogTitle>Edit contact</DialogTitle>
                <DialogDescription>{selectedContact.phone}</DialogDescription>
              </div>
              <Button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(null);
                }}
                size="sm"
                disabled={Boolean(savingId)}
                variant="outline"
              >
                Close
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">Full name</span>
                <Input
                  value={form.fullName}
                  onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">Phone</span>
                <Input
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">List label</span>
                <Input
                  list="contact-list-labels"
                  value={form.listLabel}
                  onChange={(event) => setForm({ ...form, listLabel: event.target.value })}
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-muted-foreground">Location</span>
                <Input
                  value={form.location}
                  onChange={(event) => setForm({ ...form, location: event.target.value })}
                />
              </label>

              <label className="space-y-2 text-sm md:col-span-2">
                <span className="text-muted-foreground">Tags</span>
                <Input
                  value={form.tags}
                  onChange={(event) => setForm({ ...form, tags: event.target.value })}
                  placeholder="vip, johannesburg, retail"
                />
              </label>
            </div>

            <label className="mt-4 block space-y-2 text-sm">
              <span className="text-muted-foreground">Notes</span>
              <Textarea
                rows={3}
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </label>

            <div className="mt-4 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={form.optIn}
                  onCheckedChange={(checked) => setForm({ ...form, optIn: checked === true })}
                />
                Opted in
              </label>

              <label className="flex items-center gap-2">
                <Checkbox
                  checked={form.excluded}
                  onCheckedChange={(checked) => setForm({ ...form, excluded: checked === true })}
                />
                Excluded
              </label>
            </div>

            <div className="mt-5 flex justify-end">
              <Button
                type="button"
                onClick={saveEdit}
                disabled={savingId === selectedContact.id}
              >
                {savingId === selectedContact.id ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </div> : null}
          </DialogContent>
        </Dialog>

        <Dialog open={showAddContact} onOpenChange={open => { if (!addingContact) setShowAddContact(open); }}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader><DialogTitle>Add contact</DialogTitle><DialogDescription>An existing phone number updates its contact.</DialogDescription></DialogHeader>
            <form onSubmit={event => { event.preventDefault(); void addContact(); }} className="contacts-add-form" noValidate>
              <label>Full name<Input value={addContactForm.fullName} onChange={event => setAddContactForm(current => ({ ...current, fullName: event.target.value }))} /></label>
              <label>Phone<Input type="tel" aria-invalid={Boolean(addContactError)} value={addContactForm.phone} onChange={event => setAddContactForm(current => ({ ...current, phone: event.target.value }))} />{addContactError ? <span role="alert" className="text-destructive">{addContactError}</span> : null}</label>
              <label>List<Input value={addContactForm.listLabel} onChange={event => setAddContactForm(current => ({ ...current, listLabel: event.target.value }))} /></label>
              <label>Location<Input value={addContactForm.location} onChange={event => setAddContactForm(current => ({ ...current, location: event.target.value }))} /></label>
              <label>Tags<Input value={addContactForm.tags} onChange={event => setAddContactForm(current => ({ ...current, tags: event.target.value }))} /></label>
              <label className="contacts-add-notes">Notes<Textarea rows={2} value={addContactForm.notes} onChange={event => setAddContactForm(current => ({ ...current, notes: event.target.value }))} /></label>
              <label className="contacts-add-consent"><Checkbox checked={addContactForm.optIn} onCheckedChange={checked => setAddContactForm(current => ({ ...current, optIn: checked === true }))} />Opted in to marketing</label>
              {addContactForm.optIn ? <label className="contacts-add-consent"><Checkbox checked={addContactForm.consentConfirmed} onCheckedChange={checked => setAddContactForm(current => ({ ...current, consentConfirmed: checked === true }))} />I have permission to record this marketing consent.</label> : null}
              <DialogFooter className="contacts-add-footer"><Button type="button" variant="outline" disabled={addingContact} onClick={() => setShowAddContact(false)}>Cancel</Button><Button type="submit" disabled={addingContact || (addContactForm.optIn && !addContactForm.consentConfirmed)}>{addingContact ? "Saving..." : "Save contact"}</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog open={showImportModal} onOpenChange={setShowImportModal}>
          <DialogContent className="max-h-[calc(100svh-2rem)] max-w-2xl overflow-y-auto">
              <div className="flex items-start justify-between gap-4">
                <DialogHeader>
                  <DialogTitle>Create or import contacts</DialogTitle>
                  <DialogDescription>
                    Import a CSV into <span className="font-semibold text-foreground">{importListLabel || "default"}</span>.
                    Use a new label to create a new list, or pick an existing one to add more contacts.
                  </DialogDescription>
                </DialogHeader>
              </div>

              <div className="mt-5 grid gap-4">
                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">Target list</span>
                  <Input
                    list="contact-list-labels"
                    value={importListLabel}
                    onChange={(event) => setImportListLabel(event.target.value)}
                    placeholder="websites-reachout"
                  />
                </label>

                <datalist id="contact-list-labels">
                  {lists.map((list) => (
                    <option key={list.label} value={list.label} />
                  ))}
                </datalist>

                <label className="space-y-2 text-sm">
                  <span className="text-muted-foreground">CSV file</span>
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => setCsvFile(event.target.files?.[0] || null)}
                  />
                </label>

                <label className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-3 text-sm text-muted-foreground">
                  <Checkbox
                    checked={defaultOptIn}
                    onCheckedChange={(checked) => setDefaultOptIn(checked === true)}
                  />
                  Default imported contacts to opted-in
                </label>

                <label className="flex items-start gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-3 text-sm text-muted-foreground">
                  <Checkbox
                    checked={consentConfirmed}
                    onCheckedChange={(checked) => setConsentConfirmed(checked === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I confirm that I have permission to record marketing consent for every opted-in row in this CSV. Re-importing does not revoke an existing opt-in.
                  </span>
                </label>
              </div>
              {importing || importProgress.phase === "done" ? (
                <div className="mt-4">
                  <ImportProgressPanel progress={importProgress} />
                </div>
              ) : null}

              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={onImportCsv}
                  disabled={importing || (defaultOptIn && !consentConfirmed)}
                >
                  {importing ? "Importing..." : "Import into list"}
                </Button>
              </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(renamingListLabel)} onOpenChange={(open) => {
          if (!open) {
            setRenamingListLabel(null);
            setRenameValue("");
          }
        }}>
          <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Rename list</DialogTitle>
                <DialogDescription>
                  Update the label for <span className="font-semibold text-foreground">{renamingListLabel}</span>.
                </DialogDescription>
              </DialogHeader>

              <label className="mt-5 block space-y-2 text-sm">
                <span className="text-muted-foreground">New label</span>
                <Input
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
              </label>

              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  onClick={() => {
                    setRenamingListLabel(null);
                    setRenameValue("");
                  }}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => renamingListLabel && renameList(renamingListLabel, renameValue)}
                >
                  Save
                </Button>
              </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(deleteTargetLabel)} onOpenChange={(open) => !open && setDeleteTargetLabel(null)}>
          <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Remove list</DialogTitle>
                <DialogDescription>
                  Remove <span className="font-semibold text-foreground">{deleteTargetLabel}</span> and its memberships. Customer records and consent history stay intact.
                </DialogDescription>
              </DialogHeader>

              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  onClick={() => setDeleteTargetLabel(null)}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => deleteTargetLabel && deleteList(deleteTargetLabel)}
                  variant="destructive"
                >
                  Remove list
                </Button>
              </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
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
          Remove list
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function initials(name: string | null, phone: string) { return name?.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || phone.slice(-2); }
function avatarTone(value: string) { return ["blue", "rose", "green", "amber", "violet"][Array.from(value).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % 5]; }
function recordDate(value: string) { return new Date(value).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }); }

function contactCsv(rows: string[][], spreadsheetSafe = false) {
  return rows.map(row => row.map(value => {
    const literal = spreadsheetSafe && /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
    return `"${literal.replace(/"/g, '""')}"`;
  }).join(",")).join("\n") + "\n";
}
function downloadContactFile(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
