import type { Metadata } from "next";
import ThemeScript from "@/components/theme-script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kasitek Labs",
  description: "Kasitek Labs internal operations workspace",
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
