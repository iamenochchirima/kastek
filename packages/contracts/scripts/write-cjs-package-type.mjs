import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cjs");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "package.json"), '{"type":"commonjs"}\n');
