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
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
          {intro}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {outcomes.map((outcome, i) => (
          <div
            key={i}
            className="group relative flex flex-col overflow-hidden rounded-2xl border bg-[#0D0D0D] transition-all duration-300 hover:bg-[#111111]"
            style={{ borderColor: accentBorder }}
          >
            {/* Accent glow on hover */}
            <div
              className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
              style={{
                background: `radial-gradient(ellipse at 50% 0%, ${accentDim} 0%, transparent 60%)`,
              }}
            />

            {/* Image */}
            <div
              className="relative w-full overflow-hidden"
              style={{ aspectRatio: "16/10" }}
            >
              <Image
                src={outcome.image}
                alt={outcome.title}
                fill
                className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                sizes="(max-width: 768px) 100vw, 33vw"
              />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    "linear-gradient(to bottom, transparent 40%, rgba(13,13,13,0.95) 100%)",
                }}
              />
              <div
                className="absolute top-3 left-3 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
                style={{
                  background: accentColor,
                  color: accentColor === "#E8A020" ? "#000" : "#fff",
                }}
              >
                {i + 1}
              </div>
            </div>

            {/* Body */}
            <div className="relative z-10 flex flex-1 flex-col gap-4 p-5 md:p-6">
              <div>
                <h3 className="font-display text-2xl leading-tight text-foreground mb-2">
                  {outcome.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {outcome.description}
                </p>
              </div>

              {/* Underlying services */}
              <ul className="mt-auto space-y-1.5 border-t border-white/5 pt-4">
                {outcome.includes.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-xs text-muted-foreground"
                  >
                    <Check
                      className="mt-0.5 h-3 w-3 flex-shrink-0"
                      style={{ color: accentColor }}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
