import type { Metadata } from "next";
import Providers from "@/components/providers";
import "../index.css";

export const metadata: Metadata = {
  title: "Tenant Portal",
  description: "White-label tenant portal for client-facing services and dashboards.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
