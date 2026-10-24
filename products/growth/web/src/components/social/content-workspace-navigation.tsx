import { Link } from "react-router";
import { BarChart3, CalendarDays, FileText, Pencil } from "lucide-react";

export type ContentWorkspaceView = "posts" | "calendar" | "history" | "analytics";

const navigation = [
  { href: "/content", label: "Create", icon: Pencil, view: "posts" },
  { href: "/content/posts", label: "Posts", icon: FileText, view: "history" },
  { href: "/content/calendar", label: "Calendar", icon: CalendarDays, view: "calendar" },
  { href: "/content/analytics", label: "Analytics", icon: BarChart3, view: "analytics" },
] as const;

export function ContentWorkspaceNavigation({ active }: { active: ContentWorkspaceView }) {
  return (
    <nav aria-label="Content navigation" className="flex gap-1 overflow-x-auto">
      {navigation.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            to={item.href}
            aria-current={item.view === active ? "page" : undefined}
            className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              item.view === active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
