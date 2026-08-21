import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Authentication Error | KasiTek",
};

export default function AuthErrorPage() {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-destructive/20 bg-status-danger-soft text-2xl text-destructive">
        ✕
      </div>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-destructive">Authentication error</p>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
      <p className="text-muted-foreground">
        There was a problem signing you in. Please try again.
      </p>
      <Button asChild><Link href="/login">Back to sign in</Link></Button>
    </div>
  );
}
