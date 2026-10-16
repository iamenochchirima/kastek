import type { CoreWorkspaceStatus } from "../core/client";
import type { ExecutionScope } from "../runtime/execution-scope";
import type { ToolInvocationContext } from "../tools/types";
import {
  authorizeHostCapability,
  HostCapabilityError,
  type HostCapabilityAdapter,
  type HostCapabilityAuthorization,
  type HostCapabilityIdentity,
  type HostCapabilityInvocation,
  type HostIdentity,
} from "./types";

export const CORE_WORKSPACE_STATUS_CAPABILITY = "kasitek.core.workspace_status" as const;

export interface CoreWorkspaceStatusReader {
  getWorkspaceStatus(context: ToolInvocationContext): Promise<CoreWorkspaceStatus>;
}

const host: HostIdentity = {
  id: "kasitek-core",
  kind: "kasitek-core",
};

const workspaceStatusIdentity: HostCapabilityIdentity = {
  name: CORE_WORKSPACE_STATUS_CAPABILITY,
  version: "1.0.0",
  host,
  requiredGrants: [CORE_WORKSPACE_STATUS_CAPABILITY],
  readOnly: true,
};

/**
 * Adapter for the one read-only capability owned by kasitek-core in this
 * first host seam. The adapter receives a projected ToolInvocationContext;
 * it never constructs credentials or reaches into the Core database.
 */
export class CoreHostAdapter implements HostCapabilityAdapter {
  public readonly host = host;

  public constructor(private readonly reader: CoreWorkspaceStatusReader) {}

  public listCapabilities(): readonly HostCapabilityIdentity[] {
    return [workspaceStatusIdentity];
  }

  public authorize(
    identity: HostCapabilityIdentity,
    scope: ExecutionScope,
  ): HostCapabilityAuthorization {
    return authorizeHostCapability(identity, scope);
  }

  public async invoke(input: HostCapabilityInvocation): Promise<CoreWorkspaceStatus> {
    if (Object.keys(input.arguments).length > 0) {
      throw new HostCapabilityError(
        "failed",
        "INVALID_ARGUMENTS",
        `${CORE_WORKSPACE_STATUS_CAPABILITY} does not accept arguments`,
      );
    }
    return this.reader.getWorkspaceStatus(input.context);
  }
}
