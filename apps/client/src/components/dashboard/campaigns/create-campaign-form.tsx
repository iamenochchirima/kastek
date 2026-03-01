"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type ConnectionOption = {
  id: string;
  phoneDisplayNumber: string | null;
  phoneNumberId: string;
  verified: boolean;
  currentQualityRating: string;
  dailyLimitEstimate: number | null;
};

type TemplateOption = {
  id: string;
  templateName: string;
  language: string;
  status: string;
  variablesCount: number;
};

type ContactOption = {
  id: string;
  fullName: string | null;
  phone: string;
  tags: string[];
  location: string | null;
  optIn: boolean;
  excluded: boolean;
  lastMarketingSent: string | null;
};

type VariableMapping = {
  source: "static" | "contact";
  key: string;
};

const CONTACT_FIELDS = [
  { value: "fullName", label: "Full name" },
  { value: "location", label: "Location" },
  { value: "phone", label: "Phone" },
  { value: "tags", label: "Tags" },
];

function canSendAgain(lastMarketingSent: string | null) {
  if (!lastMarketingSent) return true;
  const then = new Date(lastMarketingSent).getTime();
  const minMs = 10 * 24 * 60 * 60 * 1000;
  return Date.now() - then >= minMs;
}

function matchesAudience(
  contact: ContactOption,
  filters: {
    search: string;
    location: string;
    tags: string[];
    optInStatus: "all" | "opted_in" | "not_opted_in";
    excludedStatus: "all" | "active_only" | "excluded_only";
    cooldownStatus: "all" | "passed" | "recent";
  }
) {
  const query = filters.search.trim().toLowerCase();
  if (query) {
    const haystack = [
      contact.fullName || "",
      contact.phone,
      contact.location || "",
      contact.tags.join(" "),
    ]
      .join(" ")
      .toLowerCase();

    if (!haystack.includes(query)) return false;
  }

  if (
    filters.location.trim() &&
    !(contact.location || "").toLowerCase().includes(filters.location.trim().toLowerCase())
  ) {
    return false;
  }

  if (filters.tags.length > 0 && !filters.tags.some((tag) => contact.tags.includes(tag))) {
    return false;
  }

  if (filters.optInStatus === "opted_in" && !contact.optIn) return false;
  if (filters.optInStatus === "not_opted_in" && contact.optIn) return false;
  if (filters.excludedStatus === "active_only" && contact.excluded) return false;
  if (filters.excludedStatus === "excluded_only" && !contact.excluded) return false;

  const cooldownPassed = canSendAgain(contact.lastMarketingSent);
  if (filters.cooldownStatus === "passed" && !cooldownPassed) return false;
  if (filters.cooldownStatus === "recent" && cooldownPassed) return false;

  return true;
}

