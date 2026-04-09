export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-xl shadow-black/10">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          Offline
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          You&apos;re offline right now.
        </h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          KasiTek can still open cached pages and assets, but live dashboard data,
          inbox activity, and publishing actions need a connection.
        </p>
      </div>
    </main>
  );
}
