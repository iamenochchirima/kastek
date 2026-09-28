import type { ExecutionScope } from "../runtime/execution-scope";
import {
  authorizeHostCapability,
  HostCapabilityError,
  type HostCapabilityAdapter,
  type HostCapabilityAuthorization,
  type HostCapabilityIdentity,
  type HostCapabilityInvocation,
  type HostIdentity,
} from "./types";

export const NATIVE_CURRENT_TIME_CAPABILITY = "platform.current_time" as const;

export interface NativeClock {
  now(): Date;
}

const host: HostIdentity = {
  id: "agents-runtime",
  kind: "native-runtime",
};

const currentTimeIdentity: HostCapabilityIdentity = {
  name: NATIVE_CURRENT_TIME_CAPABILITY,
  version: "1.0.0",
  host,
  requiredGrants: [NATIVE_CURRENT_TIME_CAPABILITY],
  readOnly: true,
};

const systemClock: NativeClock = {
  now: () => new Date(),
};

/** A Core-free native capability with an injectable clock for deterministic tests. */
export class NativeHostAdapter implements HostCapabilityAdapter {
  public readonly host = host;

  public constructor(private readonly clock: NativeClock = systemClock) {}

  public listCapabilities(): readonly HostCapabilityIdentity[] {
    return [currentTimeIdentity];
  }

  public authorize(
    identity: HostCapabilityIdentity,
    scope: ExecutionScope,
  ): HostCapabilityAuthorization {
    return authorizeHostCapability(identity, scope);
  }

  public async invoke(input: HostCapabilityInvocation): Promise<{ iso: string }> {
    if (Object.keys(input.arguments).length > 0) {
      throw new HostCapabilityError(
        "failed",
        "INVALID_ARGUMENTS",
        `${NATIVE_CURRENT_TIME_CAPABILITY} does not accept arguments`,
      );
    }
    return { iso: this.clock.now().toISOString() };
  }
}
