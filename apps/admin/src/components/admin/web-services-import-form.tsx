"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type FileEntry = {
  fileName: string;
  category: string;
  listings: { name: string; website?: string; address?: string; bizbayUrl?: string }[];
};

export default function WebServicesImportForm() {
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
            entries.push({ fileName: file.name, category: cat, listings: items });
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
        const res = await fetch("/api/web-services/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: file.category, listings: file.listings }),
        });

        if (!res.ok) {
          const data = await res.json();
          importResults.push({ category: file.category, count: 0, error: data.error });
        } else {
          const data = await res.json();
          importResults.push({ category: file.category, count: data.imported });
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
        router.push("/web-services");
        router.refresh();
      }, 1500);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg border border-danger/20">
          {error}
        </div>
      )}

      <div className="bg-surface-raised rounded-xl border border-border p-6 space-y-4">
        <h2 className="font-semibold text-text">Upload Data</h2>

        <div>
          <label className="flex items-center justify-center w-full h-32 border-2 border-dashed border-border rounded-xl cursor-pointer hover:border-primary/50 transition-colors">
            <div className="text-center">
              {files.length > 0 ? (
                <>
                  <p className="text-sm font-medium text-text">
                    {files.length} file{files.length > 1 ? "s" : ""} selected
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    {totalListings} businesses total
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-text-muted">Click to select JSON files</p>
                  <p className="text-xs text-text-faint mt-1">Select multiple files at once</p>
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
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold text-text mb-3">
            {files.length} files ({totalListings} businesses)
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
                    <p className="text-text font-medium">{f.category}</p>
                    <p className="text-text-faint text-xs">{f.listings.length} businesses</p>
                  </div>
                  {result ? (
                    result.error ? (
                      <span className="text-red-400 text-xs">{result.error}</span>
                    ) : (
                      <span className="text-green-400 text-xs">{result.count} imported</span>
                    )
                  ) : loading ? (
                    <span className="text-text-faint text-xs">waiting...</span>
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
          className="bg-primary hover:bg-primary-dark text-white px-6 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {loading ? "Importing..." : `Import All (${totalListings} leads)`}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-text-muted hover:text-text px-6 py-2.5 rounded-lg font-medium"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
