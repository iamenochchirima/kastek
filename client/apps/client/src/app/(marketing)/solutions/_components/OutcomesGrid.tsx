import Image from "next/image";
import { Check } from "lucide-react";
import type { SolutionOutcome } from "../data";

interface OutcomesGridProps {
  intro?: string;
  outcomes: SolutionOutcome[];
  accentColor: string;
  accentBorder: string;
  accentDim: string;
}

export function OutcomesGrid({
  intro,
  outcomes,
  accentColor,
  accentBorder,
  accentDim,
}: OutcomesGridProps) {
  return (
    <div className="space-y-8">
      {intro && (
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          {intro}
        </p>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {outcomes.map((outcome, i) => (
          <div
            key={i}
            className="group relative flex flex-col overflow-hidden rounded-2xl border bg-[#0D0D0D] transition-all duration-300"
            style={{ borderColor: accentBorder }}
          >
            {/* Number badge */}
            <div
              className="absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold"
              style={{
                background: accentColor,
                color: accentColor === "#E8A020" ? "#000" : "#fff",
              }}
            >
              {i + 1}
            </div>

            {/* Image */}
            <div
              className="relative w-full overflow-hidden"
              style={{ aspectRatio: "4/3" }}
            >
              <Image
                src={outcome.image}
                alt={outcome.title}
                fill
                className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                sizes="(max-width: 1024px) 100vw, 33vw"
              />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `linear-gradient(to bottom, transparent 40%, rgba(13,13,13,0.95) 100%)`,
                }}
              />
            </div>

            {/* Body */}
            <div className="flex flex-col gap-4 p-6 flex-1">
              <div>
                <h3 className="font-display text-2xl leading-tight text-foreground">
                  {outcome.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {outcome.description}
                </p>
              </div>

              {/* Includes */}
              <div className="mt-auto pt-4 border-t" style={{ borderColor: accentDim }}>
                <p
                  className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em]"
                  style={{ color: accentColor }}
                >
                  Includes
                </p>
                <ul className="space-y-1.5">
                  {outcome.includes.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2 text-xs leading-snug text-muted-foreground"
                    >
                      <Check
                        className="mt-0.5 h-3 w-3 flex-shrink-0"
                        style={{ color: accentColor }}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
