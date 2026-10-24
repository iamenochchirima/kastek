import { Suspense } from "react";
import LoginForm from "@/components/auth/login-form";

export function meta() { return [{ title: "Create account | KasiTek" }]; }

export default function SignupPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-center text-2xl font-semibold">Create account</h1>
      <Suspense fallback={null}><LoginForm signup /></Suspense>
    </div>
  );
}
