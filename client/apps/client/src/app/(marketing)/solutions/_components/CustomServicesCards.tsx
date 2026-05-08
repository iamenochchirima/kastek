import Image from "next/image";
import type { SolutionService } from "../data";

interface CustomServicesCardsProps {
  title: string;
  description: string;
  services: SolutionService[];
  accentColor: string;
  accentBorder: string;
  accentDim: string;
}

export function CustomServicesCards({
  title,
  description,
  services,
  accentColor,
  accentBorder,
  accentDim,
}: CustomServicesCardsProps) {
  const withImages = services.filter((s) => s.image);
  if (withImages.length === 0) return null;

  return (
    <div className="space-y-6">
      <div>
        <span
          className="text-xs font-semibold uppercase tracking-[0.22em]"
          style={{ color: accentColor }}
        >
          {title}
        </span>
        <p className="mt-1 text-sm text-muted-foreground max-w-lg">{description}</p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {withImages.map((service, i) => (
          <div
            key={i}
            className="group flex flex-col rounded-2xl overflow-hidden border bg-[#0D0D0D] transition-all duration-300 hover:border-opacity-60"
            style={{ borderColor: accentBorder }}
          >
            {/* Image */}
            <div className="relative w-full overflow-hidden" style={{ aspectRatio: "4/3" }}>
              <Image
                src={service.image!}
                alt={service.title}
                fill
                className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `linear-gradient(to bottom, transparent 50%, rgba(13,13,13,0.85) 100%)`,
                }}
              />
              <div
                className="absolute top-3 left-3 h-1.5 w-1.5 rounded-full"
                style={{ background: accentColor }}
              />
            </div>

            {/* Text */}
            <div className="flex flex-col gap-2 p-4 flex-1">
              <h3 className="font-semibold text-sm leading-snug text-foreground">
                {service.title}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground flex-1">
                {service.description}
              </p>
              <div
                className="mt-1 h-px w-8 rounded-full transition-all duration-300 group-hover:w-14"
                style={{ background: accentColor }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
