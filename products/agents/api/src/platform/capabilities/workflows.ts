/** Explicit workflow registrations served by the worker. */
export interface WorkflowRegistration<T> {
  id: string;
  service: T;
  enabled?: boolean;
}

/** Services passed to the Restate endpoint, in registration order. Disabled entries are skipped. */
export function registeredWorkflowServices<T>(entries: readonly WorkflowRegistration<T>[]): T[] {
  return entries.filter(entry => entry.enabled !== false).map(entry => entry.service);
}
