"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { SolutionService } from "../data";

interface ServiceCatalogueAccordionProps {
  primaryLabel: string;
  primaryServices: SolutionService[];
  secondaryLabel: string;
  secondaryServices: SolutionService[];
  accentColor: string;
  accentBorder: string;
}

export function ServiceCatalogueAccordion({
  primaryLabel,
  primaryServices,
  secondaryLabel,
  secondaryServices,
  accentColor,
  accentBorder,
}: ServiceCatalogueAccordionProps) {
  const [open, setOpen] = useState(false);
  const totalCount = primaryServices.length + secondaryServices.length;

  return (
    <div
      className="rounded-2xl border bg-[#0A0A0A] overflow-hidden"
      style={{ borderColor: "rgba(255,255,255,0.06)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-white/[0.02] md:px-6 md:py-5"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span
            className="text-xs font-semibold uppercase tracking-[0.22em]"
            style={{ color: accentColor }}
          >
            Full service catalogue
          </span>
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            {totalCount} services
          </span>
        </div>
        <ChevronDown
          className={`h-5 w-5 text-muted-foreground transition-transform duration-300 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="border-t border-white/5 px-5 py-6 md:px-6 md:py-7">
          {/* Primary group */}
          <div className="mb-7">
            <p
              className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground"
            >
              {primaryLabel}
            </p>
            <ul className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
              {primaryServices.map((service) => (
                <li key={service.title} className="flex items-start gap-3">
                  <div
                    className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{ background: accentColor }}
                  />
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {service.title}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {service.description}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Secondary group */}
          {secondaryServices.length > 0 && (
            <div className="border-t border-white/5 pt-6">
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                {secondaryLabel}
              </p>
              <ul className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
                {secondaryServices.map((service) => (
                  <li key={service.title} className="flex items-start gap-3">
                    <div
                      className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full border"
                      style={{ borderColor: accentBorder }}
                    />
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {service.title}
                      </p>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {service.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
