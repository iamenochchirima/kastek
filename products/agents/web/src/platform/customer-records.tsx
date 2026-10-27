import "./customer-workspace.css";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ApiError, message, readStored, writeStored } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import {
  customerRecordsApi,
  type Contact,
  type CustomerEnquiry,
  type CustomerFields,
  type CustomerMember,
} from "./customer-records-api";
const statusLabels = {
  new: "New",
  in_progress: "In progress",
  waiting_on_customer: "Waiting on customer",
  closed: "Closed",
};
const fieldNames = ["name", "email", "phone", "service", "message"] as const;
const label = (value: string) =>
  value.replaceAll("_", " ").replaceAll("-", " ");
const date = (value: string) => new Date(value).toLocaleString();
function FieldList({ fields }: { fields: CustomerFields }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {fieldNames
        .filter((key) => fields[key])
        .map((key) => (
          <div key={key} className={key === "message" ? "sm:col-span-2" : ""}>
            <dt className="text-xs capitalize text-muted-foreground">{key}</dt>
            <dd className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
              {fields[key]}
            </dd>
          </div>
        ))}
    </dl>
  );
}
function FieldsEditor({
  fields,
  setFields,
  contact = false,
}: {
  fields: CustomerFields;
  setFields: (fields: CustomerFields) => void;
  contact?: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fieldNames
        .filter((key) => !contact || ["name", "email", "phone"].includes(key))
        .map((key) => (
          <label
            key={key}
            className={`block space-y-2 text-sm capitalize ${key === "message" ? "sm:col-span-2" : ""}`}
          >
            {key[0].toUpperCase() + key.slice(1)}
            {key === "message" ? (
              <Textarea
                maxLength={4000}
                value={fields[key] ?? ""}
                onChange={(event) =>
                  setFields({ ...fields, [key]: event.target.value })
                }
              />
            ) : (
              <Input
                type={
                  key === "email" ? "email" : key === "phone" ? "tel" : "text"
                }
                maxLength={
                  key === "name"
                    ? 200
                    : key === "phone"
                      ? 80
                      : key === "service"
                        ? 500
                        : 320
                }
                value={fields[key] ?? ""}
                onChange={(event) =>
                  setFields({ ...fields, [key]: event.target.value })
                }
              />
            )}
          </label>
        ))}
    </div>
  );
}
type Editor =
  | { kind: "contact"; contact?: Contact }
  | { kind: "enquiry"; enquiry?: CustomerEnquiry };
