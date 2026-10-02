import { catalog } from "./catalog.js";
import Ajv2020 from "ajv/dist/2020.js";
import semver from "semver";
import { SerdeFloat } from "@kasitek/server-support/json";
import type { ValidateFunction } from "ajv";
export type ProductRuntime = "control_plane" | "direct" | "white_label";
export type ActorKind =
  | "platform_operator"
  | "direct_user"
  | "tenant_staff"
  | "tenant_client"
  | "native_agent"
  | "api_client"
  | "external_agent";
export type RiskClass =
  | "read"
  | "draft"
  | "controlled_write"
  | "external_effect"
  | "privileged";
export type ActionLifecycle =
  | "draft"
  | "internal"
  | "pilot"
  | "public"
  | "deprecated"
  | "retired";
export type DenialCode =
  | "unsupported_action"
  | "unsupported_runtime"
  | "unsupported_actor"
  | "unauthorized_scope"
  | "missing_grant"
  | "missing_entitlement"
  | "limit_exceeded"
  | "approval_rejected"
  | "policy_denied";
export type FailureCode =
  | "invalid_input"
  | "invalid_output"
  | "conflict"
  | "deadline_exceeded"
  | "temporarily_unavailable"
  | "internal";
export interface ActionId {
  name: string;
  version: string;
}
export interface Actor {
  kind: ActorKind;
  id: string;
  realm: "platform" | "direct" | "white_label";
  authenticated_client_id: string | null;
  delegated_by: {
    kind: ActorKind;
    id: string;
  } | null;
}
export type Scope =
  | {
      type: "control_plane";
    }
  | {
      type: "direct";
      organisation_id: string;
    }
  | {
      type: "tenant_staff";
      workspace_id: string;
      client_access:
        | {
            type: "all";
          }
        | {
            type: "assigned";
            client_ids: string[];
          };
    }
  | {
      type: "tenant_client";
      workspace_id: string;
      tenant_client_id: string;
    };
export interface ActionDefinition {
  id: ActionId;
  owning_domain: string;
  title: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  risk: RiskClass;
  approval: {
    type: "none" | "policy_controlled" | "always" | "four_eyes";
  };
  supported_runtimes: ProductRuntime[];
  supported_actors: ActorKind[];
  client_scope: "not_applicable" | "optional" | "required";
  required_grants: string[];
  required_oauth_scopes: string[];
  required_entitlements: string[];
  idempotency: "not_applicable" | "optional" | "required";
  data_classification: "public" | "internal" | "confidential" | "restricted";
  audit: "none" | "access" | "full";
  usage: "none" | "count" | "measured";
  lifecycle: ActionLifecycle;
}
export interface IncomingActionRequest {
  invocation_id: string;
  correlation_id: string;
  causation_id: string | null;
  action: ActionId;
  actor: Actor;
  scope: Scope;
  input: unknown;
  idempotency_key: string | null;
  approval_id: string | null;
  requested_at: Date;
  deadline: Date | null;
}
export type ActionOutcome =
  | {
      status: "succeeded";
      output: unknown;
    }
  | {
      status: "accepted";
      operation_id: string;
    }
  | {
      status: "approval_required";
      approval_id: string;
    }
  | {
      status: "denied";
      reason_code: DenialCode;
    }
  | {
      status: "failed";
      error_code: FailureCode;
    };
