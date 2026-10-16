import type { CSSProperties } from "react";
import Link from "next/link";
import { LandingImage } from "./landing-image";

export function StudioSection() {
  return (
    <section className="services" id="studio">
      <div className="servicesImage">
        <LandingImage src="/labs-landing/assets/service-delivery-editorial-v1.webp" alt="" loading="lazy" style={{"position": "absolute", "inset": "0", "width": "100%", "height": "100%"} as CSSProperties} decoding="async" width="1672" height="941" />
      </div>
      <div className="servicesCopy">
        <p className="sectionLabel">
          {"Built with Labs"}
        </p>
        <h2>
          {"Some work calls"}
          <br />
          {"for something... "}
          <em>
            {"specific."}
          </em>
        </h2>
        <p>
          {"Custom software, integrations and hands-on delivery."}
          <br />
          {"Tell us what you’re working on."}
        </p>
        <Link className="textLink" href="/get-quote?service=delivery">
          {"Start a project "}
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right" aria-hidden="true">
            <path d="M7 7h10v10">
            </path>
            <path d="M7 17 17 7">
            </path>
          </svg>
        </Link>
      </div>
    </section>
  );
}
