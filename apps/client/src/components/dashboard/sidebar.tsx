"use client";

import SignOutButton from "@/components/auth/sign-out-button";
import ThemeToggle from "@/components/theme-toggle";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type IconProps = {
  active?: boolean;
  className?: string;
};

type NavSubItem = {
  label: string;
  href: string;
};

type NavItem = {
  label: string;
  href: string;
  icon: (props: IconProps) => React.JSX.Element;
  subItems?: NavSubItem[];
};

type SidebarProps = {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
};

function DashboardIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" className={active ? "fill-current/12" : ""} />
      <rect x="13.5" y="3.5" width="7" height="4.5" rx="1.5" className={active ? "fill-current/12" : ""} />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" className={active ? "fill-current/12" : ""} />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" className={active ? "fill-current/12" : ""} />
    </svg>
  );
}

function BotIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M9 3.5h6" />
      <path d="M12 3.5V6" />
      <rect x="4" y="6.5" width="16" height="11" rx="4" className={active ? "fill-current/12" : ""} />
      <path d="M7.5 20v-2.5M16.5 20v-2.5" />
      <circle cx="9" cy="11.5" r="1" />
      <circle cx="15" cy="11.5" r="1" />
      <path d="M9 15h6" />
    </svg>
  );
}

function InboxIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z" className={active ? "fill-current/12" : ""} />
      <path d="M4 8.5h4l2.1 4h3.8L16 8.5h4" />
    </svg>
  );
}

function ContactsIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <circle cx="8" cy="9" r="3" className={active ? "fill-current/12" : ""} />
      <path d="M3.5 18a4.5 4.5 0 0 1 9 0" />
      <circle cx="16.5" cy="10" r="2.5" className={active ? "fill-current/12" : ""} />
      <path d="M13.5 18a4 4 0 0 1 7 0" />
    </svg>
  );
}

function ProfileIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <circle cx="12" cy="8.5" r="3.5" className={active ? "fill-current/12" : ""} />
      <path d="M5 19a7 7 0 0 1 14 0" />
    </svg>
  );
}

function TemplateIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h6.8L19 8.7v7.8A2.5 2.5 0 0 1 16.5 19h-9A2.5 2.5 0 0 1 5 16.5v-10Z" className={active ? "fill-current/12" : ""} />
      <path d="M14 4v5h5" />
      <path d="M8.5 12h7M8.5 15h5" />
    </svg>
  );
}

function CampaignIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M4 14.5V9.8a2 2 0 0 1 1.4-1.9l11.2-3.6a2 2 0 0 1 2.6 1.9v11.6a2 2 0 0 1-2.6 1.9L5.4 16.4A2 2 0 0 1 4 14.5Z" className={active ? "fill-current/12" : ""} />
      <path d="M8 17.2v2.3a1.5 1.5 0 0 0 3 0v-1.3" />
      <path d="M19.2 9.5c1 .4 1.8 1.4 1.8 2.5s-.7 2.1-1.8 2.5" />
    </svg>
  );
}

function SettingsIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M12 3.5 14 5l2.5-.5 1 2.3 2.3 1-.5 2.5L21 12l-1.7 2 .5 2.5-2.3 1-1 2.3L14 19l-2 1.5L10 19l-2.5.5-1-2.3-2.3-1 .5-2.5L3 12l1.7-2-.5-2.5 2.3-1 1-2.3L10 5l2-1.5Z" />
      <circle cx="12" cy="12" r="3.2" className={active ? "fill-current/12" : ""} />
    </svg>
  );
}

function HelpIcon({ active = false, className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <circle cx="12" cy="12" r="8.5" className={active ? "fill-current/12" : ""} />
      <path d="M9.8 9.7a2.5 2.5 0 1 1 4.4 1.6c-.8 1-1.7 1.4-2.2 2.2-.2.3-.3.6-.3 1" />
      <circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m7 4 6 6-6 6" />
    </svg>
  );
}

const navItems: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: DashboardIcon },
  { label: "My Bots", href: "/dashboard/bots", icon: BotIcon },
  {
    label: "Inbox",
    href: "/dashboard/inbox",
    icon: InboxIcon,
    subItems: [{ label: "WhatsApp", href: "/dashboard/inbox/whatsapp" }],
  },
  { label: "Contacts", href: "/dashboard/contacts", icon: ContactsIcon },
  {
    label: "Templates",
    href: "/dashboard/templates",
    icon: TemplateIcon,
    subItems: [
      { label: "Template Library", href: "/dashboard/templates/library" },
      { label: "Your Templates", href: "/dashboard/templates/whatsapp" },
    ],
  },
  {
    label: "Campaigns",
    href: "/dashboard/campaigns",
    icon: CampaignIcon,
    subItems: [{ label: "WhatsApp", href: "/dashboard/campaigns/whatsapp" }],
  },
  { label: "Settings", href: "/dashboard/settings", icon: SettingsIcon },
];

function isItemActive(pathname: string, href: string) {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
}

