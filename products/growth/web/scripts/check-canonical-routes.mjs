import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const appRoot = resolve("src/app");
const scanRoots = [appRoot, resolve("src/components"), resolve("public")];
const obsoleteRouteTrees = [
  join(appRoot, "(dashboard)", "dashboard"),
  join(appRoot, "(dashboard)", "reach"),
  join(appRoot, "(social)"),
  join(appRoot, "(onboarding)", "dashboard"),
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

export function checkRouteContract(source, contract, moduleExists = (file) => existsSync(resolve("src", file))) {
  const errors = [];
  const routes = [];
  const parsed = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exported = parsed.statements.find(ts.isExportAssignment);
  function literal(node) {
    if (!node || !ts.isStringLiteral(node)) throw new Error("route paths and modules must be string literals");
    return node.text;
  }
  function visit(node, parentPath = "") {
    if (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return visit(node.expression, parentPath);
    if (ts.isArrayLiteralExpression(node)) {
      for (const child of node.elements) visit(child, parentPath);
      return;
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) throw new Error("unsupported route configuration expression");
    const name = node.expression.text;
    if (name === "layout") {
      const file = literal(node.arguments[0]);
      if (!moduleExists(file)) errors.push(`layout module is missing: ${file}`);
      visit(node.arguments[1], parentPath);
      return;
    }
    if (name !== "route" && name !== "index") throw new Error(`unsupported route helper: ${name}`);
    const routePath = name === "index" ? parentPath || "/" : `/${[parentPath, literal(node.arguments[0])].join("/").split("/").filter(Boolean).join("/")}`;
    const file = literal(node.arguments[name === "index" ? 0 : 1]);
    routes.push({ path: routePath, source: `products/growth/web/src/${file}` });
    if (!moduleExists(file)) errors.push(`route module is missing: ${file}`);
    if (node.arguments[2]) visit(node.arguments[2], routePath);
  }
  try {
    if (!exported) throw new Error("route configuration has no default export");
    visit(exported.expression);
  } catch (error) {
    errors.push(`cannot inspect route configuration: ${error.message}`);
  }
  const baseline = contract.routes;
  if (!Array.isArray(baseline) || baseline.length !== 50) return [...errors, "baseline must contain all 50 audited routes"];
  for (const [label, list] of [["baseline", baseline], ["configured", routes]]) {
    const counts = new Map();
    for (const entry of list) counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
    for (const [path, count] of counts) if (count > 1) errors.push(`duplicate ${label} route: ${path}`);
  }
  const expected = new Map(baseline.map(entry => [entry.path, entry.source]));
  const configured = new Map(routes.map(entry => [entry.path, entry.source]));
  for (const [path, file] of expected) {
    if (!configured.has(path)) errors.push(`canonical route is missing: ${path}`);
    else if (configured.get(path) !== file) errors.push(`route module changed without a contract update: ${path}`);
  }
  for (const path of configured.keys()) if (!expected.has(path)) errors.push(`route is absent from the contract: ${path}`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const routeTree of obsoleteRouteTrees) {
    if (existsSync(routeTree)) {
      failures.push(`obsolete route tree still exists: ${relative(process.cwd(), routeTree)}`);
    }
  }

  failures.push(...checkRouteContract(
    readFileSync(resolve("src/routes.ts"), "utf8"),
    JSON.parse(readFileSync(resolve("scripts/route-contract.json"), "utf8")),
  ));

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

}
