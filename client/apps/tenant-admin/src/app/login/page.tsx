"use client";

import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { useState } from "react";
import { useTenantAdminAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useTenantAdminAuth();
  const [error, setError] = useState("");

  function onSubmit(formData: FormData) {
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    if (email === "agency@demo.com" && password === "password") {
      login();
      router.replace("/");
      return;
    }

    setError("Invalid credentials. Use agency@demo.com / password");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,#16324f_0%,#08111b_32%,#04070c_100%)] p-6 text-white">
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-black/25 p-8 shadow-2xl backdrop-blur-xl">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-400/10">
            <Building2 className="h-6 w-6 text-cyan-300" />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Tenant Admin</h1>
          <p className="mt-2 text-sm text-white/60">
            Manage client workspaces, branding, and provisioning.
          </p>
        </div>

        <form
          action={onSubmit}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label className="text-sm text-white/75" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="agency@demo.com"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none ring-0 placeholder:text-white/30"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm text-white/75" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              placeholder="password"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none ring-0 placeholder:text-white/30"
            />
          </div>

          {error ? <p className="text-sm text-rose-300">{error}</p> : null}

          <button
            type="submit"
            className="w-full rounded-2xl bg-cyan-300 px-4 py-3 font-medium text-slate-950 transition-colors hover:bg-cyan-200"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-white/45">
          Demo login: <span className="text-cyan-200">agency@demo.com / password</span>
        </p>
      </div>
    </div>
  );
}
