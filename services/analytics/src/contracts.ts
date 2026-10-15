export const SERVICE_NAME = 'kasitek-analytics' as const;
export type ProcessKind = 'analytics-api' | 'analytics-worker';
export interface LivenessResponse {status:'ok';service:typeof SERVICE_NAME;process:ProcessKind;timestamp:string;}
export interface DependencyStatus {status:'ready'|'unavailable'|'pending';}
export interface ReadinessResponse {
 status:'ready'|'not_ready';service:typeof SERVICE_NAME;process:ProcessKind;timestamp:string;
 dependencies:{postgres:DependencyStatus;migrations:DependencyStatus};
}
