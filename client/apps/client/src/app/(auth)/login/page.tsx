import LoginForm from "@/components/auth/login-form";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { safeReturnTo } from "@/lib/shared-login";

export const metadata = {
  title: "Sign In | KasiTek",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string; callbackUrl?: string }> }) {
  const params = await searchParams;
  const session = await getRustSession();
  if (session?.user?.id) {
    redirect(safeReturnTo(params.returnTo ?? params.callbackUrl));
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-ink-1">Sign in</h1>
        <p className="mt-0.5 text-[13px] text-ink-2">KasiTek workspace.</p>
      </div>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
