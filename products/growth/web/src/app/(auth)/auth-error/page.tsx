import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Sign-in error | KasiTek" };

const MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled. Please try again.",
  identity_unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
  email_unverified: "Verify your email before continuing.",
  invalid_state: "Your sign-in request expired. Please try again.",
};

export default async function AuthErrorPage({ searchParams }: { searchParams: Promise<{ code?: string; error?: string }> }) {
  const params = await searchParams;
  const message = MESSAGES[params.code ?? params.error ?? ""] ?? "We could not sign you in. Please try again.";
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-2xl font-semibold">Unable to sign in</h1>
      <p role="alert" className="text-sm text-muted-foreground">{message}</p>
      <Button asChild><Link href="/login">Try again</Link></Button>
    </div>
  );
}
