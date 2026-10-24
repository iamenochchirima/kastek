import { type ClientLoaderFunctionArgs } from "react-router";
import LoginForm from "@/components/auth/login-form";
import { getCoreSession } from "@/lib/core-auth";
import { redirect } from "react-router";
import { Suspense } from "react";
import { safeReturnTo } from "@/lib/shared-login";

export function meta() { return [{ title: "Sign In | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as { returnTo?: string; callbackUrl?: string });

  const params = searchParams;
  const session = await getCoreSession();
  if (session?.user?.id) {
    throw redirect(safeReturnTo(params.returnTo ?? params.callbackUrl));
  }

  return {  };
}

export default function LoginPage() {
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
