"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { buttonClassName } from "@/components/ui/button";
import { adminRequest } from "@/lib/admin-request";

type Attempt = {
  id: string;
  status: string;
  recipients: string[];
  accepted: string[];
  rejected: string[];
  providerMessageId?: string;
};
const fieldClass = "block w-full rounded border border-border bg-background p-2";

export default function OutreachRecovery({ campaignId, leadId, subject, text }: {
  campaignId: string; leadId: string; subject: string; text: string;
}) {
  const router = useRouter();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [evidence, setEvidence] = useState("");
  const [accepted, setAccepted] = useState("");
  const [outcome, setOutcome] = useState("not_submitted");

  async function load() {
    setError("");
    setBusy(true);
    try {
      const response = await adminRequest(`/api/outreach/${campaignId}/leads/${leadId}/send-attempts`);
      setAttempts(await response.json());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load attempts");
    } finally { setBusy(false); }
  }

  async function reconcile(attempt: Attempt) {
    setBusy(true);
    setError("");
    try {
      const list = accepted.split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
      await adminRequest(`/api/outreach/send-attempts/${attempt.id}/reconcile`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          evidence,
          notSubmitted: outcome === "not_submitted",
          accepted: outcome === "smtp" ? list : [],
          rejected: outcome === "smtp" ? attempt.recipients.filter(value => !list.includes(value)) : [],
        }),
      });
      setActiveId(""); setEvidence(""); setAccepted("");
      await load();
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not reconcile");
    } finally { setBusy(false); }
  }

  async function retry(attempt: Attempt) {
    setBusy(true);
    setError("");
    try {
      await adminRequest(`/api/outreach/${campaignId}/leads/${leadId}/send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retryOf: attempt.id, to: attempt.status === "partial" ? attempt.rejected : attempt.recipients, subject, text }),
      });
      await load();
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not retry");
    } finally { setBusy(false); }
  }

  return <Dialog>
    <DialogTrigger className="text-xs underline" onClick={() => void load()}>Send attempts</DialogTrigger>
    <DialogContent>
      <DialogTitle>Send attempts</DialogTitle>
      <DialogDescription>SMTP acceptance is not delivery confirmation.</DialogDescription>
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      {busy && <p role="status">Loading…</p>}
      {!busy && !attempts.length && <p>No attempts</p>}
      {attempts.map(attempt => <div key={attempt.id} className="space-y-3 border-t border-border pt-3">
        <p className="text-sm break-all">{attempt.status} · {attempt.recipients.join(", ")}</p>
        {attempt.providerMessageId && <p className="text-xs break-all">{attempt.providerMessageId}</p>}
        {["submitting", "uncertain"].includes(attempt.status) && (activeId !== attempt.id
          ? <button className={buttonClassName({ size: "sm", variant: "outline" })} disabled={busy} onClick={() => {
            setActiveId(attempt.id); setEvidence(""); setOutcome("not_submitted"); setAccepted(attempt.accepted.join(", "));
          }}>Reconcile</button>
          : <>
            <label className="block text-sm">Verified outcome
              <select className={fieldClass} value={outcome} onChange={event => setOutcome(event.target.value)}>
                <option value="not_submitted">Not submitted</option>
                <option value="smtp">SMTP results</option>
              </select>
            </label>
            {outcome === "smtp" && <label className="block text-sm">Accepted recipients
              <input className={fieldClass} value={accepted} onChange={event => setAccepted(event.target.value)} placeholder="Comma-separated addresses" />
              <span className="text-xs">Other recipients will be recorded as rejected.</span>
            </label>}
            <label className="block text-sm">Provider evidence
              <textarea className={fieldClass} value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={2000} />
            </label>
            <button className={buttonClassName({ size: "sm" })} disabled={busy || !evidence.trim()} onClick={() => void reconcile(attempt)}>Record outcome</button>
          </>)}
        {["not_submitted", "rejected", "partial"].includes(attempt.status) && <button
          className={buttonClassName({ size: "sm", variant: "outline" })}
          disabled={busy || !subject || !text} onClick={() => void retry(attempt)}
        >{attempt.status === "partial" ? "Retry rejected recipients" : "Retry submission"}</button>}
      </div>)}
    </DialogContent>
  </Dialog>;
}