function SidebarNavItem({
  item,
  pathname,
  open,
  onToggle,
}: {
  item: NavItem;
  pathname: string;
  open: boolean;
  onToggle: () => void;
}) {
  const active = isItemActive(pathname, item.href);
  const hasSubmenu = !!item.subItems?.length;
  const Icon = item.icon;

  return (
    <div>
      <div className="mb-1">
        <Link
          href={item.href}
          className={`group flex min-w-0 items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm no-underline transition-all ${
            active
              ? "bg-[linear-gradient(135deg,rgba(196,240,77,0.14),rgba(196,240,77,0.04))] text-text shadow-[inset_0_0_0_1px_rgba(196,240,77,0.18)]"
              : "text-text-muted hover:bg-surface-2 hover:text-text"
          }`}
        >
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
              active
                ? "border-accent/25 bg-accent/10 text-accent"
                : "border-border bg-bg/50 text-text-dim group-hover:border-border-light group-hover:text-text"
            }`}
          >
            <Icon active={active} className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
          {hasSubmenu ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggle();
              }}
              aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
              aria-expanded={open}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
                active || open
                  ? "border-accent/20 bg-accent/10 text-accent"
                  : "border-border bg-bg/40 text-text-dim hover:border-border-light hover:text-text"
              }`}
            >
              <ChevronIcon open={open} />
            </button>
          ) : null}
        </Link>
      </div>

      {hasSubmenu && open ? (
        <div className="mb-3 ml-5 border-l border-border/80 pl-5">
          <div className="space-y-1.5">
            {item.subItems!.map((subItem) => {
              const subActive = pathname === subItem.href;

              return (
                <Link
                  key={subItem.href}
                  href={subItem.href}
                  className={`block rounded-xl px-3 py-2.5 text-sm no-underline transition-colors ${
                    subActive
                      ? "bg-accent/10 text-accent"
                      : "text-text-dim hover:bg-surface-2 hover:text-text"
                  }`}
                >
                  {subItem.label}
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navItems.filter((item) => item.subItems?.length).map((item) => [item.href, isItemActive(pathname, item.href)])),
  );
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const identity = user.name ?? "KasiAI User";
  const secondary = user.email ?? "@kasiai";
  const initials = (user.name || user.email || "K")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <aside className="hidden w-72 shrink-0 border-r border-border/80 bg-[radial-gradient(circle_at_top,rgba(196,240,77,0.06),transparent_22%),var(--color-surface)] md:flex md:flex-col">
      <div className="border-b border-border/80 px-6 pb-5 pt-6">
        <Link href="/" className="block text-text no-underline">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            KasiAI Workspace
          </div>
          <div className="text-[28px] font-semibold leading-none tracking-tight">
            Kasi<span className="text-accent">AI</span>
          </div>
        </Link>
      </div>

      <nav className="flex-1 px-4 py-4">
        {navItems.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            pathname={pathname}
            open={isItemActive(pathname, item.href) || !!openMenus[item.href]}
            onToggle={() =>
              setOpenMenus((current) => ({
                ...current,
                [item.href]: !current[item.href],
              }))
            }
          />
        ))}
      </nav>

      <div className="relative px-4 pb-4">
        {accountMenuOpen ? (
          <div className="absolute inset-x-4 bottom-[88px] rounded-[28px] border border-border/90 bg-[rgba(32,32,32,0.96)] p-3 shadow-[0_24px_80px_rgba(0,0,0,0.38)] backdrop-blur-xl">
            <div className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
              {user.image ? (
                <div
                  aria-hidden="true"
                  className="h-10 w-10 rounded-2xl border border-border bg-cover bg-center"
                  style={{ backgroundImage: `url("${user.image}")` }}
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-sm font-semibold text-accent">
                  {initials || "K"}
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-text">{identity}</div>
                <div className="truncate text-xs text-text-dim">{secondary}</div>
              </div>
            </div>

            <div className="my-2 border-t border-border/80" />

            <div className="space-y-1.5">
              <Link
                href="/dashboard/profile"
                onClick={() => setAccountMenuOpen(false)}
                className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-text-muted no-underline transition-colors hover:bg-surface-2 hover:text-text"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-bg/40 text-text-dim">
                  <ProfileIcon className="h-4 w-4" />
                </span>
                Profile
              </Link>

              <Link
                href="/dashboard/settings"
                onClick={() => setAccountMenuOpen(false)}
                className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-text-muted no-underline transition-colors hover:bg-surface-2 hover:text-text"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-bg/40 text-text-dim">
                  <SettingsIcon className="h-4 w-4" />
                </span>
                Settings
              </Link>

              <Link
                href="/dashboard"
                onClick={() => setAccountMenuOpen(false)}
                className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-text-muted no-underline transition-colors hover:bg-surface-2 hover:text-text"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-bg/40 text-text-dim">
                  <HelpIcon className="h-4 w-4" />
                </span>
                Help
              </Link>

              <div className="rounded-2xl px-3 py-2">
                <ThemeToggle />
              </div>
            </div>

            <div className="my-2 border-t border-border/80" />

            <div className="px-3 py-1">
              <SignOutButton />
            </div>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setAccountMenuOpen((current) => !current)}
          className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-border/80 bg-surface/80 px-3.5 py-3 text-left transition-colors hover:border-border-light hover:bg-surface"
        >
          {user.image ? (
            <div
              aria-hidden="true"
              className="h-11 w-11 rounded-2xl border border-border bg-cover bg-center"
              style={{ backgroundImage: `url("${user.image}")` }}
            />
          ) : (
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-sm font-semibold text-accent">
              {initials || "K"}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text">{identity}</div>
            <div className="truncate text-xs text-text-dim">{secondary}</div>
          </div>

          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-bg/40 text-text-dim">
            <ChevronIcon open={accountMenuOpen} />
          </span>
        </button>
      </div>
    </aside>
  );
}
