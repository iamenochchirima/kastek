"use client";

import { apiUrl } from "@/lib/server-api";
import { Button } from "@/components/ui/button";
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
};

type VariableMapping = {
  source: "static" | "contact";
  key: string;
};

const CONTACT_FIELD_OPTIONS = [
  { value: "fullName", label: "Full name" },
  { value: "phone", label: "Phone" },
  { value: "location", label: "Location" },
  { value: "tags", label: "Tags" },
];

export default function CampaignCreateForm({
  connections,
  templates,
  contacts,
  tagOptions,
}: {
  connections: Connection[];
  templates: Template[];
  contacts: Contact[];
  tagOptions: string[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [connectionId, setConnectionId] = useState(connections[0]?.id || "");
  const [templateId, setTemplateId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [optInStatus, setOptInStatus] = useState("all");
  const [excludedStatus, setExcludedStatus] = useState("active_only");
  const [cooldownStatus, setCooldownStatus] = useState("passed");
  const [audienceMode, setAudienceMode] = useState<"all" | "filters" | "manual">("all");
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([]);
  const [variableMappings, setVariableMappings] = useState<VariableMapping[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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

  const visibleContacts = useMemo(() => {
    const searchNeedle = search.trim().toLowerCase();
    return contacts.filter((contact) => {
      if (searchNeedle) {
        const matchesSearch = [contact.fullName || "", contact.phone, contact.tags.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(searchNeedle);
        if (!matchesSearch) return false;
      }

      if (selectedTags.length > 0) {
        const tagMatch = contact.tags.some((tag) =>
          selectedTags.some((selectedTag) => tag.toLowerCase() === selectedTag.toLowerCase()),
        );
        if (!tagMatch) return false;
      }

      return true;
    });
  }, [contacts, search, selectedTags]);

  const selectedRecipientsPreview = useMemo(() => {
    if (audienceMode !== "manual") return visibleContacts.length;
    return visibleContacts.filter((contact) => selectedRecipientIds.includes(contact.id)).length;
  }, [audienceMode, selectedRecipientIds, visibleContacts]);

  function syncVariableMappings(nextCount: number) {
    setVariableMappings((current) => {
      const next = [...current];
      while (next.length < nextCount) {
        next.push({ source: "contact", key: "fullName" });
      }
      return next.slice(0, nextCount);
    });
  }

  function toggleTag(tag: string) {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag],
    );
  }

  function toggleRecipient(contactId: string) {
    setSelectedRecipientIds((current) =>
      current.includes(contactId)
        ? current.filter((value) => value !== contactId)
        : [...current, contactId],
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setNotice("");

    try {
      if (!name.trim()) {
        throw new Error("Campaign name is required");
      }
      if (!connectionId) {
        throw new Error("Select a WhatsApp connection");
      }
      if (!templateId) {
        throw new Error("Select an approved marketing template");
      }

      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || undefined,
        connectionId,
        templateId,
        scheduledAt: scheduledAt || undefined,
        variableMappings:
          variableMappings.length > 0
            ? variableMappings.map((mapping) => ({
                source: mapping.source,
                key: mapping.key.trim(),
              }))
            : undefined,
      };

      if (audienceMode === "manual") {
        payload.recipientIds = selectedRecipientIds;
      } else if (audienceMode === "filters") {
        payload.audience = {
          search: search.trim() || undefined,
          location: location.trim() || undefined,
          tags: selectedTags,
          optInStatus,
          excludedStatus,
          cooldownStatus,
        };
      }

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

      const createdRecipients = Number(body.createdRecipients || 0);
      setNotice(`Campaign created with ${createdRecipients} eligible recipients.`);
      router.push(
        `/reach/campaigns?notice=${encodeURIComponent(
          `Campaign created with ${createdRecipients} eligible recipients.`,
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
    <form onSubmit={onSubmit} className="space-y-6">
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

      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold text-foreground">Campaign setup</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Campaign name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              placeholder="Winter promo follow-up"
            />
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-muted-foreground">Launch time</span>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
            />
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
                setTemplateId(event.target.value);
                const template = availableTemplates.find(
                  (candidate) => candidate.id === event.target.value,
                );
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

          <label className="space-y-2 text-sm md:col-span-2">
            <span className="text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              placeholder="Internal note about the goal of this campaign."
            />
          </label>
        </div>
      </section>

      {selectedTemplate && selectedTemplate.variablesCount > 0 ? (
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Template variables</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Map each template variable to a contact field or a static value.
          </p>
          <div className="mt-4 space-y-3">
            {Array.from({ length: selectedTemplate.variablesCount }).map((_, index) => {
              const mapping = variableMappings[index] || { source: "contact", key: "fullName" };
              return (
                <div key={index} className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[160px_minmax(0,1fr)]">
                  <div className="text-sm font-medium text-foreground">Variable {index + 1}</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <select
                      value={mapping.source}
                      onChange={(event) => {
                        const nextSource = event.target.value as "static" | "contact";
                        setVariableMappings((current) => {
                          const next = [...current];
                          next[index] = {
                            source: nextSource,
                            key: nextSource === "contact" ? "fullName" : "",
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
                        {CONTACT_FIELD_OPTIONS.map((option) => (
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
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold text-foreground">Audience</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            { value: "all", label: "All contacts" },
            { value: "filters", label: "Use filters" },
            { value: "manual", label: "Choose manually" },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setAudienceMode(option.value as "all" | "filters" | "manual")}
              className={`rounded-full px-4 py-2 text-sm ${
                audienceMode === option.value
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-secondary/60 text-foreground"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {audienceMode !== "all" ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">Search</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                placeholder="Name, phone, or tag"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">Location</span>
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
                placeholder="Cape Town"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">Opt-in</span>
              <select
                value={optInStatus}
                onChange={(event) => setOptInStatus(event.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              >
                <option value="all">All</option>
                <option value="opted_in">Opted in</option>
                <option value="not_opted_in">Not opted in</option>
              </select>
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">Excluded</span>
              <select
                value={excludedStatus}
                onChange={(event) => setExcludedStatus(event.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              >
                <option value="active_only">Active only</option>
                <option value="all">All</option>
                <option value="excluded_only">Excluded only</option>
              </select>
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">Cooldown</span>
              <select
                value={cooldownStatus}
                onChange={(event) => setCooldownStatus(event.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
              >
                <option value="passed">Cooldown passed</option>
                <option value="all">All</option>
                <option value="recent">Recently marketed</option>
              </select>
            </label>
          </div>
        ) : null}

        {tagOptions.length > 0 && audienceMode !== "all" ? (
          <div className="mt-4">
            <div className="mb-2 text-sm text-muted-foreground">Tags</div>
            <div className="flex flex-wrap gap-2">
              {tagOptions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className={`rounded-full px-3 py-1.5 text-xs ${
                    selectedTags.includes(tag)
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-secondary/60 text-foreground"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {audienceMode === "manual" ? (
          <div className="mt-5 space-y-3">
            <p className="text-sm text-muted-foreground">
              Select the exact contacts to receive this campaign.
            </p>
            <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border p-3">
              {visibleContacts.map((contact) => (
                <label key={contact.id} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedRecipientIds.includes(contact.id)}
                    onChange={() => toggleRecipient(contact.id)}
                  />
                  <div>
                    <div className="font-medium text-foreground">
                      {contact.fullName || contact.phone}
                    </div>
                    <div className="text-muted-foreground">
                      {contact.phone}
                      {contact.tags.length ? ` · ${contact.tags.join(", ")}` : ""}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm text-muted-foreground">
          Audience preview:{" "}
          <span className="font-medium text-foreground">{selectedRecipientsPreview}</span> visible
          contact{selectedRecipientsPreview === 1 ? "" : "s"} before final eligibility checks.
        </div>
      </section>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.push("/reach/campaigns")}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating..." : "Create campaign"}
        </Button>
      </div>
    </form>
  );
}
