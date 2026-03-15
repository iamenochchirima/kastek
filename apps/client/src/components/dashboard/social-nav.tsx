"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { label: "Planner", href: "/dashboard/social" },
  { label: "Calendar", href: "/dashboard/social/calendar" },
  { label: "Posts", href: "/dashboard/social/posts" },
  { label: "Channels", href: "/dashboard/social/channels" },
  { label: "Analytics", href: "/dashboard/social/analytics" },
];

export default function SocialNav() {
  const pathname = usePathname();

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => {
        const active = pathname === item.href;

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-full px-4 py-2 text-sm font-medium no-underline transition ${
              active
                ? "bg-accent text-bg shadow-[0_4px_20px_rgba(196,240,77,0.2)]"
                : "border border-border bg-surface text-text-muted hover:border-border-light hover:text-text"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
