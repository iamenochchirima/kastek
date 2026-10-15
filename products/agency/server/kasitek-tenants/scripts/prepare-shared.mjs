import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Temporary local migration delivery. Registry installation replaces this at cutover.
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? process.env.LABS_SOURCE_DIR;
if (!source) throw new Error('Provide the Labs source checkout path or LABS_SOURCE_DIR');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24');
const destination = resolve(core, '.artifacts/shared');
mkdirSync(destination, { recursive: true });
const expected = JSON.parse(readFileSync(resolve(core, 'shared-packages.json'), 'utf8'));
const result = spawnSync('pnpm', ['pack:shared', destination], { cwd: resolve(source), stdio: 'inherit' });
if (result.status !== 0) throw new Error('Build the Labs packages after installing its frozen lockfile');
const actual = JSON.parse(readFileSync(resolve(destination, 'manifest.json'), 'utf8'));
if (actual.sourceContentSha256 !== expected.sourceContentSha256) throw new Error('Labs source content differs from the pinned migration packages');
for (const artifact of expected.artifacts) {
  const bytes = readFileSync(resolve(destination, artifact.file));
  if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== artifact.integrity) {
    throw new Error(`Shared package checksum mismatch: ${artifact.package}`);
  }
}
copyFileSync(resolve(core, 'shared-packages.json'), resolve(destination, 'pinned-manifest.json'));
console.log('Pinned local packages prepared. Run pnpm install --frozen-lockfile.');
