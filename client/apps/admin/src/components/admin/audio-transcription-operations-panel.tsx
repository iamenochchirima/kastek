"use client";

import { StatusBadge } from "@/components/admin/status-badge";
import { OperatorAudioTranscriptionDeleteButton, OperatorAudioTranscriptionRetryButton } from "@/components/admin/operator-command-button";

type AudioTranscriptionJob = {
  id: string;
  organization_id: string;
  installation_id: string;
  asset_id: string;
  dispatch_kind: string;
  status: string;
  attempt_count: number;
  error_code?: string | null;
  created_at: string;
};

export function AudioTranscriptionOperationsPanel({ jobs, canCommand }: { jobs: AudioTranscriptionJob[]; canCommand: boolean }) {
  return <article className="v-card overflow-hidden">
    <div className="border-b border-border px-5 py-4">
      <h2 className="text-sm font-semibold text-foreground">Audio transcription jobs</h2>
      <p className="mt-1 text-xs text-muted-foreground">Safe job state only; audio, transcripts, provider payloads, and storage keys stay out of the operator list.</p>
    </div>
    {jobs.length === 0 ? <p className="px-5 py-8 text-sm text-muted-foreground">No audio transcription jobs have been recorded.</p> : <div className="divide-y divide-border">
      {jobs.map((job) => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-foreground">{job.id}</p>
          <p className="truncate text-[11px] text-muted-foreground">{job.organization_id} · {job.dispatch_kind} · attempt {job.attempt_count} · {new Date(job.created_at).toLocaleString()}</p>
          {job.error_code ? <p className="truncate text-[11px] text-destructive">{job.error_code}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge value={job.status} />
          {canCommand && ["failed", "retryable_failed"].includes(job.status) ? <OperatorAudioTranscriptionRetryButton jobId={job.id} status={job.status} expectedOrganizationId={job.organization_id} expectedInstallationId={job.installation_id} /> : null}
          {canCommand && ["completed", "failed", "retryable_failed"].includes(job.status) ? <OperatorAudioTranscriptionDeleteButton jobId={job.id} status={job.status} expectedOrganizationId={job.organization_id} expectedInstallationId={job.installation_id} /> : null}
        </div>
      </div>)}
    </div>}
  </article>;
}
