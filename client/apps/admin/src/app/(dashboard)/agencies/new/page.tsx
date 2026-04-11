"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function NewAgencyPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    workspaceName: "",
    slug: "",
    adminEmail: "",
    adminPassword: "",
    primaryColor: "",
    domain: "",
  });

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

    const res = await fetch("/api/tenants/admin/workspaces", {
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

    router.push("/agencies");
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
            placeholder="Acme Marketing"
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
            placeholder="acme-marketing"
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
            placeholder="admin@acmemarketing.com"
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
            placeholder="portal.acmemarketing.com"
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
