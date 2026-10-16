import { writeFile } from "node:fs/promises";
import { createDefaultTools } from "../src/temporal/activities";
import { generateCapabilityDocumentation } from "../src/capabilities/surfaces";

const output = new URL("../../docs/generated-capabilities.md", import.meta.url);

async function main(): Promise<void> {
  await writeFile(output, generateCapabilityDocumentation(createDefaultTools().manifests()), "utf8");
  console.log(`Wrote ${output.pathname}`);
}

void main();
