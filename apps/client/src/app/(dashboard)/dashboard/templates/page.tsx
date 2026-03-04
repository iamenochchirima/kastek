import Link from "next/link";

export const metadata = {
  title: "Templates | KasiAI",
};

const sections = [
  {
    title: "Template Library",
    description: "Browse reusable starter templates and jump into customization from a cleaner catalog.",
    href: "/dashboard/templates/library",
    icon: "🧩",
  },
  {
    title: "Your Templates",
    description: "Create, sync, and manage the WhatsApp templates tied to your account.",
    href: "/dashboard/templates/whatsapp",
    icon: "🗂",
  },
];

export default function TemplatesOverviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Templates</h1>
        <p className="max-w-2xl text-text-muted">
          Manage reusable message templates from one place. Start with the library, then move into
          your own approved and pending templates.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((section) => (
          <div key={section.title} className="rounded-xl border border-border bg-surface p-5">
            <div className="mb-4 text-3xl">{section.icon}</div>
            <h2 className="mb-2 text-lg font-semibold text-text">{section.title}</h2>
            <p className="mb-5 text-sm text-text-muted">{section.description}</p>
            <Link
              href={section.href}
              className="inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg no-underline"
            >
              Open {section.title}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
