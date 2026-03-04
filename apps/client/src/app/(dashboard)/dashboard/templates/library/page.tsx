import Link from "next/link";
import { TEMPLATE_CATEGORY_OPTIONS, TEMPLATE_LIBRARY, categoryLabel } from "@/lib/whatsapp/template-library";

export const metadata = {
  title: "Template Library | KasiTek",
};

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  ...TEMPLATE_CATEGORY_OPTIONS.map((option) => ({
    value: option.value.toLowerCase(),
    label: option.label,
  })),
] as const;

export default async function TemplateLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const params = await searchParams;
  const selectedFilter = (params.type || "all").toLowerCase();
  const visibleTemplates =
    selectedFilter === "all"
      ? TEMPLATE_LIBRARY
      : TEMPLATE_LIBRARY.filter((item) => item.category.toLowerCase() === selectedFilter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/dashboard/templates"
            className="mb-2 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
          >
            ← Back to Templates
          </Link>
          <h1 className="mb-1 text-3xl font-semibold tracking-tight">Template Library</h1>
          <p className="max-w-2xl text-text-muted">
            Pick a reusable starting point, then jump into Your Templates to customize and submit it
            to Meta.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTER_OPTIONS.map((option) => {
          const active = option.value === selectedFilter;

          return (
            <Link
              key={option.value}
              href={
                option.value === "all"
                  ? "/dashboard/templates/library"
                  : `/dashboard/templates/library?type=${option.value}`
              }
              className={`rounded-full px-4 py-2 text-sm font-medium no-underline transition-colors ${
                active
                  ? "bg-accent text-bg"
                  : "border border-border text-text-muted hover:border-border-light hover:text-text"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {selectedFilter === "all"
            ? "All reusable starter templates."
            : `${FILTER_OPTIONS.find((option) => option.value === selectedFilter)?.label || "Filtered"} starter templates.`}
        </p>
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-dim">
          {visibleTemplates.length} starter templates
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {visibleTemplates.map((item) => (
          <div key={item.id} className="rounded-xl border border-border bg-surface p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-text">{item.title}</h3>
              <span className="rounded-full border border-border px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-text-dim">
                {categoryLabel(item.category)}
              </span>
            </div>
            <p className="mb-3 text-sm text-text-muted">{item.description}</p>
            <div className="rounded-lg border border-border bg-surface-2 p-3">
              <p className="whitespace-pre-wrap text-xs text-text-dim">{item.body}</p>
            </div>
            <Link
              href={`/dashboard/templates/whatsapp?starter=${item.id}`}
              className="mt-4 inline-flex rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text-muted no-underline transition-colors hover:border-border-light hover:bg-surface hover:text-text"
            >
              Use this template
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
