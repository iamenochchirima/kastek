import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kasitek Labs | Product company & technology studio",
  description:
    "Kasitek Labs designs software, AI agents and connected customer systems for growing businesses and agency partners.",
  applicationName: "Kasitek Labs",
  openGraph: {
    title: "Kasitek Labs",
    description:
      "Useful technology, beautifully put to work.",
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
      <body>{children}</body>
    </html>
  );
}
