import { z } from "zod";
import type { ResourceHandle } from "./resources";
export const githubOperationSchema = z.enum(["get_repository", "list_releases", "resolve_ref", "list_tree", "read_file"]);
export type GithubOperation = z.infer<typeof githubOperationSchema>;
export const githubRepositorySelectionSchema = z.strictObject({
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine(value => value !== "." && value !== ".."),
  ref: z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
});
export type GithubRepositorySelection = z.infer<typeof githubRepositorySelectionSchema>;
export function githubRepositoryHandle(selection: Pick<GithubRepositorySelection, "owner" | "repository">): ResourceHandle {
  const parsed = githubRepositorySelectionSchema.parse({ ...selection, ref: "HEAD" });
  return { kind: "github.repository", id: `${parsed.owner.toLowerCase()}/${parsed.repository.toLowerCase()}` };
}
