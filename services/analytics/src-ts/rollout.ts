import { RequestExtractionError } from "./error.js";
import { typedQuery } from "./query.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createClient } from "redis";
import type { PoolClient } from "pg";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AnalyticsContext } from "./context.js";
import type { AnalyticsConfig } from "./config.js";
import {
  IngestionAuthenticator,
  strictObject,
  dtoString,
  dtoI64,
  asI64,
  asObject,
  type AuthenticatedProducer,
} from "./ingestion.js";
import {
  canonicalJson,
  parseSerdeValueJson,
} from "@kasitek-labs/server-support/json";
import { normalizedTime, timestampNanos } from "./records.js";
import { transaction } from "./db.js";
import { SQL } from "./rollout-sql.js";
export const CONTROLS_PATH = "/internal/rollouts/v1/controls",
  EVALUATE_PATH = "/internal/rollouts/v1/evaluate",
  EXPIRE_PATH = "/internal/rollouts/v1/expire";
const AUDIT_CHAIN = "analytics.rollout_controls",
  POLICY = "analytics-rollout/v1";
const CONTROL_KEYS = [
  "publish",
  "ingest",
  "project",
  "report",
  "ui",
  "agent_read",
  "export",
  "alerts",
  "scheduled_reports",
];
const CUSTOMER_KEYS = [
  "report",
  "ui",
  "agent_read",
  "export",
  "alerts",
  "scheduled_reports",
];
export type RolloutControlKind = "rollout" | "kill_switch";
export type TargetKind =
  | "global"
  | "producer_service"
  | "domain"
  | "reporting_scope"
  | "percentage";
