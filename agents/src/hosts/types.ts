import type { ExecutionScope } from "../runtime/execution-scope";
import type { ToolInvocationContext } from "../tools/types";

export type HostKind = "kasitek-core" | "native-runtime" | "tenant-fixture" | "unresolved";

export interface HostIdentity {
  readonly id: string;
  readonly kind: HostKind;
}

export interface HostCapabilityIdentity {
  readonly name: string;
  readonly version: string;
  readonly host: HostIdentity;
  readonly requiredGrants: readonly string[];
  readonly readOnly: boolean;
}

export type HostCapabilityDeniedCode =
  | "CAPABILITY_NOT_GRANTED"
  | "HOST_DENIED"
  | "RESOURCE_NOT_GRANTED";

export type HostCapabilityUnavailableCode =
  | "CAPABILITY_UNAVAILABLE"
  | "HOST_UNAVAILABLE";

export type HostCapabilityFailureCode =
  | "HOST_TIMEOUT"
  | "HOST_REJECTED"
  | "INVALID_ARGUMENTS";

export type HostCapabilityAuthorization =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: HostCapabilityDeniedCode;
      readonly message: string;
    };

export interface HostCapabilityInvocation {
  readonly identity: HostCapabilityIdentity;
  readonly scope: ExecutionScope;
  readonly context: ToolInvocationContext;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface HostCapabilityAdapter {
  readonly host: HostIdentity;
  listCapabilities(): readonly HostCapabilityIdentity[];
  authorize(
    identity: HostCapabilityIdentity,
    scope: ExecutionScope,
  ): HostCapabilityAuthorization;
  invoke(input: HostCapabilityInvocation): Promise<unknown>;
}

export type HostCapabilityOutcome<T> =
  | {
      readonly status: "succeeded";
      readonly identity: HostCapabilityIdentity;
      readonly scope: ExecutionScope;
      readonly value: T;
    }
  | {
      readonly status: "denied";
      readonly identity: HostCapabilityIdentity;
      readonly scope: ExecutionScope;
      readonly code: HostCapabilityDeniedCode;
      readonly message: string;
    }
  | {
      readonly status: "unavailable";
      readonly identity: HostCapabilityIdentity;
      readonly scope: ExecutionScope;
      readonly code: HostCapabilityUnavailableCode;
      readonly message: string;
    }
  | {
      readonly status: "failed";
      readonly identity: HostCapabilityIdentity;
      readonly scope: ExecutionScope;
      readonly code: HostCapabilityFailureCode;
      readonly message: string;
    };

export class HostCapabilityError extends Error {
  public constructor(
    public readonly status: "denied" | "unavailable" | "failed",
    public readonly code: HostCapabilityDeniedCode | HostCapabilityUnavailableCode | HostCapabilityFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "HostCapabilityError";
  }
}

export function authorizeHostCapability(
  identity: HostCapabilityIdentity,
  scope: ExecutionScope,
): HostCapabilityAuthorization {
  const grants = new Set(scope.capabilityGrants ?? []);
  const missingGrant = identity.requiredGrants.find((grant) => !grants.has(grant));
  if (missingGrant) {
    return {
      allowed: false,
      code: "CAPABILITY_NOT_GRANTED",
      message: `Capability grant is missing: ${missingGrant}`,
    };
  }
  return { allowed: true };
}
