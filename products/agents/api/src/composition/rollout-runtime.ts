import { Pool } from "pg";
import { registerProductManifest } from "../capabilities/products/product-capabilities";
import { EvidenceStore } from "../execution/context/evidence";
import { createConfiguredProductRuntime } from "../execution/products/configured-runtime";
import { databasePoolOptions } from "../infrastructure/pool-policy";
import { applyRuntimeRollout, previewRuntimeRollout } from "../product/runtime/runtime-rollout";
import { PlatformError } from "../contracts/contracts";
async function main(): Promise<void> {
  const [mode = "preview", digest] = process.argv.slice(2);
  if (!["preview", "apply"].includes(mode) || mode === "apply" && !/^[a-f0-9]{64}$/.test(digest ?? ""))
    throw new Error("Use preview, or apply with the exact preview digest");
  const connectionString = process.env.AGENTS_MIGRATION_DATABASE_URL || process.env.AGENTS_DATABASE_URL;
  if (!connectionString)
    throw new Error("Agent database is not configured");
  const pool = new Pool({ connectionString, ...databasePoolOptions("migration") });
  try {
    await createConfiguredProductRuntime(pool, new EvidenceStore(pool));
    const publications = (await pool.query("SELECT manifest FROM agents_platform.product_capability_publications ORDER BY created_at")).rows;
    for (const publication of publications)
      registerProductManifest(publication.manifest);
    const result = mode === "apply" ? await applyRuntimeRollout(pool, digest!) : await previewRuntimeRollout(pool);
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  finally {
    await pool.end();
  }
}
if (require.main === module)
  void main().catch(error => {
    process.stderr.write(JSON.stringify({ code: error instanceof PlatformError ? error.code : "RUNTIME_ROLLOUT_FAILED", message: error instanceof PlatformError ? error.message : "Runtime rollout failed; inspect the configured environment and current publication dependencies" }) + "\n");
    process.exitCode = 1;
  });
