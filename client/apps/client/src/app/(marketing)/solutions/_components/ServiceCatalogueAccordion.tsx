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
  const panelId = "service-catalogue-panel";

  return (
    <div
      className="rounded-2xl border bg-[#0A0A0A] overflow-hidden"
      style={{ borderColor: accentBorder }}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between px-6 py-5 text-left transition-colors hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-3">
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.2em]"
            style={{ color: accentColor }}
          >
            All services
          </span>
          <span className="text-sm text-muted-foreground">
            See the full catalogue ({totalCount})
          </span>
        </div>
        <ChevronDown
          className={`h-5 w-5 text-muted-foreground transition-transform duration-300 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          id={panelId}
          className="border-t px-6 py-6 space-y-8"
          style={{ borderColor: accentBorder }}
        >
          {/* Primary services */}
          <div>
            <p
              className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em]"
              style={{ color: accentColor }}
            >
              {primaryLabel}
            </p>
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {primaryServices.map((service) => (
                <li
                  key={service.title}
                  className="rounded-lg border border-white/5 bg-white/[0.02] p-3"
                >
                  <p className="text-sm font-semibold text-foreground">{service.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {service.description}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {/* Secondary services */}
          {secondaryServices.length > 0 && (
            <div>
              <p
                className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em]"
                style={{ color: accentColor }}
              >
                {secondaryLabel}
              </p>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {secondaryServices.map((service) => (
                  <li
                    key={service.title}
                    className="rounded-lg border border-white/5 bg-white/[0.02] p-3"
                  >
                    <p className="text-sm font-semibold text-foreground">{service.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {service.description}
                    </p>
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