export function CustomersPage() {
  const { organizationId, session } = useWorkspace();
  const service = useMemo(
    () => customerRecordsApi(organizationId),
    [organizationId],
  );
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "contacts" ? "contacts" : "enquiries",
    selected = params.get("enquiry") ?? "",
    selectedContact = params.get("contact") ?? "";
  const [fullEnquiry, setFullEnquiry] = useState(false);
  const [search, setSearch] = useState(params.get("search") ?? ""),
    [status, setStatus] = useState(params.get("status") ?? ""),
    [assigned, setAssigned] = useState(params.get("assigned") ?? ""),
    [dueFilter, setDueFilter] = useState(params.get("due") ?? "");
  const [enquiries, setEnquiries] = useState<CustomerEnquiry[] | null>(null),
    [contacts, setContacts] = useState<Contact[] | null>(null),
    [members, setMembers] = useState<CustomerMember[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [contactDetail, setContactDetail] = useState<{
    contact: Contact;
    enquiries: CustomerEnquiry[];
  } | null>(null);
  const [detail, setDetail] = useState<CustomerEnquiry | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [loadingMore, setLoadingMore] = useState(false);
  const [activity, setActivity] = useState<
      NonNullable<CustomerEnquiry["activity"]>
    >([]),
    [activityCursor, setActivityCursor] = useState<string | null>(null),
    [loadingActivity, setLoadingActivity] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState(false),
    [saveUncertain, setSaveUncertain] = useState(false);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const saveRequest = useRef<{
    body: Record<string, unknown>;
    kind:
      | "create-contact"
      | "correct-contact"
      | "create-enquiry"
      | "correct-enquiry";
    id?: string;
  } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null),
    [fields, setFields] = useState<CustomerFields>({}),
    [editorError, setEditorError] = useState("");
  const [note, setNote] = useState(""),
    [due, setDue] = useState(""),
    [contactSearch, setContactSearch] = useState(""),
    [contactOptions, setContactOptions] = useState<Contact[]>([]),
    [contactId, setContactId] = useState(""),
    [linkOpen, setLinkOpen] = useState(false),
    [contactError, setContactError] = useState("");
  const listSequence = useRef(0),
    detailSequence = useRef(0),
    mutationLock = useRef(false);
  const owner =
    session.organizations.find((org) => org.id === organizationId)?.role ===
    "owner";
  const canManage = owner || detail?.assigneeAccountId === session.account.id;
  const query = useMemo(
    () =>
      new URLSearchParams({
        limit: "30",
        ...(view === "enquiries" && params.get("contactId")
          ? { contactId: params.get("contactId")! }
          : {}),
        ...(view === "enquiries" && params.get("due")
          ? { due: params.get("due")! }
          : {}),
        ...(params.get("search") ? { search: params.get("search")! } : {}),
        ...(view === "enquiries" && params.get("status")
          ? { status: params.get("status")! }
          : {}),
        ...(view === "enquiries" && params.get("assigned")
          ? { assigned: params.get("assigned")! }
          : {}),
      }),
    [params, view],
  );
  const queryKey = query.toString();
  useEffect(() => {
    setSearch(params.get("search") ?? "");
    setStatus(params.get("status") ?? "");
    setAssigned(params.get("assigned") ?? "");
    setDueFilter(params.get("due") ?? "");
  }, [params]);
  useEffect(() => {
    let live = true;
    void service
      .members()
      .then((result) => {
        if (live) setMembers(result.members);
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [service]);
  useEffect(() => {
    const seq = ++listSequence.current;
    setError("");
    setNext(null);
    setEnquiries(null);
    setContacts(null);
    const run = async () => {
      try {
        if (view === "contacts") {
          const result = await service.contacts(new URLSearchParams(queryKey));
          if (seq === listSequence.current) {
            setContacts(result.contacts);
            setNext(result.nextCursor);
          }
        } else {
          const result = await service.enquiries(new URLSearchParams(queryKey));
          if (seq === listSequence.current) {
            setEnquiries(result.enquiries);
            setNext(result.nextCursor);
          }
        }
      } catch (e) {
        if (seq === listSequence.current) setError(message(e));
      }
    };
    void run();
    return () => {
      if (listSequence.current === seq) listSequence.current = seq + 1;
    };
  }, [service, view, queryKey, refresh]);
  useEffect(() => {
    const seq = ++detailSequence.current;
    setDetail(null);
    setLinkOpen(false);
    setContactId("");
    setError("");
    if (!selected) return;
    void service
      .enquiry(selected)
      .then((result) => {
        if (seq === detailSequence.current) {
          setDetail(result.enquiry);
          const value = result.enquiry.dueAt;
          setDue(
            value
              ? new Date(
                  Date.parse(value) -
                    new Date(value).getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)
              : "",
          );
        }
      })
      .catch((e) => {
        if (seq === detailSequence.current) setError(message(e));
      });
    return () => {
      if (detailSequence.current === seq) detailSequence.current = seq + 1;
    };
  }, [selected, service, refresh]);
  useEffect(() => {
    let live = true;
    setContactDetail(null);
    if (!selectedContact) return;
    void service
      .contact(selectedContact)
      .then((result) => {
        if (live) setContactDetail(result);
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [selectedContact, service, refresh]);
  useEffect(() => {
    setPendingUpdate(
      Boolean(
        readStored(
          `agents.customer-command.${session.account.id}.${organizationId}.${detail?.id ?? selected}`,
        ),
      ),
    );
  }, [detail?.id, selected, organizationId, session.account.id]);
  useEffect(() => {
    let live = true;
    setActivity([]);
    setActivityCursor(null);
    if (!selected) return;
    void service
      .activity(selected)
      .then((result) => {
        if (live) {
          setActivity(result.activity);
          setActivityCursor(result.nextCursor);
        }
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [selected, service, refresh]);
  async function moreActivity() {
    if (!detail || !activityCursor || loadingActivity) return;
    setLoadingActivity(true);
    const seq = detailSequence.current;
    try {
      const result = await service.activity(detail.id, activityCursor);
      if (seq === detailSequence.current) {
        setActivity((old) => [
          ...old,
          ...result.activity.filter(
            (item) => !old.some((existing) => existing.id === item.id),
          ),
        ]);
        setActivityCursor(result.nextCursor);
      }
    } catch (e) {
      if (seq === detailSequence.current) setError(message(e));
    } finally {
      setLoadingActivity(false);
    }
  }
  const noteKey = `agents.customer-note.${session.account.id}.${organizationId}.${selected}`;
  useEffect(() => {
    setNote(readStored<string>(noteKey) ?? "");
  }, [noteKey]);
  useEffect(() => {
    if (!linkOpen) return;
    let live = true;
    setContactError("");
    void service
      .contacts(new URLSearchParams({ limit: "30", search: contactSearch }))
      .then((result) => {
        if (live) setContactOptions(result.contacts);
      })
      .catch((e) => {
        if (live) setContactError(message(e));
      });
    return () => {
      live = false;
    };
  }, [linkOpen, contactSearch, service]);
  function navigate(values: Record<string, string>) {
    setParams((old) => {
      const updated = new URLSearchParams(old);
      for (const [key, value] of Object.entries(values)) {
        if (value) updated.set(key, value);
        else updated.delete(key);
      }
      return updated;
    });
  }
  function filters(event: FormEvent) {
    event.preventDefault();
    navigate({
      search: search.trim(),
      status,
      assigned,
      due: dueFilter,
      enquiry: "",
    });
  }
  async function more() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    const seq = listSequence.current;
    try {
      const page = new URLSearchParams(queryKey);
      page.set("cursor", next);
      if (view === "contacts") {
        const result = await service.contacts(page);
        if (seq === listSequence.current) {
          setContacts((old) => [
            ...(old ?? []),
            ...result.contacts.filter(
              (item) => !old?.some((existing) => existing.id === item.id),
            ),
          ]);
          setNext(result.nextCursor);
        }
      } else {
        const result = await service.enquiries(page);
        if (seq === listSequence.current) {
          setEnquiries((old) => [
            ...(old ?? []),
            ...result.enquiries.filter(
              (item) => !old?.some((existing) => existing.id === item.id),
            ),
          ]);
          setNext(result.nextCursor);
        }
      }
    } catch (e) {
      if (seq === listSequence.current) setError(message(e));
    } finally {
      setLoadingMore(false);
    }
  }
  async function command(action: string, extra: Record<string, unknown> = {}) {
    if (!detail || mutationLock.current) return;
    if (pendingUpdate && action !== "retry") {
      setError("Retry the pending update first.");
      return;
    }
    mutationLock.current = true;
    setBusy(true);
    setError("");
    const target = detail.id,
      key = `agents.customer-command.${session.account.id}.${organizationId}.${target}`,
      body = readStored<Record<string, unknown>>(key) ?? {
        commandId: crypto.randomUUID(),
        expectedRevision: detail.revision,
        action,
        ...extra,
      };
    writeStored(key, body);
    try {
      await service.command(target, body);
      writeStored(key, null);
      setPendingUpdate(false);
      if (body.action === "note") {
        writeStored(noteKey, null);
        setNote("");
      }
      setRefresh((value) => value + 1);
      toast.success("Enquiry updated");
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        writeStored(key, null);
        setPendingUpdate(false);
        if (e.status === 409) setRefresh((value) => value + 1);
      }
      if (!(e instanceof ApiError) || e.status >= 500) setPendingUpdate(true);
      setError(message(e));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  function openEditor(value: Editor) {
    editorTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setEditorError("");
    saveRequest.current = null;
    setSaveUncertain(false);
    setEditor(value);
    setFields(
      value.kind === "contact"
        ? {
            name: value.contact?.name ?? "",
            email: value.contact?.email ?? "",
            phone: value.contact?.phone ?? "",
          }
        : (value.enquiry?.fields ?? {}),
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || mutationLock.current) return;
    const cleaned = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, value?.trim() ?? ""]),
    );
    if (!Object.values(cleaned).some(Boolean)) {
      setEditorError("Enter customer details.");
      return;
    }
    mutationLock.current = true;
    setBusy(true);
    setEditorError("");
    try {
      const commandId = crypto.randomUUID();
      if (!saveRequest.current) {
        if (editor.kind === "contact")
          saveRequest.current = editor.contact
            ? {
                kind: "correct-contact",
                id: editor.contact.id,
                body: {
                  commandId,
                  expectedRevision: editor.contact.revision,
                  action: "correct",
                  ...cleaned,
                },
              }
            : { kind: "create-contact", body: { commandId, ...cleaned } };
        else
          saveRequest.current = editor.enquiry
            ? {
                kind: "correct-enquiry",
                id: editor.enquiry.id,
                body: {
                  commandId,
                  expectedRevision: editor.enquiry.revision,
                  action: "correct",
                  fields: cleaned,
                },
              }
            : { kind: "create-enquiry", body: { commandId, fields: cleaned } };
      }
      const request = saveRequest.current;
      if (request.kind === "create-contact")
        await service.createContact(request.body);
      else if (request.kind === "correct-contact")
        await service.correctContact(request.id!, request.body);
      else if (request.kind === "create-enquiry")
        await service.createEnquiry(request.body);
      else await service.command(request.id!, request.body);
      saveRequest.current = null;
      setSaveUncertain(false);
      setEditor(null);
      setRefresh((value) => value + 1);
      toast.success("Saved");
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        saveRequest.current = null;
        setSaveUncertain(false);
      } else setSaveUncertain(true);
      if (e instanceof ApiError && e.status === 409) {
        try {
          if (editor.kind === "contact" && editor.contact) {
            const current = await service.contact(editor.contact.id);
            setEditor({ kind: "contact", contact: current.contact });
          } else if (editor.kind === "enquiry" && editor.enquiry) {
            const current = await service.enquiry(editor.enquiry.id);
            setEditor({ kind: "enquiry", enquiry: current.enquiry });
          }
          setRefresh((value) => value + 1);
        } catch {
          /* Preserve entered values until the record can be refreshed. */
        }
        setEditorError("Record changed. Review your changes and save again.");
      } else setEditorError(message(e));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  const contactName = (contact: Contact) =>
    contact.name || contact.email || contact.phone || "Contact";
  return (
    <section className="workspace-page customer-page min-w-0 space-y-6">
      <header className="customer-page-header flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <Button
          onClick={() =>
            openEditor({ kind: view === "contacts" ? "contact" : "enquiry" })
          }
        >
          {view === "contacts" ? "Add contact" : "Add enquiry"}
        </Button>
      </header>
      <nav aria-label="Customer views" className="customer-tabs flex border-b gap-5">
        {(["enquiries", "contacts"] as const).map((value) => (
          <Link
            key={value}
            aria-current={view === value ? "page" : undefined}
            className={`pb-3 text-sm capitalize ${view === value ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
            to={value === "contacts" ? "?view=contacts" : "?"}
          >
            {value}
          </Link>
        ))}
      </nav>
      <ErrorMessage value={error} />
      {error && !pendingUpdate ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Try again
        </Button>
      ) : null}
      {pendingUpdate && detail ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">Update not confirmed.</p>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void command("retry")}
          >
            Retry update
          </Button>
        </div>
      ) : null}
      <div className={`customer-content${selectedContact || selected ? " has-selection" : ""}${selected && !selectedContact && fullEnquiry ? " has-enquiry-full" : ""}`}>
        <div className="customer-list-pane">
        <>
          <form className="customer-filters flex flex-wrap items-end gap-3" onSubmit={filters}>
            <label className="block min-w-0 flex-1 basis-48 text-sm">
              <span className="sr-only">Search</span>
              <Input
                aria-label="Search customers"
                placeholder="Search customers"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={120}
              />
            </label>
            {view === "enquiries" ? (
              <>
                <label className="text-sm">
                  <span className="sr-only">Status</span>
                  <select
                    aria-label="Filter enquiry status"
                    className="task-filter w-full"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="">All statuses</option>
                    {Object.entries(statusLabels).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="sr-only">Due date</span>
                  <select
                    aria-label="Filter due date"
                    className="task-filter w-full"
                    value={dueFilter}
                    onChange={(event) => setDueFilter(event.target.value)}
                  >
                    <option value="">Any due date</option>
                    <option value="overdue">Overdue</option>
                    <option value="scheduled">Scheduled</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="sr-only">Assignment</span>
                  <select
                    aria-label="Filter enquiry assignment"
                    className="task-filter w-full"
                    value={assigned}
                    onChange={(event) => setAssigned(event.target.value)}
                  >
                    <option value="">Everyone</option>
                    <option value="mine">Assigned to me</option>
                    <option value="unassigned">Unassigned</option>
                  </select>
                </label>
              </>
            ) : null}
            <Button variant="outline" type="submit">
              Search
            </Button>
          </form>
          {(view === "contacts" ? contacts : enquiries) === null ? (
            !error ? <Loading /> : null
          ) : view === "contacts" ? (
            <div className="customer-table-wrap">
              {contacts?.length ? (
                <table className="customer-table">
                  <thead><tr><th>Contact</th><th>Email</th><th>Phone</th>{owner ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead>
                  <tbody>{contacts.map((contact) => (
                    <tr key={contact.id} className={selectedContact === contact.id ? "is-selected" : undefined}>
                      <td data-label="Contact"><Link className="customer-record-link" to={`?view=contacts&contact=${encodeURIComponent(contact.id)}`}><span aria-hidden="true" className="customer-initial">{contactName(contact).slice(0, 1).toUpperCase()}</span><span>{contactName(contact)}</span></Link></td>
                      <td data-label="Email">{contact.email || "—"}</td><td data-label="Phone">{contact.phone || "—"}</td>
                      {owner ? <td><Button variant="ghost" size="sm" onClick={() => openEditor({ kind: "contact", contact })}>Edit contact</Button></td> : null}
                    </tr>
                  ))}</tbody>
                </table>
              ) : <p className="customer-empty">No contacts</p>}
            </div>
          ) : (
            <div className="customer-table-wrap">
              {enquiries?.length ? (
                <table className="customer-table">
                  <thead><tr><th>Customer</th><th>Enquiry</th><th>Status</th><th>Assignee</th><th>Due date</th><th>Created</th></tr></thead>
                  <tbody>{enquiries.map((item) => (
                    <tr key={item.id} className={selected === item.id ? "is-selected" : undefined}>
                      <td data-label="Customer"><Link aria-label={`${item.fields.name || item.fields.service || "Enquiry"} · ${statusLabels[item.status]}`} className="customer-record-link" to={`?${new URLSearchParams({ ...Object.fromEntries(params), enquiry: item.id })}`}><span aria-hidden="true" className="customer-initial">{(item.fields.name || item.fields.service || "E").slice(0, 1).toUpperCase()}</span><span>{item.fields.name || "Enquiry"}</span></Link></td>
                      <td data-label="Enquiry"><Link className="customer-enquiry-link" to={`?${new URLSearchParams({ ...Object.fromEntries(params), enquiry: item.id })}`}>{item.fields.service || item.fields.message || item.fields.email || item.fields.phone || "Enquiry"}</Link></td>
                      <td data-label="Status"><span className={`customer-status customer-status-${item.status}`}>{statusLabels[item.status]}</span></td>
                      <td data-label="Assignee">{members.find((member) => member.accountId === item.assigneeAccountId)?.name ?? (item.assigneeAccountId ? "Former member" : "Unassigned")}</td>
                      <td data-label="Due date">{item.dueAt ? date(item.dueAt) : "—"}</td><td data-label="Created"><time dateTime={item.createdAt}>{date(item.createdAt)}</time></td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <p className="customer-empty">No enquiries</p>}
            </div>
          )}
          {(view === "contacts" ? contacts : enquiries)?.length ? (
            <p className="customer-result-count">{(view === "contacts" ? contacts : enquiries)?.length} shown</p>
          ) : null}
          {next ? (
            <Button
              variant="outline"
              disabled={loadingMore}
              onClick={() => void more()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
        </div>
        {selectedContact || selected ? <section className="customer-detail-pane" aria-label={selectedContact ? "Contact details" : "Enquiry details"}>
      {selectedContact ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ contact: "" })}
          >
            ← Contacts
          </Button>
          {!contactDetail && !error ? (
            <Loading />
          ) : contactDetail ? (
            <article className="customer-detail contact-detail space-y-6">
              <header className="flex flex-wrap justify-between gap-3">
                <h2 className="text-xl font-semibold break-words">
                  {contactName(contactDetail.contact)}
                </h2>
                {owner ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      openEditor({
                        kind: "contact",
                        contact: contactDetail.contact,
                      })
                    }
                  >
                    Edit contact
                  </Button>
                ) : null}
              </header>
              <FieldList
                fields={{
                  name: contactDetail.contact.name ?? undefined,
                  email: contactDetail.contact.email ?? undefined,
                  phone: contactDetail.contact.phone ?? undefined,
                }}
              />
              <section className="border-t pt-4 space-y-3">
                <h3 className="font-medium">Enquiries</h3>
                <Link
                  className="text-sm underline"
                  to={`?contactId=${encodeURIComponent(contactDetail.contact.id)}`}
                >
                  View all enquiries
                </Link>
                {contactDetail.enquiries.length ? (
                  contactDetail.enquiries.map((item) => (
                    <Link
                      className="flex flex-wrap justify-between gap-3 border-b py-3 text-sm"
                      key={item.id}
                      to={`?enquiry=${encodeURIComponent(item.id)}`}
                    >
                      <span>
                        {item.fields.service ||
                          item.fields.message?.slice(0, 80) ||
                          "Enquiry"}
                      </span>
                      <span>{statusLabels[item.status]}</span>
                    </Link>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No linked enquiries
                  </p>
                )}
              </section>
            </article>
          ) : null}
        </>
      ) : selected ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setFullEnquiry(false); navigate({ enquiry: "" }); }}
          >
            ← Enquiries
          </Button>
          {!detail && !error ? (
            <Loading />
          ) : detail ? (
            <fieldset disabled={busy || pendingUpdate} className="min-w-0">
              <article className="customer-detail enquiry-detail space-y-6">
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div className="customer-detail-identity">
                    <span className="customer-detail-avatar" aria-hidden="true">
                      {(detail.fields.name || detail.fields.service || "E").trim().slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <h2 className="text-xl font-semibold break-words">
                        {detail.fields.name || detail.fields.service || "Enquiry"}
                      </h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {date(detail.createdAt)}
                      </p>
                    </div>
                    <span className={`customer-status customer-status-${detail.status}`}>{statusLabels[detail.status]}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                  <Button className="customer-expand-detail" variant="outline" size="sm" onClick={() => setFullEnquiry(!fullEnquiry)}>
                    {fullEnquiry ? "Show list" : "Expand"}
                  </Button>
                  {canManage ? (
                    <Button
                      disabled={busy}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        openEditor({ kind: "enquiry", enquiry: detail })
                      }
                    >
                      Edit details
                    </Button>
                  ) : null}
                  </div>
                </header>
                <div className="customer-detail-columns">
                  <div className="customer-detail-main">
                <section
                  className="border-t pt-4 space-y-4"
                  aria-label="Internal activity"
                >
                  <h3 className="font-medium">Internal activity</h3>
                  <ol className="customer-activity-list">
                    {activity.map((item) => (
                      <li key={item.id} className="text-sm">
                        <p className="capitalize">
                          {label(item.kind)}{" "}
                          <span className="text-muted-foreground normal-case">
                            · {date(item.createdAt)} ·{" "}
                            {members.find(
                              (member) =>
                                member.accountId === item.actorAccountId,
                            )?.name ??
                              (item.actorAccountId ? "Staff member" : "System")}
                          </span>
                        </p>
                        {item.body ? (
                          <p className="mt-1 whitespace-pre-wrap break-words">
                            {item.body}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  {canManage ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void command("note", { body: note.trim() });
                      }}
                    >
                      <label className="block space-y-2 text-sm">
                        Internal note
                        <Textarea
                          maxLength={4000}
                          value={note}
                          onChange={(event) => {
                            setNote(event.target.value);
                            writeStored(noteKey, event.target.value);
                          }}
                        />
                      </label>
                      <Button disabled={!note.trim() || busy} type="submit">
                        Add note
                      </Button>
                    </form>
                  ) : null}
                  {activityCursor ? (
                    <Button
                      variant="outline"
                      disabled={loadingActivity}
                      onClick={() => void moreActivity()}
                    >
                      {loadingActivity ? "Loading…" : "Earlier activity"}
                    </Button>
                  ) : null}
                </section>
                  </div>
                  <div className="customer-detail-sidebar">
                <section className="space-y-4" aria-label="Enquiry properties">
                  <h3 className="font-medium">Properties</h3>
                  <FieldList fields={detail.fields} />
                  {detail.originalFields ? (
                    <details>
                      <summary className="cursor-pointer text-sm text-muted-foreground">Original submission</summary>
                      <div className="mt-4"><FieldList fields={detail.originalFields} /></div>
                    </details>
                  ) : null}
                </section>
                <section
                  className="border-t pt-4 space-y-3"
                  aria-label="Source"
                >
                  <h3 className="text-sm font-medium">Source</h3>
                  <p className="text-sm text-muted-foreground">
                    {detail.sourceEnquiryId
                      ? "Customer submission"
                      : "Staff entry"}
                  </p>
                  <div className="flex flex-wrap gap-4 text-sm">
                    {detail.customerConversationId ? (
                      <Link
                        className="underline"
                        to={`/app/inbox?conversation=${encodeURIComponent(detail.customerConversationId)}`}
                      >
                        Open Inbox
                      </Link>
                    ) : null}
                    {detail.agentId && detail.conversationId ? (
                      <Link
                        className="underline"
                        to={`/app/agents/${detail.agentId}/conversations/${detail.conversationId}`}
                      >
                        Open conversation
                      </Link>
                    ) : null}
                    {detail.sourceTaskId ? (
                      <Link
                        className="underline"
                        to={`/app/tasks/${detail.sourceTaskId}`}
                      >
                        Open task
                      </Link>
                    ) : null}
                  </div>
                </section>
                {detail.bookings?.length ? (
                  <section
                    className="border-t pt-4 space-y-3"
                    aria-label="Conversation bookings"
                  >
                    <h3 className="font-medium">Conversation bookings</h3>
                    <ul className="space-y-2">
                      {detail.bookings.map((booking) => (
                        <li key={booking.id} className="text-sm">
                          <p className="capitalize">{label(booking.state)}</p>
                          <p className="text-muted-foreground">
                            {date(booking.startsAt)} – {date(booking.endsAt)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                <section
                  className="border-t pt-4 space-y-4"
                  aria-label="Follow-up"
                >
                  <h3 className="font-medium">Follow-up</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      Status
                      <select
                        className="task-filter w-full"
                        aria-label="Enquiry status"
                        value={detail.status}
                        disabled={
                          !canManage || busy || detail.status === "closed"
                        }
                        onChange={(event) =>
                          void command("set-status", {
                            status: event.target.value,
                          })
                        }
                      >
                        {Object.entries(statusLabels).map(([key, value]) => (
                          <option key={key} value={key}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-2 text-sm">
                      Assignee
                      <select
                        className="task-filter w-full"
                        aria-label="Enquiry assignee"
                        disabled={!owner || busy}
                        value={detail.assigneeAccountId ?? ""}
                        onChange={(event) =>
                          void command(
                            event.target.value ? "assign" : "unassign",
                            event.target.value
                              ? { assigneeAccountId: event.target.value }
                              : {},
                          )
                        }
                      >
                        <option value="">Unassigned</option>
                        {detail.assigneeAccountId &&
                        !members.some(
                          (member) =>
                            member.accountId === detail.assigneeAccountId,
                        ) ? (
                          <option value={detail.assigneeAccountId} disabled>
                            Former member
                          </option>
                        ) : null}
                        {members.map((member) => (
                          <option
                            key={member.accountId}
                            value={member.accountId}
                          >
                            {member.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!detail.assigneeAccountId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void command("claim")}
                      >
                        Assign to me
                      </Button>
                    ) : detail.assigneeAccountId === session.account.id ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void command("unassign")}
                      >
                        Unassign me
                      </Button>
                    ) : null}
                    {detail.status === "closed" && canManage ? (
                      <Button
                        disabled={busy}
                        variant="outline"
                        size="sm"
                        onClick={() => void command("reopen")}
                      >
                        Reopen enquiry
                      </Button>
                    ) : null}
                  </div>
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void command("set-due", {
                        dueAt: due ? new Date(due).toISOString() : null,
                      });
                    }}
                  >
                    <label className="space-y-2 text-sm min-w-0">
                      Due date
                      <Input
                        aria-label="Due date"
                        type="datetime-local"
                        disabled={!canManage || busy}
                        value={due}
                        onChange={(event) => setDue(event.target.value)}
                      />
                    </label>
                    {canManage ? (
                      <Button type="submit" variant="outline" disabled={busy}>
                        Save due date
                      </Button>
                    ) : null}
                  </form>
                </section>
                <section
                  className="border-t pt-4 space-y-3"
                  aria-label="Linked contact"
                >
                  <h3 className="font-medium">Contact</h3>
                  {detail.contactId ? (
                    <div className="flex flex-wrap items-center gap-4">
                      <Link
                        className="text-sm underline"
                        to={`?view=contacts&contact=${encodeURIComponent(detail.contactId)}`}
                      >
                        View contact
                      </Link>
                      {canManage ? (
                        <Button
                          disabled={busy}
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void command("link-contact", { contactId: null })
                          }
                        >
                          Unlink contact
                        </Button>
                      ) : null}
                    </div>
                  ) : canManage ? (
                    <Button
                      disabled={busy}
                      size="sm"
                      variant="outline"
                      onClick={() => setLinkOpen((value) => !value)}
                    >
                      Link contact
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No linked contact
                    </p>
                  )}
                  {linkOpen ? (
                    <div className="space-y-3 max-w-md">
                      <Input
                        aria-label="Find contact"
                        placeholder="Search contacts"
                        value={contactSearch}
                        onChange={(event) =>
                          setContactSearch(event.target.value)
                        }
                      />
                      <ErrorMessage value={contactError} />
                      <select
                        aria-label="Contact to link"
                        className="task-filter w-full"
                        value={contactId}
                        onChange={(event) => setContactId(event.target.value)}
                      >
                        <option value="">Select contact</option>
                        {contactOptions.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contactName(contact)}
                          </option>
                        ))}
                      </select>
                      <Button
                        disabled={!contactId || busy}
                        onClick={() =>
                          void command("link-contact", { contactId })
                        }
                      >
                        Link contact
                      </Button>
                    </div>
                  ) : null}
                </section>
                  </div>
                </div>
              </article>
            </fieldset>
          ) : null}
        </>
      ) : null}
        </section> : null}
      </div>
      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open && !busy && !saveUncertain) setEditor(null);
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editorTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editor?.kind === "contact"
                ? editor.contact
                  ? "Edit contact"
                  : "Add contact"
                : editor?.enquiry
                  ? "Edit enquiry"
                  : "Add enquiry"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Customer details
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void save(event)} className="space-y-4">
            <ErrorMessage value={editorError} />
            <fieldset disabled={busy || saveUncertain}>
              <FieldsEditor
                fields={fields}
                setFields={setFields}
                contact={editor?.kind === "contact"}
              />
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                disabled={busy || saveUncertain}
                variant="outline"
                onClick={() => setEditor(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : saveUncertain ? "Retry save" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
