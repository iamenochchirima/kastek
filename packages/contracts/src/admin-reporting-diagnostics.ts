export type AdminDiagnosticService = "growth" | "agents" | "agency" | "analytics";
export type AdminDiagnosticState = "ready" | "unknown" | "not_configured" | "disconnected" | "unauthorized" | "incompatible_schema" | "backfilling" | "stale" | "no_activity";
export interface AdminDiagnosticCheck { state: AdminDiagnosticState; code?: string; }
/** Aggregate operational metadata only. Counts are exact strings; absent evidence stays null. */
export interface AdminReportingDiagnostics {
 contractVersion: "1";
 service: AdminDiagnosticService;
 observedAt: string;
 configuration: AdminDiagnosticCheck;
 connectivity: AdminDiagnosticCheck;
 schema: AdminDiagnosticCheck;
 reads: AdminDiagnosticCheck;
 publication: null | {state:"ready"|"no_activity"|"backfilling";pending:string;retrying:string;quarantined:string;oldestPendingAt:string|null;lastPublishedAt:string|null;failureCode:string|null;pendingReceipts:string|null};
 projection: null | {registeredScopes:string;observedSourceAt:string|null;ingestedAt:string|null;checkpointAt:string|null;completeThrough:string|null;pending:string;oldestPendingAt:string|null;failed:string;backfilling:string;promotedGenerations:string;latestPromotedAt:string|null;sourceStates:Record<string,string>;coverage:"unknown"|"partial"};
}
