import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export function meta() { return [{ title: "Sign-in error | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

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
    <div className="space-y-4 text-center">
      <h1 className="text-2xl font-semibold">Unable to sign in</h1>
      <p role="alert" className="text-sm text-muted-foreground">{message}</p>
      <Button asChild><Link to="/login">Try again</Link></Button>
    </div>
  );
}
