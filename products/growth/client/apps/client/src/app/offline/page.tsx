import { MotionReveal } from "@/components/ui/motion-reveal";

export default function OfflinePage() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-12 text-foreground sm:px-6 sm:py-16">
      <MotionReveal>
      <div className="max-w-lg rounded-md border border-border bg-card p-6 text-center shadow-[0_24px_80px_rgb(0_0_0_/_0.18)] sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          Offline
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          You&apos;re offline
        </h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">Reconnect to continue.</p>
      </div>
      </MotionReveal>
    </main>
  );
}
