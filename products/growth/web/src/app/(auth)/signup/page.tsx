import { Suspense } from "react";
import LoginForm from "@/components/auth/login-form";

export function meta() { return [{ title: "Create account | KasiTek Growth" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function SignupPage() {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#617168]">Get started</p>
      <h1 className="auth-card-title mt-3">Create your account.</h1>
      <p className="auth-card-description">
        Start with the inbox. Add campaigns, content and workspace agents when
        you need them.
      </p>
      <div className="auth-card-form">
        <Suspense fallback={null}><LoginForm signup /></Suspense>
      </div>
    </div>
  );
}
