import { ArrowRight } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { loginUrl } from "@/lib/shared-login";



export default function LoginForm({ signup = false }: { signup?: boolean }) {
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? params.get("callbackUrl");
  return (
    <div>
      <a className="auth-primary" href={loginUrl(returnTo, signup)}>
        {signup ? "Continue to create account" : "Continue to sign in"}
        <ArrowRight size={17} aria-hidden="true" />
      </a>
      <p className="auth-secondary">
        {signup ? "Already have an account? " : "New to KasiTek? "}
        <Link to={`${signup ? "/login" : "/signup"}?returnTo=${encodeURIComponent(returnTo ?? "/workspace")}`}>
          {signup ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}
