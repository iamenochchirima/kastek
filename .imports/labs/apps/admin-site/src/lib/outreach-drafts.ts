import fs from "node:fs/promises";
import path from "node:path";

const OUTREACH_DRAFTS_PATH = path.join(
  "local-work",
  "outreach-emails",
  "organized",
  "categories",
);

export async function resolveOutreachDraftDirectory() {
  const configuredPath = process.env.OUTREACH_DRAFTS_DIR?.trim();
  if (configuredPath) return path.resolve(configuredPath);

  const candidates = [
    path.join(process.cwd(), OUTREACH_DRAFTS_PATH),
    path.join(process.cwd(), "..", "..", OUTREACH_DRAFTS_PATH),
    path.join(process.cwd(), "..", OUTREACH_DRAFTS_PATH),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // try next
    }
  }

  return candidates[0];
}
