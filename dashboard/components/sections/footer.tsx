import Link from "next/link"

export function Footer() {
  return (
    <footer className="border-t border-border px-6 md:px-12 lg:px-16 py-12">
      <div className="flex flex-col md:flex-row items-center justify-between gap-6">
        <Link 
          href="#" 
          className="text-xl tracking-[0.2em]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          KASI<span className="text-primary">TEK</span>
        </Link>

        <span className="text-xs text-muted-foreground order-3 md:order-none">
          © 2025 KasiTek · Built for SMBs
        </span>

        <div className="flex items-center gap-7">
          <Link 
            href="#products" 
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Products
          </Link>
          <Link 
            href="#services" 
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Services
          </Link>
          <Link 
            href="mailto:hello@kasitek.co.za" 
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            hello@kasitek.co.za
          </Link>
        </div>
      </div>
    </footer>
  )
}
