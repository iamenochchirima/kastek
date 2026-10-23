export type CustomerProduct = "growth" | "agents" | "agency";
export type CustomerAction = "webhook.replay" | "webhook.replay.approve" | "task.cancel" | "ingress.retry" | "client.suspend" | "client.resume";
export interface CustomerReference { product: CustomerProduct; id: string }
export interface CustomerFact { key: string; label: string; value: string | null; unit?: string; period?: string; enforced?: boolean | null }
export interface CustomerActionTemplate { action: CustomerAction; label: string; targetId: string; expected: Record<string, string | number>; selection?: string[] }
export interface CustomerRecord { id: string; label: string; state: string; facts: CustomerFact[]; actions?: CustomerActionTemplate[] }
export interface CustomerSection { id: string; title: string; status: "available" | "unsupported" | "unavailable"; records: CustomerRecord[]; nextCursor: string | null }
export interface CustomerRelationship { product: CustomerProduct; customerId: string; executionOrganizationId: string; mappingId: string; state: "active" | "revoked" }
export interface CustomerOverview { customer: CustomerReference & { name: string; state: string }; observedAt: string; sections: CustomerSection[]; relationships: CustomerRelationship[] }
export interface CustomerOperationRequest extends CustomerActionTemplate { operationId: string; reason: string }
export interface CustomerOperationPreview { customer: CustomerReference; action: CustomerAction; targetId: string; impact: string; eligible: boolean; code?: string }
export type CustomerOperationStatus = "awaiting_approval" | "pending" | "confirmed" | "rejected" | "failed" | "unknown";
export interface CustomerOperationReceipt { id: string; customer: CustomerReference; action: CustomerAction; targetId: string; actorId: string; reason: string; status: CustomerOperationStatus; createdAt: string; updatedAt: string; code: string | null; sourceOperationId?: string | null }
