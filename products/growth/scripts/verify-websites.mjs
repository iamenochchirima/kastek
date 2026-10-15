import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";

const INPUT_DIR = "scripts/bizbay-data";
const OUTPUT_DIR_WORKING = "scripts/bizbay-data-verified/working";
const OUTPUT_DIR_FAULTY = "scripts/bizbay-data-verified/faulty";

// Concurrency settings
const MAX_CONCURRENT = 15; // Number of parallel requests
const TIMEOUT_MS = 10000;  // 10 second timeout per request

function loadCategory(filename) {
  const filepath = `${INPUT_DIR}/${filename}`;
  return JSON.parse(readFileSync(filepath, "utf-8"));
}

function saveResults(category, working, faulty) {
  const baseName = category.toLowerCase();
  writeFileSync(
    `${OUTPUT_DIR_WORKING}/${baseName}.json`,
    JSON.stringify({ category, count: working.length, listings: working }, null, 2)
  );
  writeFileSync(
    `${OUTPUT_DIR_FAULTY}/${baseName}.json`,
    JSON.stringify({ category, count: faulty.length, listings: faulty }, null, 2)
  );
}

async function checkWebsite(listing) {
  const { website } = listing;

  if (!website) {
    return { ...listing, status: "no_website", error: "No website provided" };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(website, {
      method: "HEAD", // Use HEAD to minimize data transfer
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    // Consider 2xx and 3xx as working
    if (response.ok || (response.status >= 300 && response.status < 400)) {
      return { ...listing, status: "working", httpStatus: response.status };
    } else {
      return { ...listing, status: "faulty", httpStatus: response.status, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    let errorType = "unknown";
    let errorMessage = err.message;

    if (err.name === "AbortError") {
      errorType = "timeout";
      errorMessage = `Timeout after ${TIMEOUT_MS}ms`;
    } else if (err.cause?.code === "ENOTFOUND") {
      errorType = "dns_error";
      errorMessage = "Domain not found";
    } else if (err.cause?.code === "ECONNREFUSED") {
      errorType = "connection_refused";
      errorMessage = "Connection refused";
    } else if (err.cause?.code === "ECONNRESET") {
      errorType = "connection_reset";
      errorMessage = "Connection reset";
    } else if (err.message.includes("certificate")) {
      errorType = "ssl_error";
      errorMessage = "SSL certificate error";
    }

    return { ...listing, status: "faulty", errorType, error: errorMessage };
  }
}

async function processWithConcurrency(items, fn, maxConcurrent) {
  const results = [];
  let index = 0;
  let completed = 0;
  const total = items.length;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      const result = await fn(item);
      results[currentIndex] = result;
      completed++;

      // Progress indicator
      const percent = Math.round((completed / total) * 100);
      process.stdout.write(`\r  Progress: ${completed}/${total} (${percent}%)`);
    }
  }

  // Start workers
  const workers = [];
  for (let i = 0; i < Math.min(maxConcurrent, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  console.log(); // New line after progress

  return results;
}

async function verifyCategory(filename) {
  const data = loadCategory(filename);
  // Fallback to filename if category is missing
  const category = data.category || filename.replace(".json", "");
  const baseName = category.toLowerCase();
  const listings = data.listings;

  // Skip if already verified
  const workingFile = `${OUTPUT_DIR_WORKING}/${baseName}.json`;
  const faultyFile = `${OUTPUT_DIR_FAULTY}/${baseName}.json`;
  if (existsSync(workingFile) && existsSync(faultyFile)) {
    const existingWorking = JSON.parse(readFileSync(workingFile, "utf-8"));
    const existingFaulty = JSON.parse(readFileSync(faultyFile, "utf-8"));
    console.log(`\n=== ${category} === (already verified, skipping)`);
    return { category, working: existingWorking.count, faulty: existingFaulty.count, skipped: true };
  }

  console.log(`\n=== ${category} === (${listings.length} listings)`);

  // Filter listings that have websites
  const withWebsites = listings.filter((l) => l.website);
  const withoutWebsites = listings.filter((l) => !l.website);

  console.log(`  ${withWebsites.length} have websites, ${withoutWebsites.length} without`);

  if (withWebsites.length === 0) {
    console.log("  No websites to verify.");
    saveResults(category, [], withoutWebsites.map(l => ({ ...l, status: "no_website" })));
    return { category, working: 0, faulty: withoutWebsites.length };
  }

  // Check all websites with concurrency limit
  const results = await processWithConcurrency(withWebsites, checkWebsite, MAX_CONCURRENT);

  const working = results.filter((r) => r.status === "working");
  const faulty = [
    ...results.filter((r) => r.status === "faulty"),
    ...withoutWebsites.map((l) => ({ ...l, status: "no_website", error: "No website provided" })),
  ];

  saveResults(category, working, faulty);

  console.log(`  Working: ${working.length}, Faulty: ${faulty.length}`);

  return { category, working: working.length, faulty: faulty.length };
}

async function main() {
  // Ensure output directories exist
  if (!existsSync(OUTPUT_DIR_WORKING)) {
    mkdirSync(OUTPUT_DIR_WORKING, { recursive: true });
  }
  if (!existsSync(OUTPUT_DIR_FAULTY)) {
    mkdirSync(OUTPUT_DIR_FAULTY, { recursive: true });
  }

  // Get all JSON files from input directory
  const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".json"));

  // Allow filtering via CLI args
  const args = process.argv.slice(2);
  const filesToProcess =
    args.length > 0
      ? files.filter((f) =>
          args.some((a) => f.toLowerCase().includes(a.toLowerCase()))
        )
      : files;

  console.log(`Verifying websites in ${filesToProcess.length} category files...`);
  console.log(`Concurrency: ${MAX_CONCURRENT} parallel requests`);
  console.log(`Timeout: ${TIMEOUT_MS}ms per request`);
  console.log(`Output: ${OUTPUT_DIR_WORKING}/ and ${OUTPUT_DIR_FAULTY}/\n`);

  const results = [];

  for (const file of filesToProcess) {
    const result = await verifyCategory(file);
    results.push(result);
  }

  console.log("\n====== Summary ======");
  let totalWorking = 0;
  let totalFaulty = 0;

  for (const r of results) {
    const skipped = r.skipped ? " (skipped)" : "";
    console.log(`  ${r.category}: ${r.working} working, ${r.faulty} faulty${skipped}`);
    totalWorking += r.working;
    totalFaulty += r.faulty;
  }

  console.log(`\n  TOTAL: ${totalWorking} working, ${totalFaulty} faulty`);
  console.log(`\nFiles saved to:`);
  console.log(`  - ${OUTPUT_DIR_WORKING}/ (working websites)`);
  console.log(`  - ${OUTPUT_DIR_FAULTY}/ (non-working websites)`);
}

main();
