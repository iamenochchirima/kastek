import { AsyncLocalStorage } from "node:async_hooks";

const signals = new AsyncLocalStorage<AbortSignal>();

/** Keeps cancellation local to a direct run, including concurrent conversations. */
export function withExecutionSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return signals.run(signal, operation);
}

export function currentExecutionSignal(): AbortSignal | undefined {
  return signals.getStore();
}
