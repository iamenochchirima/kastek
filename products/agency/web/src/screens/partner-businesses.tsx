"use client";

import { AgencyShell } from "@/components/agency-shell";
import { useEffect, useState } from "react";
import Link from "@/lib/link";
import { useRouter } from "@/lib/navigation";
import { openAgencyWorkspace, tenantFetch } from "@/lib/api";

type Business = {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  createdAt: string;
  branding: {
    primaryColor: string | null;
    secondaryColor: string | null;
    logoUrl: string | null;
  };
};

export default function PartnerBusinessesScreen() {
  const router = useRouter();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [email, setEmail] = useState("");
  const [accountUrl, setAccountUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      tenantFetch<{ partner: { email: string }; accountUrl: string }>(
        "/api/partner/auth/me",
      ),
      tenantFetch<{ businesses: Business[] }>("/api/partner/businesses"),
    ])
      .then(([account, result]) => {
        if (!active) return;
        setEmail(account.partner.email);
        setAccountUrl(account.accountUrl);
        setBusinesses(result.businesses);
        if (!result.businesses.length) router.replace("/onboarding");
      })
      .catch((reason) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Your session could not be loaded.",
          );
          router.replace("/login?audience=partner");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function signOut(allDevices = false) {
    try {
      const result = await tenantFetch<{ logoutUrl: string }>(
        `/api/partner/auth/${allDevices ? "logout-all" : "logout"}`,
        { method: "POST" },
      );
      window.location.assign(result.logoutUrl);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not sign out.",
      );
    }
  }

  if (loading)
    return (
      <main className="grid min-h-[calc(100dvh-4rem)] place-items-center bg-background text-muted-foreground">
        Loading your businesses…
      </main>
    );

  return (
    <AgencyShell mode="partner">
      <main className="min-h-[calc(100dvh-4rem)] bg-background px-4 py-8 sm:px-7 text-foreground sm:py-8">
        <div className="mx-auto max-w-5xl">
          <header className="flex flex-wrap items-start justify-between gap-5 border-b border-border pb-7">
            <div>
              <Link
                href="/"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                KasiTek Agency
              </Link>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight">
                Your businesses
              </h1>
              <p className="mt-2 text-muted-foreground">Signed in as {email}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {accountUrl ? (
                <a
                  href={accountUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-input px-5 py-3 text-sm font-medium text-foreground hover:bg-secondary"
                >
                  Sign-in methods
                </a>
              ) : null}
              <Link
                href="/onboarding"
                className="rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Create business
              </Link>
              <button
                data-slot="button"
                data-size="default"
                onClick={() => void signOut()}
                className="rounded-md border border-input px-5 py-3 text-sm font-medium text-foreground hover:bg-secondary"
              >
                Sign out
              </button>
            </div>
          </header>
          {error ? (
            <p
              role="alert"
              className="mt-5 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {businesses.map((business) => (
              <article
                data-slot="card"
                key={business.id}
                className="rounded-lg border border-border bg-card p-6"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold">
                      {business.displayName}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Local portal: /portal/{business.slug}
                    </p>
                  </div>
                  <span className="rounded-md bg-primary/10 px-3 py-1 text-xs font-medium capitalize text-primary">
                    {business.status}
                  </span>
                </div>
                <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
                  <span
                    className="size-4 rounded-md border border-border"
                    style={{
                      backgroundColor:
                        business.branding.primaryColor || "#0f766e",
                    }}
                  />
                  <span>
                    {business.branding.primaryColor
                      ? "Brand colour configured"
                      : "Set up branding"}
                  </span>
                </div>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    href={`/app/businesses/${encodeURIComponent(business.id)}`}
                    className="rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    Manage business
                  </Link>
                  <button
                    data-slot="button"
                    data-size="default"
                    onClick={() => openAgencyWorkspace(business.slug)}
                    className="rounded-md border border-input px-4 py-2.5 text-sm font-medium hover:bg-secondary"
                  >
                    Open workspace
                  </button>
                  <Link
                    href={`/portal/${encodeURIComponent(business.slug)}`}
                    className="rounded-md border border-input px-4 py-2.5 text-sm font-medium hover:bg-secondary"
                  >
                    Preview portal
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <div className="mt-10 border-t border-border pt-5">
            <button
              data-slot="button"
              data-size="default"
              onClick={() => void signOut(true)}
              className="text-sm text-muted-foreground hover:text-muted-foreground"
            >
              Sign out on all Agency sessions
            </button>
          </div>
        </div>
      </main>
    </AgencyShell>
  );
}
