import SetPasswordForm from "@/components/auth/set-password-form";

export const metadata = {
  title: "Set Password | KasiTek",
};

export default function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Account access
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Set up a password
        </h1>
        <p className="mt-2 text-muted-foreground">
          Add email and password sign-in to your account
        </p>
      </div>
      <SetPasswordForm searchParams={searchParams} />
    </div>
  );
}