export interface ActionResult {
  invocation_id: string;
  correlation_id: string;
  outcome: ActionOutcome;
}
export class ActionError extends Error {
  constructor(
    public readonly code:
      | "invalid_action_name"
      | "invalid_action_version"
      | "invalid_definition"
      | "invalid_schema"
      | "schema_violation"
      | "duplicate_action"
      | "action_not_found"
      | "invalid_request",
    message: string,
    public readonly side?: "input" | "output",
    public readonly instancePath?: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}
const invalid = (message: string): never => {
  throw new ActionError(
    "invalid_request",
    `action request is invalid: ${message}`,
  );
};
const identifier = (label: string, value: string): void => {
  if (!value?.trim()) invalid(`${label} cannot be empty`);
};
export function actionId(name: string, version: string): ActionId {
  if (
    Buffer.byteLength(name) < 3 ||
    Buffer.byteLength(name) > 128 ||
    !name.includes(".") ||
    !name.split(".").every((segment) => /^[a-z][a-z0-9_-]*$/.test(segment))
  )
    throw new ActionError(
      "invalid_action_name",
      `action name is invalid: ${name}`,
    );
  if (semver.valid(version) !== version)
    throw new ActionError(
      "invalid_action_version",
      `action version is invalid: ${version}`,
    );
  return { name, version };
}
export const actionKey = (id: ActionId): string => `${id.name}@${id.version}`;
export const scopeRuntime = (scope: Scope): ProductRuntime =>
  scope.type === "control_plane"
    ? "control_plane"
    : scope.type === "direct"
      ? "direct"
      : "white_label";
export function validateActor(actor: Actor, runtime: ProductRuntime): void {
  identifier("actor ID", actor.id);
  if (actor.authenticated_client_id !== null)
    identifier("authenticated client ID", actor.authenticated_client_id);
  if (actor.delegated_by)
    identifier("delegating actor ID", actor.delegated_by.id);
  if (
    (
      {
        platform: "control_plane",
        direct: "direct",
        white_label: "white_label",
      } as const
    )[actor.realm] !== runtime
  )
    invalid("actor identity realm does not match the product runtime");
  if (
    (actor.kind === "platform_operator" && actor.realm !== "platform") ||
    (actor.kind === "direct_user" && actor.realm !== "direct") ||
    (["tenant_staff", "tenant_client"].includes(actor.kind) &&
      actor.realm !== "white_label")
  )
    invalid("actor type does not match its identity realm");
  if (
    ["native_agent", "api_client", "external_agent"].includes(actor.kind) &&
    actor.authenticated_client_id === null
  )
    invalid("machine actors require an authenticated client ID");
}
export function validateScope(scope: Scope, actor: ActorKind): void {
  switch (scope.type) {
    case "control_plane":
      if (actor !== "platform_operator")
        invalid("only platform operators can use control-plane scope");
      break;
    case "direct":
      identifier("organisation ID", scope.organisation_id);
      if (["tenant_staff", "tenant_client"].includes(actor))
        invalid("white-label actors cannot use direct scope");
      break;
    case "tenant_staff":
      identifier("workspace ID", scope.workspace_id);
      if (actor === "tenant_client")
        invalid("tenant client actors require tenant-client scope");
      if (scope.client_access.type === "assigned")
        for (const id of scope.client_access.client_ids)
          identifier("assigned client ID", id);
      break;
    case "tenant_client":
      identifier("workspace ID", scope.workspace_id);
      identifier("tenant client ID", scope.tenant_client_id);
      if (
        ![
          "tenant_client",
          "native_agent",
          "api_client",
          "external_agent",
        ].includes(actor)
      )
        invalid(
          "tenant-client scope requires a tenant client or scoped machine actor",
        );
  }
}
function metadata(definition: ActionDefinition): void {
  actionId(definition.id.name, definition.id.version);
  for (const [label, value] of [
    ["owning domain", definition.owning_domain],
    ["title", definition.title],
    ["description", definition.description],
    ...definition.required_grants.map((value) => ["grant", value]),
    ...definition.required_oauth_scopes.map((value) => ["OAuth scope", value]),
    ...definition.required_entitlements.map((value) => ["entitlement", value]),
  ])
    if (!value!.trim())
      throw new ActionError(
        "invalid_definition",
        `action definition is invalid: ${label} cannot be empty`,
      );
  if (
    !definition.supported_runtimes.length ||
    !definition.supported_actors.length
  )
    throw new ActionError(
      "invalid_definition",
      `action definition is invalid: supported ${!definition.supported_runtimes.length ? "runtimes" : "actors"} cannot be empty`,
    );
  if (
    ["read", "draft"].includes(definition.risk) &&
    ["always", "four_eyes"].includes(definition.approval.type)
  )
    throw new ActionError(
      "invalid_definition",
      "action definition is invalid: read and draft actions cannot require unconditional approval",
    );
}
// Validation examines numeric values; the invocation retains lossless JSON integers and float tags.
function validationValue(value: unknown): unknown {
  if (value instanceof SerdeFloat) return value.value;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(validationValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        validationValue(child),
      ]),
    );
  return value;
}
export class RegisteredAction {
  readonly definition: ActionDefinition;
  private input: ValidateFunction;
  private output: ValidateFunction;
  constructor(definition: ActionDefinition) {
    metadata(definition);
    this.definition = structuredClone(definition);
    const compile = (
      side: "input" | "output",
      schema: Record<string, unknown>,
    ): ValidateFunction => {
      if (schema.type !== "object")
        throw new ActionError(
          "invalid_schema",
          `${side} schema is invalid: top-level action schemas must declare type object`,
          side,
        );
      try {
        return new Ajv2020.default({
          strict: false,
          validateFormats: false,
          allErrors: false,
          useDefaults: false,
          coerceTypes: false,
          removeAdditional: false,
        }).compile(schema);
      } catch (error) {
        throw new ActionError(
          "invalid_schema",
          `${side} schema is invalid: ${error instanceof Error ? error.message : "invalid schema"}`,
          side,
        );
      }
    };
    this.input = compile("input", definition.input_schema);
    this.output = compile("output", definition.output_schema);
  }
  private validate(side: "input" | "output", value: unknown): void {
    const validator = side === "input" ? this.input : this.output;
    if (!validator(validationValue(value))) {
      const path = validator.errors?.[0]?.instancePath || "/";
      throw new ActionError(
        "schema_violation",
        `${side} does not match the action schema at ${path}`,
        side,
        path,
      );
    }
  }
  validateInput(value: unknown): void {
    this.validate("input", value);
  }
  validateOutput(value: unknown): void {
    this.validate("output", value);
  }
}
export class ValidatedActionRequest {
  private constructor(readonly incoming: IncomingActionRequest) {}
  static from(
    request: IncomingActionRequest,
    action: RegisteredAction,
  ): ValidatedActionRequest {
    identifier("invocation ID", request.invocation_id);
    identifier("correlation ID", request.correlation_id);
    for (const [label, value] of [
      ["causation ID", request.causation_id],
      ["idempotency key", request.idempotency_key],
      ["approval ID", request.approval_id],
    ])
      if (value !== null) identifier(label!, value!);
    if (request.deadline && request.deadline <= request.requested_at)
      invalid("deadline must be later than the request time");
    const definition = action.definition;
    if (actionKey(request.action) !== actionKey(definition.id))
      invalid("request action does not match the registered action");
    const runtime = scopeRuntime(request.scope);
    validateActor(request.actor, runtime);
    validateScope(request.scope, request.actor.kind);
    if (!definition.supported_runtimes.includes(runtime))
      invalid("action does not support the resolved product runtime");
    if (!definition.supported_actors.includes(request.actor.kind))
      invalid("action does not support this actor type");
    if (
      definition.client_scope === "not_applicable" &&
      request.scope.type === "tenant_client"
    )
      invalid("action does not accept tenant-client scope");
    if (
      definition.client_scope === "required" &&
      request.scope.type !== "tenant_client"
    )
      invalid("action requires tenant-client scope");
    if (
      definition.idempotency === "required" &&
      request.idempotency_key === null
    )
      invalid("action requires an idempotency key");
    action.validateInput(request.input);
    return new ValidatedActionRequest(request);
  }
}
export class ActionRegistry {
  private actions = new Map<string, RegisteredAction>();
  constructor(definitions: Iterable<ActionDefinition> = []) {
    for (const definition of definitions) this.register(definition);
  }
  register(definition: ActionDefinition): void {
    const key = actionKey(definition.id);
    if (this.actions.has(key))
      throw new ActionError(
        "duplicate_action",
        `action is already registered: ${key}`,
      );
    this.actions.set(key, new RegisteredAction(definition));
  }
  get(id: ActionId): RegisteredAction {
    const key = actionKey(id),
      registered = this.actions.get(key);
    if (!registered)
      throw new ActionError(
        "action_not_found",
        `action is not registered: ${key}`,
      );
    return registered;
  }
  *definitions(): IterableIterator<ActionDefinition> {
    const sorted = [...this.actions.values()].sort((a, b) =>
      a.definition.id.name < b.definition.id.name
        ? -1
        : a.definition.id.name > b.definition.id.name
          ? 1
          : semver.compare(a.definition.id.version, b.definition.id.version) ||
            a.definition.id.version.localeCompare(b.definition.id.version),
    );
    for (const action of sorted) yield action.definition;
  }
  *discoverableDefinitions(filter: {
    runtime: ProductRuntime;
    actor: ActorKind;
    lifecycle?: ActionLifecycle;
    grants: Set<string>;
  }): IterableIterator<ActionDefinition> {
    for (const definition of this.definitions())
      if (
        definition.supported_runtimes.includes(filter.runtime) &&
        definition.supported_actors.includes(filter.actor) &&
        (filter.lifecycle === undefined ||
          definition.lifecycle === filter.lifecycle) &&
        definition.required_grants.every((grant) => filter.grants.has(grant))
      )
        yield definition;
  }
  validateRequest(request: IncomingActionRequest): ValidatedActionRequest {
    return ValidatedActionRequest.from(request, this.get(request.action));
  }
  validateOutput(id: ActionId, output: unknown): void {
    this.get(id).validateOutput(output);
  }
}
export function builtInDefinitions(): ActionDefinition[] {
  return structuredClone(catalog) as unknown as ActionDefinition[];
}
export const initialDefinitions = (): ActionDefinition[] =>
  builtInDefinitions().slice(0, 3);
export const coreDefinitions = (): ActionDefinition[] =>
  builtInDefinitions().slice(3);
export const initialRegistry = (): ActionRegistry =>
  new ActionRegistry(initialDefinitions());
export const growthRegistry = (): ActionRegistry =>
  new ActionRegistry(builtInDefinitions());
