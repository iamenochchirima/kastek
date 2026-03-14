export default function Dashboard2SettingsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-muted-foreground">Prototype settings surface for the new dashboard.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5">Workspace Theme</div>
          <div className="rounded-2xl border border-border bg-card p-5">Campaign Defaults</div>
          <div className="rounded-2xl border border-border bg-card p-5">Connection Health</div>
          <div className="rounded-2xl border border-border bg-card p-5">Fallback Alerts</div>
        </div>
      </div>
    </div>
  );
}
