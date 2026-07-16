import ThemeScope from "@/components/theme-scope";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      <ThemeScope mode="stored" />
      <div className="relative w-full max-w-md">
        <div className="rounded-lg border border-border bg-card p-6 md:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
