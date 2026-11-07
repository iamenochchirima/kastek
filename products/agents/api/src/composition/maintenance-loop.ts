/**
 * One maintenance loop with a single in-flight run and a swallowed failure. Separate loops keep a
 * slow provider operation from postponing unrelated maintenance (cancellation, timeout notices,
 * delivery), which previously shared one promise chain.
 */
export interface MaintenanceLoop {
  timer: ReturnType<typeof setInterval>;
  tick(): Promise<void>;
  pending(): Promise<unknown> | undefined;
  stop(): void;
}

export function createMaintenanceLoop(
  run: () => Promise<unknown>,
  onFailure: () => void,
  intervalMs = 1000,
): MaintenanceLoop {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("Maintenance interval must be a positive integer");
  let pending: Promise<unknown> | undefined;
  const tick = async (): Promise<void> => {
    if (pending) return;
    pending = Promise.resolve().then(run).catch(onFailure).finally(() => { pending = undefined; });
    await pending;
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return { timer, tick, pending: () => pending, stop: () => clearInterval(timer) };
}
