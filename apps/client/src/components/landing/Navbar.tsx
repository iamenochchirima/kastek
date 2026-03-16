"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 40);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
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
        <Link
          href="/pricing"
          className="rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white/82 transition hover:border-white/20 hover:bg-white/8 hover:text-white md:hidden"
        >
          Pricing
        </Link>
        <Link
          href="/login"
          className="rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white/82 transition hover:border-white/20 hover:bg-white/8 hover:text-white md:hidden"
        >
          Login
        </Link>

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
        <li>
          <Link
            href="/login"
            className="text-muted-foreground transition-colors hover:text-white"
          >
            Login
          </Link>
        </li>
        <li>
          <button
            type="button"
            onClick={() => scrollTo("contact")}
            className="px-5 py-2.5 bg-primary/10 text-primary border border-primary/20 rounded-lg hover:bg-primary hover:text-primary-foreground transition-all duration-300 font-semibold"
          >
            Get Started
          </button>
        </li>
        </ul>
      </div>
    </motion.nav>
  );
}
