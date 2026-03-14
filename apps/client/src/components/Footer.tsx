import Link from "next/link";

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border px-8 py-10 text-sm text-text-dim">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 md:flex-row">
        <p>&copy; {year} KasiTek</p>

        <div className="flex items-center gap-5">
          <Link href="/privacy-policy" className="transition hover:text-text">
            Privacy Policy
          </Link>
          <Link href="/terms" className="transition hover:text-text">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}
