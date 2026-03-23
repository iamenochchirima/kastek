"use client";

import Image from "next/image";
import Link from "next/link";

export function Footer() {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <footer className="border-t border-border px-6 md:px-12 py-8 bg-background relative z-10" id="footer">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        
        <Link
          href="/"
          className="flex items-center gap-3 opacity-80 transition-opacity hover:opacity-100"
        >
          <Image
            src="/logo.png"
            alt="KasiTek"
            width={32}
            height={32}
            className="h-8 w-8 rounded-md object-contain"
          />
          <div className="font-display text-2xl tracking-widest text-white">
            Kasi<span className="text-primary">Tek</span>
          </div>
        </Link>

        <div className="text-xs text-muted-foreground font-medium">
          © {new Date().getFullYear()} KasiTek · Built for SMBs
        </div>

        <div className="flex items-center gap-6 text-sm font-medium">
          <button onClick={() => scrollTo("products")} className="text-muted-foreground hover:text-white transition-colors">Products</button>
          <button onClick={() => scrollTo("services")} className="text-muted-foreground hover:text-white transition-colors">Services</button>
          <Link href="/privacy-policy" className="text-muted-foreground hover:text-white transition-colors">
            Privacy
          </Link>
          <Link href="/terms" className="text-muted-foreground hover:text-white transition-colors">
            Terms of Service
          </Link>
        </div>

      </div>
    </footer>
  );
}
