import ThemeScope from "@/components/theme-scope";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ThemeScope mode="dark" />
      {children}
    </>
  );
}
