/** Product capability publication is data selecting installed handlers, never executable code or endpoints. */
export interface ProductCapabilityPolicy {
  effect: "read" | "draft_write" | "authorized_write" | "reviewed_write";
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
  clientId?: string;
  originClientId?: string;
}
/** Data destinations are separate from permission to invoke a business operation. */
export interface ProductInformationEnvelope {
  version: "1";
  origin: { product: string; tenantId: string; actor: { issuer: string; subject: string } };
  audience: { product: string; tenantId: string; actor: { issuer: string; subject: string }; conversationId: string; clientId: string | null };
  providers: {
    destinationDigest: string;
    bindingDigest: string;
    providerId: string;
    protocol: string;
    endpoint: string;
    connectionId: string;
    connectionRevision: number;
    credentialRevision: number;
    modelId: string;
  }[];
}
export interface ProductExecutionLineage {
  version: "1";
  workId: string;
  rootTaskId: string;
  parentTaskId: string | null;
  taskId: string;
}
export interface ProductOriginAuthorization {
  version: "1"; product: string; requestId: string; taskId: string; conversationId: string;
  tenantId: string; clientId: string | null; actor: { issuer: string; subject: string };
  purpose?: "execute" | "configure_model";
}
/** Destination grants need the published identity, never a product's private executor types. */
export interface ProductGrantBinding {
  id: string; digest: string; authority: ProductCapabilityAuthority;
  definition: { providerOperation: string };
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
  execution?: ProductExecutionLineage;
  information?: ProductInformationEnvelope;
  /** Requests private access-only provenance; neither observation is model-visible. */
  observation?: "access-v1" | "effect-status-v1";
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
  information?: ProductInformationEnvelope;
  sources?: ProductSourceObservation[];
  /** Returned only to a caller that requested access-v1; never model-visible. */
  access?: { version: "1"; reference: string; scopeReference: string; resultDigest: string };
  review?: ProductReviewReference;
  receipt?: { id: string; operationId: string; payloadDigest: string; state: "saved" };
}
