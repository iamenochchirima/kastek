"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const showLocalLogin = useSyncExternalStore(
    () => () => {},
    () => {
      const { hostname } = window.location;
      return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1"
      );
    },
    () => false,
  );

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 40);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = isMobileMenuOpen ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [isMobileMenuOpen]);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
    setIsMobileMenuOpen(false);
  };

  return (
    <motion.nav
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "fixed top-0 inset-x-0 z-40 transition-all duration-300 px-6 md:px-12 py-4 flex items-center justify-between",
        scrolled ? "bg-background/80 backdrop-blur-md border-b border-border shadow-lg shadow-black/20 py-4" : "bg-transparent py-6"
      )}
    >
      <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
        <Image
          src="/logo.png"
          alt="KasiTek"
          width={36}
          height={36}
          className="h-9 w-9 rounded-md object-contain"
        />
        <span className="font-display text-2xl tracking-widest text-white">
          Kasi<span className="text-primary">Tek</span>
        </span>
      </Link>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setIsMobileMenuOpen((current) => !current)}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-white/12 bg-white/5 text-muted-foreground transition hover:border-white/20 hover:bg-white/8 hover:text-white md:hidden"
          aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
        >
          {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        <ul className="hidden md:flex items-center gap-8 text-sm font-medium">
        <li>
          <button type="button" onClick={() => scrollTo("products")} className="text-muted-foreground transition-colors hover:text-white">
            Products
          </button>
        </li>
        <li>
          <button type="button" onClick={() => scrollTo("services")} className="text-muted-foreground transition-colors hover:text-white">
            Services
          </button>
        </li>
        <li>
          <button type="button" onClick={() => scrollTo("footer")} className="text-muted-foreground transition-colors hover:text-white">
            About
          </button>
        </li>
        <li>
          <Link
            href="/pricing"
            className="text-muted-foreground transition-colors hover:text-white"
          >
            Pricing
          </Link>
        </li>
        {showLocalLogin ? (
          <li>
            <Link
              href="/login"
              className="text-muted-foreground transition-colors hover:text-white"
            >
              Login
            </Link>
          </li>
        ) : null}
        <li>
          <Link
            href="/get-quote"
            className="rounded-lg border border-primary/15 bg-white/5 px-5 py-2.5 font-semibold text-muted-foreground transition-all duration-300 hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
          >
            Get Quote
          </Link>
        </li>
        <li>
          <Link
            href="/waitlist"
            className="rounded-lg border border-primary/20 bg-primary/10 px-5 py-2.5 font-semibold text-primary transition-all duration-300 hover:bg-primary hover:text-primary-foreground"
          >
            Join Waitlist
          </Link>
        </li>
        </ul>
      </div>

      {isMobileMenuOpen ? (
        <div className="absolute inset-x-6 top-full mt-3 rounded-[24px] border border-white/12 bg-[#090909]/96 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl md:hidden">
          <div className="flex flex-col gap-3 text-sm font-medium">
            <Link
              href="/#products"
              className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-muted-foreground transition hover:border-white/14 hover:bg-white/[0.05] hover:text-white"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              Products
            </Link>
            <Link
              href="/#services"
              className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-muted-foreground transition hover:border-white/14 hover:bg-white/[0.05] hover:text-white"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              Services
            </Link>
            <Link
              href="/pricing"
              className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-muted-foreground transition hover:border-white/14 hover:bg-white/[0.05] hover:text-white"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              Pricing
            </Link>
            {showLocalLogin ? (
              <Link
                href="/login"
                className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-muted-foreground transition hover:border-white/14 hover:bg-white/[0.05] hover:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Login
              </Link>
            ) : null}
            <div className="mt-2 grid grid-cols-1 gap-3">
              <Link
                href="/get-quote"
                className="rounded-xl border border-primary/15 bg-white/[0.03] px-4 py-3 text-center font-semibold text-muted-foreground transition hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Get Quote
              </Link>
              <Link
                href="/waitlist"
                className="rounded-xl border border-primary/20 bg-primary/10 px-4 py-3 text-center font-semibold text-primary transition hover:bg-primary hover:text-primary-foreground"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Join Waitlist
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </motion.nav>
  );
}
