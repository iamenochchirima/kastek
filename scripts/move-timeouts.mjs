import { readFileSync, writeFileSync, readdirSync } from "fs";

const WORKING_DIR = "scripts/bizbay-data-verified/working";
const FAULTY_DIR = "scripts/bizbay-data-verified/faulty";

function processCategory(filename) {
  const workingPath = `${WORKING_DIR}/${filename}`;
  const faultyPath = `${FAULTY_DIR}/${filename}`;

  let working, faulty;
  try {
    working = JSON.parse(readFileSync(workingPath, "utf-8"));
    faulty = JSON.parse(readFileSync(faultyPath, "utf-8"));
  } catch {
    console.log(`  Skipping ${filename} (missing files)`);
    return { category: filename, moved: 0 };
  }

  const category = working.category || faulty.category || filename.replace(".json", "");

  // Find timeout listings in faulty
  const timeouts = faulty.listings.filter((l) => l.errorType === "timeout");
  const remainingFaulty = faulty.listings.filter((l) => l.errorType !== "timeout");

  if (timeouts.length === 0) {
    console.log(`  ${category}: no timeouts to move`);
    return { category, moved: 0 };
  }

  // Move timeouts to working (update their status)
  const movedTimeouts = timeouts.map((l) => ({
    ...l,
    status: "working",
    httpStatus: null,
    errorType: undefined,
    error: undefined,
    movedFromTimeout: true,
  }));

  // Update working file
  working.listings.push(...movedTimeouts);
  working.count = working.listings.length;
  writeFileSync(workingPath, JSON.stringify(working, null, 2));

  // Update faulty file
  faulty.listings = remainingFaulty;
  faulty.count = remainingFaulty.length;
  writeFileSync(faultyPath, JSON.stringify(faulty, null, 2));

  console.log(`  ${category}: moved ${timeouts.length} timeouts to working`);
  return { category, moved: timeouts.length };
}

function main() {
  const args = process.argv.slice(2);
  const files = readdirSync(FAULTY_DIR).filter((f) => f.endsWith(".json"));

  const filesToProcess =
    args.length > 0
      ? files.filter((f) =>
          args.some((a) => f.toLowerCase().includes(a.toLowerCase()))
        )
      : files;

  console.log(`Processing ${filesToProcess.length} categories...\n`);

  const results = [];
  for (const file of filesToProcess) {
    const result = processCategory(file);
    results.push(result);
  }

  console.log("\n====== Summary ======");
  let totalMoved = 0;
  for (const r of results) {
    if (r.moved > 0) {
      console.log(`  ${r.category}: ${r.moved} moved`);
      totalMoved += r.moved;
    }
  }
  console.log(`\n  TOTAL: ${totalMoved} timeouts moved to working`);
}

main();
