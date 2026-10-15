import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import ThemeScript from "@/components/theme-script";
import ThemeScope from "@/components/theme-scope";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Kasitek Labs", template: "%s | Kasitek Labs" },
  description: "Kasitek Labs internal operations workspace",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F7F9" },
    { media: "(prefers-color-scheme: dark)", color: "#090B11" },
  ],
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
      <body className={`${geist.variable} ${geistMono.variable} bg-background font-sans text-foreground antialiased`}>
        <ThemeScope />
        {children}
      </body>
    </html>
  );
}
