import { Skeleton } from "@/components/ui/skeleton";

function AutomationPageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">{children}</div>
    </div>
  );
}

function AutomationPageHeader({ action = false }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-3xl space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-[min(440px,100%)]" />
      </div>
      {action ? <Skeleton className="h-10 w-36 rounded-md" /> : null}
    </div>
  );
}

export function AgentsPageSkeleton() {
  return (
    <AutomationPageFrame>
      <AutomationPageHeader action />

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Loading agent overview">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-xl border border-border bg-card p-5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-5 h-8 w-12" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </section>

      <section className="mt-7 grid gap-4 lg:grid-cols-2" aria-label="Loading agents">
        {Array.from({ length: 2 }).map((_, index) => (
          <article key={index} className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <Skeleton className="mt-6 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-4/5" />
            <div className="mt-6 flex gap-3 border-t border-border pt-4">
              <Skeleton className="h-8 w-20 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </article>
        ))}
      </section>
    </AutomationPageFrame>
  );
}

export function AgentTemplatesPageSkeleton() {
  return (
    <AutomationPageFrame>
      <AutomationPageHeader />

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading agent templates">
        {Array.from({ length: 6 }).map((_, index) => (
          <article key={index} className="min-h-64 rounded-xl border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-3">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="mt-8 h-5 w-44" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-4/5" />
            <Skeleton className="mt-6 h-4 w-28" />
          </article>
        ))}
      </section>
    </AutomationPageFrame>
  );
}

export function AgentActivityPageSkeleton() {
  return (
    <AutomationPageFrame>
      <AutomationPageHeader />

      <section className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" aria-label="Loading agent activity">
        {Array.from({ length: 6 }).map((_, index) => (
          <article key={index} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-4 w-[min(340px,100%)]" />
              <div className="flex gap-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-14" />
              </div>
            </div>
            <Skeleton className="h-3 w-28" />
          </article>
        ))}
      </section>
    </AutomationPageFrame>
  );
}

export function AgentAnalyticsPageSkeleton() {
  return (
    <AutomationPageFrame>
      <AutomationPageHeader />

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Loading agent analytics">
        {Array.from({ length: 4 }).map((_, index) => (
          <article key={index} className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-4" />
            </div>
            <Skeleton className="mt-5 h-8 w-14" />
            <Skeleton className="mt-2 h-3 w-36" />
          </article>
        ))}
      </section>
    </AutomationPageFrame>
  );
}
