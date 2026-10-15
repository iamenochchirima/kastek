"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyAdminText } from "@/lib/format";

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
    adminInviteUrl: string | null;
    adminInviteEmailSent: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({
    workspaceName: "",
    slug: "",
    adminEmail: "",
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
      adminInviteUrl:
        typeof data?.adminInvite?.activationUrl === "string" ? data.adminInvite.activationUrl : null,
      adminInviteEmailSent: Boolean(data?.adminInvite?.emailSent),
    });

    if (key) {
      setCreatedKey(key);
    } else {
      router.push("/agencies");
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    setCopied(await copyAdminText(createdKey));
    setTimeout(() => setCopied(false), 2000);
  }

  if (createdKey) {
    return (
      <div className="admin-page max-w-xl">
        <AdminPageHeader title="Agency created" description="The workspace was provisioned successfully." />
        <div className="v-card space-y-4 p-[var(--density-card-padding)]">
          {createdWorkspace ? (
            <div className="space-y-2 rounded-md border border-line bg-background px-4 py-4 text-sm">
              <p className="text-foreground">
                <span className="text-muted-foreground">Workspace:</span> {createdWorkspace.displayName}
              </p>
              <p className="text-foreground">
                <span className="text-muted-foreground">Slug:</span>{" "}
                <span className="font-mono">{createdWorkspace.slug}</span>
              </p>
              <p className="text-foreground">
                <span className="text-muted-foreground">Status:</span> {createdWorkspace.status}
              </p>
              <p className="text-foreground">
                <span className="text-muted-foreground">Tenant admin email:</span> {createdWorkspace.adminEmail}
              </p>
              <p className="text-foreground">
                <span className="text-muted-foreground">Admin onboarding:</span>{" "}
                {createdWorkspace.adminInviteEmailSent ? "Email sent" : "Use fallback setup link below"}
              </p>
              {createdWorkspace.portalUrl ? (
                <p className="text-foreground">
                  <span className="text-muted-foreground">Portal login URL:</span>{" "}
                  <span className="font-mono break-all">{createdWorkspace.portalUrl}</span>
                </p>
              ) : null}
              {createdWorkspace.adminInviteUrl ? (
                <p className="text-foreground">
                  <span className="text-muted-foreground">Admin setup URL:</span>{" "}
                  <span className="font-mono break-all">{createdWorkspace.adminInviteUrl}</span>
                </p>
              ) : null}
              {createdWorkspace.hostedDomain ? (
                <p className="text-foreground">
                  <span className="text-muted-foreground">Hosted domain:</span>{" "}
                  <span className="font-mono">{createdWorkspace.hostedDomain}</span>
                </p>
              ) : null}
              {createdWorkspace.domains.length > 0 ? (
                <p className="text-foreground">
                  <span className="text-muted-foreground">Custom domain:</span>{" "}
                  <span className="font-mono">{createdWorkspace.domains[0]}</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The hosted tenant domain is available immediately. For local fallback access without wildcard
                  DNS, run the tenant backend with{" "}
                  <span className="font-mono">TENANT_DEFAULT_WORKSPACE_SLUG={createdWorkspace.slug}</span>.
                </p>
              )}
            </div>
          ) : null}
          <div className="space-y-2 rounded-md border border-status-attention/25 bg-status-attention-soft px-4 py-4">
            <p className="text-sm font-medium text-status-attention">Save this API key — it will not be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all font-mono text-xs text-foreground">{createdKey}</code>
              <button
                onClick={copyKey}
                className={buttonClassName({ variant: "outline", size: "sm" })}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
          <Link
            href="/agencies"
            className={buttonClassName({ className: "w-full" })}
          >
            Go to Agencies
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page max-w-xl">
      <AdminPageHeader eyebrow="Platform" title="New agency workspace" description="Provision a tenant workspace and its first admin account." actions={<Link href="/agencies" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to agencies</Link>} />

      <form onSubmit={handleSubmit} className="v-card space-y-4 p-[var(--density-card-padding)]">
        {error && (
          <div role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
            {error}
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">Agency name</label>
          <Input
            name="workspaceName"
            value={form.workspaceName}
            onChange={handleChange}
            required
            placeholder="Northstar Agency"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">Slug</label>
          <Input
            name="slug"
            value={form.slug}
            onChange={handleChange}
            required
            pattern="[a-z0-9-]+"
            placeholder="northstar-agency"
            className="font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens only.</p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">Admin email</label>
          <Input
            name="adminEmail"
            type="email"
            value={form.adminEmail}
            onChange={handleChange}
            required
            placeholder="admin@northstar.local"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">
            Primary color <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            name="primaryColor"
            value={form.primaryColor}
            onChange={handleChange}
            placeholder="#3b82f6"
            className="font-mono"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">
            Custom domain <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            name="domain"
            value={form.domain}
            onChange={handleChange}
            placeholder="portal.northstar.local"
          />
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={loading}
            className={buttonClassName({ className: "w-full" })}
          >
            {loading ? "Creating..." : "Create Agency"}
          </button>
        </div>
      </form>
    </div>
  );
}
