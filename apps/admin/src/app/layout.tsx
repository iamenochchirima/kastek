import type { Metadata } from "next";
import ThemeScript from "@/components/theme-script";
import "./globals.css";

export const metadata: Metadata = {
  title: "KasiAI Admin",
  description: "KasiAI Admin Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="bg-surface text-text antialiased">{children}</body>
    </html>
  );
}
