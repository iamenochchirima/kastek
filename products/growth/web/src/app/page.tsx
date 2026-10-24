import { Link, useNavigate } from "react-router";
import { useEffect } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCoreSession } from "@/lib/core-auth";
import { publicSiteUrl } from "@/lib/public-site";

export const meta = () => [
  { name: "robots", content: "index, follow" },
  { title: "Growth | KasiTek" },
  { name: "description", content: "Manage customer conversations, campaigns, content and bookings in your Growth workspace." },
  { tagName: "link", rel: "canonical", href: "https://growth.kasitek.co.za/" },
  { property: "og:title", content: "Growth | KasiTek" },
  { property: "og:description", content: "Your customer conversations, campaigns, content and bookings in one workspace." },
  { property: "og:url", content: "https://growth.kasitek.co.za/" },
  { property: "og:type", content: "website" },
  { name: "twitter:card", content: "summary" },
];
export default function GrowthLandingPage() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    void getCoreSession().then((session) => { if (active && session?.user) navigate("/workspace", { replace: true }); }).catch(() => {});
    return () => { active = false; };
  }, [navigate]);
  return (
    <main className="relative isolate flex min-h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_20%,color-mix(in_oklab,var(--primary)_13%,transparent),transparent_28%),radial-gradient(circle_at_30%_88%,color-mix(in_oklab,var(--primary)_8%,transparent),transparent_31%)]" />
        <div className="absolute -right-40 top-1/2 h-[46rem] w-[46rem] -translate-y-1/2 rounded-full border border-border/60 bg-card/10 shadow-[0_0_140px_color-mix(in_oklab,var(--background)_78%,transparent)]" />
        <div className="absolute right-10 top-1/2 h-[30rem] w-[30rem] -translate-y-1/2 rounded-full border border-border/60 bg-card/10" />
      </div>

      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5 sm:px-8 lg:px-10">
        <a href={publicSiteUrl} className="group inline-flex items-center gap-2.5 no-underline">
          <img
            src="/logo.svg"
            alt="KasiTek"
            width={36}
            height={36}
            className="h-9 w-9 rounded-lg border border-black/5 shadow-sm"
          />
          <span>
            <span className="block text-sm font-semibold tracking-tight text-foreground">KasiTek</span>
            <span className="block text-[11px] font-medium text-muted-foreground">Growth</span>
          </span>
        </a>
        <a
          href={publicSiteUrl}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          KasiTek Labs
          <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      </header>

      <section className="mx-auto flex w-full max-w-7xl flex-1 items-center px-4 py-12 sm:px-8 lg:px-10 lg:py-16">
        <div className="flex w-full justify-center lg:justify-start">
          <section
            className="w-full max-w-[440px] rounded-xl border border-border bg-card p-7 shadow-lg sm:p-9"
            aria-labelledby="access-heading"
            >
            <p className="text-sm font-medium text-muted-foreground">KasiTek Growth</p>
            <h1 id="access-heading" className="mt-3 text-[2rem] font-semibold tracking-[-0.035em] text-foreground">
              Stay close to your customers
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
              Manage conversations, campaigns, content and bookings in one workspace.
            </p>

            <div className="mt-8 grid gap-3">
            <Button asChild size="lg"><Link to="/login">Sign in<ArrowRight className="h-4 w-4" /></Link></Button>
            <Button asChild variant="outline" size="lg"><Link to="/signup">Create an account</Link></Button>
            </div>

          </section>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-7xl flex-col gap-3 border-t border-border px-6 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
        <span>© {new Date().getFullYear()} KasiTek Labs</span>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Public site links">
          <a className="hover:text-foreground" href={`${publicSiteUrl}/about`}>About</a>
          <a className="hover:text-foreground" href={`${publicSiteUrl}/pricing`}>Pricing</a>
          <a className="hover:text-foreground" href={`${publicSiteUrl}/demo`}>Book a demo</a>
          <a className="hover:text-foreground" href={`${publicSiteUrl}/privacy-policy`}>Privacy</a>
          <a className="hover:text-foreground" href={`${publicSiteUrl}/terms`}>Terms</a>
        </nav>
      </footer>
    </main>
  );
}
