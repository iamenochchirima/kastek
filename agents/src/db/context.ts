import { AsyncLocalStorage } from "node:async_hooks";
import { recordDatabaseContextMissing } from "../telemetry/spans";
import { operationalLogger } from "../telemetry/logger";

const MAX_CONTEXT_VALUE_LENGTH = 240;

export interface DatabaseContext {
  organizationId?: string;
  actorId?: string;
  operator?: boolean;
}

const databaseContextStorage = new AsyncLocalStorage<DatabaseContext | undefined>();

function bounded(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_CONTEXT_VALUE_LENGTH);
}

export function normalizeDatabaseContext(context: DatabaseContext | undefined): DatabaseContext | undefined {
  if (!context) return undefined;
  const normalized = {
    ...(bounded(context.organizationId) ? { organizationId: bounded(context.organizationId) } : {}),
    ...(bounded(context.actorId) ? { actorId: bounded(context.actorId) } : {}),
    ...(context.operator === true ? { operator: true } : {}),
  } satisfies DatabaseContext;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function currentDatabaseContext(): DatabaseContext | undefined {
  return databaseContextStorage.getStore();
}

export function runWithDatabaseContext<T>(context: DatabaseContext | undefined, operation: () => T): T {
  return databaseContextStorage.run(normalizeDatabaseContext(context), operation);
}

/**
 * Establishes a scope that is safe for background work against tenant-owned
 * tables. Background jobs must never silently continue with an unscoped pool
 * query: a missing scope is an operational failure and must be visible.
 */
export function runWithRequiredDatabaseContext<T>(
  processName: string,
  context: DatabaseContext | undefined,
  operation: () => T,
): T {
  const normalized = normalizeDatabaseContext(context);
  if (!normalized?.organizationId || !normalized.actorId) {
    recordDatabaseContextMissing(processName);
    operationalLogger.error({
      event: "database.context.missing",
      process: processName.slice(0, MAX_CONTEXT_VALUE_LENGTH),
      error_code: "DATABASE_CONTEXT_REQUIRED",
    }, "Database context required for background operation");
    throw Object.assign(new Error(`Database context required for ${processName}`), {
      code: "DATABASE_CONTEXT_REQUIRED",
      process: processName,
    });
  }
  return databaseContextStorage.run(normalized, operation);
}

/** Use only after authentication or a trusted background scope has been established. */
export function enterDatabaseContext(context: DatabaseContext | undefined): void {
  databaseContextStorage.enterWith(normalizeDatabaseContext(context));
}
