import type { Metadata } from 'next'
import { Sora, Bebas_Neue, DM_Serif_Display } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { ThemeProvider } from '@/components/theme-provider'
import './globals.css'

const sora = Sora({ 
  subsets: ["latin"],
  variable: '--font-sans',
  weight: ['300', '400', '500', '600', '700']
});

const bebasNeue = Bebas_Neue({ 
  subsets: ["latin"],
  variable: '--font-display',
  weight: '400'
});

const dmSerifDisplay = DM_Serif_Display({ 
  subsets: ["latin"],
  variable: '--font-serif',
  weight: '400'
});

export const metadata: Metadata = {
  title: 'KasiTek — AI Agents, Marketing Automation & Growth Systems for SMBs',
  description: 'AI agents, marketing automation, and growth systems for businesses ready to scale. KasiTek gives you the tools and services to respond to every lead, run marketing campaigns, and grow without adding headcount.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="scroll-smooth" suppressHydrationWarning>
      <body className={`${sora.variable} ${bebasNeue.variable} ${dmSerifDisplay.variable} font-sans antialiased bg-background text-foreground`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  )
}