export default function CreateCampaignForm({
  connections,
  templates,
  contacts,
}: {
  connections: ConnectionOption[];
  templates: TemplateOption[];
  contacts: ContactOption[];
}) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [connectionId, setConnectionId] = useState(connections[0]?.id || "");
  const [templateId, setTemplateId] = useState(templates[0]?.id || "");
  const [scheduleAt, setScheduleAt] = useState("");
  const [useAllEligible, setUseAllEligible] = useState(true);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [launchNow, setLaunchNow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audienceSearch, setAudienceSearch] = useState("");
  const [audienceLocation, setAudienceLocation] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [optInStatus, setOptInStatus] = useState<"all" | "opted_in" | "not_opted_in">("opted_in");
  const [excludedStatus, setExcludedStatus] = useState<"all" | "active_only" | "excluded_only">(
    "active_only"
  );
  const [cooldownStatus, setCooldownStatus] = useState<"all" | "passed" | "recent">("passed");

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [defaultOptIn, setDefaultOptIn] = useState(true);
  const [importing, setImporting] = useState(false);

  const selectedTemplate = templates.find((template) => template.id === templateId);

  const [variableMappings, setVariableMappings] = useState<VariableMapping[]>(
    selectedTemplate?.variablesCount
      ? Array.from({ length: selectedTemplate.variablesCount }, () => ({
          source: "contact",
          key: "fullName",
        }))
      : []
  );

  const tagOptions = useMemo(
    () => Array.from(new Set(contacts.flatMap((contact) => contact.tags))).sort((a, b) => a.localeCompare(b)),
    [contacts]
  );

  const audienceContacts = useMemo(() => {
    return contacts.filter((contact) =>
      matchesAudience(contact, {
        search: audienceSearch,
        location: audienceLocation,
        tags: selectedTags,
        optInStatus,
        excludedStatus,
        cooldownStatus,
      })
    );
  }, [audienceLocation, audienceSearch, contacts, cooldownStatus, excludedStatus, optInStatus, selectedTags]);

  const eligibleContacts = useMemo(() => {
    return audienceContacts.filter(
      (contact) => contact.optIn && !contact.excluded && canSendAgain(contact.lastMarketingSent)
    );
  }, [audienceContacts]);

  const visibleContacts = useAllEligible
    ? eligibleContacts
    : eligibleContacts.filter((contact) => selectedContactIds.includes(contact.id));

  const selectedConnection = connections.find((connection) => connection.id === connectionId);

  function onTemplateChange(nextTemplateId: string) {
    setTemplateId(nextTemplateId);
    const template = templates.find((item) => item.id === nextTemplateId);
    const count = template?.variablesCount || 0;

    setVariableMappings(
      count
        ? Array.from({ length: count }, () => ({
            source: "contact",
            key: "fullName",
          }))
        : []
    );
  }

  function toggleContact(id: string) {
    setSelectedContactIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

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

  async function submitCampaign() {
    if (!name.trim()) {
      setError("Campaign name is required.");
      return;
    }

    if (!connectionId) {
      setError("Select a WhatsApp connection.");
      return;
    }

    if (!templateId) {
      setError("Select an approved marketing template.");
      return;
    }

    if (!useAllEligible && selectedContactIds.length === 0) {
      setError("Pick at least one recipient or use all eligible contacts.");
      return;
    }

    setSubmitting(true);
    setError("");
    setNotice("");

    try {
      const createRes = await fetch("/api/whatsapp/campaigns", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          connectionId,
          templateId,
          recipientIds: useAllEligible ? undefined : selectedContactIds,
          audience: useAllEligible
            ? {
                search: audienceSearch || undefined,
                location: audienceLocation || undefined,
                tags: selectedTags,
                optInStatus,
                excludedStatus,
                cooldownStatus,
              }
            : undefined,
          scheduledAt: scheduleAt || undefined,
          variableMappings,
        }),
      });

      const createBody = await createRes.json();
      if (!createRes.ok) {
        throw new Error(createBody.error || "Failed to create campaign");
      }

      const campaignId = createBody.campaign.id as string;

      if (launchNow) {
        const launchRes = await fetch(`/api/whatsapp/campaigns/${campaignId}/launch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scheduledAt: scheduleAt || undefined,
          }),
        });

        const launchBody = await launchRes.json();
        if (!launchRes.ok) {
          throw new Error(launchBody.error || "Campaign created, but launch failed");
        }
      }

      router.push(`/dashboard/campaigns/${campaignId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
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

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">Campaign setup</h2>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Campaign name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="March Special Promo"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            />
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Schedule (optional)</span>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(event) => setScheduleAt(event.target.value)}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            />
          </label>
        </div>

        <label className="mt-4 block space-y-2 text-sm">
          <span className="text-text-muted">Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="Seasonal offer for opted-in clients"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
          />
        </label>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="text-text-muted">WhatsApp connection</span>
            <select
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {(connection.phoneDisplayNumber || connection.phoneNumberId) +
                    ` · ${connection.currentQualityRating}`}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Approved template</span>
            <select
              value={templateId}
              onChange={(event) => onTemplateChange(event.target.value)}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.templateName} ({template.language})
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedConnection?.dailyLimitEstimate && (
          <p className="mt-3 text-xs text-text-muted">
            Estimated daily portfolio limit: {selectedConnection.dailyLimitEstimate} recipients.
          </p>
        )}
      </section>

      {selectedTemplate && selectedTemplate.variablesCount > 0 && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold">Template variable mapping</h2>
          <div className="space-y-3">
            {variableMappings.map((mapping, index) => (
              <div key={index} className="grid gap-3 md:grid-cols-[120px_1fr]">
                <select
                  value={mapping.source}
                  onChange={(event) => {
                    const next = [...variableMappings];
                    const source = event.target.value as "static" | "contact";
                    next[index] = {
                      source,
                      key: source === "contact" ? "fullName" : "",
                    };
                    setVariableMappings(next);
                  }}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
                >
                  <option value="contact">Contact</option>
                  <option value="static">Static</option>
                </select>

                {mapping.source === "contact" ? (
                  <select
                    value={mapping.key}
                    onChange={(event) => {
                      const next = [...variableMappings];
                      next[index] = { ...next[index], key: event.target.value };
                      setVariableMappings(next);
                    }}
                    className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
                  >
                    {CONTACT_FIELDS.map((field) => (
                      <option key={field.value} value={field.value}>
                        Var {index + 1}: {field.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={mapping.key}
                    onChange={(event) => {
                      const next = [...variableMappings];
                      next[index] = { ...next[index], key: event.target.value };
                      setVariableMappings(next);
                    }}
                    placeholder={`Static value for var ${index + 1}`}
                    className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">Audience segmentation</h2>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Search</span>
            <input
              value={audienceSearch}
              onChange={(event) => setAudienceSearch(event.target.value)}
              placeholder="Name, phone, tag, location"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            />
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Location</span>
            <input
              value={audienceLocation}
              onChange={(event) => setAudienceLocation(event.target.value)}
              placeholder="Johannesburg"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            />
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Opt-in filter</span>
            <select
              value={optInStatus}
              onChange={(event) =>
                setOptInStatus(event.target.value as "all" | "opted_in" | "not_opted_in")
              }
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            >
              <option value="opted_in">Opted in only</option>
              <option value="all">All contacts</option>
              <option value="not_opted_in">Not opted in only</option>
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Exclusion filter</span>
            <select
              value={excludedStatus}
              onChange={(event) =>
                setExcludedStatus(event.target.value as "all" | "active_only" | "excluded_only")
              }
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            >
              <option value="active_only">Active only</option>
              <option value="all">All contacts</option>
              <option value="excluded_only">Excluded only</option>
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="text-text-muted">Recent-send cooldown</span>
            <select
              value={cooldownStatus}
              onChange={(event) =>
                setCooldownStatus(event.target.value as "all" | "passed" | "recent")
              }
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text outline-none ring-accent/30 focus:ring"
            >
              <option value="passed">Passed cooldown only</option>
              <option value="all">All contacts</option>
              <option value="recent">Recent sends only</option>
            </select>
          </label>
        </div>

        {tagOptions.length > 0 ? (
          <div className="mt-4 space-y-2 text-sm">
            <span className="block text-text-muted">Tags</span>
            <div className="flex flex-wrap gap-2">
              {tagOptions.map((tag) => {
                const active = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() =>
                      setSelectedTags((prev) =>
                        prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]
                      )
                    }
                    className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-surface-2 text-text-muted"
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <p className="mt-4 text-xs text-text-muted">
          Audience matches: {audienceContacts.length} contacts. Eligible after WhatsApp marketing
          safety checks: {eligibleContacts.length}.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Recipients ({eligibleContacts.length} eligible)</h2>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={useAllEligible}
              onChange={(event) => setUseAllEligible(event.target.checked)}
            />
            Use all eligible contacts
          </label>
        </div>

        {!useAllEligible && (
          <div className="max-h-64 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Select</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Phone</th>
                  <th className="px-3 py-2 text-left">Location</th>
                  <th className="px-3 py-2 text-left">Tags</th>
                </tr>
              </thead>
              <tbody>
                {eligibleContacts.map((contact) => (
                  <tr key={contact.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedContactIds.includes(contact.id)}
                        onChange={() => toggleContact(contact.id)}
                      />
                    </td>
                    <td className="px-3 py-2">{contact.fullName || "-"}</td>
                    <td className="px-3 py-2">{contact.phone}</td>
                    <td className="px-3 py-2">{contact.location || "-"}</td>
                    <td className="px-3 py-2">{contact.tags.join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {useAllEligible && (
          <p className="text-sm text-text-muted">
            This campaign will target all audience-matched contacts that are still eligible under
            opt-in, exclusion, and 10-day cooldown rules.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-3 text-sm font-semibold">Import contacts (CSV)</h2>
        <p className="mb-3 text-xs text-text-muted">
          Import phone, name, tags, location, and opt-in columns. Numbers are normalized to E.164.
        </p>

        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setCsvFile(event.target.files?.[0] || null)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
          />

          <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted">
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
            className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:border-border-light disabled:opacity-60"
          >
            {importing ? "Importing..." : "Import CSV"}
          </button>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={launchNow}
            onChange={(event) => setLaunchNow(event.target.checked)}
          />
          Launch immediately after create
        </label>

        <button
          type="button"
          onClick={submitCampaign}
          disabled={submitting || !connections.length || !templates.length}
          className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-bg transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)] disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {submitting ? "Saving..." : launchNow ? "Create & Launch" : "Create Campaign"}
        </button>
      </section>

      {!connections.length || !templates.length ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          You need at least one WhatsApp connection and one approved marketing template before you
          can create a campaign.{" "}
          {!connections.length ? (
            <Link href="/dashboard/settings" className="underline hover:text-amber-200">
              Connect WhatsApp in Settings
            </Link>
          ) : null}
        </div>
      ) : null}

      {visibleContacts.length === 0 && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          No eligible contacts yet. Import contacts and ensure they are opted-in.
        </div>
      )}
    </div>
  );
}
