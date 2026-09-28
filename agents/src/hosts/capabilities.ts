/**
 * Stable host-capability seam for harness composition.
 *
 * Keep callers on this facade so adapter files can evolve without moving the
 * harness integration point.
 */
export { HostCapabilityRouter } from "./router";
export type { HostCapabilityRequest } from "./router";
export type { HostCapabilityOutcome as HostCapabilityResult } from "./types";
export { CORE_WORKSPACE_STATUS_CAPABILITY, CoreHostAdapter } from "./core-host-adapter";
export { NATIVE_CURRENT_TIME_CAPABILITY, NativeHostAdapter } from "./native-host-adapter";
export { TenantHostFixtureAdapter } from "./tenant-host-fixture";
