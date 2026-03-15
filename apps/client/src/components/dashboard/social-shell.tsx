import Link from "next/link";
import SocialNav from "@/components/dashboard/social-nav";

type SocialShellProps = {
  title: string;
  description: string;
  ctaLabel?: string;
  ctaHref?: string;
  children: React.ReactNode;
};

export function SocialShell({
  title,
  description,
  ctaLabel = "Create Post",
  ctaHref = "/dashboard/social/posts",
  children,
}: SocialShellProps) {
  return (
    <div className="space-y-8">
      <section className="rounded-[32px] border border-border bg-[radial-gradient(circle_at_top_left,rgba(61,186,122,0.14),transparent_25%),radial-gradient(circle_at_top_right,rgba(232,160,32,0.14),transparent_20%),linear-gradient(180deg,rgba(31,31,31,0.98),rgba(20,20,20,0.98))] p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
              KasiSocial
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-text">{title}</h1>
            <p className="mt-2 max-w-2xl text-sm text-text-muted">{description}</p>
          </div>

          <Link
            href={ctaHref}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
          >
            {ctaLabel}
          </Link>
        </div>

        <div className="mt-6">
          <SocialNav />
        </div>
      </section>

      {children}
    </div>
  );
}

export function SocialMetricCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="text-sm font-medium text-text-muted">{label}</div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-text">{value}</div>
      <div className="mt-2 text-sm leading-6 text-text-dim">{helper}</div>
    </div>
  );
}

export function SocialPanel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">{title}</h2>
          {description ? <p className="text-sm text-text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
