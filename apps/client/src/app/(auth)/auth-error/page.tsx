import Link from "next/link";

export const metadata = {
  title: "Authentication Error | KasiAI",
};

export default function AuthErrorPage() {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-red-500/15 bg-red-500/10 text-2xl">
        ✕
      </div>
      <h1 className="font-serif text-2xl text-text">Something went wrong</h1>
      <p className="text-text-muted">
        There was a problem signing you in. Please try again.
      </p>
      <Link
        href="/login"
        className="inline-block rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-bg transition-all hover:-translate-y-0.5"
      >
        Back to Sign In
      </Link>
    </div>
  );
}
