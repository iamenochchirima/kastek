import { Suspense } from "react";
import LoginForm from "@/components/auth/login-form";

export function meta() { return [{ title: "Create account | KasiTek Growth" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function SignupPage() {
  return (
    <div>
      <h1 className="auth-card-title">Create your account.</h1>
      <p className="auth-card-description">
        Create your KasiTek account. Email, Google and passkeys are supported.
      </p>
      <div className="auth-card-form">
        <Suspense fallback={null}><LoginForm signup /></Suspense>
      </div>
    </div>
  );
}
