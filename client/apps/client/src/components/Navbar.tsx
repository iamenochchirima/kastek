import Link from "next/link";
import SignOutButton from "@/components/auth/sign-out-button";
import { getRustSession } from "@/lib/rust-auth";

export default async function Navbar() {
  const session = await getRustSession();

  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-bg/82 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <img src="/logo.png" alt="KasiTek" className="h-8 w-8" />
          <span className="text-2xl font-semibold tracking-tight text-text">
            Kasi<span className="text-accent">Tek</span>
          </span>
        </Link>

        <div className="hidden items-center gap-6 lg:flex">
          <Link href="/#packages" className="text-sm text-text-muted transition hover:text-text">
            Packages
          </Link>
          <Link href="/#packages" className="text-sm text-text-muted transition hover:text-text">
            Services
          </Link>
          <Link href="/pricing" className="text-sm text-text-muted transition hover:text-text">
            Pricing
          </Link>
          <Link href="/#faq" className="text-sm text-text-muted transition hover:text-text">
            FAQ
          </Link>
        </div>

        <div className="flex items-center gap-3">
          {session?.user ? (
            <>
              <Link href="/dashboard" className="text-sm text-text-muted transition hover:text-text">
                Dashboard
              </Link>
              <SignOutButton />
            </>
          ) : (
            <Link href="/login" className="text-sm text-text-muted transition hover:text-text">
              Log In
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
