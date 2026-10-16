"use client";

import { AgencyShell } from "@/components/agency-shell";
import { useEffect, useState, type FormEvent } from "react";
import Link from "@/lib/link";
import { useRouter } from "@/lib/navigation";
import { tenantFetch } from "@/lib/api";

const CREATE_REQUEST_KEY = "kasitek.agency.create-business-request";

type BusinessRequest = {
  name: string;
  reportingTimezone: string;
  primaryColor: string;
};

function idempotencyKeyFor(request: BusinessRequest) {
  const fingerprint = JSON.stringify({
    name: request.name.trim(),
    reportingTimezone: request.reportingTimezone.trim(),
    primaryColor: request.primaryColor.toLowerCase(),
  });
  const stored = window.sessionStorage.getItem(CREATE_REQUEST_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        fingerprint?: unknown;
        key?: unknown;
      };
      if (parsed.fingerprint === fingerprint && typeof parsed.key === "string")
        return parsed.key;
    } catch {}
  }
  const key = crypto.randomUUID();
  window.sessionStorage.setItem(
    CREATE_REQUEST_KEY,
    JSON.stringify({ fingerprint, key }),
  );
  return key;
}

type Partner = { id: string; email: string; display_name: string | null };
type Business = { id: string; slug: string; displayName: string };
export default function PartnerOnboardingScreen() {
  const router = useRouter();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [accountUrl, setAccountUrl] = useState("");
  const [name, setName] = useState("");
  const [reportingTimezone, setReportingTimezone] = useState("UTC");
  const [primaryColor, setPrimaryColor] = useState("#0f766e");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    try {
      setReportingTimezone(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      );
    } catch {
      setReportingTimezone("UTC");
    }
    void tenantFetch<{ partner: Partner; accountUrl: string }>(
      "/api/partner/auth/me",
    )
      .then(({ partner: current, accountUrl: securityUrl }) => {
        if (!active) return;
        setPartner(current);
        setAccountUrl(securityUrl);
        setName(current.display_name || "");
      })
      .catch(() => {
        if (active) router.replace("/login?audience=partner");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function createBusiness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const request = {
        name: name.trim(),
        reportingTimezone: reportingTimezone.trim(),
        primaryColor: primaryColor.toLowerCase(),
      };
      const result = await tenantFetch<{ business: Business }>(
        "/api/partner/businesses",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKeyFor(request) },
          body: JSON.stringify(request),
        },
      );
      window.sessionStorage.removeItem(CREATE_REQUEST_KEY);
      router.replace(
        `/app/businesses/${encodeURIComponent(result.business.id)}`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create your business. Try again.",
      );
      setSaving(false);
    }
  }

  if (loading)
    return (
      <main className="grid min-h-[calc(100dvh-4rem)] place-items-center bg-background text-muted-foreground">
        Loading your account…
      </main>
    );

  return (
    <AgencyShell mode="partner">
      <main className="min-h-[calc(100dvh-4rem)] bg-background px-4 py-8 sm:px-7 text-foreground sm:py-8">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            KasiTek Agency
          </Link>
          <div className="mt-9 grid gap-9 lg:grid-cols-[.8fr_1.2fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">
                First step
              </p>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-3xl">
                Name your business.
              </h1>
              <p className="mt-5 leading-7 text-muted-foreground">
                This creates your private Agency workspace. You’ll be its
                primary partner and can customize its look next.
              </p>
            </div>
            <form
              onSubmit={createBusiness}
              className="rounded-lg border border-border bg-card p-6 sm:p-8"
            >
              <label
                className="block text-sm font-medium"
                htmlFor="business-name"
              >
                Business name
              </label>
              <input
                data-slot="input"
                id="business-name"
                autoFocus
                required
                minLength={2}
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Northstar Creative"
                className="mt-2 w-full rounded-md border border-input bg-card px-4 py-3.5 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring"
              />
              <div className="mt-5 grid gap-5 sm:grid-cols-[1fr_auto] sm:items-end">
                <div>
                  <label
                    className="block text-sm font-medium"
                    htmlFor="reporting-timezone"
                  >
                    Business time zone
                  </label>
                  <input
                    data-slot="input"
                    id="reporting-timezone"
                    required
                    maxLength={64}
                    value={reportingTimezone}
                    onChange={(event) =>
                      setReportingTimezone(event.target.value)
                    }
                    placeholder="Africa/Johannesburg"
                    className="mt-2 w-full rounded-md border border-input bg-card px-4 py-3 text-foreground outline-none focus:border-ring"
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Use an IANA time zone, such as Africa/Johannesburg or UTC.
                  </p>
                </div>
                <div>
                  <label
                    className="block text-sm font-medium"
                    htmlFor="primary-color"
                  >
                    Brand color
                  </label>
                  <input
                    data-slot="input"
                    id="primary-color"
                    aria-label="Brand color"
                    type="color"
                    value={primaryColor}
                    onChange={(event) => setPrimaryColor(event.target.value)}
                    className="mt-2 h-12 w-full cursor-pointer rounded-md border border-input bg-card p-1 sm:w-24"
                  />
                </div>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Your workspace URL is created automatically. You can use it
                before setting up a custom domain.
              </p>
              {partner ? (
                <p className="mt-5 text-sm text-muted-foreground">
                  Signed in as{" "}
                  <span className="text-foreground">{partner.email}</span>
                </p>
              ) : null}
              {accountUrl ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Set up a passkey or optional two-step verification from{" "}
                  <a
                    href={accountUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    sign-in methods
                  </a>
                  .
                </p>
              ) : null}
              {error ? (
                <p
                  role="alert"
                  className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {error}
                </p>
              ) : null}
              <button
                data-slot="button"
                data-size="default"
                disabled={saving || name.trim().length < 2}
                className="mt-6 w-full rounded-md bg-primary px-5 py-3.5 font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Creating workspace…" : "Create my business"}
              </button>
            </form>
          </div>
        </div>
      </main>
    </AgencyShell>
  );
}
