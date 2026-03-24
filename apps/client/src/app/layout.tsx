import type { Metadata, Viewport } from "next";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import ChatWidget from "@/components/chat-widget";
import PwaRegister from "@/components/pwa-register";
import ThemeScript from "@/components/theme-script";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "KasiTek",
  title: "KasiTek | AI Solutions for Your Business",
  description:
    "We build WhatsApp chatbots, AI voice agents, and smart automations that handle your customer inquiries, bookings, and admin.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/logo.png",
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    other: [
      { rel: "mask-icon", url: "/maskable-icon-512.png" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "KasiTek",
  },
};

export const viewport: Viewport = {
  themeColor: "#080808",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="font-sans antialiased">
        <SessionProvider session={session}>
          {children}
          <PwaRegister />
          <ChatWidget />
        </SessionProvider>
      </body>
    </html>
  );
}
