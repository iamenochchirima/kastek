import { mkdir, writeFile } from "node:fs/promises";
import { createDefaultTools } from "../src/temporal/activities";
import { generateCapabilityDocumentation } from "../src/capabilities/surfaces";

const output = new URL("../generated/capabilities.md", import.meta.url);

async function main(): Promise<void> {
  await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
  await writeFile(output, generateCapabilityDocumentation(createDefaultTools().manifests()), "utf8");
  console.log(`Wrote ${output.pathname}`);
}

void main();
