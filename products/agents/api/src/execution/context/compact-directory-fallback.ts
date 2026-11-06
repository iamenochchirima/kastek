import { ModelOperationError } from "../business/model";
import { buildContext, type ContextInput } from "./context";

export const compactDirectoryText = "Available tools and their purposes are described in their callable schemas.";

/** Only the caller can establish that every directory capability remains represented. */
export function compactDirectoryFallback(input: ContextInput, directory: string) {
  const original = "\n" + directory;
  if (!input.instructions.includes(original)) return undefined;
  const instructions = input.instructions.replace(original, "\n" + compactDirectoryText);
  try { return { built: buildContext({ ...input, instructions }), instructions }; }
  catch (error) {
    if (error instanceof ModelOperationError && error.code === "CONTEXT_LIMIT") return undefined;
    throw error;
  }
}
