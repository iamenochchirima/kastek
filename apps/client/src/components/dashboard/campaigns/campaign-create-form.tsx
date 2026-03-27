"use client";

import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/server-api";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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

type VariableMapping = {
  source: "static" | "contact";
  key: string;
};

type Step = "setup" | "confirm";

const BASE_FIELDS = [
  { value: "fullName", label: "Full name" },
  { value: "phone", label: "Phone" },
  { value: "location", label: "Location" },
  { value: "tags", label: "Tags" },
];

function formatLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractListRunSuffix(listLabel: string) {
  const match = listLabel.match(/(\d{4}-\d{2}-\d{2}-run-\d+)$/i);
  return match?.[1] || "";
}

function stripListRunSuffix(value: string) {
  return value.replace(/-\d{4}-\d{2}-\d{2}-run-\d+$/i, "").trim();
}

function buildCampaignName(baseName: string, listLabel: string) {
  const normalizedBase = stripListRunSuffix(baseName.trim());
  const suffix = extractListRunSuffix(listLabel);
  if (!normalizedBase) return "";
  if (!suffix) return normalizedBase;
  return `${normalizedBase}-${suffix}`;
}

function resolvePreviewValue(contact: Contact | null, mapping: VariableMapping) {
  if (!contact) return "";
  if (mapping.source === "static") return mapping.key;
  switch (mapping.key) {
    case "fullName":
      return contact.fullName || "";
    case "phone":
      return contact.phone;
    case "location":
      return contact.location || "";
    case "tags":
      return contact.tags.join(", ");
    default:
      return contact.metadata?.[mapping.key] || "";
  }
}

