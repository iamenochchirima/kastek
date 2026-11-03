import { Pool } from "pg";
import { databasePoolOptions } from "../infrastructure/pool-policy";
import { platformAdmissionControlSchema, controlPlatformAdmissions } from "../product/agents/platform-admission-control";

async function main(): Promise<void> {
  const rawExpectedRevision = process.env.AGENTS_ADMISSION_CONTROL_EXPECTED_REVISION;
  if (!rawExpectedRevision || !/^(0|[1-9][0-9]*)$/.test(rawExpectedRevision)) throw Error("Expected gate revision is required");
  const expectedRevision = Number(rawExpectedRevision);
  if (!Number.isSafeInteger(expectedRevision)) throw Error("Expected gate revision is invalid");
  const input = platformAdmissionControlSchema.parse({
    action: process.env.AGENTS_ADMISSION_CONTROL_ACTION,
    actor: process.env.AGENTS_ADMISSION_CONTROL_ACTOR,
    reason: process.env.AGENTS_ADMISSION_CONTROL_REASON,
    expectedRevision,
  });
  if (!process.env.AGENTS_DATABASE_URL) throw Error("Agents database is not configured");
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, ...databasePoolOptions("migration") });
  try {
    const result = await controlPlatformAdmissions(pool, input);
    process.stdout.write(JSON.stringify({ event: "agents_root_admission_controlled", ...result }) + "\n");
  } finally {
    await pool.end();
  }
}

if (require.main === module) void main().catch(() => {
  process.stderr.write("Agents admission control failed; check the action, expected revision, operator reason and database access\n");
  process.exitCode = 1;
});
