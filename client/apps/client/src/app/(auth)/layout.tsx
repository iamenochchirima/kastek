import ThemeScope from "@/components/theme-scope";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      <ThemeScope mode="dark" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(232,160,32,0.12),transparent_38%),radial-gradient(circle_at_bottom,rgba(255,255,255,0.04),transparent_30%)]" />
      <div className="relative w-full max-w-md">
        <div className="rounded-2xl border border-border bg-card/95 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur md:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