export default function CampaignCreateForm({
  connections,
  templates,
  contacts,
  lists,
}: {
  connections: Connection[];
  templates: Template[];
  contacts: Contact[];
  lists: ContactListSummary[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("setup");
  const [baseName, setBaseName] = useState("");
  const [description, setDescription] = useState("");
  const [connectionId, setConnectionId] = useState(connections[0]?.id || "");
  const [templateId, setTemplateId] = useState("");
  const [listLabel, setListLabel] = useState(lists[0]?.label || "default");
  const [batchSize, setBatchSize] = useState("200");
  const [search, setSearch] = useState("");
  const [excludedContactIds, setExcludedContactIds] = useState<string[]>([]);
  const [variableMappings, setVariableMappings] = useState<VariableMapping[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const availableTemplates = useMemo(() => {
    return templates.filter(
      (template) =>
        template.category === "MARKETING" &&
        template.status === "APPROVED" &&
        (!connectionId || !template.connectionId || template.connectionId === connectionId),
    );
  }, [connectionId, templates]);

  const selectedTemplate = useMemo(
    () => availableTemplates.find((template) => template.id === templateId) || null,
    [availableTemplates, templateId],
  );

  const selectedList = useMemo(
    () => lists.find((list) => list.label === listLabel) || null,
    [listLabel, lists],
  );

  const listContacts = useMemo(
    () => contacts.filter((contact) => contact.listLabel === listLabel),
    [contacts, listLabel],
  );

  const availableFieldOptions = useMemo(() => {
    const metadataKeys = selectedList?.metadataKeys || [];
    return [
      ...BASE_FIELDS,
      ...metadataKeys.map((key) => ({ value: key, label: formatLabel(key) })),
    ];
  }, [selectedList]);

  const searchableContacts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return listContacts.filter((contact) => {
      if (!needle) return true;
      const metadataText = Object.values(contact.metadata || {}).join(" ");
      return [contact.fullName || "", contact.phone, contact.location || "", metadataText]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [listContacts, search]);

  const excludedContacts = useMemo(
    () => listContacts.filter((contact) => excludedContactIds.includes(contact.id)),
    [excludedContactIds, listContacts],
  );

  const sampleContact = listContacts[0] || null;
  const eligibleCount = Math.max(listContacts.length - excludedContactIds.length, 0);
  const selectedBatchSize = Math.min(
    Math.max(Number.parseInt(batchSize || "0", 10) || 0, 0),
    eligibleCount,
  );
  const generatedCampaignName = useMemo(
    () => buildCampaignName(baseName, listLabel),
    [baseName, listLabel],
  );

  const previewBody = useMemo(() => {
    if (!selectedTemplate?.body) return "Preview unavailable.";
    let preview = selectedTemplate.body;
    variableMappings.forEach((mapping, index) => {
      const value = resolvePreviewValue(sampleContact, mapping) || `{{${index + 1}}}`;
      const matcher = new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, "g");
      preview = preview.replace(matcher, value);
    });
    return preview;
  }, [sampleContact, selectedTemplate, variableMappings]);

  function syncVariableMappings(nextCount: number, fields = availableFieldOptions) {
    setVariableMappings((current) => {
      const next = [...current];
      const defaultField = fields[0]?.value || "fullName";
      while (next.length < nextCount) {
        next.push({ source: "contact", key: defaultField });
      }
      return next.slice(0, nextCount);
    });
  }

  function toggleExcluded(contactId: string) {
    setExcludedContactIds((current) =>
      current.includes(contactId)
        ? current.filter((value) => value !== contactId)
        : [...current, contactId],
    );
  }

  function validateSetup() {
    if (!baseName.trim()) return "Campaign name is required";
    if (!connectionId) return "Select a WhatsApp connection";
    if (!templateId) return "Select an approved marketing template";
    if (!listLabel) return "Select a contact list";
    if (eligibleCount <= 0) return "This contact list has no eligible contacts left";
    if (selectedBatchSize <= 0) return "Enter how many contacts to send to";
    return "";
  }

  async function createCampaign() {
    setSubmitting(true);
    setError("");

    try {
      const validationError = validateSetup();
      if (validationError) throw new Error(validationError);

      const payload = {
        name: generatedCampaignName,
        description: description.trim() || undefined,
        connectionId,
        templateId,
        listLabel,
        batchSize: selectedBatchSize,
        excludedContactIds,
        variableMappings: variableMappings.map((mapping) => ({
          source: mapping.source,
          key: mapping.key.trim(),
        })),
      };

      const res = await fetch(apiUrl("/api/whatsapp/campaigns"), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Failed to create campaign");
      }

      router.push(
        `/reach/campaigns?notice=${encodeURIComponent(
          `Campaign queued for ${body.createdRecipients || selectedBatchSize} contacts from ${listLabel}.`,
        )}`,
      );
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create campaign");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold text-foreground">Campaign setup</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Campaign base name</span>
            <input
              value={baseName}
              onChange={(event) => setBaseName(event.target.value)}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              placeholder="website-outreach-kasitek"
            />
            <p className="text-xs text-muted-foreground">
              The selected list&apos;s date/run suffix is appended automatically.
            </p>
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Connection</span>
            <select
              value={connectionId}
              onChange={(event) => {
                setConnectionId(event.target.value);
                setTemplateId("");
              }}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.phoneDisplayNumber || connection.phoneNumberId}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Template</span>
            <select
              value={templateId}
              onChange={(event) => {
                const nextTemplateId = event.target.value;
                setTemplateId(nextTemplateId);
                const template = availableTemplates.find((candidate) => candidate.id === nextTemplateId);
                syncVariableMappings(template?.variablesCount || 0);
              }}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
            >
              <option value="">Select an approved template</option>
              {availableTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.templateName} ({template.connectionLabel})
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Contact list</span>
            <select
              value={listLabel}
              onChange={(event) => {
                setListLabel(event.target.value);
                setExcludedContactIds([]);
              }}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
            >
              {lists.map((list) => (
                <option key={list.label} value={list.label}>
                  {list.label} ({list.totalContacts})
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">How many to send now</span>
            <input
              type="number"
              min={1}
              max={eligibleCount || 1}
              value={batchSize}
              onChange={(event) => setBatchSize(event.target.value)}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
            />
          </label>

          <label className="space-y-2 text-sm md:col-span-2">
            <span className="text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              placeholder="Internal note about this campaign."
            />
          </label>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-secondary/20 p-4">
            <div className="text-xs text-muted-foreground">Generated campaign name</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{generatedCampaignName || "-"}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/20 p-4">
            <div className="text-xs text-muted-foreground">Selected list</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{listLabel}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/20 p-4">
            <div className="text-xs text-muted-foreground">Available now</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{eligibleCount}</div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/20 p-4">
            <div className="text-xs text-muted-foreground">This batch</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{selectedBatchSize}</div>
          </div>
        </div>
      </section>

      {selectedTemplate && selectedTemplate.variablesCount > 0 ? (
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Template variables</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Map each template variable to a field from the selected contact list or to static text.
          </p>

          <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
            <div className="rounded-xl border border-border p-4">
              <p className="mb-4 text-sm text-muted-foreground">
                Available fields for <span className="font-semibold text-foreground">{listLabel}</span>:{" "}
                {availableFieldOptions.map((field) => field.label).join(", ")}
              </p>
              <div className="space-y-3">
                {Array.from({ length: selectedTemplate.variablesCount }).map((_, index) => {
                  const mapping = variableMappings[index] || {
                    source: "contact",
                    key: availableFieldOptions[0]?.value || "fullName",
                  };
                  return (
                    <div
                      key={index}
                      className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)]"
                    >
                      <div className="text-sm font-medium text-foreground">Variable {index + 1}</div>
                      <select
                        value={mapping.source}
                        onChange={(event) => {
                          const nextSource = event.target.value as "static" | "contact";
                          setVariableMappings((current) => {
                            const next = [...current];
                            next[index] = {
                              source: nextSource,
                              key: nextSource === "contact" ? availableFieldOptions[0]?.value || "fullName" : "",
                            };
                            return next;
                          });
                        }}
                        className="rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                      >
                        <option value="contact">Contact field</option>
                        <option value="static">Static text</option>
                      </select>
                      {mapping.source === "contact" ? (
                        <select
                          value={mapping.key}
                          onChange={(event) => {
                            const key = event.target.value;
                            setVariableMappings((current) => {
                              const next = [...current];
                              next[index] = { source: "contact", key };
                              return next;
                            });
                          }}
                          className="rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                        >
                          {availableFieldOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={mapping.key}
                          onChange={(event) => {
                            const key = event.target.value;
                            setVariableMappings((current) => {
                              const next = [...current];
                              next[index] = { source: "static", key };
                              return next;
                            });
                          }}
                          className="rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                          placeholder="Static replacement text"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-border p-4">
              <div className="rounded-[1.25rem] border border-border bg-[#111513] p-4">
                <div className="rounded-[1.25rem] border border-[#5d7e31] bg-[#22361f] px-5 py-6 text-[1.05rem] leading-9 text-[#f3f1d9] shadow-[inset_0_0_0_1px_rgba(121,159,61,0.18)]">
                  <div className="whitespace-pre-wrap">{previewBody}</div>
                  <div className="mt-6 text-right text-xs uppercase tracking-[0.35em] text-[#d7c98f]">
                    Preview
                  </div>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Preview contact: {sampleContact?.phone || "No contacts in this list yet"}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Exclude specific numbers</h2>
            <p className="text-sm text-muted-foreground">
              Search inside the selected list and remove specific recipients from this campaign.
            </p>
          </div>
          <div className="text-sm text-muted-foreground">Excluded: {excludedContactIds.length}</div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, phone, or field value"
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground"
            />
            <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-xl border border-border p-3">
              {searchableContacts.map((contact) => {
                const isExcluded = excludedContactIds.includes(contact.id);
                return (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{contact.fullName || contact.phone}</div>
                      <div className="truncate text-sm text-muted-foreground">
                        {contact.phone}
                        {contact.location ? ` · ${contact.location}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleExcluded(contact.id)}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                        isExcluded
                          ? "border border-red-500/30 bg-red-500/10 text-red-200"
                          : "border border-border bg-secondary/60 text-foreground"
                      }`}
                    >
                      {isExcluded ? "Excluded" : "Exclude"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-border p-4">
            <h3 className="text-sm font-semibold text-foreground">Excluded numbers</h3>
            <div className="mt-3 space-y-2">
              {excludedContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No excluded contacts yet.</p>
              ) : (
                excludedContacts.map((contact) => (
                  <div key={contact.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {contact.fullName || contact.phone}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{contact.phone}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleExcluded(contact.id)}
                      className="rounded-md border border-border bg-secondary/60 px-2.5 py-1 text-xs text-foreground"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {step === "setup" ? (
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/reach/campaigns")}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              const validationError = validateSetup();
              if (validationError) {
                setError(validationError);
                return;
              }
              setError("");
              setStep("confirm");
            }}
          >
            Continue
          </Button>
        </div>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Confirm campaign</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryItem label="Campaign" value={generatedCampaignName} />
            <SummaryItem label="List" value={listLabel} />
            <SummaryItem label="Send now" value={String(selectedBatchSize)} />
            <SummaryItem label="Excluded" value={String(excludedContactIds.length)} />
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setStep("setup")}>
              Back
            </Button>
            <Button type="button" disabled={submitting} onClick={createCampaign}>
              {submitting ? "Creating..." : "Create campaign"}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold text-foreground">{value || "-"}</div>
    </div>
  );
}
