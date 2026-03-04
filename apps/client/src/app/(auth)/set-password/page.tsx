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
        <h1 className="font-serif text-3xl text-text">
          Set up a password
        </h1>
        <p className="mt-2 text-text-muted">
          Add email and password sign-in to your account
        </p>
      </div>
      <SetPasswordForm searchParams={searchParams} />
    </div>
  );
}
