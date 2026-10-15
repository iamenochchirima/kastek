"use client";

import { useEffect, useState } from "react";
import "@/styles/marketing.css";
import Link from "@/lib/link";
import { useRouter } from "@/lib/navigation";
import { ArrowRight, Building2 } from "lucide-react";
import { selectAgencyWorkspace, tenantFetch } from "@/lib/api";

type TenantContext = {
  workspace: { id: string; slug: string; displayName: string };
  branding: {
    displayName: string;
    primaryColor: string | null;
    secondaryColor: string | null;
    logoUrl: string | null;
  } | null;
};

export default function PortalEntryPage({ slug }: { slug: string }) {
  const router = useRouter();
  const [context, setContext] = useState<TenantContext | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    selectAgencyWorkspace(slug);
    void tenantFetch<TenantContext>("/api/public/tenant-context")
      .then((result) => {
        if (active) setContext(result);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "Portal not found.",
          );
      });
    return () => {
      active = false;
    };
  }, [slug]);

  if (error)
    return (
      <main className="grid min-h-screen place-items-center bg-background p-8 text-center text-foreground">
        <div>
          <h1 className="text-2xl font-semibold">Portal unavailable</h1>
          <p className="mt-3 text-muted-foreground">{error}</p>
          <Link href="/" className="mt-6 inline-block text-primary">
            Return to KasiTek Agency
          </Link>
        </div>
      </main>
    );
  if (!context)
    return (
      <main className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        Loading branded portal…
      </main>
    );

  const name = context.branding?.displayName || context.workspace.displayName;
  const primary = context.branding?.primaryColor || "#0f766e";
  const secondary = context.branding?.secondaryColor || "#e0f2f1";

  return (
    <div
      className="marketing"
      style={{ ["--marketing-accent" as string]: secondary }}
    >
      <nav className="marketing-nav">
        <Link href="/" className="marketing-brand">
          <span className="inline-flex items-center gap-3">
            {context.branding?.logoUrl ? (
              <img
                src={context.branding.logoUrl}
                alt=""
                className="h-8 max-w-24 object-contain"
              />
            ) : (
              <Building2 size={24} style={{ color: primary }} />
            )}
            {name}
          </span>
        </Link>
        <div>
          <Link
            href="/login?audience=tenant"
            onClick={() => selectAgencyWorkspace(slug)}
          >
            Portal sign in
          </Link>
        </div>
      </nav>
      <main>
        <section className="marketing-hero">
          <p className="marketing-kicker">Your client workspace</p>
          <h1>
            Welcome to
            <br />
            <em>{name}.</em>
          </h1>
          <p className="marketing-intro">
            Sign in to access your client workspace and collaborate with the{" "}
            {name} team.
          </p>
          <div className="marketing-actions">
            <button
              onClick={() => {
                selectAgencyWorkspace(slug);
                router.push("/login?audience=tenant");
              }}
              className="marketing-cta"
              style={{ backgroundColor: primary }}
            >
              Sign in to your portal
              <ArrowRight size={18} />
            </button>
          </div>
        </section>
      </main>
      <footer>
        <span>{name}</span>
        <span>Client workspace</span>
      </footer>
    </div>
  );
}
