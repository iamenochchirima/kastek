import Link from "next/link";

export const metadata = {
  title: "Inbox | KasiTek",
};

const channels = [
  {
    title: "WhatsApp",
    description: "Manage live WhatsApp conversations, reply to customers, and handle bot handoff.",
    href: "/dashboard/inbox/whatsapp",
    icon: "💬",
    status: "Available now",
  },
  {
    title: "Instagram",
    description: "Bring Instagram DMs into the same agent workspace.",
    href: "#",
    icon: "📸",
    status: "Coming next",
  },
  {
    title: "Messenger",
    description: "Handle Facebook Messenger conversations from the same inbox hub.",
    href: "#",
    icon: "📨",
    status: "Planned",
  },
];

export default function InboxOverviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Inbox</h1>
        <p className="max-w-2xl text-text-muted">
          Inbox is the parent workspace for all conversation channels. WhatsApp is live first, with
          other channels following the same operating model.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {channels.map((channel) => (
          <div key={channel.title} className="rounded-xl border border-border bg-surface p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="text-3xl">{channel.icon}</div>
              <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">
                {channel.status}
              </span>
            </div>

            <h2 className="mb-2 text-lg font-semibold text-text">{channel.title}</h2>
            <p className="mb-5 text-sm text-text-muted">{channel.description}</p>

            {channel.href === "#" ? (
              <span className="inline-flex rounded-lg border border-border px-4 py-2 text-sm text-text-dim">
                Not available yet
              </span>
            ) : (
              <Link
                href={channel.href}
                className="inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg no-underline"
              >
                Open {channel.title}
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
