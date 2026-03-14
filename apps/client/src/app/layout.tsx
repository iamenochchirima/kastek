import type { Metadata } from "next";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import ChatWidget from "@/components/chat-widget";
import ThemeScript from "@/components/theme-script";
import "./globals.css";

export const metadata: Metadata = {
  title: "KasiTek | AI Solutions for Your Business",
  description:
    "We build WhatsApp chatbots, AI voice agents, and smart automations that handle your customer inquiries, bookings, and admin.",
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
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
          <ChatWidget />
        </SessionProvider>
      </body>
    </html>
  );
}
