"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type DomainRecord = {
  id: string;
  domain: string;
  is_primary: boolean;
  dns_status: string;
  verified_at: string | null;
  created_at: string;
  verification_message: string;
};

function statusTone(status: string) {
  switch (status) {
    case "verified":
      return "bg-green-500/15 text-green-400";
    case "misconfigured":
      return "bg-amber-500/15 text-amber-400";
    default:
      return "bg-white/5 text-text-faint";
  }
}

export default function AgencyDomainsManager({
  workspaceId,
  workspaceSlug,
  domains,
  expectedTargetHost,
  hostedDomain,
}: {
  workspaceId: string;
  workspaceSlug: string;
  domains: DomainRecord[];
  expectedTargetHost: string | null;
  hostedDomain: string | null;
}) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [makePrimary, setMakePrimary] = useState(domains.length === 0);
  const [loading, setLoading] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const primaryDomain = useMemo(
    () => domains.find((entry) => entry.is_primary) ?? null,
    [domains]
  );

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch(`/api/agencies/${workspaceId}/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain, makePrimary }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to add domain");
      setLoading(false);
      return;
    }

    setDomain("");
    setMakePrimary(false);
    setLoading(false);
    router.refresh();
  }

  async function handleVerify(domainId: string) {
    setVerifyingId(domainId);
    setError("");
    const res = await fetch(`/api/agencies/${workspaceId}/domains/${domainId}/verify`, {
      method: "POST",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to verify domain");
    }

    setVerifyingId(null);
    router.refresh();
  }

  async function handleRemove(domainId: string) {
    setRemovingId(domainId);
    setError("");
    const res = await fetch(`/api/agencies/${workspaceId}/domains/${domainId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to remove domain");
    }

    setRemovingId(null);
    router.refresh();
  }

  async function handleMakePrimary(domainId: string) {
    setPrimaryId(domainId);
    setError("");
    const res = await fetch(`/api/agencies/${workspaceId}/domains/${domainId}/primary`, {
      method: "POST",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to update primary domain");
    }

    setPrimaryId(null);
    router.refresh();
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-text">Domains</h2>
          <p className="text-sm text-text-muted mt-1">
            Point tenant domains to the shared portal deployment, then verify routing here.
          </p>
          {hostedDomain ? (
            <p className="text-xs text-text-faint mt-2">
              Default hosted domain:
              <span className="ml-1 font-mono text-text">{hostedDomain}</span>
            </p>
          ) : null}
        </div>
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-xs text-text-muted max-w-sm">
          <p className="font-medium text-text">Local fallback</p>
          <p className="mt-1">
            Without a mapped custom domain, run the tenant backend with{" "}
            <span className="font-mono">TENANT_DEFAULT_WORKSPACE_SLUG={workspaceSlug}</span>.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_0.9fr]">
        <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
          {domains.length === 0 ? (
            <p className="px-6 py-8 text-sm text-text-faint text-center">
              No custom domains yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Domain</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-text-muted">Verified</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {domains.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-4 py-3 text-text">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{entry.domain}</span>
                        {entry.is_primary ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            Primary
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusTone(entry.dns_status)}`}
                      >
                        {entry.dns_status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-faint">
                      <div className="space-y-1">
                        <p>
                          {entry.verified_at
                            ? new Date(entry.verified_at).toLocaleString()
                            : "Not yet"}
                        </p>
                        <p className="max-w-xs">{entry.verification_message}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleVerify(entry.id)}
                          disabled={verifyingId === entry.id}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-muted transition-colors hover:text-text disabled:opacity-50"
                        >
                          {verifyingId === entry.id ? "Checking…" : "Verify"}
                        </button>
                        {!entry.is_primary ? (
                          <button
                            onClick={() => handleMakePrimary(entry.id)}
                            disabled={primaryId === entry.id}
                            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-muted transition-colors hover:text-text disabled:opacity-50"
                          >
                            {primaryId === entry.id ? "Updating…" : "Make Primary"}
                          </button>
                        ) : null}
                        <button
                          onClick={() => handleRemove(entry.id)}
                          disabled={removingId === entry.id}
                          className="rounded-lg px-2.5 py-1 text-xs font-medium text-text-faint transition-colors hover:text-danger disabled:opacity-50"
                        >
                          {removingId === entry.id ? "Removing…" : "Remove"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-surface-raised rounded-xl border border-border p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-text">Add Domain</h3>
              <p className="text-xs text-text-faint mt-1">
                Store the tenant domain first, then verify DNS after the record is pointed at your portal.
              </p>
            </div>

            {error ? (
              <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
                {error}
              </div>
            ) : null}

            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-muted mb-1">
                  Custom Domain
                </label>
                <input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  required
                  placeholder="portal.clienta.com"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-text-muted">
                <input
                  type="checkbox"
                  checked={makePrimary}
                  onChange={(e) => setMakePrimary(e.target.checked)}
                />
                Make this the primary domain
              </label>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
              >
                {loading ? "Adding…" : "Add Domain"}
              </button>
            </form>
          </div>

          <div className="bg-surface-raised rounded-xl border border-border p-5 text-sm text-text-muted space-y-2">
            <h3 className="text-sm font-semibold text-text">DNS Instructions</h3>
            <p>
              Point the tenant domain to your shared portal deployment using a CNAME to your public portal host.
            </p>
            <p>
              Example:
              <span className="ml-1 font-mono text-text">
                {primaryDomain?.domain ?? "portal.clienta.com"} CNAME{" "}
                {expectedTargetHost ?? "portal.kasitek.com"}
              </span>
            </p>
            <p className="text-xs text-text-faint">
              After DNS propagates, use Verify to confirm that the tenant domain resolves to{" "}
              <span className="font-mono">{expectedTargetHost ?? "your shared portal host"}</span>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
