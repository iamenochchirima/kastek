import { z } from "zod";
import { githubRepositorySelectionSchema } from "../../src/platform/github-adapter";

/** Shared preflight for opt-in acceptance. It performs no I/O or credential discovery. */
export function readGithubAcceptanceConfig(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const token = env.AGENTS_GITHUB_ACCEPTANCE_TOKEN ?? "";
  if (!token.startsWith("github_pat_") || token.length < 12 || token.length > 4096 || /\s/.test(token)) {
    throw Error("Set the explicitly approved AGENTS_GITHUB_ACCEPTANCE_TOKEN; no other credential is searched");
  }
  const expiresAt = env.AGENTS_GITHUB_ACCEPTANCE_EXPIRES_AT ?? "";
  const expires = Date.parse(expiresAt);
  if (!z.iso.datetime().safeParse(expiresAt).success || expires <= now || expires > now + 90 * 86400000) {
    throw Error("Set the actual finite ISO token expiry within 90 days in AGENTS_GITHUB_ACCEPTANCE_EXPIRES_AT");
  }
  const parts = (env.AGENTS_GITHUB_ACCEPTANCE_REPOSITORY ?? "github/github-mcp-server").split("/");
  const parsed = githubRepositorySelectionSchema.safeParse({ owner: parts[0], repository: parts[1], ref: env.AGENTS_GITHUB_ACCEPTANCE_REF ?? "main" });
  if (parts.length !== 2 || !parsed.success) throw Error("Select an approved GitHub owner/repository and revision, never a URL");
  const selectedFile = env.AGENTS_GITHUB_ACCEPTANCE_FILE ?? "README.md";
  if (!selectedFile.length || selectedFile.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(selectedFile) ||
      selectedFile.split("/").some(part => !part || part === "." || part === "..")) {
    throw Error("Select a bounded relative file path in the approved repository");
  }
  const expected = env.AGENTS_GITHUB_ACCEPTANCE_EXPECT ?? "GitHub";
  if (!expected.trim() || Buffer.byteLength(expected) > 256 || /[\u0000-\u001f\u007f]/.test(expected)) {
    throw Error("Set a bounded expected public fact for provider acceptance");
  }
  return { token, expiresAt, selection: parsed.data, selectedFile, expected };
}
