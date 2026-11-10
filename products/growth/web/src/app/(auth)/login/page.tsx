import { type ClientLoaderFunctionArgs } from "react-router";
import LoginForm from "@/components/auth/login-form";
import { getCoreSession } from "@/lib/core-auth";
import { redirect } from "react-router";
import { Suspense } from "react";
import { safeReturnTo } from "@/lib/shared-login";

export function meta() { return [{ title: "Sign In | KasiTek Growth" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as { returnTo?: string; callbackUrl?: string });

  const params = searchParams;
  const session = await getCoreSession(route.request);
  if (session?.user?.id) {
    throw redirect(safeReturnTo(params.returnTo ?? params.callbackUrl));
  }

  return {  };
}

export default function LoginPage() {
  return (
    <div>
      <h1 className="auth-card-title">Welcome back.</h1>
      <p className="auth-card-description">
        Sign in to your KasiTek workspace. Email, Google and passkeys are supported.
      </p>
      <div className="auth-card-form">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
