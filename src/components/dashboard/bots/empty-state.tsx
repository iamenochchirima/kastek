import Link from "next/link";

export default function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <div className="mb-4 text-4xl text-text-dim">⚡</div>
      <h2 className="mb-2 font-serif text-xl text-text">No bots yet</h2>
      <p className="mb-6 max-w-sm text-sm text-text-muted">
        Create your first WhatsApp chatbot to start automating customer
        conversations for your business.
      </p>
      <Link
        href="/dashboard/bots/new"
        className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
      >
        Create Your First Bot
      </Link>
    </div>
  );
}
