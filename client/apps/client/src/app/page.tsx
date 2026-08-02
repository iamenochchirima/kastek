import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { getRustSession } from "@/lib/rust-auth";
import { publicSiteUrl } from "@/lib/public-site";

export const metadata: Metadata = {
  title: "KasiTek app",
  description: "Sign in to your KasiTek workspace.",
  robots: { index: false, follow: false },
};

export default async function AppGatewayPage() {
  const session = await getRustSession();

  if (session?.user) {
    redirect(
      session.user.emailVerified
        ? "/workspace"
        : `/verify-request?email=${encodeURIComponent(session.user.email)}`,
    );
  }

  return (
    <main className="relative isolate flex min-h-screen flex-col overflow-hidden bg-[#f6f7f5] text-[#171a18]">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_20%,rgba(45,92,116,0.18),transparent_28%),radial-gradient(circle_at_75%_72%,rgba(39,112,83,0.17),transparent_34%),radial-gradient(circle_at_30%_88%,rgba(204,168,76,0.18),transparent_31%)]" />
        <div className="absolute -right-40 top-1/2 h-[46rem] w-[46rem] -translate-y-1/2 rounded-full border border-white/80 bg-white/15 shadow-[0_0_140px_rgba(255,255,255,0.78)]" />
        <div className="absolute right-10 top-1/2 h-[30rem] w-[30rem] -translate-y-1/2 rounded-full border border-white/80 bg-white/10" />
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-white/60 to-transparent" />
      </div>

      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5 sm:px-8 lg:px-10">
        <a href={publicSiteUrl} className="group inline-flex items-center gap-2.5 no-underline">
          <Image
            src="/logo.svg"
            alt="KasiTek"
            width={36}
            height={36}
            className="h-9 w-9 rounded-lg border border-black/5 shadow-sm"
            priority
          />
          <span>
            <span className="block text-sm font-semibold tracking-tight text-[#171a18]">KasiTek</span>
            <span className="block text-[11px] font-medium text-[#68706b]">Workspace</span>
          </span>
        </a>
        <a
          href={publicSiteUrl}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#5f6762] no-underline transition-colors hover:text-[#171a18]"
        >
          KasiTek Labs
          <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      </header>

      <section className="mx-auto flex w-full max-w-7xl flex-1 items-center px-4 py-12 sm:px-8 lg:px-10 lg:py-16">
        <div className="flex w-full justify-center lg:justify-start">
          <section
            className="w-full max-w-[440px] rounded-xl border border-[#dedfdb] bg-white p-7 shadow-[0_14px_40px_rgba(22,28,24,0.07)] sm:p-9"
            aria-labelledby="access-heading"
          >
            <p className="text-sm font-medium text-[#68706b]">Workspace access</p>
            <h1 id="access-heading" className="mt-3 text-[2rem] font-semibold tracking-[-0.035em] text-[#171a18]">
              Welcome back
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-6 text-[#68706b]">
              Sign in to continue to your KasiTek workspace.
            </p>

            <div className="mt-8 grid gap-3">
            <Link
              href="/login"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-[#171a18] px-4 text-sm font-semibold text-white no-underline transition-colors hover:bg-[#303632]"
            >
                Sign in
                <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/signup"
                className="inline-flex h-12 items-center justify-center rounded-lg border border-[#d8dad6] bg-white px-4 text-sm font-semibold text-[#171a18] no-underline transition-colors hover:bg-[#f1f2ef]"
            >
              Create an account
            </Link>
            </div>

          </section>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-7xl flex-col gap-3 border-t border-[#dfe1dc] px-6 py-5 text-xs text-[#68706b] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
        <span>© {new Date().getFullYear()} KasiTek Labs</span>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Public site links">
          <a className="hover:text-[#171a18]" href={`${publicSiteUrl}/about`}>About</a>
          <a className="hover:text-[#171a18]" href={`${publicSiteUrl}/pricing`}>Pricing</a>
          <a className="hover:text-[#171a18]" href={`${publicSiteUrl}/demo`}>Book a demo</a>
          <a className="hover:text-[#171a18]" href={`${publicSiteUrl}/privacy-policy`}>Privacy</a>
          <a className="hover:text-[#171a18]" href={`${publicSiteUrl}/terms`}>Terms</a>
        </nav>
      </footer>
    </main>
  );
}
