import { ArrowRight, Chrome, Fingerprint, Mail, ShieldCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { loginUrl } from "@/lib/shared-login";

const methods = [
  { label: "Email", Icon: Mail },
  { label: "Google", Icon: Chrome },
  { label: "Passkey", Icon: Fingerprint },
];

export default function LoginForm({ signup = false }: { signup?: boolean }) {
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? params.get("callbackUrl");
  return (
    <div>
      <div className="auth-methods" aria-label="Supported sign-in methods">
        {methods.map(({ label, Icon }) => (
          <span key={label} className="auth-method">
            <Icon size={14} aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>
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
      <p className="auth-security">
        <ShieldCheck size={15} aria-hidden="true" />
        Secure sign-in through KasiTek Identity. Your password and passkeys are
        never stored in this workspace.
      </p>
    </div>
  );
}
