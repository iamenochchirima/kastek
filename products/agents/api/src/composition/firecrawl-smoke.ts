import { FirecrawlClient, loadFirecrawlConfig } from "../adapters/providers/firecrawl/client";

async function main() {
  const config = loadFirecrawlConfig();
  if (!config) throw new Error("Configure AGENTS_FIRECRAWL_URL first");
  const target = process.argv[2] ?? "https://example.com";
  const result = await new FirecrawlClient(config).scrape(target);
  console.log(JSON.stringify({ event: "firecrawl_scrape_verified", providerOrigin: config.url, markdownCharacters: result.markdown!.length }));
}
void main().catch(error => { console.error(JSON.stringify({ event: "firecrawl_scrape_failed", code: error instanceof Error ? error.message : "FIRECRAWL_UNAVAILABLE" })); process.exitCode = 1; });
