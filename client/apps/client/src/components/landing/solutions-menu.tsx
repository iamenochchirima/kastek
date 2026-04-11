"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { solutionCategories } from "@/app/(marketing)/solutions/data";

export function SolutionsMenu({ currentSlug }: { currentSlug?: string }) {
  const [isOpen, setIsOpen] = useState(false);

  const currentLabel = useMemo(() => {
    if (!currentSlug) return "Browse categories";
    return solutionCategories.find((item) => item.slug === currentSlug)?.menuLabel ?? "Browse categories";
  }, [currentSlug]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-foreground transition hover:border-white/20 hover:bg-white/[0.06]"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        {currentLabel}
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen ? (
        <div className="absolute right-0 top-full z-20 mt-3 min-w-[250px] rounded-2xl border border-white/10 bg-[#0B0B0B]/96 p-2 shadow-[0_20px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <div className="flex flex-col gap-1">
            {solutionCategories.map((category) => (
              <Link
                key={category.slug}
                href={`/solutions/${category.slug}`}
                onClick={() => setIsOpen(false)}
                className={`rounded-xl px-4 py-3 text-sm transition ${
                  category.slug === currentSlug
                    ? "bg-primary/10 font-semibold text-primary"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span>{category.menuLabel}</span>
                  {category.readiness === "coming-soon" ? (
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      Soon
                    </span>
                  ) : null}
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
