"use client";

import { useMemo, useState } from "react";

type FileOption = {
  key: string;
  label: string;
  leadCount: number;
  generatedOn?: string;
};

type LeadItem = {
  business_name: string;
  website: string;
  contact_emails: string[];
  subject: string;
  email_body: string;
  fit_assessment?: string;
  source_file?: string;
};

export default function OutreachEmailBrowser({
  files,
  selectedFile,
  selectedFileLabel,
  leads,
}: {
  files: FileOption[];
  selectedFile: string;
  selectedFileLabel?: string;
  leads: LeadItem[];
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [isReaderOpen, setIsReaderOpen] = useState(false);

  const filteredLeads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((lead) => {
      return (
        lead.business_name.toLowerCase().includes(q) ||
        lead.subject.toLowerCase().includes(q) ||
        lead.website.toLowerCase().includes(q) ||
        lead.contact_emails.join(" ").toLowerCase().includes(q) ||
        (lead.source_file || "").toLowerCase().includes(q)
      );
    });
  }, [leads, query]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[320px,1fr]">
        <section className="rounded-xl border border-border bg-surface-raised p-4 space-y-3">
          <h2 className="text-base font-semibold text-text">JSON Sources</h2>
          <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
            {files.map((file) => {
              const active = file.key === selectedFile;
              return (
                <a
                  key={file.key}
                  href={`/outreach/drafts?file=${encodeURIComponent(file.key)}`}
                  className={`block rounded-lg border px-3 py-2 transition-colors ${
                    active
                      ? "border-primary/50 bg-primary/10"
                      : "border-border hover:bg-surface-overlay"
                  }`}
                >
                  <p className="text-sm text-text font-medium truncate">{file.label}</p>
                  <p className="text-xs text-text-faint mt-1">
                    {file.leadCount} lead{file.leadCount === 1 ? "" : "s"}
                    {file.generatedOn ? ` · ${file.generatedOn}` : ""}
                  </p>
                </a>
              );
            })}
            {files.length === 0 ? (
              <p className="text-sm text-text-faint">No outreach JSON files found.</p>
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-surface-raised p-4 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-text">Draft Emails</h2>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search business, subject, website, email, source file"
                className="w-full sm:w-80 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => setIsReaderOpen(true)}
                disabled={leads.length === 0}
                className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs text-text hover:bg-surface-overlay disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Read All
              </button>
            </div>
          </div>

          <p className="text-xs text-text-faint">
            Showing {filteredLeads.length} of {leads.length} lead drafts
          </p>

          <div className="space-y-3 max-h-[72vh] overflow-y-auto pr-1">
            {filteredLeads.map((lead) => {
              const key = `${lead.business_name}-${lead.subject}`;
              const open = expanded === key;
              return (
                <article key={key} className="rounded-lg border border-border bg-surface p-3 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-text">{lead.business_name}</h3>
                      {lead.website ? (
                        <a
                          href={lead.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary break-all hover:underline"
                        >
                          {lead.website}
                        </a>
                      ) : (
                        <p className="text-xs text-text-faint break-all">No website</p>
                      )}
                      <p className="text-xs text-text-faint break-all">
                        {lead.contact_emails.join(", ") || "No contact email"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : key)}
                      className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-overlay"
                    >
                      {open ? "Hide" : "View"}
                    </button>
                  </div>

                  <p className="text-sm text-text font-medium">{lead.subject}</p>
                  {lead.source_file ? (
                    <p className="text-xs text-text-faint break-all">Source: {lead.source_file}</p>
                  ) : null}
                  {lead.fit_assessment ? (
                    <p className="text-xs text-text-muted">Fit: {lead.fit_assessment}</p>
                  ) : null}

                  {open ? (
                    <pre className="text-xs leading-5 whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 overflow-x-auto text-text">
                      {lead.email_body}
                    </pre>
                  ) : null}
                </article>
              );
            })}

            {filteredLeads.length === 0 ? (
              <p className="text-sm text-text-faint">No leads match your search.</p>
            ) : null}
          </div>
        </section>
      </div>

      {isReaderOpen ? (
        <div className="fixed inset-0 z-50 bg-black/65 p-4 sm:p-6">
          <div className="mx-auto h-full max-w-5xl rounded-xl border border-border bg-surface-raised flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-text">Email Reader</h3>
                <p className="text-xs text-text-faint">
                  {selectedFileLabel || selectedFile} · {leads.length} email draft
                  {leads.length === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsReaderOpen(false)}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-overlay"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {leads.map((lead, index) => (
                <article key={`${lead.business_name}-${lead.subject}-${index}`} className="rounded-lg border border-border bg-surface p-3 space-y-2">
                  <div>
                    <p className="text-xs text-text-faint">#{index + 1}</p>
                    <h4 className="text-sm font-semibold text-text">{lead.business_name}</h4>
                    <p className="text-xs text-text-faint break-all">{lead.contact_emails.join(", ") || "No contact email"}</p>
                  </div>
                  <p className="text-sm font-medium text-text">{lead.subject}</p>
                  <pre className="text-xs leading-5 whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 overflow-x-auto text-text">
                    {lead.email_body}
                  </pre>
                </article>
              ))}
              {leads.length === 0 ? (
                <p className="text-sm text-text-faint">No email drafts in this source file.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
