import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function DashboardPageFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-h-[100dvh] p-4 sm:p-6 lg:p-8", className)}>
      <div className="mx-auto max-w-[1600px] space-y-6">{children}</div>
    </div>
  );
}

function MetricGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-2xl border border-border bg-card p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-9 w-20" />
          <Skeleton className="mt-3 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton({
  columns,
  rows,
}: {
  columns: number;
  rows: number;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div
        className="grid gap-4 border-b border-border bg-secondary/30 px-4 py-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={index} className="h-3 w-16" />
        ))}
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid gap-4 px-4 py-4"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((_, columnIndex) => (
              <Skeleton
                key={columnIndex}
                className={cn(
                  "h-4",
                  columnIndex === 0 ? "w-11/12" : columnIndex === columns - 1 ? "w-4/5" : "w-3/4",
                )}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardShellSkeleton({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dashboard-theme flex h-screen bg-background">
      <aside className="hidden w-64 border-r border-border bg-card lg:flex lg:flex-col">
        <div className="border-b border-border px-3 py-3">
          <div className="rounded-xl border border-border bg-secondary/30 px-3 py-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-2 p-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 rounded-xl px-3.5 py-3">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </div>

        <div className="space-y-3 border-t border-border p-3">
          <div className="flex items-center gap-3 px-3">
            <Skeleton className="h-7 w-7 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur lg:hidden">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2 w-16" />
            </div>
          </div>
          <Skeleton className="h-9 w-9 rounded-md" />
        </div>
        <main className="flex-1 overflow-auto pt-14 lg:pt-0">{children}</main>
      </div>
    </div>
  );
}

export function DashboardGenericPageSkeleton() {
  return (
    <DashboardPageFrame>
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-[min(560px,100%)]" />
      </div>
      <MetricGridSkeleton />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-3 h-4 w-[min(440px,100%)]" />
            <div className="mt-5 space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          </div>
          <TableSkeleton columns={5} rows={5} />
        </div>
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5">
            <Skeleton className="h-5 w-32" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full rounded-xl" />
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5">
            <Skeleton className="h-5 w-28" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </DashboardPageFrame>
  );
}

export function WorkspacePageSkeleton() {
  return (
    <DashboardPageFrame>
      <section className="rounded-2xl border border-border bg-card p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl space-y-3">
            <Skeleton className="h-6 w-32 rounded-full" />
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-4 w-[min(640px,100%)]" />
            <Skeleton className="h-4 w-[min(540px,100%)]" />
          </div>
          <Skeleton className="h-11 w-40 rounded-full" />
        </div>

        <div className="mt-6">
          <MetricGridSkeleton count={5} />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_360px]">
        <div className="space-y-6">
          <MetricGridSkeleton count={3} />
          <div className="grid gap-6 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-border bg-card p-5">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="mt-2 h-4 w-56" />
                <div className="mt-5 space-y-3">
                  {Array.from({ length: 4 }).map((__, rowIndex) => (
                    <Skeleton key={rowIndex} className="h-16 w-full rounded-xl" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-border bg-card p-5">
              <Skeleton className="h-6 w-36" />
              <div className="mt-5 space-y-3">
                {Array.from({ length: 5 }).map((__, rowIndex) => (
                  <Skeleton key={rowIndex} className="h-12 w-full rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </DashboardPageFrame>
  );
}

export function CampaignsPageSkeleton() {
  return (
    <DashboardPageFrame className="lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-10 w-52" />
          <Skeleton className="h-4 w-[min(560px,100%)]" />
        </div>
        <Skeleton className="h-10 w-36 rounded-md" />
      </div>

      <Skeleton className="h-10 w-full rounded-lg" />
      <TableSkeleton columns={10} rows={8} />
    </DashboardPageFrame>
  );
}

export function CampaignDetailPageSkeleton() {
  return (
    <DashboardPageFrame>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-[min(420px,100%)]" />
          <Skeleton className="h-4 w-[min(420px,100%)]" />
          <Skeleton className="h-4 w-[min(520px,100%)]" />
        </div>
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>

      <MetricGridSkeleton count={6} />

      {Array.from({ length: 2 }).map((_, index) => (
        <div key={index} className="rounded-2xl border border-border bg-card p-5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="mt-3 h-4 w-72" />
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <MetricGridSkeleton count={4} />
            </div>
            <div className="rounded-xl border border-border bg-secondary/20 p-4">
              <Skeleton className="h-5 w-24" />
              <div className="mt-4 flex flex-wrap gap-2">
                {Array.from({ length: 4 }).map((__, actionIndex) => (
                  <Skeleton key={actionIndex} className="h-10 w-28 rounded-md" />
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}

      <TableSkeleton columns={11} rows={7} />
    </DashboardPageFrame>
  );
}

export function InboxPageSkeleton() {
  return (
    <DashboardPageFrame className="p-0 lg:p-0">
      <div className="grid min-h-[100dvh] lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="border-r border-border bg-card/70 p-5">
          <div className="space-y-3">
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>

          <div className="mt-6 space-y-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-border bg-background/60 p-4">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-11 w-11 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-3 w-12" />
                    </div>
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="hidden min-h-[100dvh] bg-background lg:flex lg:flex-col">
          <div className="border-b border-border px-6 py-5">
            <div className="flex items-center gap-4">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          </div>

          <div className="flex-1 space-y-4 px-6 py-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className={cn(
                  "max-w-[75%] rounded-2xl border border-border px-4 py-4",
                  index % 2 === 0 ? "mr-auto bg-card" : "ml-auto bg-secondary/30",
                )}
              >
                <Skeleton className="h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-5/6" />
                <Skeleton className="mt-3 h-3 w-16" />
              </div>
            ))}
          </div>

          <div className="border-t border-border px-6 py-5">
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    </DashboardPageFrame>
  );
}
