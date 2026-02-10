const links = [
  { label: "Services", href: "#services" },
  { label: "Industries", href: "#industries" },
  { label: "Process", href: "#process" },
  { label: "Pricing", href: "#pricing" },
];

export default function Navbar() {
  return (
    <nav className="fixed top-0 z-100 w-full flex items-center justify-between px-8 py-4 bg-bg/85 backdrop-blur-xl border-b border-border max-sm:px-4">
      <a href="#" className="font-serif text-2xl text-text tracking-tight no-underline">
        Kasi<span className="text-accent">AI</span>
      </a>

      <div className="hidden md:flex items-center gap-8">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="text-sm text-text-muted no-underline transition-colors hover:text-text"
          >
            {link.label}
          </a>
        ))}
      </div>

      <a
        href="#contact"
        className="bg-accent text-bg px-6 py-2.5 rounded-full font-semibold text-sm no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
      >
        Let&apos;s Talk &rarr;
      </a>
    </nav>
  );
}
