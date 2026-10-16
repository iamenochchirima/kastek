"use client";

import { AgencyShell } from "@/components/agency-shell";
import { useEffect, useState, type FormEvent } from "react";
import Link from "@/lib/link";
import { useRouter } from "@/lib/navigation";
import {
  notifyAgencyBusinessesChanged,
  openAgencyWorkspace,
  selectAgencyWorkspace,
  tenantFetch,
} from "@/lib/api";

type Business = {
  id: string;
  slug: string;
  displayName: string;
  branding: {
    primaryColor: string | null;
    secondaryColor: string | null;
    logoUrl: string | null;
  };
  staffCount: number;
  clientCount: number;
};

export default function PartnerBusinessSettingsScreen({
  businessId,
}: {
  businessId: string;
}) {
  const router = useRouter();
  const [business, setBusiness] = useState<Business | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#0f766e");
  const [secondaryColor, setSecondaryColor] = useState("#e0f2f1");
  const [logoUrl, setLogoUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void tenantFetch<{ business: Business }>(
      `/api/partner/businesses/${encodeURIComponent(businessId)}`,
    )
      .then(({ business: result }) => {
        if (!active) return;
        setBusiness(result);
        setDisplayName(result.displayName);
        setPrimaryColor(result.branding.primaryColor || "#0f766e");
        setSecondaryColor(result.branding.secondaryColor || "#e0f2f1");
        setLogoUrl(result.branding.logoUrl || "");
      })
      .catch((reason) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : "Business not found.",
          );
          if (
            (reason instanceof Error ? reason.message : "")
              .toLowerCase()
              .includes("unauthorized")
          )
            router.replace("/login?audience=partner");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [businessId, router]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const result = await tenantFetch<{ business: Business }>(
        `/api/partner/businesses/${encodeURIComponent(businessId)}/branding`,
        {
          method: "PATCH",
          body: JSON.stringify({
            displayName,
            primaryColor,
            secondaryColor,
            logoUrl: logoUrl || null,
          }),
        },
      );
      setBusiness(result.business);
      notifyAgencyBusinessesChanged();
      setSaved(true);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save your branding.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return (
      <main className="grid min-h-[calc(100dvh-4rem)] place-items-center bg-background text-muted-foreground">
        Loading business…
      </main>
    );
  if (!business)
    return (
      <main className="mx-auto max-w-xl p-10 text-foreground">
        <p>{error || "Business not found."}</p>
        <Link className="mt-5 inline-block text-primary" href="/app/businesses">
          Back to businesses
        </Link>
      </main>
    );

  function preview() {
    selectAgencyWorkspace(business!.slug);
    router.push(`/portal/${encodeURIComponent(business!.slug)}`);
  }

  const setupItems = [
    {
      label: "Business name and branding",
      complete: Boolean(business.displayName && business.branding.primaryColor),
      action: "Review branding",
      onClick: () =>
        document
          .getElementById("branding-settings")
          ?.scrollIntoView({ behavior: "smooth" }),
    },
    {
      label: "Invite your team",
      complete: business.staffCount > 0,
      action: business.staffCount ? "Manage team" : "Invite a teammate",
      onClick: () => openAgencyWorkspace(business.slug, "/settings"),
    },
    {
      label: "Add your first client",
      complete: business.clientCount > 0,
      action: business.clientCount ? "Manage clients" : "Add a client",
      onClick: () => openAgencyWorkspace(business.slug, "/clients"),
    },
  ];
  const completedSetupCount = setupItems.filter((item) => item.complete).length;

  return (
    <AgencyShell mode="partner">
      <main className="min-h-[calc(100dvh-4rem)] bg-background px-4 py-8 sm:px-7 text-foreground sm:py-8">
        <div className="mx-auto max-w-4xl">
          <Link
            href="/app/businesses"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← All businesses
          </Link>
          <div className="mt-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
                Business settings
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                {business.displayName}
              </h1>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                data-slot="button"
                data-size="default"
                onClick={() => openAgencyWorkspace(business.slug)}
                className="rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Open workspace
              </button>
              <button
                data-slot="button"
                data-size="default"
                onClick={() => openAgencyWorkspace(business.slug, "/clients")}
                className="rounded-md border border-input px-5 py-3 text-sm font-medium hover:bg-secondary"
              >
                Manage clients
              </button>
              <button
                data-slot="button"
                data-size="default"
                onClick={() => openAgencyWorkspace(business.slug, "/settings")}
                className="rounded-md border border-input px-5 py-3 text-sm font-medium hover:bg-secondary"
              >
                Team & settings
              </button>
              <button
                data-slot="button"
                data-size="default"
                onClick={preview}
                className="rounded-md border border-input px-5 py-3 text-sm font-medium hover:bg-secondary"
              >
                Preview portal
              </button>
            </div>
          </div>
          <section
            aria-labelledby="setup-progress-title"
            className="mt-8 rounded-lg border border-border bg-card p-6 sm:p-8"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="setup-progress-title" className="text-xl font-semibold">
                  Business setup
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {completedSetupCount} of {setupItems.length} steps complete
                </p>
              </div>
              <button
                data-slot="button"
                data-size="default"
                onClick={preview}
                className="rounded-md border border-input px-4 py-2.5 text-sm font-medium hover:bg-secondary"
              >
                Preview your portal
              </button>
            </div>
            <ol className="mt-5 grid gap-3 xl:grid-cols-3">
              {setupItems.map((item) => (
                <li
                  key={item.label}
                  className="flex flex-col items-start justify-between gap-3 rounded-lg border border-border bg-card p-4"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{item.label}</p>
                    <p
                      className={`mt-1 text-xs ${item.complete ? "text-primary" : "text-muted-foreground"}`}
                    >
                      {item.complete ? "Complete" : "Next step"}
                    </p>
                  </div>
                  <button
                    data-slot="button"
                    data-size="default"
                    onClick={item.onClick}
                    className="shrink-0 text-sm font-medium text-primary hover:text-primary"
                  >
                    {item.action}
                  </button>
                </li>
              ))}
            </ol>
          </section>
          <form
            id="branding-settings"
            onSubmit={save}
            className="mt-8 grid gap-8 rounded-lg border border-border bg-card p-6 sm:p-8 md:grid-cols-[1fr_.7fr]"
          >
            <div className="space-y-5">
              <div>
                <label htmlFor="display-name" className="text-sm font-medium">
                  Business name
                </label>
                <input
                  data-slot="input"
                  id="display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={80}
                  required
                  className="mt-2 w-full rounded-md border border-input bg-card px-4 py-3 text-foreground outline-none focus:border-ring"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="primary-color"
                    className="text-sm font-medium"
                  >
                    Primary color
                  </label>
                  <div className="mt-2 flex gap-3 rounded-md border border-input bg-card p-2">
                    <input
                      data-slot="input"
                      id="primary-color"
                      aria-label="Primary color"
                      type="color"
                      value={primaryColor}
                      onChange={(event) => setPrimaryColor(event.target.value)}
                      className="size-10 cursor-pointer rounded-lg bg-transparent"
                    />
                    <span className="self-center text-sm text-muted-foreground">
                      {primaryColor}
                    </span>
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="secondary-color"
                    className="text-sm font-medium"
                  >
                    Secondary color
                  </label>
                  <div className="mt-2 flex gap-3 rounded-md border border-input bg-card p-2">
                    <input
                      data-slot="input"
                      id="secondary-color"
                      aria-label="Secondary color"
                      type="color"
                      value={secondaryColor}
                      onChange={(event) =>
                        setSecondaryColor(event.target.value)
                      }
                      className="size-10 cursor-pointer rounded-lg bg-transparent"
                    />
                    <span className="self-center text-sm text-muted-foreground">
                      {secondaryColor}
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <label htmlFor="logo-url" className="text-sm font-medium">
                  Logo URL{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </label>
                <input
                  data-slot="input"
                  id="logo-url"
                  type="url"
                  value={logoUrl}
                  onChange={(event) => setLogoUrl(event.target.value)}
                  placeholder="https://example.com/logo.png"
                  maxLength={2048}
                  className="mt-2 w-full rounded-md border border-input bg-card px-4 py-3 text-foreground outline-none focus:border-ring"
                />
              </div>
              {saved ? (
                <p role="status" className="text-sm text-primary">
                  Branding saved.
                </p>
              ) : null}
              {error ? (
                <p
                  role="alert"
                  className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {error}
                </p>
              ) : null}
              <button
                data-slot="button"
                data-size="default"
                disabled={saving || displayName.trim().length < 2}
                className="rounded-md bg-primary px-5 py-3 font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save branding"}
              </button>
            </div>
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Portal preview
              </p>
              <div className="mt-4 overflow-hidden rounded-md border border-border bg-background">
                <div
                  className="h-2"
                  style={{ backgroundColor: primaryColor }}
                />
                <div className="p-5">
                  {logoUrl ? (
                    <div
                      role="img"
                      aria-label={`${displayName} logo`}
                      className="mb-5 h-12 w-40 bg-contain bg-left bg-no-repeat"
                      style={{ backgroundImage: `url("${logoUrl}")` }}
                    />
                  ) : (
                    <div
                      className="mb-5 grid size-11 place-items-center rounded-md text-sm font-bold text-foreground"
                      style={{ backgroundColor: primaryColor }}
                    >
                      {displayName.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <h2 className="text-lg font-semibold">
                    {displayName || "Your business"}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    A client portal that reflects your brand.
                  </p>
                  <button
                    data-slot="button"
                    data-size="default"
                    type="button"
                    className="mt-5 rounded-lg px-4 py-2 text-sm font-semibold text-primary-foreground"
                    style={{ backgroundColor: secondaryColor }}
                  >
                    Open portal
                  </button>
                </div>
              </div>
              <p className="mt-4 break-all text-xs text-muted-foreground">
                Local portal: /portal/{business.slug}
              </p>
            </div>
          </form>
        </div>
      </main>
    </AgencyShell>
  );
}
