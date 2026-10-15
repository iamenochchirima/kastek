"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { loginUrl } from "@/lib/shared-login";
import { Button } from "@/components/ui/button";

export default function LoginForm({ signup = false }: { signup?: boolean }) {
  const params = useSearchParams();
  const returnTo = params.get("returnTo") ?? params.get("callbackUrl");
  return (
    <div className="space-y-5">
      <p className="text-center text-sm text-muted-foreground">Email, Google or passkey</p>
      <Button asChild className="w-full">
        <a href={loginUrl(returnTo, signup)}>{signup ? "Create account" : "Continue to sign in"}</a>
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        <Link href={`${signup ? "/login" : "/signup"}?returnTo=${encodeURIComponent(returnTo ?? "/workspace")}`} className="text-primary hover:underline">
          {signup ? "Already have an account? Sign in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}
