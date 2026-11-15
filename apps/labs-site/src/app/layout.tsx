import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kasitek Labs | Product company & technology studio",
  description:
    "Kasitek Labs builds AI products and technology services for customer engagement, business growth and everyday operations.",
  applicationName: "Kasitek Labs",
  openGraph: {
    title: "Kasitek Labs",
    description:
      "AI products and technology services for customer engagement, business growth and everyday operations.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#10110f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
