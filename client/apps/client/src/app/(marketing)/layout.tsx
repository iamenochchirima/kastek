import "./marketing-prototype.css";
import ThemeScope from "@/components/theme-scope";
import ChatWidget from "@/components/chat-widget";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ThemeScope mode="dark" />
      <div className="landing-shell min-h-screen">
        {children}
        <ChatWidget />
      </div>
    </>
  );
}