export interface RolloutTarget {
  kind: TargetKind;
  key: string;
}
export interface RolloutMutationRequest {
  control_key: string;
  control_kind: RolloutControlKind;
  target: RolloutTarget;
  enabled: boolean;
  percentage_basis_points: number | null;
  reason: string;
  issue_ref: string | null;
  expires_at: string | null;
  remove: boolean;
}
export interface EvaluationContext {
  source_service?: string | null;
  source_domain?: string | null;
  reporting_scope_id?: bigint | null;
  cohort_key?: string | null;
}
export interface RolloutDecision {
  control_key: string;
  control_kind: RolloutControlKind;
  registry_revision: bigint;
  allowed: boolean;
  defaulted: boolean;
  matched_target_kind?: TargetKind;
  matched_target_key?: string;
  revision?: bigint;
  expires_at?: string;
}
export interface StoredControl {
  control_id: bigint;
  control_key: string;
  control_kind: RolloutControlKind;
  target_kind: TargetKind;
  target_key: string;
  enabled: boolean;
  percentage_basis_points: number | null;
  revision: bigint;
  expires_at: string | null;
  removed_at: string | null;
}
export class RolloutError extends Error {
  constructor(
    public kind: "unauthorized" | "invalid_request" | "database",
    message: string,
  ) {
    super(message);
  }
}
const invalid = (text: string): never => {
  throw new RolloutError("invalid_request", text);
};
const asciiLower = (v: string) => v.replace(/[A-Z]/g, (c) => c.toLowerCase());
export function normalizeControlKey(v: string): string {
  v = asciiLower(v.trim());
  return CONTROL_KEYS.includes(v) ? v : invalid("unknown rollout control key");
}
const normalizeText = (v: string, field: string) => {
  v = asciiLower(v.trim());
  return v || invalid(`${field} cannot be empty`);
};
function kind(value: unknown): RolloutControlKind {
  return value === "rollout" || value === "kill_switch"
    ? value
    : invalid("stored rollout control has an invalid kind");
}
function targetKind(value: unknown): TargetKind {
  return [
    "global",
    "producer_service",
    "domain",
    "reporting_scope",
    "percentage",
  ].includes(String(value))
    ? (value as TargetKind)
    : invalid("stored rollout control has an invalid target");
}
function stored(row: Record<string, unknown>): StoredControl {
  return {
    control_id: BigInt(row.control_id as string),
    control_key: row.control_key as string,
    control_kind: kind(row.control_kind),
    target_kind: targetKind(row.target_kind),
    target_key: row.target_key as string,
    enabled: row.enabled as boolean,
    percentage_basis_points: row.percentage_basis_points as number | null,
    revision: BigInt(row.revision as string),
    expires_at:
      row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : (row.expires_at as string | null),
    removed_at:
      row.removed_at instanceof Date
        ? row.removed_at.toISOString()
        : (row.removed_at as string | null),
  };
}
function storedValue(v: StoredControl): unknown {
  return {
    control_id: v.control_id,
    control_key: v.control_key,
    control_kind: v.control_kind,
    target: { kind: v.target_kind, key: v.target_key },
    enabled: v.enabled,
    percentage_basis_points: v.percentage_basis_points,
    revision: v.revision,
    expires_at: v.expires_at,
    removed_at: v.removed_at,
  };
}
export function normalizeMutation(
  r: RolloutMutationRequest,
  now: string,
): RolloutMutationRequest {
  const control_key = normalizeControlKey(r.control_key);
  let key: string;
  switch (r.target.kind) {
    case "global":
      if (r.target.key.trim() !== "global")
        invalid("global targets must use the global key");
      key = "global";
      break;
    case "producer_service":
      key = normalizeText(r.target.key, "producer service");
      break;
    case "domain":
      key = normalizeText(r.target.key, "domain");
      break;
    case "reporting_scope": {
      const raw = r.target.key.trim();
      if (
        !/^[+]?\d+$/.test(raw) ||
        BigInt(raw) <= 0n ||
        BigInt(raw) > (1n << 63n) - 1n
      )
        invalid("reporting scope targets require a positive numeric key");
      key = BigInt(raw).toString();
      break;
    }
    case "percentage":
      key = normalizeText(r.target.key, "percentage cohort");
      break;
  }
  if (r.control_kind === "kill_switch" && r.target.kind === "percentage")
    invalid("kill switches cannot target percentage cohorts");
  if (r.target.kind === "percentage") {
    if (
      r.percentage_basis_points === null ||
      r.percentage_basis_points < 0 ||
      r.percentage_basis_points > 10000
    )
      invalid("percentage targets require 0 through 10000 basis points");
  } else if (r.percentage_basis_points !== null)
    invalid("percentage basis points require a percentage target");
  const reason = r.reason.trim();
  if (!reason) invalid("rollout changes require a reason");
  if (
    r.expires_at !== null &&
    timestampNanos(r.expires_at) <= timestampNanos(now)
  )
    invalid("rollout expiry must be in the future");
  return {
    control_key,
    control_kind: r.control_kind,
    target: { kind: r.target.kind, key },
    enabled: r.enabled,
    percentage_basis_points: r.percentage_basis_points,
    reason,
    issue_ref: r.issue_ref?.trim() || null,
    expires_at: r.expires_at,
    remove: r.remove,
  };
}
function normalizedContext(c: EvaluationContext): EvaluationContext {
  const text = (v: string | null | undefined) =>
    v?.trim() ? asciiLower(v.trim()) : null;
  return {
    source_service: text(c.source_service),
    source_domain: text(c.source_domain),
    reporting_scope_id:
      c.reporting_scope_id != null && c.reporting_scope_id > 0n
        ? c.reporting_scope_id
        : null,
    cohort_key: text(c.cohort_key),
  };
}
export function stableCohortEnabled(
  control: string,
  target: string,
  cohort: string,
  basis: number,
): boolean {
  return (
    createHash("sha256")
      .update(`${control}\0${target}\0${cohort}`)
      .digest()
      .readUInt16BE(0) %
      10000 <
    basis
  );
}
export function evaluateCandidates(
  control_key: string,
  control_kind: RolloutControlKind,
  input: EvaluationContext,
  candidates: StoredControl[],
): RolloutDecision {
  const c = normalizedContext(input);
  let selected: StoredControl | undefined,
    rank = -1;
  for (const row of candidates) {
    if (row.removed_at !== null) continue;
    let next = -1;
    switch (row.target_kind) {
      case "global":
        if (row.target_key === "global") next = 10;
        break;
      case "producer_service":
        if (c.source_service === row.target_key) next = 30;
        break;
      case "domain":
        if (c.source_domain === row.target_key) next = 40;
        break;
      case "reporting_scope":
        if (c.reporting_scope_id?.toString() === row.target_key) next = 50;
        break;
      case "percentage":
        if (
          c.cohort_key &&
          stableCohortEnabled(
            control_key,
            row.target_key,
            c.cohort_key,
            row.percentage_basis_points ?? 0,
          )
        )
          next = 20;
        break;
    }
    if (
      next >= 0 &&
      (next > rank ||
        (next === rank && (!selected || row.revision >= selected.revision)))
    ) {
      rank = next;
      selected = row;
    }
  }
  if (!selected)
    return {
      control_key,
      control_kind,
      registry_revision: 0n,
      allowed:
        control_kind === "kill_switch" || !CUSTOMER_KEYS.includes(control_key),
      defaulted: true,
    };
  return {
    control_key,
    control_kind,
    registry_revision: 0n,
    allowed: control_kind === "rollout" ? selected.enabled : !selected.enabled,
    defaulted: false,
    matched_target_kind: selected.target_kind,
    matched_target_key: selected.target_key,
    revision: selected.revision,
    ...(selected.expires_at !== null
      ? { expires_at: selected.expires_at }
      : {}),
  };
}
async function currentRevision(tx: PoolClient): Promise<bigint> {
  const row = (await tx.query(SQL.current_registry_revision)).rows[0];
  if (!row) throw Error("registry not ready");
  return BigInt(row.revision);
}
async function bumpRevision(tx: PoolClient): Promise<bigint> {
  return BigInt((await tx.query(SQL.bump_registry_revision)).rows[0]!.revision);
}
export async function evaluateTransaction(
  tx: PoolClient,
  control: string,
  type: RolloutControlKind,
  c: EvaluationContext,
  now: string | Date,
): Promise<RolloutDecision> {
  control = normalizeControlKey(control);
  const revision = await currentRevision(tx),
    rows = (
      await tx.query(SQL.evaluate_transaction, [
        control,
        type,
        now instanceof Date ? now.toISOString() : now,
      ])
    ).rows.map(stored),
    decision = evaluateCandidates(control, type, c, rows);
  decision.registry_revision = revision;
  return decision;
}
function orderedJson(value: Record<string, unknown>): string {
  return (
    "{" +
    Object.entries(value)
      .map(([key, val]) => JSON.stringify(key) + ":" + canonicalJson(val))
      .join(",") +
    "}"
  );
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
async function appendAudit(
  tx: PoolClient,
  a: AuthenticatedProducer,
  scope: bigint | null,
  operation: string,
  request_hash: string,
  correlation_id: string | null,
  safe_metadata: unknown,
  now: string,
): Promise<void> {
  await tx.query(SQL.append_rollout_audit, [AUDIT_CHAIN]);
  const previous =
      (await tx.query(SQL.append_rollout_audit_2, [AUDIT_CHAIN])).rows[0]
        ?.record_hash ?? null,
    principal = `${a.source_service}:${a.producer_id}`;
  const record_hash = hash(
    canonicalJson({
      chain_name: AUDIT_CHAIN,
      previous_record_hash: previous,
      principal_type: "service",
      principal_id: principal,
      reporting_scope_id: scope,
      permission: null,
      operation,
      metric_keys: [],
      request_hash,
      filter_hash: null,
      outcome: "accepted",
      correlation_id,
      policy_version: POLICY,
      safe_metadata,
      occurred_at: now,
      created_at: now,
    }),
  );
  await tx.query(SQL.append_rollout_audit_3, [
    AUDIT_CHAIN,
    previous,
    record_hash,
    principal,
    scope,
    operation,
    request_hash,
    correlation_id,
    POLICY,
    canonicalJson(safe_metadata),
    now,
    now,
  ]);
}
export async function upsertTransaction(
  tx: PoolClient,
  a: AuthenticatedProducer,
  request: RolloutMutationRequest,
  now: string | Date,
  correlation_id: string | null = null,
): Promise<unknown> {
  const time = now instanceof Date ? now.toISOString() : now,
    n = normalizeMutation(request, time);
  const row = (
      await tx.query(SQL.upsert_transaction, [
        n.control_key,
        n.control_kind,
        n.target.kind,
        n.target.key,
      ])
    ).rows[0],
    previous = row ? stored(row) : null,
    revision = previous ? previous.revision + 1n : 1n,
    removed_at = n.remove ? time : null,
    enabled = n.enabled && !n.remove;
  const control_id = BigInt(
    (
      await tx.query(
        previous ? SQL.upsert_transaction_2 : SQL.upsert_transaction_3,
        previous
          ? [
              enabled,
              n.percentage_basis_points,
              revision,
              a.producer_id,
              n.reason,
              n.issue_ref,
              n.expires_at,
              removed_at,
              n.control_key,
              n.control_kind,
              n.target.kind,
              n.target.key,
            ]
          : [
              n.control_key,
              n.control_kind,
              n.target.kind,
              n.target.key,
              enabled,
              n.percentage_basis_points,
              revision,
              a.producer_id,
              n.reason,
              n.issue_ref,
              n.expires_at,
              removed_at,
            ],
      )
    ).rows[0]!.control_id,
  );
  const registry_revision = await bumpRevision(tx);
  const metadata = {
    source_service: a.source_service,
    control_id,
    registry_revision,
    control_key: n.control_key,
    control_kind: n.control_kind,
    target: n.target,
    enabled,
    remove: n.remove,
    percentage_basis_points: n.percentage_basis_points,
    revision,
    reason: n.reason,
    issue_ref: n.issue_ref,
    expires_at: n.expires_at,
    removed_at,
    previous_value: previous ? storedValue(previous) : null,
  };
  // The normalized DTO is a Rust struct: nested RolloutTarget also uses declaration order.
  const request_hash = hash(
    "{" +
      Object.entries(n)
        .map(
          ([key, value]) =>
            JSON.stringify(key) +
            ":" +
            (key === "target"
              ? orderedJson(value as unknown as Record<string, unknown>)
              : canonicalJson(value)),
        )
        .join(",") +
      "}",
  );
  await appendAudit(
    tx,
    a,
    n.target.kind === "reporting_scope" ? BigInt(n.target.key) : null,
    "rollout_control.upsert",
    request_hash,
    correlation_id,
    metadata,
    time,
  );
  return {
    control_id,
    control_key: n.control_key,
    control_kind: n.control_kind,
    target: n.target,
    enabled,
    removed: n.remove,
    revision,
    registry_revision,
    ...(n.expires_at !== null ? { expires_at: n.expires_at } : {}),
  };
}
export async function closeExpiredTransaction(
  tx: PoolClient,
  a: AuthenticatedProducer,
  now: string | Date,
  correlation_id: string | null = null,
): Promise<{ closed_count: bigint; registry_revision?: bigint }> {
  const time = now instanceof Date ? now.toISOString() : now,
    rows = (await tx.query(SQL.close_expired_transaction, [time])).rows.map(
      stored,
    );
  let closed_count = 0n,
    registry_revision: bigint | undefined;
  for (const c of rows) {
    await tx.query(SQL.close_expired_transaction_2, [
      a.producer_id,
      time,
      c.control_id,
    ]);
    registry_revision = await bumpRevision(tx);
    const metadata = {
      source_service: a.source_service,
      control_id: c.control_id,
      registry_revision,
      control_key: c.control_key,
      control_kind: c.control_kind,
      target: { kind: c.target_kind, key: c.target_key },
      enabled: false,
      remove: true,
      reason: "expired automatically",
      expires_at: c.expires_at,
      removed_at: time,
      previous_value: storedValue(c),
    };
    const request_hash = hash(
      canonicalJson({
        operation: "rollout_control.expire",
        control_id: c.control_id,
        removed_at: time,
      }),
    );
    await appendAudit(
      tx,
      a,
      c.target_kind === "reporting_scope" ? BigInt(c.target_key) : null,
      "rollout_control.expire",
      request_hash,
      correlation_id,
      metadata,
      time,
    );
    closed_count++;
  }
  return {
    closed_count,
    ...(registry_revision !== undefined ? { registry_revision } : {}),
  };
}
export interface DecisionCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
  close?(): Promise<void>;
}
class RedisDecisionCacheBackend implements DecisionCacheBackend {
  private client: ReturnType<typeof createClient> | undefined;
  private connecting: Promise<void> | undefined;
  constructor(private url: string) {}
  private async connection() {
    if (!this.client) {
      const client = createClient({
        url: this.url,
        socket: { connectTimeout: 150, reconnectStrategy: false },
      });
      client.on("error", () => {});
      this.client = client;
      this.connecting = client.connect().then(() => undefined);
    }
    if (this.connecting) await this.connecting;
    return this.client!;
  }
  private async operation<T>(run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("rollout cache unavailable")),
            150,
          );
        }),
      ]);
    } catch (error) {
      if (this.client?.isOpen) this.client.destroy();
      this.client = undefined;
      this.connecting = undefined;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  get(key: string): Promise<string | null> {
    return this.operation(async () => await (await this.connection()).get(key));
  }
  async set(key: string, value: string, ttl: number): Promise<void> {
    await this.operation(async () => {
      await (await this.connection()).setEx(key, ttl, value);
    });
  }
  async close(): Promise<void> {
    if (this.client?.isOpen) this.client.destroy();
    this.client = undefined;
    this.connecting = undefined;
  }
}
export function decisionCacheKey(
  control_key: string,
  control_kind: RolloutControlKind,
  context: EvaluationContext,
  registry_revision: bigint,
): string {
  const c = {
    source_service: context.source_service ?? null,
    source_domain: context.source_domain ?? null,
    reporting_scope_id: context.reporting_scope_id ?? null,
    cohort_key: context.cohort_key ?? null,
  };
  const payload = `{"schema_version":1,"registry_revision":${registry_revision},"control_key":${canonicalJson(control_key)},"control_kind":${canonicalJson(control_kind)},"context":${orderedJson(c)}}`;
  return `kasitek:analytics:rollout:v1:${hash(payload)}`;
}
export type DecisionCacheRead =
  | { kind: "disabled" | "miss" | "stale" | "unavailable" }
  | { kind: "hit"; decision: RolloutDecision };
