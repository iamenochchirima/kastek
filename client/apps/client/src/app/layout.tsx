import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/pwa-register";
import ThemeScript from "@/components/theme-script";
import "./globals.css";

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
    { media: "(prefers-color-scheme: light)", color: "#fbfbfc" },
    { media: "(prefers-color-scheme: dark)", color: "#17191c" },
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
      <body className="font-sans antialiased">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
