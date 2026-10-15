"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

export default function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  if (totalPages <= 1) return null;

  function goToPage(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (page <= 1) {
      params.delete("page");
    } else {
      params.set("page", String(page));
    }
    router.push(`?${params.toString()}`);
  }

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  // Build page numbers to show
  const pages: (number | "...")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (currentPage > 3) pages.push("...");
    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
      pages.push(i);
    }
    if (currentPage < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <p className="v-label">
        Showing {start}–{end} of {totalItems}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          Previous
        </button>
        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`dots-${i}`} className="px-1.5 text-xs text-muted-foreground">
              ...
            </span>
          ) : (
            <button
              key={p}
              onClick={() => goToPage(p)}
              aria-current={p === currentPage ? "page" : undefined}
              className={cn("min-w-7 rounded-md px-1.5 py-1.5 text-xs font-medium transition-colors", p === currentPage ? "bg-primary text-primary-foreground shadow-card" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  );
}
