import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { PathSplit } from "@/components/landing/PathSplit";
import { Products } from "@/components/landing/Products";
import { Services } from "@/components/landing/Services";
import { CTA } from "@/components/landing/CTA";
import { Footer } from "@/components/landing/Footer";

export default function Home() {
  return (
    <main className="min-h-screen w-full relative selection:bg-primary/30 selection:text-primary">
      {/* Global CSS Grain Noise */}
      <div className="bg-noise" />
      
      <Navbar />
      <Hero />
      <PathSplit />
      <Products />
      <Services />
      <CTA />
      <Footer />
    </main>
  );
}
