import type { CoreWorkspaceStatus } from "../core/client";
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
import { CORE_WORKSPACE_STATUS_CAPABILITY } from "./core-host-adapter";

export interface TenantHostFixtureOptions {
  readonly organizationId: string;
  readonly installationId: string;
  readonly workspaceStatus: CoreWorkspaceStatus;
  readonly deniedCapabilities?: readonly string[];
}

const host: HostIdentity = {
  id: "tenant-fixture",
  kind: "tenant-fixture",
};

/**
 * In-memory host used by tenant conformance tests and local development.
 * It deliberately has an explicit denial list so callers exercise the same
 * denied outcome as a tenant host with a missing entitlement or resource.
 */
export class TenantHostFixtureAdapter implements HostCapabilityAdapter {
  public readonly host = host;
  private readonly deniedCapabilities: ReadonlySet<string>;
  private readonly identity: HostCapabilityIdentity = {
    name: CORE_WORKSPACE_STATUS_CAPABILITY,
    version: "1.0.0",
    host,
    requiredGrants: [CORE_WORKSPACE_STATUS_CAPABILITY],
    readOnly: true,
  };

  public constructor(private readonly options: TenantHostFixtureOptions) {
    this.deniedCapabilities = new Set(options.deniedCapabilities ?? []);
  }

  public listCapabilities(): readonly HostCapabilityIdentity[] {
    return [this.identity];
  }

  public authorize(
    identity: HostCapabilityIdentity,
    scope: ExecutionScope,
  ): HostCapabilityAuthorization {
    const grantDecision = authorizeHostCapability(identity, scope);
    if (!grantDecision.allowed) return grantDecision;
    if (scope.organizationId !== this.options.organizationId || scope.installationId !== this.options.installationId) {
      return {
        allowed: false,
        code: "HOST_DENIED",
        message: "Tenant host is not assigned to this execution scope",
      };
    }
    if (this.deniedCapabilities.has(identity.name)) {
      return {
        allowed: false,
        code: "HOST_DENIED",
        message: "Tenant host fixture denied this capability",
      };
    }
    return { allowed: true };
  }

  public async invoke(input: HostCapabilityInvocation): Promise<CoreWorkspaceStatus> {
    if (Object.keys(input.arguments).length > 0) {
      throw new HostCapabilityError(
        "failed",
        "INVALID_ARGUMENTS",
        `${CORE_WORKSPACE_STATUS_CAPABILITY} does not accept arguments`,
      );
    }
    return this.options.workspaceStatus;
  }
}
