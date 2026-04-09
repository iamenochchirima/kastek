import { CTA } from "@/components/landing/CTA";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { Navbar } from "@/components/landing/Navbar";
import { PathSplit } from "@/components/landing/PathSplit";
import { Products } from "@/components/landing/Products";
import { Services } from "@/components/landing/Services";

export default function HomePage() {
  return (
    <main className="relative min-h-screen w-full selection:bg-primary/30 selection:text-primary">
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
