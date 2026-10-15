export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-4 py-8 sm:py-10">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
