import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  ArrowLeft,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from "@/components/ui/interface-icons";
import { apiUrl } from "@/lib/server-api";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import { scheduledInstants, timeZoneOptions } from "./campaign-create-utils";
import "./campaign-create.css";

type Connection = {
  id: string;
  phoneDisplayNumber: string | null;
  phoneNumberId: string;
};
type Template = {
  id: string;
  templateName: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  status: "APPROVED" | "PENDING" | "REJECTED" | "DISABLED";
  variablesCount: number;
  body: string | null;
  header?: string | null;
  footer?: string | null;
  buttons?: unknown;
  connectionId?: string | null;
  connectionLabel: string;
};
type Contact = {
  id: string;
  fullName?: string | null;
  phone: string;
  tags: string[];
  location?: string | null;
  listLabel: string;
  metadata: Record<string, string> | null;
  excluded?: boolean;
  optIn?: boolean;
};
type ContactListSummary = {
  label: string;
  totalContacts: number;
  primaryLocation: string | null;
  metadataKeys: string[];
};
type VariableMapping = { source: "static" | "contact"; key: string };
type Preflight = {
  totalContacts: number;
  eligibleRecipients: number;
  skipped: { notOptedIn: number; excluded: number; cooldown: number };
};
const STEPS = ["Details", "Audience", "Message", "Review"];
const BASE_FIELDS = [
  { value: "fullName", label: "Full name" },
  { value: "phone", label: "Phone" },
  { value: "location", label: "Location" },
  { value: "tags", label: "Tags" },
];
function resolveValue(contact: Contact | null, mapping: VariableMapping) {
  if (mapping.source === "static") return mapping.key;
  if (!contact) return "";
  if (mapping.key === "fullName") return contact.fullName || "";
  if (mapping.key === "phone") return contact.phone;
  if (mapping.key === "location") return contact.location || "";
  if (mapping.key === "tags") return contact.tags.join(", ");
  return contact.metadata?.[mapping.key] || "";
}

