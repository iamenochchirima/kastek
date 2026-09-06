import { createExecutionScope, type ExecutionScope } from "../runtime/execution-scope";
import { toolInvocationContextFromScope } from "../tools/types";
import {
  HostCapabilityError,
  type HostCapabilityAdapter,
  type HostCapabilityDeniedCode,
  type HostCapabilityFailureCode,
  type HostCapabilityIdentity,
  type HostCapabilityOutcome,
  type HostCapabilityUnavailableCode,
} from "./types";

export interface HostCapabilityRequest {
  readonly name: string;
  readonly scope: ExecutionScope;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

type HostErrorCode = HostCapabilityDeniedCode | HostCapabilityUnavailableCode | HostCapabilityFailureCode;

/**
 * Small capability registry and routing seam. Production composition roots
 * can register one adapter per capability; callers only depend on this
 * interface and receive bounded outcomes instead of host-specific errors.
 */
export class HostCapabilityRouter {
  private readonly routes = new Map<string, { adapter: HostCapabilityAdapter; identity: HostCapabilityIdentity }>();

  public constructor(adapters: readonly HostCapabilityAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  public register(adapter: HostCapabilityAdapter): void {
    for (const identity of adapter.listCapabilities()) {
      if (identity.host.id !== adapter.host.id || identity.host.kind !== adapter.host.kind) {
        throw new Error(`HOST_CAPABILITY_IDENTITY_MISMATCH:${identity.name}`);
      }
      if (this.routes.has(identity.name)) throw new Error(`Duplicate host capability: ${identity.name}`);
      this.routes.set(identity.name, { adapter, identity });
    }
  }

  public get(name: string): HostCapabilityIdentity | undefined {
    return this.routes.get(name)?.identity;
  }

  public list(): readonly HostCapabilityIdentity[] {
    return [...this.routes.values()].map(({ identity }) => identity);
  }

  public async invoke<T = unknown>(request: HostCapabilityRequest): Promise<HostCapabilityOutcome<T>> {
    const scope = createExecutionScope(request.scope);
    const route = this.routes.get(request.name);
    if (!route) {
      return {
        status: "unavailable",
        identity: this.unavailableIdentity(request.name),
        scope,
        code: "CAPABILITY_UNAVAILABLE",
        message: "Host capability is not registered",
      };
    }

    const authorization = route.adapter.authorize(route.identity, scope);
    if (!authorization.allowed) {
      return {
        status: "denied",
        identity: route.identity,
        scope,
        code: authorization.code,
        message: authorization.message,
      };
    }

    try {
      const context = toolInvocationContextFromScope(scope, request.signal ? { signal: request.signal } : {});
      const value = await route.adapter.invoke({
        identity: route.identity,
        scope,
        context,
        arguments: request.arguments ?? {},
      });
      return { status: "succeeded", identity: route.identity, scope, value: value as T };
    } catch (error) {
      return this.errorOutcome(route.identity, scope, error);
    }
  }

  private unavailableIdentity(name: string): HostCapabilityIdentity {
    return {
      name,
      version: "unknown",
      host: { id: "unresolved", kind: "unresolved" },
      requiredGrants: [],
      readOnly: true,
    };
  }

  private errorOutcome<T>(
    identity: HostCapabilityIdentity,
    scope: ExecutionScope,
    error: unknown,
  ): HostCapabilityOutcome<T> {
    if (error instanceof HostCapabilityError) {
      if (error.status === "denied") {
        return { status: "denied", identity, scope, code: error.code as HostCapabilityDeniedCode, message: error.message };
      }
      if (error.status === "unavailable") {
        return { status: "unavailable", identity, scope, code: error.code as HostCapabilityUnavailableCode, message: error.message };
      }
      return { status: "failed", identity, scope, code: error.code as HostCapabilityFailureCode, message: error.message };
    }

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "HOST_REJECTED";
    if (code === "CORE_UNAUTHORIZED") {
      return { status: "denied", identity, scope, code: "HOST_DENIED", message: "Host rejected the capability request" };
    }
    if (code === "CORE_UNAVAILABLE" || code === "CORE_TIMEOUT") {
      return { status: "unavailable", identity, scope, code: "HOST_UNAVAILABLE", message: "Host capability is unavailable" };
    }
    return { status: "failed", identity, scope, code: "HOST_REJECTED", message: "Host capability failed" };
  }
}

export type { HostCapabilityAdapter, HostCapabilityIdentity, HostCapabilityOutcome } from "./types";
