"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";

const links = [
  { label: "Services", href: "#services" },
  { label: "Industries", href: "#industries" },
  { label: "Process", href: "#process" },
  { label: "Pricing", href: "/pricing" },
  { label: "FAQ", href: "#faq" },
];

export default function Navbar() {
  const { status } = useSession();
  const authHref = status === "authenticated" ? "/dashboard" : "/login";
  const authLabel = status === "authenticated" ? "Dashboard" : "Log In";

  return (
    <nav className="fixed top-0 z-100 w-full flex items-center justify-between px-8 py-4 bg-bg/85 backdrop-blur-xl border-b border-border max-sm:px-4">
      <Link href="/" className="flex items-center gap-2 no-underline">
        <img src="/logo.png" alt="KasiAI" className="h-8 w-8" />
        <span className="font-serif text-2xl text-text tracking-tight">
          Kasi<span className="text-accent">AI</span>
        </span>
      </Link>

      <div className="hidden md:flex items-center gap-8">
        {links.map((link) =>
          link.href.startsWith("/") ? (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-text-muted no-underline transition-colors hover:text-text"
            >
              {link.label}
            </Link>
          ) : (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-text-muted no-underline transition-colors hover:text-text"
            >
              {link.label}
            </a>
          )
        )}
      </div>

      <div className="flex items-center gap-3">
        <Link
          href={authHref}
          className="text-sm text-text-muted no-underline transition-colors hover:text-text"
        >
          {authLabel}
        </Link>
        <Link
          href="/get-quote"
          className="bg-accent text-bg px-6 py-2.5 rounded-full font-semibold text-sm no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
        >
          Get a Quote &rarr;
        </Link>
      </div>
    </nav>
  );
}
