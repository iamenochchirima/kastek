import { Hero } from "./hero";
import { ProductDirectory } from "./product-directory";
import { AgentsSection } from "./agents-section";
import { GrowthSection } from "./growth-section";
import { AgencySection } from "./agency-section";
import { StudioSection } from "./studio-section";
import { Footer } from "./footer";
import { AgentTemplates } from "./agent-templates";
import { LandingRuntime } from "./landing-runtime";
import "./styles/index.css";

export function LabsLanding() {
  return (
    <main className="labs-landing" id="top">
      <a className="skip-link" href="#products">Skip to products</a>
      <Hero />
      <ProductDirectory />
      <div className="products container" id="products">
        <AgentsSection />
        <GrowthSection />
        <AgencySection />
      </div>
      <StudioSection />
      <Footer />
      <AgentTemplates />
      <LandingRuntime />
    </main>
  );
}
