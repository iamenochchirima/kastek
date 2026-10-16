import { productUrls } from "@/lib/site-config";

export function ProductDirectory() {
  return (
    <section className="productDirectory" id="product-directory" aria-label="Our products">
      <a href={productUrls.agents} className="directoryItem">
        <span className="productMark agentMark" aria-hidden="true">
        </span>
        <span>
          <h2>
            {"Agents"}
          </h2>
          <p>
            {"Support, business & personal."}
          </p>
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right" aria-hidden="true">
          <path d="M7 7h10v10">
          </path>
          <path d="M7 17 17 7">
          </path>
        </svg>
      </a>
      <a href={productUrls.growth} className="directoryItem">
        <span className="productMark growthMark" aria-hidden="true">
        </span>
        <span>
          <h2>
            {"Growth"}
          </h2>
          <p>
            {"Conversations and campaigns."}
          </p>
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right" aria-hidden="true">
          <path d="M7 7h10v10">
          </path>
          <path d="M7 17 17 7">
          </path>
        </svg>
      </a>
      <a href={productUrls.agency} className="directoryItem">
        <span className="productMark agencyMark" aria-hidden="true">
        </span>
        <span>
          <h2>
            {"Agency"}
          </h2>
          <p>
            {"Client portals, under your brand."}
          </p>
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right" aria-hidden="true">
          <path d="M7 7h10v10">
          </path>
          <path d="M7 17 17 7">
          </path>
        </svg>
      </a>
    </section>
  );
}
