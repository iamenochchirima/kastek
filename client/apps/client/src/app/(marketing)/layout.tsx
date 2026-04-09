import "./marketing-prototype.css";
import ThemeScope from "@/components/theme-scope";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ThemeScope mode="dark" />
      <div className="landing-shell min-h-screen">{children}</div>
    </>
  );
}
