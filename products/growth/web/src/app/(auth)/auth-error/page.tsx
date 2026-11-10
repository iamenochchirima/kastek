import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { Link } from "react-router";
import { AlertTriangle, ArrowLeft } from "lucide-react";

export function meta() { return [{ title: "Sign-in error | KasiTek Growth" }, { name: "robots", content: "noindex, nofollow" }]; }

const MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled. Please try again.",
  identity_unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
  email_unverified: "Verify your email before continuing.",
  invalid_state: "Your sign-in request expired. Please try again.",
};

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as { code?: string; error?: string });

  const params = searchParams;
  const message = MESSAGES[params.code ?? params.error ?? ""] ?? "We could not sign you in. Please try again.";
  return { message };
}

export default function AuthErrorPage() {
  const { message } = useLoaderData<typeof clientLoader>();
  return (
    <div>
      <span className="inline-flex size-11 items-center justify-center rounded-full border border-[#a83c3433] bg-[#a83c340f] text-[#a83c34]">
        <AlertTriangle size={19} aria-hidden="true" />
      </span>
      <h1 className="auth-card-title mt-5">Unable to sign in.</h1>
      <p role="alert" className="auth-card-description">{message}</p>
      <div className="auth-card-form">
        <Link className="auth-primary" to="/login">
          <ArrowLeft size={17} aria-hidden="true" />
          Try again
        </Link>
      </div>
    </div>
  );
}
