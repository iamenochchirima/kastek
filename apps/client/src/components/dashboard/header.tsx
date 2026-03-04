export default function DashboardHeader() {
  return (
    <header className="border-b border-border/80 bg-bg/75 px-8 py-4 backdrop-blur-xl max-sm:px-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-dim">Workspace</div>
          <div className="mt-1 text-sm text-text-muted">
            Manage conversations, templates, campaigns, and channel operations.
          </div>
        </div>
      </div>
    </header>
  );
}
