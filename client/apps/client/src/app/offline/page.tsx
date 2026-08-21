export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="max-w-lg rounded-md border border-border bg-card p-8 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          Offline
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          You&apos;re offline
        </h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">Reconnect to continue.</p>
      </div>
    </main>
  );
}
