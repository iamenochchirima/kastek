"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/server-api";

export function CreateOrgForm({ nextPath = "/workspace/team", initial = false }: { nextPath?: string; initial?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function autoSlug(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }

  function handleNameChange(value: string) {
    setName(value);
    if (!slugManual) setSlug(autoSlug(value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(apiUrl("/api/orgs"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to create organisation");
      const active = await fetch(apiUrl("/api/orgs/set-active"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: data.org.id }),
      });
      if (!active.ok) throw new Error("Organisation created. Could not select it. Reload to continue.");
      router.push(nextPath);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to create organisation");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border border-border bg-card p-6">
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="org-name">
          Organisation name
        </label>
        <Input
          id="org-name"
          placeholder="Acme Corp"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          required
          maxLength={80}
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="org-slug">
          URL slug
        </label>
        <Input
          id="org-slug"
          placeholder="acme-corp"
          value={slug}
          onChange={(e) => {
            setSlugManual(true);
            setSlug(autoSlug(e.target.value));
          }}
          maxLength={48}
        />
        <p className="text-xs text-muted-foreground">
          Used in URLs. Only lowercase letters, numbers, and hyphens.
        </p>
      </div>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

      <div className="flex gap-3">
        <Button type="submit" disabled={loading || !name.trim()} className="flex-1">
          {loading ? "Creating…" : "Create organisation"}
        </Button>
        {!initial && <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
        >
          Cancel
        </Button>}
      </div>
    </form>
  );
}