export class RolloutDecisionCache {
  constructor(
    private backend: DecisionCacheBackend | null = null,
    private ttl = 15,
  ) {}
  static fromConfig(
    config: Pick<AnalyticsConfig, "redis_url">,
  ): RolloutDecisionCache {
    if (!config.redis_url?.trim()) return new RolloutDecisionCache();
    try {
      const url = new URL(config.redis_url);
      if (!["redis:", "rediss:"].includes(url.protocol))
        return new RolloutDecisionCache();
      return new RolloutDecisionCache(
        new RedisDecisionCacheBackend(config.redis_url),
      );
    } catch {
      return new RolloutDecisionCache();
    }
  }
  async read(key: string, now: string): Promise<DecisionCacheRead> {
    if (!this.backend) return { kind: "disabled" };
    try {
      const raw = await this.backend.get(key);
      if (raw === null) return { kind: "miss" };
      const parsed = asObject(parseSerdeValueJson(raw)),
        cached = normalizedTime(parsed?.cached_at),
        d = asObject(parsed?.decision);
      if (
        !cached ||
        !d ||
        typeof d.control_key !== "string" ||
        !["rollout", "kill_switch"].includes(String(d.control_kind)) ||
        typeof d.allowed !== "boolean" ||
        typeof d.defaulted !== "boolean" ||
        asI64(d.registry_revision) === null
      )
        return { kind: "unavailable" };
      const revision = d.revision == null ? undefined : asI64(d.revision);
      if (revision === null) return { kind: "unavailable" };
      const expires =
        d.expires_at == null ? undefined : normalizedTime(d.expires_at);
      if (expires === null) return { kind: "unavailable" };
      if (
        d.matched_target_kind != null &&
        ![
          "global",
          "producer_service",
          "domain",
          "reporting_scope",
          "percentage",
        ].includes(String(d.matched_target_kind))
      )
        return { kind: "unavailable" };
      if (
        d.matched_target_key != null &&
        typeof d.matched_target_key !== "string"
      )
        return { kind: "unavailable" };
      const decision = {
        control_key: d.control_key,
        control_kind: d.control_kind,
        allowed: d.allowed,
        defaulted: d.defaulted,
        ...(d.matched_target_kind != null
          ? { matched_target_kind: d.matched_target_kind }
          : {}),
        ...(d.matched_target_key != null
          ? { matched_target_key: d.matched_target_key }
          : {}),
        registry_revision: asI64(d.registry_revision)!,
        ...(revision !== undefined ? { revision } : {}),
        ...(expires !== undefined ? { expires_at: expires } : {}),
      } as unknown as RolloutDecision;
      if (
        timestampNanos(cached) + BigInt(this.ttl) * 1000000000n <=
          timestampNanos(now) ||
        (expires !== undefined &&
          timestampNanos(expires) <= timestampNanos(now))
      )
        return { kind: "stale" };
      return { kind: "hit", decision };
    } catch {
      return { kind: "unavailable" };
    }
  }
  async write(key: string, d: RolloutDecision, now: string): Promise<void> {
    if (!this.backend) return;
    const remaining = d.expires_at
        ? Number(
            (timestampNanos(d.expires_at) - timestampNanos(now)) / 1000000000n,
          )
        : this.ttl,
      ttl = Math.min(this.ttl, Math.max(0, remaining));
    if (ttl === 0) return;
    try {
      await this.backend.set(
        key,
        canonicalJson({ cached_at: now, decision: d }),
        ttl,
      );
    } catch {
      /* Database evaluation remains authoritative during a cache outage. */
    }
  }
  async close(): Promise<void> {
    await this.backend?.close?.();
  }
}
function dtoBoolean(
  v: Record<string, unknown>,
  key: string,
  fallback?: boolean,
): boolean {
  if (v[key] === undefined && fallback !== undefined) return fallback;
  if (typeof v[key] !== "boolean") throw new RequestExtractionError("json");
  return v[key];
}
export function parseRolloutMutation(value: unknown): RolloutMutationRequest {
  const body = strictObject(value, [
      "control_key",
      "control_kind",
      "target",
      "enabled",
      "percentage_basis_points",
      "reason",
      "issue_ref",
      "expires_at",
      "remove",
    ]),
    target = strictObject(body.target, ["kind", "key"]);
  const type = body.control_kind === undefined ? "rollout" : body.control_kind;
  if (type !== "rollout" && type !== "kill_switch")
    throw new RequestExtractionError("json");
  if (
    ![
      "global",
      "producer_service",
      "domain",
      "reporting_scope",
      "percentage",
    ].includes(String(target.kind))
  )
    throw new RequestExtractionError("json");
  const percentage = dtoI64(body, "percentage_basis_points", true);
  if (
    percentage !== null &&
    (percentage < -2147483648n || percentage > 2147483647n)
  )
    throw new RequestExtractionError("json");
  const expires =
    body.expires_at == null ? null : normalizedTime(body.expires_at);
  if (expires === null && body.expires_at != null)
    throw new RequestExtractionError("json");
  return {
    control_key: dtoString(body, "control_key")!,
    control_kind: type,
    target: { kind: target.kind as TargetKind, key: dtoString(target, "key")! },
    enabled: dtoBoolean(body, "enabled"),
    percentage_basis_points: percentage === null ? null : Number(percentage),
    reason: body.reason === undefined ? "" : dtoString(body, "reason")!,
    issue_ref: dtoString(body, "issue_ref", true),
    expires_at: expires,
    remove: dtoBoolean(body, "remove", false),
  };
}
function parseEvaluationQuery(rawUrl: string | undefined): {
  control_key: string;
  control_kind: RolloutControlKind;
  context: EvaluationContext;
} {
  const query = typedQuery(
      rawUrl,
      [
        "control_key",
        "control_kind",
        "source_service",
        "source_domain",
        "reporting_scope_id",
        "cohort_key",
      ],
      {
        required: ["control_key"],
        signedIntegers: ["reporting_scope_id"],
        enumValues: { control_kind: ["rollout", "kill_switch"] },
        denyUnknown: true,
      },
    ),
    control_key = query.control_key as string,
    raw = (query.control_kind as string | undefined) ?? "rollout";
  return {
    control_key,
    control_kind: raw as RolloutControlKind,
    context: {
      source_service: (query.source_service as string | undefined) ?? null,
      source_domain: (query.source_domain as string | undefined) ?? null,
      reporting_scope_id:
        (query.reporting_scope_id as bigint | undefined) ?? null,
      cohort_key: (query.cohort_key as string | undefined) ?? null,
    },
  };
}
export function registerRolloutRoutes(
  app: FastifyInstance,
  context: AnalyticsContext,
): void {
  const auth = new IngestionAuthenticator(context.config.ingestion_credentials),
    allowed = new Set(context.config.rollout_admin_producers),
    cache = RolloutDecisionCache.fromConfig(context.config);
  app.addHook("onClose", async () => {
    await cache.close();
  });
  const actor = (request: FastifyRequest) => {
    try {
      const a = auth.authenticate(request);
      if (!allowed.has(a.producer_id)) throw Error();
      return a;
    } catch {
      throw new RolloutError("unauthorized", "rollout authentication failed");
    }
  };
  const correlation = (request: FastifyRequest) => {
    const raw = request.headers["x-correlation-id"];
    return typeof raw === "string" &&
      raw.trim() &&
      Buffer.byteLength(raw.trim()) <= 512
      ? raw.trim()
      : null;
  };
  const respond = (error: unknown, reply: FastifyReply) => {
    if (error instanceof RolloutError) {
      if (error.kind === "unauthorized")
        return reply
          .code(401)
          .header("www-authenticate", "Bearer")
          .send({ error: "unauthorized" });
      if (error.kind === "invalid_request")
        return reply
          .code(422)
          .send({ error: "invalid_request", message: error.message });
    }
    context.metrics?.log("error", "dependency.unavailable", {
      process: "analytics-api",
      dependency: "postgres",
      operation: "rollout",
      error_type:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return reply.code(503).send({ error: "analytics_unavailable" });
  };
  app.post(CONTROLS_PATH, async (request, reply) => {
    const body = parseRolloutMutation(request.body);
    try {
      const a = actor(request);
      return await transaction(context.pool, (tx) =>
        upsertTransaction(
          tx,
          a,
          body,
          new Date().toISOString(),
          correlation(request),
        ),
      );
    } catch (error) {
      return respond(error, reply);
    }
  });
  app.post(
    EXPIRE_PATH,
    {
      // Rust has no JSON/body extractor for this operation. Drain and discard
      // any supplied payload instead of buffering it under the global JSON cap.
      bodyLimit: Number.MAX_SAFE_INTEGER,
      async preParsing(_request, _reply, payload) {
        let receivedEncodedLength = 0;
        for await (const chunk of payload) {
          receivedEncodedLength +=
            typeof chunk === "string"
              ? Buffer.byteLength(chunk)
              : chunk.length;
        }
        return Object.assign(Readable.from([]), { receivedEncodedLength });
      },
    },
    async (request, reply) => {
      try {
        const a = actor(request),
          response = await transaction(context.pool, (tx) =>
            closeExpiredTransaction(
              tx,
              a,
              new Date().toISOString(),
              correlation(request),
            ),
          );
        context.metrics?.recordExpiredControlsClosed(response.closed_count);
        return response;
      } catch (error) {
        return respond(error, reply);
      }
    },
  );
  app.get(EVALUATE_PATH, async (request, reply) => {
    const q = parseEvaluationQuery(request.raw.url);
    try {
      actor(request);
      const control = normalizeControlKey(q.control_key),
        now = new Date().toISOString();
      let key = "",
        cacheHit = false,
        decision: RolloutDecision;
      decision = await transaction(context.pool, async (tx) => {
        const revision = await currentRevision(tx);
        key = decisionCacheKey(control, q.control_kind, q.context, revision);
        const read = await cache.read(key, now);
        if (
          read.kind === "hit" &&
          read.decision.registry_revision === revision
        ) {
          cacheHit = true;
          context.metrics?.recordRolloutCache("hit");
          context.metrics?.recordRolloutEvaluation(
            read.decision.allowed,
            read.decision.defaulted,
          );
          return read.decision;
        }
        context.metrics?.recordRolloutCache(
          read.kind === "hit" ? "stale" : read.kind,
        );
        const d = await evaluateTransaction(
          tx,
          control,
          q.control_kind,
          q.context,
          now,
        );
        context.metrics?.recordRolloutEvaluation(d.allowed, d.defaulted);
        return d;
      });
      if (!cacheHit) await cache.write(key, decision, now);
      return decision;
    } catch (error) {
      return respond(error, reply);
    }
  });
}
