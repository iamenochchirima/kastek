const runbooks = [
  ["Provider or model outage", "Check provider_workers, health, and alerts; pause only the affected scope and reconcile unknown effects after provider outcome is known."],
  ["Queue backlog or stuck run", "Compare run health with Temporal readiness; cancel only the affected run when safe and rebuild projections after recovery."],
  ["Duplicate or ambiguous effect", "Do not invoke the provider again; use the dual-control reconcile command and keep provider receipts redacted."],
  ["Credential compromise or data access", "Revoke the affected credential or support grant, use the shortest scoped grant, and preserve the audit trail."],
  ["Webhook or delivery storm", "Inspect failed or unknown deliveries, pause only the affected scope, and never replay without an idempotency key and incident reason."],
] as const;

export function OperatorRunbooks() {
  return <section id="operator-runbooks" className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Incident runbooks</h2><p className="mt-1 text-xs text-muted-foreground">Safe response guidance uses identifiers and projection state only; never copy prompts, tokens, credentials, or raw customer payloads.</p></div><div className="divide-y divide-border">{runbooks.map(([title, guidance]) => <details key={title} className="group px-5 py-3"><summary className="cursor-pointer list-none text-sm font-medium text-foreground">{title}<span className="float-right text-muted-foreground group-open:rotate-90">›</span></summary><p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">{guidance}</p></details>)}</div></section>;
}
