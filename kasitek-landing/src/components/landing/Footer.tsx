export function Footer() {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <footer className="border-t border-border px-6 md:px-12 py-8 bg-background relative z-10" id="footer">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        
        <div className="font-display text-2xl tracking-widest text-white opacity-80 hover:opacity-100 transition-opacity cursor-default">
          Kasi<span className="text-primary">Tek</span>
        </div>

        <div className="text-xs text-muted-foreground font-medium">
          © {new Date().getFullYear()} KasiTek · Built for SMBs
        </div>

        <div className="flex items-center gap-6 text-sm font-medium">
          <button onClick={() => scrollTo("products")} className="text-muted-foreground hover:text-white transition-colors">Products</button>
          <button onClick={() => scrollTo("services")} className="text-muted-foreground hover:text-white transition-colors">Services</button>
          <a href="mailto:hello@kasitek.co.za" className="text-muted-foreground hover:text-primary transition-colors">hello@kasitek.co.za</a>
        </div>

      </div>
    </footer>
  );
}
