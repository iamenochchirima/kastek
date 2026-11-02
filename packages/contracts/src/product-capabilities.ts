/** Product capability publication is data selecting installed handlers, never executable code or endpoints. */
export interface ProductCapabilityPolicy {
  effect: "read" | "draft_write" | "reviewed_write";
  disclosure: "approved_resource_identifiers" | "exact_requested_payload" | "exact_reviewed_payload";
  retry: "safe_read" | "status_only";
  approval: "none" | "exact_single_use";
  cancel: "stop_admission" | "reconcile_claimed";
}
export interface ProductCapabilityDescriptor {
  operation: string;
  revision: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  handlerRef: string;
  policy: ProductCapabilityPolicy;
  requiredAuthority: string[];
  evidence: "none" | "versioned_sources";
  limits: { timeoutMs: number; maxPhysicalAttempts: number; maxResponseBytes: number; maxModelResultBytes: number };
}
export interface ProductCapabilityManifest {
  schemaVersion: 1;
  product: string;
  revision: string;
  adapter: { id: string; release: string; manifestDigest: string };
  operations: ProductCapabilityDescriptor[];
  digest: string;
}
export interface ProductCapabilityAuthority {
  kind: "product";
  originProduct: string;
  destinationProduct: string;
  originTenantId: string;
  tenantId: string;
  mappingRef: string;
  policyRevision: string;
  manifestDigest: string;
  descriptorDigest: string;
  handlerRef: string;
}
export interface ProductCapabilityInvocation {
  version: "1";
  requestId: string;
  operationId: string;
  taskId: string;
  conversationId: string;
  actor: { issuer: string; subject: string };
  authority: ProductCapabilityAuthority;
  bindingId: string;
  bindingDigest: string;
  operation: string;
  input: unknown;
  control: "invoke" | "authorize" | "prepare" | "review" | "commit" | "evidence";
  review?: ProductReviewReference;
}
export interface ProductReviewReference {
  id: string;
  product: string;
  taskId: string;
  operationId: string;
  payloadDigest: string;
  state: "proposed" | "approved" | "saved" | "rejected" | "expired" | "uncertain";
  expiresAt: string;
}
export interface ProductSourceObservation {
  id: string;
  revision: string;
  title: string;
  text: string;
  acquiredAt: string;
  continuation: string | null;
  route?: string;
}
export interface ProductCapabilityResult {
  value: unknown;
  sources?: ProductSourceObservation[];
  review?: ProductReviewReference;
  receipt?: { id: string; operationId: string; payloadDigest: string; state: "saved" };
}
