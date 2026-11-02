import { z } from "zod";

/** Explicit local acceptance inputs only; no credential discovery or provider I/O. */
export function readStashAcceptanceConfig(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const token = env.STASH_AGENT_KEY ?? "";
  if (token.length < 16 || token.length > 4096 || /\s/.test(token)) throw Error("Set the approved STASH_AGENT_KEY; no other credential is searched");
  const item = z.uuid().safeParse(env.AGENTS_STASH_ACCEPTANCE_ITEM_ID);
  if (!item.success) throw Error("Set an explicitly approved Stash project note or idea ID in AGENTS_STASH_ACCEPTANCE_ITEM_ID");
  const expected = env.AGENTS_STASH_ACCEPTANCE_EXPECT ?? "";
  if (expected.trim().length < 16 || expected.length > 200 || /[\u0000-\u001f\u007f]/.test(expected)) throw Error("Set an exact expected Stash quote of 16..200 characters in AGENTS_STASH_ACCEPTANCE_EXPECT");
  const expiresAt = env.AGENTS_STASH_CONNECTION_EXPIRES_AT ?? new Date(now + 30 * 86400000).toISOString();
  const expires = Date.parse(expiresAt);
  if (!z.iso.datetime().safeParse(expiresAt).success || expires <= now || expires > now + 90 * 86400000) throw Error("Set a future ISO local connection expiry within 90 days in AGENTS_STASH_CONNECTION_EXPIRES_AT");
  return { token, itemId: item.data, expected, expiresAt };
}
