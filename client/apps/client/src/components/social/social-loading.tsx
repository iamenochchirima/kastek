import { Skeleton } from "@/components/ui/skeleton";

function SocialPageFrame({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className={`mx-auto space-y-6 ${wide ? "max-w-[1600px]" : "max-w-[1400px]"}`}>{children}</div>
    </div>
  );
}

function SocialMetricCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-16" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-10 w-10 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SocialCalendarSkeleton() {
  return (
    <SocialPageFrame wide>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-10 w-[min(560px,100%)]" />
          <Skeleton className="h-4 w-[min(680px,100%)]" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-10 w-10 rounded-md" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-10 rounded-md" />
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <div className="rounded-xl border border-border bg-card p-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-2 h-4 w-64" />
          <div className="mt-6 grid gap-3 md:grid-cols-7">
            {Array.from({ length: 35 }).map((_, index) => (
              <div key={index} className="min-h-[170px] rounded-xl border border-border/60 p-3">
                <Skeleton className="h-4 w-8" />
                <div className="mt-3 space-y-2">
                  <Skeleton className="h-12 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-border bg-card p-6">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="mt-2 h-4 w-52" />
              <div className="mt-5 space-y-3">
                {Array.from({ length: 5 }).map((__, itemIndex) => (
                  <Skeleton key={itemIndex} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SocialPageFrame>
  );
}

export function SocialPostsSkeleton() {
  return (
    <SocialPageFrame wide>
      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-3">
                <Skeleton className="h-6 w-28 rounded-full" />
                <Skeleton className="h-8 w-44" />
                <Skeleton className="h-4 w-full" />
              </div>
              <Skeleton className="h-10 w-10 rounded-md" />
            </div>
            <div className="mt-5 space-y-3">
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-6">
            <Skeleton className="h-5 w-28" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex flex-wrap items-center gap-3">
              <Skeleton className="h-10 w-36 rounded-md" />
              <Skeleton className="h-10 w-36 rounded-md" />
              <Skeleton className="h-10 w-36 rounded-md" />
            </div>
            <div className="mt-6 space-y-4">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="rounded-xl border border-border/70 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-3">
                      <Skeleton className="h-5 w-56" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                    </div>
                    <Skeleton className="h-8 w-20 rounded-full" />
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Skeleton className="h-8 w-20 rounded-md" />
                    <Skeleton className="h-8 w-20 rounded-md" />
                    <Skeleton className="h-8 w-20 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SocialPageFrame>
  );
}

export function SocialAnalyticsSkeleton() {
  return (
    <SocialPageFrame>
      <div className="space-y-3">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-10 w-[min(560px,100%)]" />
        <Skeleton className="h-4 w-[min(660px,100%)]" />
      </div>

      <SocialMetricCards />

      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="rounded-xl border border-border bg-card p-6">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="mt-2 h-4 w-64" />
            <div className="mt-5 space-y-3">
              {Array.from({ length: 5 }).map((__, itemIndex) => (
                <Skeleton key={itemIndex} className="h-14 w-full rounded-md" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </SocialPageFrame>
  );
}
