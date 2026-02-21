import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const BASE_URL = "https://bizbay.co.za/Services";
const OUTPUT_DIR = "scripts/bizbay-data";
const START_PAGE = 1;
const DELAY_MS = 1500;

// Categories to crawl — slug must match the URL path on bizbay.co.za
const CATEGORIES = [
  // Tier 1
  "Restaurants",
  "Hotels-And-Motels",
  "Holiday-Accommodation",
  "Vacation-Accommodation",
  "Real-Estate-Agents",
  "Estate-Agent",
  "Cleaning-Services",
  "Insurance-Agents",
  "Insurance",
  // Tier 2
  "catering",
  "Self-Catering-Apartments",
  "Tours",
  "Business-Consulting",
  "Marketing-Services",
  "Advertising",
  "Security",
  // Tier 3
  "Builders",
  "Building-Construction",
  "Construction",
  "Hardware",
  "Property-Management",
];

function getOutputFile(category) {
  const filename = category.replace(/\+/g, "-").toLowerCase();
  return `${OUTPUT_DIR}/${filename}.json`;
}

function loadProgress(category) {
  const file = getOutputFile(category);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf-8"));
  }
  return { category, lastPage: START_PAGE - 1, listings: [] };
}

function saveProgress(data) {
  const file = getOutputFile(data.category);
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function extractListings(html, pageNum) {
  const listings = [];
  const blockRegex =
    /<div class="business-info">([\s\S]*?)(?=<div class="business-info">|<div class="pager">|<\/div>\s*<\/div>\s*<\/div>\s*<div class="sidebar">)/gi;
  let block;

  while ((block = blockRegex.exec(html)) !== null) {
    const content = block[1];

    const nameMatch = content.match(
      /<a\s+[^>]*href=['"](\/Company\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i
    );
    const name = nameMatch
      ? nameMatch[2].replace(/<[^>]*>/g, "").trim()
      : null;
    const bizbayUrl = nameMatch
      ? `https://bizbay.co.za${nameMatch[1]}`
      : null;

    const webMatch = content.match(
      /<div class="weburl">\s*([\s\S]*?)\s*<\/div>/i
    );
    let website = webMatch
      ? webMatch[1].replace(/<[^>]*>/g, "").trim()
      : null;

    if (website && !website.startsWith("http")) {
      website = `https://${website}`;
    }

    const addrMatch = content.match(
      /<div class="address text">\s*([\s\S]*?)\s*<\/div>/i
    );
    const address = addrMatch
      ? addrMatch[1].replace(/<[^>]*>/g, "").trim()
      : null;

    if (name) {
      listings.push({
        name,
        website: website || null,
        address: address || null,
        bizbayUrl: bizbayUrl || null,
        page: pageNum,
      });
    }
  }

  return listings;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(category, pageNum) {
  const url = pageNum === 1
    ? `${BASE_URL}/${category}`
    : `${BASE_URL}/${category}/${pageNum}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${category} page ${pageNum}`);
  }

  const html = await res.text();
  return extractListings(html, pageNum);
}

async function crawlCategory(category) {
  const data = loadProgress(category);
  const startPage = data.lastPage + 1;

  console.log(
    `\n=== ${category} === (resuming from page ${startPage}, ${data.listings.length} listings so far)`
  );

  let emptyStreak = 0;

  for (let page = startPage; ; page++) {
    try {
      process.stdout.write(`  Page ${page}...`);
      const listings = await fetchPage(category, page);

      if (listings.length === 0) {
        emptyStreak++;
        console.log(" empty");
        if (emptyStreak >= 10) {
          console.log(`  End of ${category} (10 empty pages).`);
          break;
        }
      } else {
        emptyStreak = 0;
        data.listings.push(...listings);
        data.lastPage = page;
        saveProgress(data);
        console.log(` +${listings.length} (total: ${data.listings.length})`);
      }

      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`\n  Error: ${err.message}`);
      console.log("  Saving progress for this category.");
      saveProgress(data);
      return { category, error: err.message, total: data.listings.length };
    }
  }

  return { category, total: data.listings.length };
}

async function main() {
  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Allow filtering via CLI args: node crawl-bizbay.mjs Restaurants Tours
  const args = process.argv.slice(2);
  const categoriesToCrawl =
    args.length > 0
      ? CATEGORIES.filter((c) =>
          args.some((a) => c.toLowerCase().includes(a.toLowerCase()))
        )
      : CATEGORIES;

  console.log(`Crawling ${categoriesToCrawl.length} categories...`);
  console.log(`Output directory: ${OUTPUT_DIR}/\n`);

  const results = [];

  for (const category of categoriesToCrawl) {
    const result = await crawlCategory(category);
    results.push(result);
  }

  console.log("\n====== Summary ======");
  for (const r of results) {
    const status = r.error ? `(stopped: ${r.error})` : "";
    console.log(`  ${r.category}: ${r.total} listings ${status}`);
  }
  console.log(`\nAll files saved to ${OUTPUT_DIR}/`);
}

main();
