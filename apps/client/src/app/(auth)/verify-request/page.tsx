export const metadata = {
  title: "Check Your Email | KasiAI",
};

export default function VerifyRequestPage() {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-accent/15 bg-accent-glow text-2xl">
        ✉️
      </div>
      <h1 className="font-serif text-2xl text-text">Check your email</h1>
      <p className="text-text-muted">
        We sent a magic sign-in link to your email address. Click the link to
        sign in.
      </p>
    </div>
  );
}
