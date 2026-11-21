import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const owners = new Map();
const skip = new Set(['node_modules', 'dist', '.next', 'build', '.git', '.audit', '.artifacts', '.runtime', 'generated']);
const files = [];
const manifests = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name === 'package.json') {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (pkg.name) owners.set(pkg.name, relative(root, dirname(path)).split(sep));
      manifests.push({ path, pkg });
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(path);
  }
}
for (const area of ['products', 'packages', 'services', 'apps']) visit(resolve(root, area));
const productOwner = (parts) => parts[0] === 'products' ? parts[1] : null;
const failures = [];
for (const { path, pkg } of manifests) {
  const caller = productOwner(relative(root, path).split(sep));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      const target = owners.get(name);
      const destination = target && productOwner(target);
      if (destination && caller !== destination) failures.push(`${relative(root, path)} declares private ${destination} dependency ${name}`);
    }
  }
}
for (const file of files) {
  const location = relative(root, file).split(sep);
  // Integration tests may exercise multiple product contracts. Runtime source may not.
  if (location.some(part => ['tests', 'test', '__tests__'].includes(part)) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
  const source = readFileSync(file, 'utf8');
  const imports = /\b(?:from\s*|(?:import|require)\s*\(\s*|import\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(imports)) {
    const specifier = match[1];
    let target;
    if (specifier.startsWith('.')) target = relative(root, resolve(dirname(file), specifier)).split(sep);
    else {
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      target = owners.get(name);
    }
    if (!target) continue;
    const agentsSource = ['products', 'agents', 'api', 'src'];
    const inAgentsPlatform = agentsSource.every((part, index) => location[index] === part) && location[4] === 'platform';
    const targetsAgentsSource = agentsSource.every((part, index) => target[index] === part);
    if (inAgentsPlatform && targetsAgentsSource && ['product', 'integrations'].includes(target[4])) {
      failures.push(`${relative(root, file)} imports product or integration code via ${specifier}`);
    }
    const destination = productOwner(target);
    if (destination && productOwner(location) !== destination) failures.push(`${relative(root, file)} imports private ${destination} source via ${specifier}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Product import boundaries passed for ${files.length} source and script files.`);
