import { Navigation } from "@/components/sections/navigation"
import { Hero } from "@/components/sections/hero"
import { PathSplit } from "@/components/sections/path-split"
import { Products } from "@/components/sections/products"
import { Services } from "@/components/sections/services"
import { CTA } from "@/components/sections/cta"
import { Footer } from "@/components/sections/footer"

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground overflow-x-hidden">
      {/* Grain Overlay */}
      <div 
        className="fixed inset-0 pointer-events-none z-[9999] opacity-30"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.05'/%3E%3C/svg%3E")`
        }}
      />
      
      <Navigation />
      <Hero />
      <PathSplit />
      <Products />
      <Services />
      <CTA />
      <Footer />
    </main>
  )
}
