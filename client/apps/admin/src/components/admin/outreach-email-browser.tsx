"use client";

import { useEffect, useMemo, useState } from "react";

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
  const [testTo, setTestTo] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLeadIndex, setTestLeadIndex] = useState<string>("");

  const filteredLeadRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads
      .map((lead, index) => ({ lead, index }))
      .filter(({ lead }) => {
        if (!q) return true;
        return (
          lead.business_name.toLowerCase().includes(q) ||
          lead.subject.toLowerCase().includes(q) ||
          lead.website.toLowerCase().includes(q) ||
          lead.contact_emails.join(" ").toLowerCase().includes(q) ||
          (lead.source_file || "").toLowerCase().includes(q)
        );
      });
  }, [leads, query]);

  const filteredLeads = useMemo(
    () => filteredLeadRows.map((row) => row.lead),
    [filteredLeadRows]
  );

  useEffect(() => {
    if (filteredLeadRows.length === 0) {
      if (testLeadIndex) setTestLeadIndex("");
      return;
    }
    if (!testLeadIndex) {
      setTestLeadIndex(String(filteredLeadRows[0].index));
      return;
    }
    const exists = filteredLeadRows.some((row) => String(row.index) === testLeadIndex);
    if (!exists) {
      setTestLeadIndex(String(filteredLeadRows[0].index));
    }
  }, [filteredLeadRows, testLeadIndex]);

  const selectedTestLead = useMemo(() => {
    if (!testLeadIndex) return null;
    const index = Number(testLeadIndex);
    if (!Number.isInteger(index) || index < 0 || index >= leads.length) return null;
    return leads[index];
  }, [testLeadIndex, leads]);

  async function sendTestEmail() {
    if (!testTo.trim()) {
      setTestResult("Enter a recipient email first.");
      return;
    }
    if (!selectedTestLead) {
      setTestResult("Select a draft first.");
      return;
    }

    setTestSending(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/outreach/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: testTo.trim(),
          subject: selectedTestLead.subject,
          text: selectedTestLead.email_body,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestResult(data?.error || "Failed to send test email.");
      } else {
        setTestResult(
          `Test sent to ${testTo.trim()} using: ${selectedTestLead.business_name}`
        );
      }
    } catch {
      setTestResult("Failed to send test email.");
    } finally {
      setTestSending(false);
    }
  }

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

          <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
            <p className="text-xs text-text-faint">
              Test send: choose the exact draft you want to send.
            </p>
            <select
              value={testLeadIndex}
              onChange={(event) => setTestLeadIndex(event.target.value)}
              disabled={filteredLeadRows.length === 0}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-primary disabled:opacity-40"
            >
              {filteredLeadRows.map(({ lead, index }) => (
                <option key={`${lead.business_name}-${lead.subject}-${index}`} value={String(index)}>
                  {lead.business_name} · {lead.subject}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
                placeholder="your@email.com"
                className="w-full sm:w-80 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={sendTestEmail}
                disabled={testSending || !selectedTestLead}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary-dark disabled:opacity-40"
              >
                {testSending ? "Sending..." : "Send Test"}
              </button>
            </div>
            {selectedTestLead ? (
              <p className="text-xs text-text-muted">
                Selected draft: {selectedTestLead.business_name} · {selectedTestLead.subject}
              </p>
            ) : null}
            {testResult ? <p className="text-xs text-text-muted">{testResult}</p> : null}
          </div>

          <p className="text-xs text-text-faint">
            Showing {filteredLeads.length} of {leads.length} lead drafts
          </p>

          <div className="space-y-3 max-h-[72vh] overflow-y-auto pr-1">
            {filteredLeadRows.map(({ lead, index }) => {
              const key = `${lead.business_name}-${lead.subject}`;
              const open = expanded === key;
              const selectedForTest = testLeadIndex === String(index);
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
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setTestLeadIndex(String(index))}
                        className={`text-xs px-2 py-1 rounded border transition-colors ${
                          selectedForTest
                            ? "border-primary/60 bg-primary/10 text-primary"
                            : "border-border hover:bg-surface-overlay text-text"
                        }`}
                      >
                        {selectedForTest ? "Selected for test" : "Use for test"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : key)}
                        className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-overlay"
                      >
                        {open ? "Hide" : "View"}
                      </button>
                    </div>
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
