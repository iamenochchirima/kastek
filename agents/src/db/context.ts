import { AsyncLocalStorage } from "node:async_hooks";

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

/** Use only after authentication or a trusted background scope has been established. */
export function enterDatabaseContext(context: DatabaseContext | undefined): void {
  databaseContextStorage.enterWith(normalizeDatabaseContext(context));
}
