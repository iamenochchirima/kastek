import { z } from "zod";
import { githubRepositorySelectionSchema } from "../../src/platform/github-adapter";

/** Public providers need no credentials. Overrides remain finite repository selections. */
export function readPublicRepositoryAcceptanceConfig(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const parts = (env.AGENTS_PUBLIC_REPOSITORY_ACCEPTANCE_REPOSITORY ?? "modelcontextprotocol/typescript-sdk").split("/");
  const selection = githubRepositorySelectionSchema.safeParse({ owner: parts[0], repository: parts[1], ref: env.AGENTS_PUBLIC_REPOSITORY_ACCEPTANCE_REF ?? "main" });
  if (parts.length !== 2 || !selection.success || /[\s"'?#]/.test(selection.data.ref) || selection.data.ref.includes("://")) throw Error("Select an approved public owner/repository and revision, never a URL");
  const selectedFile = env.AGENTS_PUBLIC_REPOSITORY_ACCEPTANCE_FILE ?? "README.md";
  if (!selectedFile.length || selectedFile.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(selectedFile) || selectedFile.split("/").some(part => !part || part === "." || part === "..")) throw Error("Select a bounded relative public file path");
  const expected = env.AGENTS_PUBLIC_REPOSITORY_NATIVE_EXPECT ?? "MCP TypeScript SDK";
  const mcpExpected = env.AGENTS_PUBLIC_REPOSITORY_MCP_EXPECT ?? `Available pages for ${selection.data.owner}/${selection.data.repository}`;
  for (const text of [expected, mcpExpected]) if (!text.trim() || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) throw Error("Set bounded exact expected public-provider text");
  const expiresAt = env.AGENTS_PUBLIC_REPOSITORY_CONNECTION_EXPIRES_AT ?? new Date(now + 30 * 86400000).toISOString();
  if (!z.iso.datetime().safeParse(expiresAt).success || Date.parse(expiresAt) <= now || Date.parse(expiresAt) > now + 90 * 86400000) throw Error("Set a future ISO local public connection expiry within 90 days");
  return { selection: selection.data, selectedFile, expected, mcpExpected, expiresAt };
}
