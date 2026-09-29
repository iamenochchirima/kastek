import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const appRoot = resolve("src/app");
const scanRoots = [appRoot, resolve("src/components"), resolve("public")];
const obsoleteRouteTrees = [
  join(appRoot, "(dashboard)", "dashboard"),
  join(appRoot, "(dashboard)", "reach"),
  join(appRoot, "(social)"),
  join(appRoot, "(onboarding)", "dashboard"),
];
const requiredRoutes = [
  "workspace",
  "inbox",
  "contacts",
  "campaigns",
  "templates",
  "content",
  "calendar",
  "analytics",
  "connections",
  "billing",
];
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const obsoleteUrl = /["'`]\/(?:dashboard|reach|social)(?=\/|[?#"'`])/g;
const failures = [];

function walk(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

for (const routeTree of obsoleteRouteTrees) {
  if (existsSync(routeTree)) {
    failures.push(`obsolete route tree still exists: ${relative(process.cwd(), routeTree)}`);
  }
}

for (const route of requiredRoutes) {
  const page = join(appRoot, "(dashboard)", route, "page.tsx");
  if (!existsSync(page)) {
    failures.push(`canonical route is missing: /${route}`);
  }
}

for (const file of scanRoots.flatMap(walk)) {
  const extension = file.slice(file.lastIndexOf("."));
  if (!sourceExtensions.has(extension)) continue;

  const contents = readFileSync(file, "utf8");
  for (const match of contents.matchAll(obsoleteUrl)) {
    const line = contents.slice(0, match.index).split("\n").length;
    failures.push(
      `obsolete frontend URL ${match[0].slice(1)} in ${relative(process.cwd(), file)}:${line}`,
    );
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Canonical route map is clean.");
}