export default function CampaignCreateForm({
  connections,
  templates,
  lists,
}: {
  connections: Connection[];
  templates: Template[];
  contacts?: Contact[];
  lists: ContactListSummary[];
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [step, setStep] = useState(0);
  const [baseName, setBaseName] = useState("");
  const [description, setDescription] = useState("");
  const [connectionId, setConnectionId] = useState(connections[0]?.id || "");
  const [templateId, setTemplateId] = useState("");
  const [listLabel, setListLabel] = useState(lists[0]?.label || "");
  const [batchSize, setBatchSize] = useState("200");
  const [search, setSearch] = useState("");
  const [excludedContactIds, setExcludedContactIds] = useState<string[]>([]);
  const [variableMappings, setVariableMappings] = useState<VariableMapping[]>(
    [],
  );
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsError, setContactsError] = useState("");
  const [reload, setReload] = useState(0);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState("");
  const [delivery, setDelivery] = useState<"now" | "schedule">("now");
  const [localTime, setLocalTime] = useState("");
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [occurrence, setOccurrence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    id: string;
    recipients: number | null;
  } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const availableTemplates = templates.filter(
    (t) =>
      t.category === "MARKETING" &&
      t.status === "APPROVED" &&
      (!t.connectionId || t.connectionId === connectionId),
  );
  const template = availableTemplates.find((t) => t.id === templateId) || null;
  const list = lists.find((item) => item.label === listLabel);
  const fields = [
    ...BASE_FIELDS,
    ...(list?.metadataKeys || []).map((key) => ({
      value: key,
      label: key.replace(/[_-]+/g, " "),
    })),
  ];
  const suffix = listLabel.match(/(\d{4}-\d{2}-\d{2}-run-\d+)$/i)?.[1];
  const cleanName = baseName
    .trim()
    .replace(/-\d{4}-\d{2}-\d{2}-run-\d+$/i, "")
    .trim();
  const savedName = cleanName && suffix ? `${cleanName}-${suffix}` : cleanName;
  const requestedBatch = Number(batchSize);
  const instants = useMemo(
    () => scheduledInstants(localTime, timeZone),
    [localTime, timeZone],
  );
  const scheduledAt =
    instants.length === 1
      ? instants[0]
      : instants.includes(occurrence)
        ? occurrence
        : "";
  const payload = useMemo(
    () => ({
      name: savedName,
      description: description.trim() || undefined,
      connectionId,
      templateId,
      listLabel,
      batchSize: requestedBatch,
      excludedContactIds,
      variableMappings: variableMappings.map((mapping) => ({
        ...mapping,
        key: mapping.key.trim(),
      })),
    }),
    [
      savedName,
      description,
      connectionId,
      templateId,
      listLabel,
      requestedBatch,
      excludedContactIds,
      variableMappings,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setContactsLoading(true);
      setContactsError("");
      setContacts([]);
      try {
        if (!listLabel) return;
        const all: Contact[] = [];
        let total = Infinity;
        while (all.length < total) {
          const params = new URLSearchParams({
            listLabel,
            limit: "500",
            cursor: String(all.length),
          });
          const response = await fetch(
            apiUrl(`/api/whatsapp/contacts?${params}`),
            { credentials: "include", signal: controller.signal },
          );
          const body = await response.json();
          if (!response.ok)
            throw new Error(body.error || "Could not load contacts");
          const page: Contact[] = body.contacts || [];
          total = body.stats?.filteredTotal ?? all.length + page.length;
          if (!page.length && all.length < total)
            throw new Error("Contact list changed. Reload the audience.");
          all.push(...page);
        }
        if (new Set(all.map((c) => c.id)).size !== all.length)
          throw new Error("Contact list changed. Reload the audience.");
        if (!controller.signal.aborted) setContacts(all);
      } catch (cause) {
        if (!controller.signal.aborted)
          setContactsError(
            cause instanceof Error ? cause.message : "Could not load contacts",
          );
      } finally {
        if (!controller.signal.aborted) setContactsLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [listLabel, reload]);

  useEffect(() => {
    if (step !== 3 || created) return;
    const controller = new AbortController();
    async function check() {
      setPreflightLoading(true);
      setPreflight(null);
      setPreflightError("");
      try {
        const response = await fetch(
          apiUrl("/api/whatsapp/campaigns/preflight"),
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
          },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not check recipients");
        const counts = [
          body.totalContacts,
          body.eligibleRecipients,
          body.skipped?.notOptedIn,
          body.skipped?.excluded,
          body.skipped?.cooldown,
        ];
        if (counts.some((count) => !Number.isInteger(count) || count < 0))
          throw new Error("Recipient counts are unavailable. Retry the check.");
        if (!controller.signal.aborted) setPreflight(body);
      } catch (cause) {
        if (!controller.signal.aborted)
          setPreflightError(
            cause instanceof Error
              ? cause.message
              : "Could not check recipients",
          );
      } finally {
        if (!controller.signal.aborted) setPreflightLoading(false);
      }
    }
    void check();
    return () => controller.abort();
  }, [step, payload, created, reload]);

  const searched = contacts.filter((contact) =>
    [
      contact.fullName,
      contact.phone,
      contact.location,
      ...Object.values(contact.metadata || {}),
    ]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const templateButtons = Array.isArray(template?.buttons)
    ? template.buttons.filter(
        (button): button is { text: string } =>
          typeof button === "object" &&
          button !== null &&
          typeof button.text === "string",
      )
    : [];
  const sample =
    contacts.find((contact) => !excludedContactIds.includes(contact.id)) ||
    null;
  let preview = template?.body || "Select a template";
  variableMappings.forEach((mapping, index) => {
    preview = preview.replace(
      new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, "g"),
      () => resolveValue(sample, mapping) || `{{${index + 1}}}`,
    );
  });
  const missing = contacts.filter(
    (contact) =>
      !excludedContactIds.includes(contact.id) &&
      variableMappings.some(
        (mapping) => !resolveValue(contact, mapping).trim(),
      ),
  ).length;
  const detailsError = !savedName
    ? "Enter a campaign name"
    : !connectionId
      ? "Select a WhatsApp connection"
      : "";
  const audienceError = !listLabel
    ? "Select a contact list"
    : contactsLoading
      ? "Wait for the audience to load"
      : contactsError ||
        (!Number.isInteger(requestedBatch) || requestedBatch < 1
          ? "Enter a positive whole number"
          : "");
  const messageError = !template
    ? "Select an approved marketing template"
    : variableMappings.some((mapping) => !mapping.key.trim())
      ? "Complete all template variables"
      : "";
  const scheduleError =
    delivery !== "schedule"
      ? ""
      : !scheduledAt
        ? instants.length > 1
          ? "Choose which occurrence to use"
          : "Choose a valid date and time in this timezone"
        : Date.parse(scheduledAt) <= Date.now()
          ? "Choose a future date and time"
          : "";
  function next() {
    setAttempted(true);
    const problem = [detailsError, audienceError, messageError][step];
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setAttempted(false);
    setStep(step + 1);
  }
  async function submit(launch: boolean) {
    if (submissionInFlight.current) return;
    setAttempted(true);
    setError("");
    const problem =
      detailsError ||
      audienceError ||
      messageError ||
      (launch ? scheduleError : "");
    if (problem) {
      setError(problem);
      return;
    }
    if (!created && (!preflight || preflightLoading || preflightError)) return;
    if (launch && !created && !preflight?.eligibleRecipients) {
      setError("No eligible recipients");
      return;
    }
    submissionInFlight.current = true;
    setSubmitting(true);
    try {
      let record = created;
      if (!record) {
        const response = await fetch(apiUrl("/api/whatsapp/campaigns"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not save campaign");
        if (!body.campaign?.id)
          throw new Error("Campaign response is missing its ID");
        record = {
          id: body.campaign.id,
          recipients:
            Number.isInteger(body.createdRecipients) &&
            body.createdRecipients >= 0
              ? body.createdRecipients
              : null,
        };
        setCreated(record);
      }
      if (launch) {
        const response = await fetch(
          apiUrl(`/api/whatsapp/campaigns/${record.id}/launch`),
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              batchSize: requestedBatch,
              scheduledAt: delivery === "schedule" ? scheduledAt : null,
            }),
          },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error || "Draft saved. Could not launch campaign.",
          );
      }
      navigate(
        `/campaigns/${record.id}?notice=${encodeURIComponent(launch ? (delivery === "schedule" ? "Campaign scheduled" : "Campaign launched") : record.recipients === null ? "Draft saved" : `Draft saved · ${record.recipients} recipients`)}`,
      );
      void revalidator.revalidate();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save campaign",
      );
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="campaign-create">
      <nav aria-label="Campaign setup" className="campaign-create-steps">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            aria-current={index === step ? "step" : undefined}
            disabled={index > step || submitting || !!created}
            onClick={() => {
              setStep(index);
              setError("");
              setAttempted(false);
            }}
          >
            <span>{index < step ? <Check size={14} /> : index + 1}</span>
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="campaign-create-error">
          {error}
        </div>
      )}
      {created && (
        <div role="status" className="campaign-create-saved">
          Draft saved
          {created.recipients === null
            ? ""
            : ` · ${created.recipients} recipients`}
          . <Link to={`/campaigns/${created.id}`}>View draft</Link>
        </div>
      )}
      <div className="campaign-create-layout">
        <div className="campaign-create-main">
          <fieldset disabled={submitting || !!created}>
            {step === 0 && (
              <section>
                <div className="campaign-create-section-heading">
                  <span>01</span>
                  <h2>Campaign details</h2>
                </div>
                <div className="campaign-create-fields">
                  <label>
                    Campaign name
                    <Input
                      value={baseName}
                      aria-invalid={attempted && !savedName}
                      onChange={(e) => setBaseName(e.target.value)}
                      placeholder="Campaign name"
                    />
                    {attempted && !savedName && (
                      <small className="text-destructive">
                        Enter a campaign name
                      </small>
                    )}
                  </label>
                  {suffix && (
                    <p className="campaign-create-note">
                      Saved as {savedName || "—"}
                    </p>
                  )}
                  <label>
                    Description{" "}
                    <span className="campaign-create-optional">Optional</span>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={3}
                    />
                  </label>
                  <label>
                    WhatsApp account
                    <Select
                      value={connectionId}
                      onValueChange={(value) => {
                        setConnectionId(value);
                        setTemplateId("");
                        setVariableMappings([]);
                      }}
                    >
                      <SelectTrigger aria-label="WhatsApp account">
                        <SelectValue placeholder="Select account" />
                      </SelectTrigger>
                      <SelectContent>
                        {connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.phoneDisplayNumber ||
                              connection.phoneNumberId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {!connections.length && (
                    <p className="campaign-create-note">
                      No WhatsApp accounts.{" "}
                      <Link to="/connections">Connect account</Link>
                    </p>
                  )}
                </div>
              </section>
            )}
            {step === 1 && (
              <section>
                <div className="campaign-create-section-heading">
                  <span>02</span>
                  <h2>Choose audience</h2>
                </div>
                <div className="campaign-create-fields">
                  <label>
                    Contact list
                    <Select
                      value={listLabel}
                      onValueChange={(value) => {
                        setListLabel(value);
                        setExcludedContactIds([]);
                        setSearch("");
                      }}
                    >
                      <SelectTrigger aria-label="Contact list">
                        <SelectValue placeholder="Select list" />
                      </SelectTrigger>
                      <SelectContent>
                        {lists.map((item) => (
                          <SelectItem key={item.label} value={item.label}>
                            {item.label} · {item.totalContacts}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {!lists.length && (
                    <p className="campaign-create-note">
                      No contact lists. <Link to="/contacts">Add contacts</Link>
                    </p>
                  )}
                  <label>
                    Batch size
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={batchSize}
                      aria-invalid={
                        attempted &&
                        (!Number.isInteger(requestedBatch) ||
                          requestedBatch < 1)
                      }
                      onChange={(e) => setBatchSize(e.target.value)}
                    />
                  </label>
                </div>
                <div className="campaign-create-audience-heading">
                  <h3>
                    Recipients{" "}
                    <span>
                      {contactsLoading ? "Loading…" : contacts.length}
                    </span>
                  </h3>
                  <span>{excludedContactIds.length} manually excluded</span>
                </div>
                <Input
                  aria-label="Search audience"
                  placeholder="Search contacts"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {contactsLoading ? (
                  <div className="campaign-create-loading" role="status">
                    <LoaderCircle className="animate-spin" size={18} />
                    Loading audience
                  </div>
                ) : contactsError ? (
                  <div role="alert" className="campaign-create-error">
                    {contactsError}
                    <Button
                      variant="outline"
                      onClick={() => setReload((value) => value + 1)}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <div className="campaign-create-contact-list">
                    {searched.map((contact) => {
                      const excluded = excludedContactIds.includes(contact.id);
                      return (
                        <label key={contact.id}>
                          <input
                            type="checkbox"
                            checked={excluded}
                            onChange={() =>
                              setExcludedContactIds((current) =>
                                excluded
                                  ? current.filter((id) => id !== contact.id)
                                  : [...current, contact.id],
                              )
                            }
                            aria-label={`Exclude ${contact.fullName || contact.phone}`}
                          />
                          <span>
                            <strong>{contact.fullName || contact.phone}</strong>
                            <small>
                              {contact.phone}
                              {contact.location ? ` · ${contact.location}` : ""}
                            </small>
                          </span>
                          <span className="campaign-create-contact-status">
                            {excluded
                              ? "Excluded"
                              : contact.excluded
                                ? "Excluded globally"
                                : !contact.optIn
                                  ? "No consent"
                                  : ""}
                          </span>
                        </label>
                      );
                    })}
                    {!searched.length && (
                      <p className="campaign-create-note">No contacts</p>
                    )}
                  </div>
                )}
              </section>
            )}
            {step === 2 && (
              <section>
                <div className="campaign-create-section-heading">
                  <span>03</span>
                  <h2>Compose message</h2>
                </div>
                <div className="campaign-create-fields">
                  <label>
                    Marketing template
                    <Select
                      value={templateId}
                      onValueChange={(value) => {
                        setTemplateId(value);
                        const selected = availableTemplates.find(
                          (item) => item.id === value,
                        );
                        setVariableMappings(
                          Array.from(
                            { length: selected?.variablesCount || 0 },
                            (_, index) =>
                              variableMappings[index] || {
                                source: "contact",
                                key: "fullName",
                              },
                          ),
                        );
                      }}
                    >
                      <SelectTrigger aria-label="Marketing template">
                        <SelectValue placeholder="Select approved template" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableTemplates.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.templateName} · {item.language}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {!availableTemplates.length && (
                    <p className="campaign-create-note">
                      No approved marketing templates.{" "}
                      <Link to="/templates">Manage templates</Link>
                    </p>
                  )}
                </div>
                {variableMappings.length > 0 && (
                  <div className="campaign-create-variables">
                    <h3>Variables</h3>
                    {variableMappings.map((mapping, index) => (
                      <div key={index}>
                        <label>
                          Variable {index + 1}
                          <Select
                            value={mapping.source}
                            onValueChange={(value) =>
                              setVariableMappings((current) =>
                                current.map((item, at) =>
                                  at === index
                                    ? {
                                        source: value as "static" | "contact",
                                        key:
                                          value === "contact" ? "fullName" : "",
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger
                              aria-label={`Variable ${index + 1} source`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="contact">
                                Contact field
                              </SelectItem>
                              <SelectItem value="static">
                                Static text
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                        <label>
                          <span>
                            {mapping.source === "static" ? "Value" : "Field"}
                          </span>
                          {mapping.source === "static" ? (
                            <Input
                              aria-label={`Variable ${index + 1} value`}
                              value={mapping.key}
                              onChange={(e) =>
                                setVariableMappings((current) =>
                                  current.map((item, at) =>
                                    at === index
                                      ? { ...item, key: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          ) : (
                            <Select
                              value={mapping.key}
                              onValueChange={(key) =>
                                setVariableMappings((current) =>
                                  current.map((item, at) =>
                                    at === index ? { ...item, key } : item,
                                  ),
                                )
                              }
                            >
                              <SelectTrigger
                                aria-label={`Variable ${index + 1} field`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {fields.map((field) => (
                                  <SelectItem
                                    key={field.value}
                                    value={field.value}
                                  >
                                    {field.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </label>
                      </div>
                    ))}
                  </div>
                )}
                {missing > 0 && (
                  <p role="status" className="campaign-create-warning">
                    {missing} contacts have missing variable values.
                  </p>
                )}
              </section>
            )}
            {step === 3 && (
              <section>
                <div className="campaign-create-section-heading">
                  <span>04</span>
                  <h2>Review campaign</h2>
                </div>
                <dl className="campaign-create-review">
                  <div>
                    <dt>Saved name</dt>
                    <dd>{savedName}</dd>
                  </div>
                  <div>
                    <dt>Account</dt>
                    <dd>
                      {connections.find((item) => item.id === connectionId)
                        ?.phoneDisplayNumber ||
                        connections.find((item) => item.id === connectionId)
                          ?.phoneNumberId}
                    </dd>
                  </div>
                  <div>
                    <dt>Template</dt>
                    <dd>
                      {template?.templateName} · {template?.language}
                    </dd>
                  </div>
                  <div>
                    <dt>List</dt>
                    <dd>{listLabel}</dd>
                  </div>
                  <div>
                    <dt>Requested batch</dt>
                    <dd>{batchSize}</dd>
                  </div>
                  <div>
                    <dt>Manual exclusions</dt>
                    <dd>{excludedContactIds.length}</dd>
                  </div>
                  {description && (
                    <div>
                      <dt>Description</dt>
                      <dd>{description}</dd>
                    </div>
                  )}
                  {variableMappings.map((mapping, index) => (
                    <div key={index}>
                      <dt>Variable {index + 1}</dt>
                      <dd>
                        {mapping.source === "static"
                          ? `Text: ${mapping.key}`
                          : `Contact: ${fields.find((field) => field.value === mapping.key)?.label || mapping.key}`}
                      </dd>
                    </div>
                  ))}
                </dl>
                {preflightLoading && (
                  <p role="status" className="campaign-create-loading">
                    <LoaderCircle className="animate-spin" size={16} />
                    Checking recipients
                  </p>
                )}
                {preflightError && (
                  <div role="alert" className="campaign-create-error">
                    {preflightError}
                    <Button
                      variant="outline"
                      onClick={() => setReload((value) => value + 1)}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                {preflight && (
                  <div className="campaign-create-eligibility">
                    <h3>Recipient check</h3>
                    <dl>
                      <div>
                        <dt>Total contacts</dt>
                        <dd>{preflight.totalContacts}</dd>
                      </div>
                      <div>
                        <dt>Eligible</dt>
                        <dd>{preflight.eligibleRecipients}</dd>
                      </div>
                      <div>
                        <dt>This batch</dt>
                        <dd>
                          {Math.min(
                            requestedBatch,
                            preflight.eligibleRecipients,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>No consent</dt>
                        <dd>{preflight.skipped.notOptedIn}</dd>
                      </div>
                      <div>
                        <dt>Excluded</dt>
                        <dd>{preflight.skipped.excluded}</dd>
                      </div>
                      <div>
                        <dt>Cooldown</dt>
                        <dd>{preflight.skipped.cooldown}</dd>
                      </div>
                    </dl>
                  </div>
                )}
                <h3 className="campaign-create-delivery-title">Delivery</h3>
                <div className="campaign-create-delivery">
                  <label>
                    <input
                      type="radio"
                      name="delivery"
                      checked={delivery === "now"}
                      onChange={() => setDelivery("now")}
                    />
                    Send now
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="delivery"
                      checked={delivery === "schedule"}
                      onChange={() => setDelivery("schedule")}
                    />
                    Schedule
                  </label>
                </div>
              </section>
            )}
          </fieldset>
          {step === 3 && delivery === "schedule" && (
            <div className="campaign-create-fields campaign-create-schedule">
              <label>
                Date and time
                <Input
                  type="datetime-local"
                  value={localTime}
                  disabled={submitting}
                  onChange={(e) => {
                    setLocalTime(e.target.value);
                    setOccurrence("");
                  }}
                />
              </label>
              <label>
                Timezone
                <Select
                  value={timeZone}
                  disabled={submitting}
                  onValueChange={(value) => {
                    setTimeZone(value);
                    setOccurrence("");
                  }}
                >
                  <SelectTrigger aria-label="Timezone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timeZoneOptions(timeZone).map((zone) => (
                      <SelectItem value={zone} key={zone}>
                        {zone.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {instants.length > 1 && (
                <label>
                  Time occurs twice
                  <Select value={occurrence} onValueChange={setOccurrence}>
                    <SelectTrigger aria-label="Time occurrence">
                      <SelectValue placeholder="Choose occurrence" />
                    </SelectTrigger>
                    <SelectContent>
                      {instants.map((instant) => (
                        <SelectItem key={instant} value={instant}>
                          {new Intl.DateTimeFormat(undefined, {
                            timeZone,
                            hour: "numeric",
                            minute: "2-digit",
                            timeZoneName: "longOffset",
                          }).format(new Date(instant))}{" "}
                          · {instant}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
              {scheduledAt && (
                <p className="campaign-create-note">
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "full",
                    timeStyle: "long",
                    timeZone,
                  }).format(new Date(scheduledAt))}
                </p>
              )}
              {attempted && scheduleError && (
                <p className="text-destructive text-sm" role="alert">
                  {scheduleError}
                </p>
              )}
            </div>
          )}
          <footer className="campaign-create-actions">
            <Button
              type="button"
              variant="outline"
              disabled={submitting || !!created}
              onClick={() =>
                step
                  ? (setStep(step - 1), setError(""), setAttempted(false))
                  : navigate("/campaigns")
              }
            >
              <ArrowLeft size={16} />
              {step ? "Back" : "Cancel"}
            </Button>
            <div>
              {step < 3 ? (
                <Button onClick={next}>
                  Continue
                  <ChevronRight size={16} />
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={
                      submitting ||
                      (!created &&
                        (!preflight || preflightLoading || !!preflightError))
                    }
                    onClick={() => void submit(false)}
                  >
                    Save draft
                  </Button>
                  <Button
                    disabled={
                      submitting ||
                      (!created &&
                        (!preflight ||
                          preflightLoading ||
                          !!preflightError ||
                          !preflight.eligibleRecipients))
                    }
                    onClick={() => void submit(true)}
                  >
                    {submitting ? (
                      <LoaderCircle className="animate-spin" size={16} />
                    ) : null}
                    {created
                      ? "Retry launch"
                      : delivery === "schedule"
                        ? "Schedule campaign"
                        : "Send now"}
                  </Button>
                </>
              )}
            </div>
          </footer>
        </div>
        <aside className="campaign-create-preview">
          <div className="campaign-create-preview-heading">
            <MessageCircle size={18} />
            <h2>Message preview</h2>
          </div>
          <div className="campaign-create-phone">
            <div className="campaign-create-message">
              {template?.header && <strong>{template.header}</strong>}
              <p>{preview}</p>
              {template?.footer && <small>{template.footer}</small>}
              {templateButtons.map((button, index) => (
                <div className="campaign-create-message-button" key={index}>
                  {button.text}
                </div>
              ))}
            </div>
          </div>
          <dl>
            <div>
              <dt>Account</dt>
              <dd>
                {connections.find((item) => item.id === connectionId)
                  ?.phoneDisplayNumber || "—"}
              </dd>
            </div>
            <div>
              <dt>Template</dt>
              <dd>{template?.templateName || "—"}</dd>
            </div>
            <div>
              <dt>Sample contact</dt>
              <dd>{sample?.fullName || sample?.phone || "—"}</dd>
            </div>
            <div>
              <dt>Audience</dt>
              <dd>
                {contactsLoading ? "Loading…" : `${contacts.length} contacts`}
              </dd>
            </div>
          </dl>
          {missing > 0 && (
            <p className="campaign-create-warning">
              {missing} contacts have missing values
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
