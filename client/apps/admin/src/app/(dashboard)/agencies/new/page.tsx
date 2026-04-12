"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function NewAgencyPage() {
  const router = useRouter();
  const tenantPortalBaseUrl = (
    process.env.NEXT_PUBLIC_TENANT_PORTAL_URL || "http://localhost:3000"
  ).replace(/\/$/, "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<{
    displayName: string;
    slug: string;
    status: string;
    hostedDomain: string | null;
    domains: string[];
    portalUrl: string | null;
    adminEmail: string;
    adminPassword: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({
    workspaceName: "",
    slug: "",
    adminEmail: "",
    adminPassword: "",
    primaryColor: "",
    domain: "",
  });

  function portalUrlForDomain(domain: string) {
    const trimmed = domain.trim().toLowerCase();
    if (
      trimmed === "localhost" ||
      trimmed.endsWith(".local") ||
      /^127(?:\.\d{1,3}){3}$/.test(trimmed) ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)
    ) {
      return `http://${domain}`;
    }

    return `https://${domain}`;
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setForm((prev) => {
      const next = { ...prev, [name]: value };
      // Auto-generate slug from workspace name
      if (name === "workspaceName") {
        next.slug = value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/agencies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceName: form.workspaceName,
        slug: form.slug,
        adminEmail: form.adminEmail,
        adminPassword: form.adminPassword,
        primaryColor: form.primaryColor || undefined,
        domain: form.domain || undefined,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create agency");
      setLoading(false);
      return;
    }

    const data = await res.json().catch(() => ({}));
    const key =
      typeof data?.apiKey?.key === "string"
        ? data.apiKey.key
        : typeof data?.key === "string"
          ? data.key
          : null;
    const domains = Array.isArray(data?.workspace?.domains)
      ? data.workspace.domains.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : form.domain.trim()
        ? [form.domain.trim()]
        : [];
    const hostedDomain =
      typeof data?.workspace?.hostedDomain === "string" && data.workspace.hostedDomain.trim().length > 0
        ? data.workspace.hostedDomain
        : null;
    const primaryDomain = domains[0] ?? hostedDomain;
    const portalUrl = primaryDomain
      ? portalUrlForDomain(primaryDomain)
      : tenantPortalBaseUrl;

    setCreatedWorkspace({
      displayName: data?.workspace?.displayName ?? form.workspaceName,
      slug: data?.workspace?.slug ?? form.slug,
      status: data?.workspace?.status ?? "active",
      hostedDomain,
      domains,
      portalUrl,
      adminEmail: data?.adminUser?.email ?? form.adminEmail,
      adminPassword: form.adminPassword,
    });

    if (key) {
      setCreatedKey(key);
    } else {
      router.push("/agencies");
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (createdKey) {
    return (
      <div className="max-w-xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text">Agency Created</h1>
          <p className="text-text-muted text-sm mt-1">
            The workspace was provisioned successfully.
          </p>
        </div>
        <div className="bg-surface-raised border border-border rounded-xl p-6 space-y-4">
          {createdWorkspace ? (
            <div className="rounded-lg border border-border bg-surface px-4 py-4 space-y-2 text-sm">
              <p className="text-text">
                <span className="text-text-muted">Workspace:</span> {createdWorkspace.displayName}
              </p>
              <p className="text-text">
                <span className="text-text-muted">Slug:</span>{" "}
                <span className="font-mono">{createdWorkspace.slug}</span>
              </p>
              <p className="text-text">
                <span className="text-text-muted">Status:</span> {createdWorkspace.status}
              </p>
              <p className="text-text">
                <span className="text-text-muted">Tenant Admin Email:</span> {createdWorkspace.adminEmail}
              </p>
              <p className="text-text">
                <span className="text-text-muted">Tenant Admin Password:</span>{" "}
                <span className="font-mono">{createdWorkspace.adminPassword}</span>
              </p>
              {createdWorkspace.portalUrl ? (
                <p className="text-text">
                  <span className="text-text-muted">Portal Login URL:</span>{" "}
                  <span className="font-mono break-all">{createdWorkspace.portalUrl}</span>
                </p>
              ) : null}
              {createdWorkspace.hostedDomain ? (
                <p className="text-text">
                  <span className="text-text-muted">Hosted Domain:</span>{" "}
                  <span className="font-mono">{createdWorkspace.hostedDomain}</span>
                </p>
              ) : null}
              {createdWorkspace.domains.length > 0 ? (
                <p className="text-text">
                  <span className="text-text-muted">Custom Domain:</span>{" "}
                  <span className="font-mono">{createdWorkspace.domains[0]}</span>
                </p>
              ) : (
                <p className="text-xs text-text-faint">
                  The hosted tenant domain is available immediately. For local fallback access without wildcard
                  DNS, run the tenant backend with{" "}
                  <span className="font-mono">TENANT_DEFAULT_WORKSPACE_SLUG={createdWorkspace.slug}</span>.
                </p>
              )}
            </div>
          ) : null}
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-4 space-y-2">
            <p className="text-sm font-medium text-amber-400">Save this API key — it will not be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono text-text break-all">{createdKey}</code>
              <button
                onClick={copyKey}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-text-muted hover:text-text transition-colors"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
          <Link
            href="/agencies"
            className="block w-full text-center bg-primary hover:bg-primary-dark text-white py-2.5 rounded-lg font-medium transition-colors"
          >
            Go to Agencies
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <Link
          href="/agencies"
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Agencies
        </Link>
        <h1 className="text-2xl font-bold text-text">New Agency Workspace</h1>
        <p className="text-text-muted text-sm mt-1">
          Creates a tenant workspace with an admin user and API key.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-surface-raised rounded-xl border border-border p-6 space-y-4">
        {error && (
          <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg border border-danger/20">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">Agency Name</label>
          <input
            name="workspaceName"
            value={form.workspaceName}
            onChange={handleChange}
            required
            placeholder="Northstar Agency"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">Slug</label>
          <input
            name="slug"
            value={form.slug}
            onChange={handleChange}
            required
            pattern="[a-z0-9-]+"
            placeholder="northstar-agency"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <p className="text-xs text-text-faint mt-1">Lowercase letters, numbers, and hyphens only.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">Admin Email</label>
          <input
            name="adminEmail"
            type="email"
            value={form.adminEmail}
            onChange={handleChange}
            required
            placeholder="admin@northstar.local"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">Admin Password</label>
          <input
            name="adminPassword"
            type="password"
            value={form.adminPassword}
            onChange={handleChange}
            required
            minLength={8}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">
            Primary Color <span className="text-text-faint">(optional)</span>
          </label>
          <input
            name="primaryColor"
            value={form.primaryColor}
            onChange={handleChange}
            placeholder="#3b82f6"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1">
            Custom Domain <span className="text-text-faint">(optional)</span>
          </label>
          <input
            name="domain"
            value={form.domain}
            onChange={handleChange}
            placeholder="portal.northstar.local"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary-dark text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create Agency"}
          </button>
        </div>
      </form>
    </div>
  );
}
