import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import PwaRegister from "@/components/pwa-register";
import ThemeScript from "@/components/theme-script";
import { ConfirmationProvider } from "@/components/ui/confirmation-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "KasiTek app",
  title: {
    default: "KasiTek app",
    template: "%s | KasiTek app",
  },
  description: "Manage your KasiTek workspace, conversations, and connected channels.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/facebook-app-icon-dark-1024.png",
    apple: [
      { url: "/facebook-app-icon-dark-1024.png", sizes: "1024x1024", type: "image/png" },
    ],
    other: [
      { rel: "mask-icon", url: "/facebook-app-icon-dark-1024.png" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "KasiTek app",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F7F9" },
    { media: "(prefers-color-scheme: dark)", color: "#090B11" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className={`${geist.variable} ${geistMono.variable} font-sans antialiased`}>
        <ConfirmationProvider>{children}</ConfirmationProvider>
        <PwaRegister />
        <Toaster />
      </body>
    </html>
  );
}
