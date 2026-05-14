"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/server-api";

export function CreateOrgForm() {
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

    const res = await fetch(apiUrl("/api/orgs"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), slug: slug.trim() || undefined }),
    });

    setLoading(false);

    if (res.ok) {
      const data = await res.json();
      // Set as active org then go to team page
      await fetch("/api/orgs/set-active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: data.org.id }),
      });
      router.push("/workspace/team");
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create organisation");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-border bg-card p-6">
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

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex gap-3">
        <Button type="submit" disabled={loading || !name.trim()} className="flex-1">
          {loading ? "Creating…" : "Create organisation"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
