import { createHash } from "node:crypto";

/** A revision changes content; a family retains the server-verified publisher and source. */
export function skillFamilyId(input:{organizationId:string;name:string;sourceKind?:string;sourceSlug?:string|null;repository?:string|null;packagePath?:string|null}):string {
  const source=input.repository?["repository",input.organizationId,input.repository.toLowerCase(),input.packagePath??""]:
    input.sourceKind==="curated"?["curated","kasitek",input.sourceSlug??input.name]:["private",input.organizationId];
  return createHash("sha256").update(JSON.stringify(["skill-family-v1",...source,input.name])).digest("hex");
}
