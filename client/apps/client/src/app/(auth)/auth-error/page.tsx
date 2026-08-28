import Link from "next/link";
import { publicSiteUrl } from "@/lib/public-site";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Authentication Error | KasiTek",
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const invitationRequired = code === "INVITE_REQUIRED";

  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">
        {invitationRequired ? "✉" : "✕"}
      </div>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        {invitationRequired ? "Early access" : "Authentication error"}
      </p>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {invitationRequired ? "Invitation required" : "Something went wrong"}
      </h1>
      <p className="text-muted-foreground">
        {invitationRequired
          ? "Use the invitation link sent to your email to create your KasiTek account."
          : "There was a problem signing you in. Please try again."}
      </p>
      <div className="grid gap-2">
        {invitationRequired && (
          <Button asChild><Link href="/invite">Redeem invitation</Link></Button>
        )}
        <Button asChild variant={invitationRequired ? "outline" : "default"}>
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
      {invitationRequired && (
        <a href={publicSiteUrl + "/early-access"} className="block text-sm text-muted-foreground hover:text-foreground">
          Need access? Request early access
        </a>
      )}
    </div>
  );
}
