import LoginForm from "@/components/auth/login-form";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export const metadata = {
  title: "Sign In | KasiTek",
};

export default async function LoginPage() {
  const session = await getRustSession();
  if (session?.user?.id) {
    redirect(session.user.emailVerified ? "/workspace" : `/verify-request?email=${encodeURIComponent(session.user.email)}`);
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
