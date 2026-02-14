import Link from "next/link";
import BotStatusBadge from "./bot-status-badge";

const typeLabels: Record<string, string> = {
  starter: "Starter — Menu-driven",
  growth: "Growth — AI-powered",
};

interface BotCardProps {
  id: string;
  name: string;
  type: string;
  status: string;
  createdAt: Date;
}

export default function BotCard({ id, name, type, status, createdAt }: BotCardProps) {
  return (
    <Link
      href={`/dashboard/bots/${id}`}
      className="group rounded-xl border border-border bg-surface p-5 no-underline transition-colors hover:border-border-light"
    >
      <div className="mb-3 flex items-start justify-between">
        <h3 className="font-medium text-text group-hover:text-accent transition-colors">
          {name}
        </h3>
        <BotStatusBadge status={status} />
      </div>
      <p className="mb-3 text-sm text-text-muted">
        {typeLabels[type] || type}
      </p>
      <p className="text-xs text-text-dim">
        Created {createdAt.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}
      </p>
    </Link>
  );
}
