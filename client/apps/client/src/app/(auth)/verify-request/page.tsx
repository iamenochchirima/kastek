export const metadata = {
  title: "Check Your Email | KasiTek",
};

export default function VerifyRequestPage() {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-2xl text-primary">
        ✉️
      </div>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Check your inbox</p>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Check your email</h1>
      <p className="text-muted-foreground">
        We sent a magic sign-in link to your email address. Click the link to
        sign in.
      </p>
    </div>
  );
}
