"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";

type FileEntry = {
  fileName: string;
  name: string;
  category: string;
  listings: { name: string; website?: string; address?: string; email?: string }[];
};

export default function OutreachImportForm() {
  const router = useRouter();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ category: string; count: number; error?: string }[]>([]);

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files;
    if (!selected || selected.length === 0) return;

    setError("");
    setResults([]);
    const entries: FileEntry[] = [];
    let loaded = 0;

    Array.from(selected).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const json = JSON.parse(ev.target?.result as string);
          const items = json.listings || json;
          if (Array.isArray(items) && items.length > 0) {
            const cat = file.name
              .replace(".json", "")
              .replace(/-/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase());
            const month = new Date().toLocaleString("en", { month: "short", year: "numeric" });
            entries.push({
              fileName: file.name,
              name: `${cat} ${month}`,
              category: cat,
              listings: items,
            });
          }
        } catch {
          // skip invalid files
        }
        loaded++;
        if (loaded === selected.length) {
          setFiles(entries.sort((a, b) => a.category.localeCompare(b.category)));
        }
      };
      reader.readAsText(file);
    });
  }

  const totalListings = files.reduce((sum, f) => sum + f.listings.length, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) {
      setError("Select JSON files first");
      return;
    }
    setError("");
    setLoading(true);
    setResults([]);

    const importResults: { category: string; count: number; error?: string }[] = [];

    for (const file of files) {
      try {
        const res = await fetch("/api/outreach/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            category: file.category,
            listings: file.listings,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          importResults.push({ category: file.category, count: 0, error: data.error });
        } else {
          importResults.push({ category: file.category, count: file.listings.length });
        }
      } catch {
        importResults.push({ category: file.category, count: 0, error: "Network error" });
      }
    }

    setResults(importResults);
    setLoading(false);

    const allSuccess = importResults.every((r) => !r.error);
    if (allSuccess) {
      setTimeout(() => {
        router.push("/outreach");
        router.refresh();
      }, 1500);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      <div className="v-card space-y-4 p-[var(--density-card-padding)]">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Upload crawled data</h2>

        <div>
          <label className="flex h-32 w-full cursor-pointer items-center justify-center rounded-md border-2 border-dashed border-line transition-colors hover:border-primary/50">
            <div className="text-center">
              {files.length > 0 ? (
                <>
                  <p className="text-sm font-medium text-foreground">
                    {files.length} file{files.length > 1 ? "s" : ""} selected
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {totalListings} listings total
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">Click to select JSON files</p>
                  <p className="mt-1 text-xs text-muted-foreground">Select multiple files at once</p>
                </>
              )}
            </div>
            <input
              type="file"
              accept=".json"
              multiple
              onChange={handleFiles}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="v-card p-[var(--density-card-padding)]">
          <h2 className="mb-3 text-base font-semibold tracking-[-0.01em] text-foreground">
            {files.length} campaigns ({totalListings} listings)
          </h2>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {files.map((f, i) => {
              const result = results.find((r) => r.category === f.category);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between text-sm py-2 border-b border-border last:border-0"
                >
                  <div>
                    <p className="font-medium text-foreground">{f.name}</p>
                    <p className="text-xs text-muted-foreground">{f.listings.length} listings</p>
                  </div>
                  {result ? (
                    result.error ? (
                      <span className="text-xs text-status-danger">{result.error}</span>
                    ) : (
                      <span className="text-xs text-status-success">{result.count} imported</span>
                    )
                  ) : loading ? (
                    <span className="text-xs text-muted-foreground">Waiting…</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={loading || files.length === 0}
          className={buttonClassName({ size: "lg" })}
        >
          {loading ? "Importing..." : `Import All (${totalListings} leads)`}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className={buttonClassName({ variant: "ghost", size: "lg" })}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
