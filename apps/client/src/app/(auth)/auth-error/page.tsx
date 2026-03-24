import Link from "next/link";

export const metadata = {
  title: "Authentication Error | KasiTek",
};

export default function AuthErrorPage() {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-red-500/15 bg-red-500/10 text-2xl">
        ✕
      </div>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-400">Authentication error</p>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
      <p className="text-muted-foreground">
        There was a problem signing you in. Please try again.
      </p>
      <Link
        href="/login"
        className="inline-block rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90"
      >
        Back to Sign In
      </Link>
    </div>
  );
}
