import { createHash } from 'node:crypto';
import { compactVerify, decodeProtectedHeader, importSPKI } from 'jose';
import { createClient } from 'redis';
import type pg from 'pg';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AnalyticsContext } from './context.js';
import type { AnalyticsConfig } from './config.js';
import type {
  RegistrySnapshot,
  MetricDefinition,
  MetricSetDefinition,
} from './registry-types.js';
import { apiJson, parseSerdeValueJson } from './json.js';
import { typedQuery } from './query.js';
import { SerdeFloat, canonicalJson } from '@kasitek-labs/server-support/json';
import { UtcTimestamp, transaction } from './db.js';
import { type ReportingGrant, validateGrant } from './scope.js';
import {
  AuthorizationContextError,
  setAuthorizationContext,
} from './authorization.js';
import {
  DEFAULT_SHARD_KEY,
  PROJECTION_NAME,
  PROJECTION_VERSION,
} from './projections.js';
import * as sql from './reporting-sql.js';

export const CATALOG_PATH = '/v1/metrics/catalog',
  QUERY_PATH = '/v1/reports/query';
export const REPORTING_PERMISSION = 'analytics:read',
  DESCENDANT_PERMISSION = 'analytics:compare_children';
export const MAX_METRICS = 25,
  MAX_BREAKDOWNS = 2,
  MAX_POINTS = 2000,
  MAX_FILTER_VALUES = 100,
  MAX_AUTHORIZED_SCOPES = 100,
  MAX_RANGE_DAYS = 366;
const REPORT_CACHE_TTL_SECONDS = 30;
const utf8Compare = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
const sortedStrings = (values: Iterable<string>) =>
  [...values].sort(utf8Compare);
const I64_MIN = -(1n << 63n),
  I64_MAX = (1n << 63n) - 1n;
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof SerdeFloat);
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
function signedId(value: unknown): bigint {
  if (
    typeof value !== 'bigint' &&
    (typeof value !== 'number' || !Number.isSafeInteger(value))
  )
    throw Error('expected i64');
  const id = BigInt(value);
  if (id < I64_MIN || id > I64_MAX) throw Error('expected i64');
  return id;
}
function typedString(value: unknown): string {
  if (typeof value !== 'string') throw Error('expected string');
  return value;
}
function typedStrings(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!stringArray(value)) throw Error('expected string array');
  return value;
}
function optionalString(value: unknown): string | null {
  return value == null ? null : typedString(value);
}
function typedDate(value: unknown): Date {
  const raw = typedString(value);
  // chrono accepts a space separator and compact offsets in addition to RFC3339.
  const match =
    /^([+-]?\d{4,6})\s*-([0-9]{1,2})\s*-([0-9]{1,2})[Tt ]([0-9]{1,2})\s*:([0-9]{1,2})\s*:([0-9]{1,2})(\.\d+)?\s*(Z|UTC|[+-]\d{2}:?\d{2})$/i.exec(
      raw,
    );
  if (!match) throw Error('expected RFC3339 timestamp');
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    throw Error('invalid calendar timestamp');
  const offset =
    match[8]!.toUpperCase() === 'UTC' ? 'Z' : match[8]!.toUpperCase();
  const normalized = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}T${match[4]!.padStart(2, '0')}:${match[5]!.padStart(2, '0')}:${match[6]!.padStart(2, '0')}${match[7] ?? ''}${offset}`;
  return new UtcTimestamp(normalized, true);
}
function timestampNanos(date: Date): bigint {
  const fraction = (date.toISOString().match(/\.(\d+)/)?.[1] ?? '')
    .padEnd(9, '0')
    .slice(0, 9);
  return (
    BigInt(Math.floor(date.getTime() / 1000)) * 1000000000n +
    BigInt(fraction || '0')
  );
}
function dateFromNanos(value: bigint): Date {
  let seconds = value / 1000000000n,
    fraction = value % 1000000000n;
  if (fraction < 0n) {
    seconds--;
    fraction += 1000000000n;
  }
  const prefix = new Date(Number(seconds) * 1000)
    .toISOString()
    .replace(/\.000Z$/, '');
  return new UtcTimestamp(
    `${prefix}.${fraction.toString().padStart(9, '0')}Z`,
    true,
  );
}

function seconds(value: unknown): Date {
  // jwt-simple's serde visitor casts f64 to unsigned seconds (fraction truncation).
  if (value instanceof SerdeFloat) value = Math.trunc(Math.max(0, value.value));
  if (
    typeof value !== 'bigint' &&
    (typeof value !== 'number' || !Number.isSafeInteger(value))
  )
    throw Error('expected NumericDate');
  const integer = BigInt(value);
  if (integer < 0n || integer > 18446744073709551615n)
    throw Error('expected NumericDate');
  const date = new Date(Number(integer) * 1000);
  if (!Number.isFinite(date.getTime())) throw Error('invalid timestamp');
  return date;
}

export class ReportingError extends Error {
  constructor(
    public readonly kind:
      'unauthorized' | 'forbidden' | 'invalid_request' | 'unavailable',
    message?: string,
  ) {
    super(
      message ??
        (kind === 'unauthorized'
          ? 'reporting authorization failed'
          : 'reporting scope is not authorized'),
    );
  }
}
const unauthorized = () => new ReportingError('unauthorized'),
  forbidden = () => new ReportingError('forbidden'),
  invalid = (message: string) => new ReportingError('invalid_request', message);

export class ReportingAuthenticator {
  private constructor(
    private readonly legacy: Awaited<ReturnType<typeof importSPKI>> | null,
    private readonly keys: Map<string, Awaited<ReturnType<typeof importSPKI>>>,
    private readonly issuers: Set<string>,
    public readonly audience: string,
  ) {}
  static async fromConfig(
    config: AnalyticsConfig,
  ): Promise<ReportingAuthenticator> {
    let legacy: Awaited<ReturnType<typeof importSPKI>> | null = null;
    if (config.reporting_public_key !== null) {
      try {
        legacy = await importSPKI(config.reporting_public_key, 'ES256');
      } catch (error) {
        throw Error(
          `invalid ANALYTICS_REPORTING_PUBLIC_KEY: ${error instanceof Error ? error.message : 'invalid public key'}`,
        );
      }
    }
    const keys = new Map<string, Awaited<ReturnType<typeof importSPKI>>>();
    if (config.reporting_public_keys_json !== null) {
      let values: unknown;
      try {
        values = JSON.parse(config.reporting_public_keys_json);
        if (
          !plainObject(values) ||
          Object.values(values).some((value) => typeof value !== 'string')
        )
          throw Error('expected map of string public keys');
      } catch (error) {
        throw Error(
          `invalid ANALYTICS_REPORTING_PUBLIC_KEYS_JSON: ${error instanceof Error ? error.message : 'invalid configuration'}`,
        );
      }
      if (!plainObject(values) || Object.keys(values).length === 0)
        throw Error('ANALYTICS_REPORTING_PUBLIC_KEYS_JSON must contain a key');
      for (const id of Object.keys(values).sort()) {
        if (!id.trim()) throw Error('reporting public key ids cannot be empty');
        try {
          keys.set(id, await importSPKI(values[id] as string, 'ES256'));
        } catch (error) {
          throw Error(
            `invalid reporting key ${id}: ${error instanceof Error ? error.message : 'invalid key'}`,
          );
        }
      }
    }
    return new ReportingAuthenticator(
      legacy,
      keys,
      new Set(config.reporting_issuers),
      config.reporting_audience,
    );
  }
  async authenticate(
    request: Pick<FastifyRequest, 'headers'>,
  ): Promise<ReportingGrant> {
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ') ||
      !authorization.slice(7).trim()
    )
      throw unauthorized();
    return this.authenticateToken(authorization.slice(7));
  }
  async authenticateToken(
    token: string,
    now: Date = new Date(),
  ): Promise<ReportingGrant> {
    try {
      const metadata = decodeProtectedHeader(token);
      if (metadata.alg !== 'ES256') throw Error();
      const key =
        metadata.kid == null ? this.legacy : this.keys.get(metadata.kid);
      if (!key) throw Error();
      const verified = await compactVerify(token, key, {
        algorithms: ['ES256'],
      });
      const claims = parseSerdeValueJson(
        new TextDecoder('utf-8', { fatal: true }).decode(verified.payload),
      );
      if (!plainObject(claims)) throw Error();
      const issued_at = seconds(claims.iat),
        expires_at = seconds(claims.exp),
        not_before = claims.nbf === undefined ? issued_at : seconds(claims.nbf);
      const issuer = typedString(claims.iss),
        principal_id = typedString(claims.sub),
        grant_id = typedString(claims.jti);
      if (!this.issuers.has(issuer)) throw Error();
      const audiences =
        typeof claims.aud === 'string'
          ? [claims.aud]
          : typedStrings(claims.aud);
      if (!audiences.includes(this.audience)) throw Error();
      if (
        issued_at.getTime() > now.getTime() + 5000 ||
        now.getTime() - issued_at.getTime() > 120000
      )
        throw Error();
      const principal_type = typedString(claims.principal_type),
        descendant_mode = typedString(claims.descendant_mode);
      if (
        !['user', 'service_identity', 'agent_installation'].includes(
          principal_type,
        ) ||
        !['none', 'all', 'explicit'].includes(descendant_mode)
      )
        throw Error();
      const explicit =
        claims.explicit_descendant_scope_ids === undefined
          ? []
          : claims.explicit_descendant_scope_ids;
      if (!Array.isArray(explicit)) throw Error();
      const grant: ReportingGrant = {
        grant_id,
        issuer,
        audience: this.audience,
        principal_type: principal_type as ReportingGrant['principal_type'],
        principal_id,
        scope_id: signedId(claims.scope_id),
        root_scope_id: signedId(claims.root_scope_id),
        descendant_mode: descendant_mode as ReportingGrant['descendant_mode'],
        explicit_descendant_scope_ids: explicit.map(signedId),
        permissions: new Set(typedStrings(claims.permissions)),
        metric_keys: typedStrings(claims.metric_keys),
        dimension_keys: typedStrings(claims.dimension_keys),
        policy_version: typedString(claims.policy_version),
        issued_at,
        not_before,
        expires_at,
        correlation_id: optionalString(claims.correlation_id),
        revoked_at: null,
      };
      validateGrant(grant, this.audience, now);
      return grant;
    } catch {
      throw unauthorized();
    }
  }
}

export interface ReportQueryRequest {
  reporting_scope_id: bigint;
  range_start: Date;
  range_end: Date;
  timezone: string;
  interval: string | null;
  metrics: string[];
  metric_set: string | null;
  breakdowns: string[];
  filters: Record<string, string[]>;
  include_descendants: boolean;
  comparison: { kind: string } | null;
}
export interface AuthorizedScope {
  requested_scope_id: bigint;
  authorized_scope_ids: bigint[];
  scope_kind: string;
  timezone: string;
}
export interface GenerationInfo {
  generation_id: bigint;
  projection_version: string;
  registry_sha256: string;
  processing_status: string;
}
export interface ReportPoint {
  bucket_start: Date;
  bucket_end: Date;
  dimensions: unknown;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}
export interface CoverageAvailability {
  state: string;
  reason: string | null;
  evidence_layer: string | null;
  window_start: Date | null;
  window_end: Date | null;
  complete_through: Date | null;
  observed_at: Date | null;
}
interface SourceAvailability {
  state: string;
  reason: string | null;
  latest_timestamp: Date | null;
}
export interface MetricResult {
  key: string;
  version: number;
  unit: string;
  value_type: string;
  exactness: string;
  availability: { state: string; reason: string | null };
  coverage: {
    state: string;
    included_points: number;
    expected_points: number | null;
    evidence_layer: string | null;
    window_start: Date | null;
    window_end: Date | null;
    complete_through: Date | null;
    projection_state: string;
    projection_source_state: string;
    required_sources: string[];
    dimension_state: string;
    missing_dimension_points: number;
  };
  freshness: {
    state: string;
    latest_source_timestamp: Date | null;
    max_age_seconds: number | bigint;
  };
  warnings: string[];
  series: ReportPoint[];
}
export interface ReportResponse {
  scope_id: bigint;
  scope_kind: string;
  range_start: Date;
  range_end: Date;
  interval: string;
  timezone: string;
  generated_at: Date;
  data_as_of: Date | null;
  generation_id: bigint | null;
  projection_version: string;
  registry_sha256: string;
  metrics: MetricResult[];
  comparison: {
    kind: string;
    range_start: Date;
    range_end: Date;
    metrics: { key: string; version: number; series: ReportPoint[] }[];
  } | null;
}
export function decodeReportRequest(value: unknown): ReportQueryRequest {
  if (!plainObject(value)) throw Error('expected report request');
  const allowed = [
    'reporting_scope_id',
    'range_start',
    'range_end',
    'timezone',
    'interval',
    'metrics',
    'metric_set',
    'breakdowns',
    'filters',
    'include_descendants',
    'comparison',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error('unknown field');
  const filters = value.filters === undefined ? {} : value.filters;
  if (
    !plainObject(filters) ||
    Object.values(filters).some((item) => !stringArray(item))
  )
    throw Error('expected filters');
  let comparison: null | { kind: string } = null;
  if (value.comparison != null) {
    if (
      !plainObject(value.comparison) ||
      Object.keys(value.comparison).some((key) => key !== 'kind')
    )
      throw Error('invalid comparison');
    comparison = { kind: typedString(value.comparison.kind) };
  }
  if (
    value.include_descendants !== undefined &&
    typeof value.include_descendants !== 'boolean'
  )
    throw Error('expected boolean');
  return {
    reporting_scope_id: signedId(value.reporting_scope_id),
    range_start: typedDate(value.range_start),
    range_end: typedDate(value.range_end),
    timezone: typedString(value.timezone),
    interval: optionalString(value.interval),
    metrics: typedStrings(value.metrics),
    metric_set: optionalString(value.metric_set),
    breakdowns: typedStrings(value.breakdowns),
    filters: Object.fromEntries(
      Object.keys(filters)
        .sort()
        .map((key) => [key, filters[key]]),
    ) as Record<string, string[]>,
    include_descendants: value.include_descendants ?? false,
    comparison,
  };
}

async function authorizationContext(
  tx: pg.PoolClient,
  ids: bigint[],
  grant: string,
): Promise<void> {
  try {
    await setAuthorizationContext(tx, ids, grant);
  } catch (error) {
    if (error instanceof AuthorizationContextError)
      throw invalid(error.message);
    throw error;
  }
}
const equalJson = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);
export async function authorizeTransaction(
  tx: pg.PoolClient,
  grant: ReportingGrant,
  requested: bigint,
  now: Date = new Date(),
): Promise<AuthorizedScope> {
  try {
    validateGrant(grant, grant.audience, now);
  } catch {
    throw unauthorized();
  }
  if (
    !grant.permissions.has(REPORTING_PERMISSION) ||
    requested <= 0n ||
    grant.scope_id <= 0n
  )
    throw forbidden();
  if (grant.explicit_descendant_scope_ids.length > MAX_AUTHORIZED_SCOPES)
    throw invalid(
      `authorization covers more than ${MAX_AUTHORIZED_SCOPES} scopes`,
    );
  await authorizationContext(tx, [grant.scope_id], grant.grant_id);
  const issuer = (await tx.query(sql.AUTHORIZE_TRANSACTION_0, [grant.issuer]))
    .rows[0]?.service_identity_id as string | undefined;
  if (issuer === undefined) throw unauthorized();
  const permissions = sortedStrings(grant.permissions);
  await tx.query(sql.AUTHORIZE_TRANSACTION_1, [
    grant.grant_id,
    issuer,
    grant.audience,
    grant.principal_type,
    grant.principal_id,
    grant.scope_id,
    grant.root_scope_id,
    grant.descendant_mode,
    apiJson(grant.explicit_descendant_scope_ids),
    apiJson(permissions),
    apiJson(grant.metric_keys),
    apiJson(grant.dimension_keys),
    grant.policy_version,
    grant.issued_at,
    grant.not_before,
    grant.expires_at,
    grant.correlation_id,
  ]);
  const stored = (await tx.query(sql.AUTHORIZE_TRANSACTION_2, [grant.grant_id]))
    .rows[0];
  if (
    !stored ||
    stored.issuer_service_identity_id !== issuer ||
    stored.audience !== grant.audience ||
    stored.issuer !== grant.issuer ||
    BigInt(stored.scope_id) !== grant.scope_id ||
    BigInt(stored.root_scope_id) !== grant.root_scope_id ||
    stored.principal_type !== grant.principal_type ||
    stored.descendant_mode !== grant.descendant_mode ||
    !equalJson(
      stored.explicit_descendant_scope_ids,
      grant.explicit_descendant_scope_ids,
    ) ||
    !equalJson(stored.permissions, permissions) ||
    !equalJson(stored.metric_keys, grant.metric_keys) ||
    !equalJson(stored.dimension_keys, grant.dimension_keys) ||
    stored.revoked_at !== null ||
    new Date(stored.expires_at).getTime() <= Date.now() ||
    stored.principal_id !== grant.principal_id ||
    stored.policy_version !== grant.policy_version
  )
    throw unauthorized();
  const inspection = [
    grant.scope_id,
    requested,
    ...grant.explicit_descendant_scope_ids,
  ];
  if (inspection.some((id) => id <= 0n)) throw forbidden();
  await authorizationContext(tx, inspection, grant.grant_id);
  const scope = (await tx.query(sql.AUTHORIZE_TRANSACTION_3, [requested]))
    .rows[0];
  if (
    !scope ||
    scope.status !== 'active' ||
    BigInt(scope.root_scope_id) !== grant.root_scope_id
  )
    throw forbidden();
  if (
    !(
      await tx.query(sql.AUTHORIZE_TRANSACTION_6, [
        grant.scope_id,
        grant.root_scope_id,
      ])
    ).rows[0]?.exists
  )
    throw forbidden();
  if (
    !(await tx.query(sql.AUTHORIZE_TRANSACTION_7, [grant.scope_id, requested]))
      .rows[0]?.exists
  )
    throw forbidden();
  let ids: bigint[];
  if (grant.descendant_mode === 'none') {
    if (requested !== grant.scope_id) throw forbidden();
    ids = [grant.scope_id];
  } else if (grant.descendant_mode === 'explicit') {
    if (
      requested !== grant.scope_id &&
      !grant.explicit_descendant_scope_ids.includes(requested)
    )
      throw forbidden();
    ids = [grant.scope_id, ...grant.explicit_descendant_scope_ids];
    for (const id of grant.explicit_descendant_scope_ids)
      if (
        !(
          await tx.query(sql.AUTHORIZE_TRANSACTION_4, [
            grant.scope_id,
            id,
            grant.root_scope_id,
          ])
        ).rows[0]?.exists
      )
        throw forbidden();
  } else {
    if (
      !grant.permissions.has(DESCENDANT_PERMISSION) &&
      requested !== grant.scope_id
    )
      throw forbidden();
    ids = (
      await tx.query(sql.AUTHORIZE_TRANSACTION_5, [
        grant.scope_id,
        MAX_AUTHORIZED_SCOPES + 1,
      ])
    ).rows.map((row) => BigInt(row.scope_id));
  }
  ids = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ids.length > MAX_AUTHORIZED_SCOPES)
    throw invalid(
      `authorization covers more than ${MAX_AUTHORIZED_SCOPES} scopes`,
    );
  if (!ids.includes(requested)) throw forbidden();
  await authorizationContext(tx, ids, grant.grant_id);
  return {
    requested_scope_id: requested,
    authorized_scope_ids: ids,
    scope_kind: String(scope.scope_kind),
    timezone: String(scope.reporting_timezone),
  };
}
export const metricIdentity = (
  metric: MetricDefinition | MetricSetDefinition,
) => `${metric.key}@${metric.version}`;
export function catalogResponse(
  registry: RegistrySnapshot,
  grant: ReportingGrant,
  scope: AuthorizedScope,
) {
  const visible = (identity: string) =>
    !grant.metric_keys.length || grant.metric_keys.includes(identity);
  const metrics = registry.metrics.filter(
    (metric) =>
      visible(metricIdentity(metric)) &&
      metric.scope_kinds.includes(scope.scope_kind) &&
      metric.permissions.includes(REPORTING_PERMISSION),
  );
  const dimensions = registry.dimensions
    .filter(
      (dimension) =>
        (!grant.dimension_keys.length ||
          grant.dimension_keys.includes(dimension.key)) &&
        dimension.permissions.includes(REPORTING_PERMISSION) &&
        metrics.some((metric) => metric.dimensions.includes(dimension.key)),
    )
    .map(({ value_type, ...dimension }) => ({
      ...dimension,
      type: value_type,
    }));
  const metric_sets = registry.metric_sets.filter(
    (set) =>
      set.scope_kinds.includes(scope.scope_kind) &&
      set.permissions.includes(REPORTING_PERMISSION) &&
      set.metrics.every(visible),
  );
  return {
    scope_id: scope.requested_scope_id,
    scope_kind: scope.scope_kind,
    timezone: scope.timezone,
    registry_version: registry.metrics_registry_version,
    registry_sha256: registry.sha256,
    metrics,
    dimensions,
    metric_sets,
  };
}
export function validateRequestShape(request: ReportQueryRequest): void {
  if (request.reporting_scope_id <= 0n)
    throw invalid('reporting_scope_id must be positive');
  if (timestampNanos(request.range_end) <= timestampNanos(request.range_start))
    throw invalid('range_end must be after range_start');
  if (
    timestampNanos(request.range_end) - timestampNanos(request.range_start) >
    BigInt(MAX_RANGE_DAYS) * 86400000000000n
  )
    throw invalid(`range cannot exceed ${MAX_RANGE_DAYS} days`);
  if (!request.timezone.trim() || Buffer.byteLength(request.timezone) > 128)
    throw invalid('timezone must be a non-empty IANA timezone name');
  if (request.breakdowns.length > MAX_BREAKDOWNS)
    throw invalid(`at most ${MAX_BREAKDOWNS} breakdowns are allowed`);
  if (Object.keys(request.filters).length > MAX_BREAKDOWNS)
    throw invalid(`at most ${MAX_BREAKDOWNS} filter dimensions are allowed`);
  if (
    Object.values(request.filters).some(
      (values) => !values.length || values.length > MAX_FILTER_VALUES,
    )
  )
    throw invalid(`each filter must contain 1-${MAX_FILTER_VALUES} values`);
  if (request.metric_set !== null && request.metrics.length)
    throw invalid('metrics and metric_set are mutually exclusive');
  if (request.comparison) previousPeriodRange(request, request.comparison);
}
export function previousPeriodRange(
  request: ReportQueryRequest,
  comparison: { kind: string },
): [Date, Date] {
  if (comparison.kind !== 'previous_period')
    throw invalid(`comparison kind ${comparison.kind} is not supported`);
  return [
    dateFromNanos(
      2n * timestampNanos(request.range_start) -
        timestampNanos(request.range_end),
    ),
    request.range_start,
  ];
}
export function selectMetrics(
  registry: RegistrySnapshot,
  grant: ReportingGrant,
  scope: AuthorizedScope,
  request: ReportQueryRequest,
): MetricDefinition[] {
  let identities = request.metrics;
  if (request.metric_set !== null) {
    const set = registry.metric_sets.find(
      (set) => metricIdentity(set) === request.metric_set,
    );
    if (!set)
      throw invalid(`metric set ${request.metric_set} is not registered`);
    if (!set.scope_kinds.includes(scope.scope_kind)) throw forbidden();
    identities = set.metrics.filter((identity) =>
      registry.metrics.some(
        (metric) =>
          metricIdentity(metric) === identity &&
          metric.scope_kinds.includes(scope.scope_kind),
      ),
    );
  }
  if (!identities.length)
    throw invalid('at least one metric or metric_set is required');
  if (identities.length > MAX_METRICS)
    throw invalid(`at most ${MAX_METRICS} metrics are allowed`);
  const seen = new Set<string>();
  return identities.map((identity) => {
    if (seen.has(identity)) throw invalid(`metric ${identity} is duplicated`);
    seen.add(identity);
    if (grant.metric_keys.length && !grant.metric_keys.includes(identity))
      throw forbidden();
    const metric = registry.metrics.find(
      (metric) => metricIdentity(metric) === identity,
    );
    if (!metric) throw invalid(`metric ${identity} is not registered`);
    if (
      !metric.scope_kinds.includes(scope.scope_kind) ||
      !metric.permissions.includes(REPORTING_PERMISSION)
    )
      throw forbidden();
    return metric;
  });
}
export function expectedPoints(
  start: Date,
  end: Date,
  interval: string,
): number {
  return Math.ceil(
    Math.max(
      1,
      Math.floor(end.getTime() / 1000) - Math.floor(start.getTime() / 1000),
    ) / ({ hour: 3600, day: 86400, month: 2629800 }[interval] ?? 86400),
  );
}
export function selectInterval(
  request: ReportQueryRequest,
  metrics: MetricDefinition[],
): string {
  const supported = (interval: string) =>
    ['hour', 'day', 'month'].includes(interval) &&
    metrics.every((metric) => metric.supported_intervals.includes(interval));
  let interval = request.interval;
  if (interval !== null) {
    if (!supported(interval))
      throw invalid(
        `interval ${interval} is not available for all selected metrics`,
      );
  } else {
    const range = request.range_end.getTime() - request.range_start.getTime();
    if (range <= 2 * 86400000 && supported('hour')) interval = 'hour';
    else if (range <= 62 * 86400000 && supported('day')) interval = 'day';
    else if (supported('month')) interval = 'month';
    else if (supported('day')) interval = 'day';
    else throw invalid('no common projected interval is available');
  }
  if (
    expectedPoints(request.range_start, request.range_end, interval) >
    MAX_POINTS
  )
    throw invalid(`query would return more than ${MAX_POINTS} points`);
  return interval;
}
export function validateDimensions(
  registry: RegistrySnapshot,
  grant: ReportingGrant,
  metrics: MetricDefinition[],
  requested: string[],
  groupable: boolean,
): string[] {
  const seen = new Set<string>();
  return requested.map((key) => {
    if (seen.has(key)) throw invalid(`dimension ${key} is duplicated`);
    seen.add(key);
    if (grant.dimension_keys.length && !grant.dimension_keys.includes(key))
      throw forbidden();
    const dimension = registry.dimensions.find((value) => value.key === key);
    if (!dimension) throw invalid(`dimension ${key} is not registered`);
    if (groupable ? !dimension.groupable : !dimension.filterable)
      throw invalid(`dimension ${key} cannot be used in this position`);
    if (!metrics.every((metric) => metric.dimensions.includes(key)))
      throw invalid(
        `dimension ${key} is not compatible with every selected metric`,
      );
    return key;
  });
}
export async function loadGeneration(
  tx: pg.PoolClient,
  scope: bigint,
): Promise<GenerationInfo | null> {
  const row = (
    await tx.query(sql.LOAD_GENERATION_0, [
      PROJECTION_NAME,
      PROJECTION_VERSION,
      scope,
      DEFAULT_SHARD_KEY,
    ])
  ).rows[0];
  return row
    ? {
        generation_id: BigInt(row.generation_id),
        projection_version: row.projection_version,
        registry_sha256: row.metric_registry_sha256,
        processing_status: row.processing_status,
      }
    : null;
}
export function availabilityRank(state: string): number {
  return (
    (
      {
        unavailable: 8,
        backfilling: 7,
        stale: 6,
        partial: 5,
        unsupported: 4,
        not_instrumented: 3,
        not_applicable: 2,
        available: 1,
      } as Record<string, number>
    )[state] ?? 0
  );
}
async function loadSourceAvailability(
  tx: pg.PoolClient,
  ids: bigint[],
  metrics: MetricDefinition[],
): Promise<Map<string, SourceAvailability>> {
  const rows = (
    await tx.query(sql.LOAD_SOURCE_AVAILABILITY_0, [
      ids,
      metrics.map((metric) => metric.key),
    ])
  ).rows;
  const result = new Map<string, SourceAvailability>();
  for (const row of rows) {
    const current = result.get(row.metric_scope);
    if (
      !current ||
      availabilityRank(row.availability_state) > availabilityRank(current.state)
    )
      result.set(row.metric_scope, {
        state: row.availability_state,
        reason: row.safe_failure_code,
        latest_timestamp: row.latest_source_timestamp,
      });
  }
  return result;
}
export function unknownCoverage(reason: string): CoverageAvailability {
  return {
    state: 'unknown',
    reason,
    evidence_layer: null,
    window_start: null,
    window_end: null,
    complete_through: null,
    observed_at: null,
  };
}
export function coverageCheckpointCandidate(
  input: {
    evidence_layer: string;
    window_start: Date;
    window_end: Date;
    coverage_state: string;
    complete_through: Date | null;
    observed_at: Date;
  },
  start: Date,
  end: Date,
): CoverageAvailability {
  const state =
    input.coverage_state === 'available' &&
    timestampNanos(input.window_start) <= timestampNanos(start) &&
    timestampNanos(input.window_end) >= timestampNanos(end) &&
    input.complete_through !== null &&
    timestampNanos(input.complete_through) >= timestampNanos(end)
      ? 'available'
      : input.coverage_state === 'stale'
        ? 'stale'
        : input.coverage_state === 'unavailable'
          ? 'unavailable'
          : 'partial';
  const reason =
    state === 'available'
      ? null
      : state === 'stale'
        ? 'temporal coverage evidence is stale'
        : state === 'unavailable'
          ? 'temporal coverage evidence is unavailable'
          : 'temporal coverage does not fully cover the requested range';
  return { ...input, state, reason };
}
const layerRank = (layer: string | null) =>
  layer === 'temporal' ? 2 : layer === 'reconciliation' ? 1 : 0;
export function coverageCandidateIsBetter(
  candidate: CoverageAvailability,
  current: CoverageAvailability,
): boolean {
  const rank =
    layerRank(candidate.evidence_layer) - layerRank(current.evidence_layer);
  return (
    rank > 0 ||
    (rank === 0 &&
      (candidate.observed_at?.getTime() ?? -Infinity) >
        (current.observed_at?.getTime() ?? -Infinity))
  );
}
const maxDate = (left: Date | null, right: Date | null): Date | null =>
  left === null
    ? right
    : right === null
      ? left
      : timestampNanos(left) > timestampNanos(right)
        ? left
        : right;
const minDate = (left: Date | null, right: Date | null): Date | null =>
  left === null
    ? right
    : right === null
      ? left
      : timestampNanos(left) < timestampNanos(right)
        ? left
        : right;
export function combineScopeCoverage(
  scopes: CoverageAvailability[],
): CoverageAvailability {
  const has = (state: string) => scopes.some((scope) => scope.state === state);
  const state = has('backfilling')
    ? 'backfilling'
    : has('unavailable')
      ? 'unavailable'
      : has('stale')
        ? 'stale'
        : has('partial') || (has('available') && has('unknown'))
          ? 'partial'
          : has('available')
            ? 'available'
            : 'unknown';
  const reason =
    scopes.find((scope) => scope.state === state)?.reason ??
    (state === 'partial'
      ? 'one or more authorized scopes are incomplete'
      : null);
  const layers = [
    ...new Set(
      scopes.flatMap((scope) =>
        scope.evidence_layer === null ? [] : [scope.evidence_layer],
      ),
    ),
  ];
  return {
    state,
    reason,
    evidence_layer:
      layers.length === 0 ? null : layers.length === 1 ? layers[0]! : 'mixed',
    window_start: scopes.reduce(
      (value, scope) => maxDate(value, scope.window_start),
      null as Date | null,
    ),
    window_end: scopes.reduce(
      (value, scope) => minDate(value, scope.window_end),
      null as Date | null,
    ),
    complete_through: scopes.reduce(
      (value, scope) => minDate(value, scope.complete_through),
      null as Date | null,
    ),
    observed_at: null,
  };
}
async function loadCoverageAvailability(
  tx: pg.PoolClient,
  ids: bigint[],
  metrics: MetricDefinition[],
  start: Date,
  end: Date,
): Promise<Map<string, CoverageAvailability>> {
  const domains = [...new Set(metrics.map((metric) => metric.domain))].sort(),
    result = new Map<string, CoverageAvailability>();
  if (!ids.length || !domains.length) return result;
  const rows = (
      await tx.query(sql.LOAD_COVERAGE_AVAILABILITY_0, [
        ids,
        domains,
        start,
        end,
      ])
    ).rows,
    checkpoints = new Map<string, CoverageAvailability>();
  const identity = (domain: string, id: unknown) =>
    apiJson([domain, BigInt(id as string)]);
  for (const row of rows) {
    const candidate = coverageCheckpointCandidate(
      {
        evidence_layer: row.coverage_layer,
        window_start: row.window_start,
        window_end: row.window_end,
        coverage_state: row.coverage_state,
        complete_through: row.complete_through,
        observed_at: row.observed_at,
      },
      start,
      end,
    );
    const key = identity(row.source_domain, row.reporting_scope_id),
      current = checkpoints.get(key);
    if (!current || coverageCandidateIsBetter(candidate, current))
      checkpoints.set(key, candidate);
  }
  const backfills = new Map<string, CoverageAvailability>();
  for (const row of (
    await tx.query(sql.LOAD_COVERAGE_AVAILABILITY_1, [ids, domains, start, end])
  ).rows)
    backfills.set(identity(row.source_domain, row.reporting_scope_id), {
      state: 'backfilling',
      reason: 'historical backfill is in progress',
      evidence_layer: 'backfill',
      window_start: row.requested_range_start,
      window_end: row.requested_range_end,
      complete_through: null,
      observed_at: null,
    });
  for (const domain of domains)
    result.set(
      domain,
      combineScopeCoverage(
        ids.map(
          (id) =>
            backfills.get(identity(domain, id)) ??
            checkpoints.get(identity(domain, id)) ??
            unknownCoverage('requested range has no temporal evidence'),
        ),
      ),
    );
  return result;
}
export function reportAvailabilityState(
  source: string,
  coverage: string,
  projection: string,
  hasSeries: boolean,
): string {
  if (coverage === 'backfilling') return 'backfilling';
  if (projection === 'unavailable') return 'unavailable';
  if (source === 'available')
    return projection !== 'available'
      ? 'partial'
      : ['available', 'stale', 'unavailable'].includes(coverage)
        ? coverage
        : 'partial';
  if (
    source === 'not_instrumented' &&
    hasSeries &&
    coverage === 'available' &&
    projection === 'available'
  )
    return 'available';
  return source;
}
export function freshnessState(
  source: string,
  latest: Date | null,
  maxAge: number | bigint,
  now: Date,
): string {
  if (source !== 'available') return source;
  if (!latest) return 'unknown';
  const age = BigInt(maxAge) > I64_MAX ? I64_MAX : BigInt(maxAge);
  return timestampNanos(latest) + age * 1000000000n >= timestampNanos(now)
    ? 'fresh'
    : 'stale';
}
export function projectionCoverageState(
  generation: GenerationInfo | null,
): string {
  return !generation
    ? 'unknown'
    : generation.processing_status === 'idle'
      ? 'available'
      : generation.processing_status === 'failed'
        ? 'unavailable'
        : 'partial';
}
export function projectionSourceCoverageState(
  values: unknown[],
  required: string[],
): string {
  if (!values.length) return 'unknown';
  const expected = [...new Set(required)].sort();
  return values.every(
    (value) =>
      plainObject(value) &&
      value.coverage_state === 'observed' &&
      stringArray(value.required_sources) &&
      equalJson([...new Set(value.required_sources)].sort(), expected),
  )
    ? 'available'
    : 'partial';
}
export function dimensionCoverageState(
  series: ReportPoint[],
  requested: string[],
): [string, number] {
  if (!requested.length) return ['not_requested', 0];
  if (!series.length) return ['unknown', 0];
  const missing = series.filter((point) =>
    requested.some(
      (key) => !plainObject(point.dimensions) || point.dimensions[key] == null,
    ),
  ).length;
  return missing ? ['partial', missing] : ['available', 0];
}
export interface SeriesQuery {
  generation_id: bigint;
  metric: MetricDefinition;
  range_start: Date;
  range_end: Date;
  interval: string;
  requested_scope_id: bigint;
  authorized_scope_ids: bigint[];
  include_descendants: boolean;
  breakdowns: string[];
  filters: Record<string, string[]>;
}
const sqlLiteral = (value: string) => value.replaceAll("'", "''");
export function dimensionsProjection(
  alias: string,
  breakdowns: string[],
): string {
  return !breakdowns.length
    ? "'{}'::jsonb"
    : `jsonb_build_object(${breakdowns.map((key) => `'${sqlLiteral(key)}', ${alias}.dimensions -> '${sqlLiteral(key)}'`).join(', ')})`;
}
export function contributionBucketExpressions(
  interval: string,
): [string, string] {
  if (interval === 'hour') return ['c.bucket_start', 'c.bucket_end'];
  if (interval !== 'day' && interval !== 'month')
    throw Error('interval was validated before the query planner');
  return [
    `date_trunc('${interval}', c.bucket_start AT TIME ZONE c.timezone_name) AT TIME ZONE c.timezone_name`,
    `(date_trunc('${interval}', c.bucket_start AT TIME ZONE c.timezone_name) + INTERVAL '1 ${interval}') AT TIME ZONE c.timezone_name`,
  ];
}
export function planMetricSeries(spec: SeriesQuery): {
  text: string;
  values: unknown[];
} {
  const distinct = spec.metric.default_aggregation === 'distinct_count',
    alias = distinct ? 'c' : 'r',
    projection = dimensionsProjection(alias, spec.breakdowns);
  const clauses = [
    `${alias}.generation_id = $1`,
    `${alias}.projection_name = $2`,
    `${alias}.projection_version = $3`,
    `${alias}.metric_key = $4`,
    `${alias}.metric_version = $5`,
    `${alias}.target_scope_id = $6`,
  ];
  const values: unknown[] = [
    spec.generation_id,
    PROJECTION_NAME,
    PROJECTION_VERSION,
    spec.metric.key,
    Number((BigInt(spec.metric.version) << 32n) >> 32n),
    spec.requested_scope_id,
  ];
  // Rust uses `version as i32` when binding metric versions.
  if (!distinct) {
    clauses.push('r.interval = $7');
    values.push(spec.interval);
  }
  clauses.push(
    `${alias}.bucket_end > $${values.length + 1}`,
    `${alias}.bucket_start < $${values.length + 2}`,
  );
  values.push(spec.range_start, spec.range_end);
  if (distinct) clauses.push('c.deduplication_key IS NOT NULL');
  if (spec.include_descendants) {
    clauses.push(
      `${alias}.source_scope_id = ANY($${values.length + 1}::bigint[])`,
    );
    values.push(spec.authorized_scope_ids);
  } else clauses.push(`${alias}.source_scope_id = $6`);
  for (const key of Object.keys(spec.filters).sort()) {
    clauses.push(
      `${alias}.dimensions ->> '${sqlLiteral(key)}' = ANY($${values.length + 1}::text[])`,
    );
    values.push(spec.filters[key]);
  }
  let text: string;
  if (distinct) {
    const [start, end] = contributionBucketExpressions(spec.interval);
    text = `SELECT ${start} AS bucket_start, ${end} AS bucket_end, ${projection} AS dimensions, COUNT(DISTINCT c.deduplication_key)::double precision AS value, NULL::double precision AS numerator, NULL::double precision AS denominator, jsonb_agg(c.coverage) AS coverage FROM analytics.analytics_projection_contribution AS c WHERE ${clauses.join(' AND ')} GROUP BY 1, 2, 3 ORDER BY 1, 3 LIMIT ${MAX_POINTS + 1}`;
  } else {
    const expression =
      spec.metric.default_aggregation === 'ratio_of_sums'
        ? 'SUM(r.numerator)::double precision / NULLIF(SUM(r.denominator)::double precision, 0)'
        : spec.metric.default_aggregation === 'weighted_average'
          ? 'SUM(r.value_sum)::double precision / NULLIF(SUM(r.value_count)::double precision, 0)'
          : spec.metric.default_aggregation === 'count'
            ? 'SUM(r.value_count)::double precision'
            : 'SUM(r.value_sum)::double precision';
    text = `SELECT r.bucket_start, r.bucket_end, ${projection} AS dimensions, ${expression} AS value, SUM(r.numerator)::double precision AS numerator, SUM(r.denominator)::double precision AS denominator, jsonb_agg(r.coverage) AS coverage FROM analytics.analytics_projection_rollup AS r WHERE ${clauses.join(' AND ')} GROUP BY r.bucket_start, r.bucket_end, ${projection} ORDER BY r.bucket_start, dimensions LIMIT ${MAX_POINTS + 1}`;
  }
  return { text, values };
}
export async function queryMetricSeries(
  tx: pg.PoolClient,
  spec: SeriesQuery,
): Promise<{ points: ReportPoint[]; projection_source_state: string }> {
  const plan = planMetricSeries(spec),
    rows = (await tx.query(plan.text, plan.values)).rows;
  if (rows.length > MAX_POINTS)
    throw invalid(`query would return more than ${MAX_POINTS} points`);
  const values: unknown[] = [];
  const points = rows.map((row) => {
    if (Array.isArray(row.coverage)) values.push(...row.coverage);
    else values.push(row.coverage);
    return {
      bucket_start: row.bucket_start as Date,
      bucket_end: row.bucket_end as Date,
      dimensions: row.dimensions as unknown,
      value: row.value as number | null,
      numerator: row.numerator as number | null,
      denominator: row.denominator as number | null,
    };
  });
  return {
    points,
    projection_source_state: projectionSourceCoverageState(
      values,
      spec.metric.coverage.required_sources,
    ),
  };
}
export async function executeReport(
  tx: pg.PoolClient,
  registry: RegistrySnapshot,
  grant: ReportingGrant,
  scope: AuthorizedScope,
  request: ReportQueryRequest,
): Promise<ReportResponse> {
  validateRequestShape(request);
  if (request.timezone !== scope.timezone)
    throw invalid('timezone must match the reporting scope timezone');
  if (
    request.include_descendants &&
    scope.authorized_scope_ids.length === 1 &&
    grant.descendant_mode === 'none'
  )
    throw forbidden();
  if (
    request.include_descendants &&
    !grant.permissions.has(DESCENDANT_PERMISSION)
  )
    throw forbidden();
  const metrics = selectMetrics(registry, grant, scope, request),
    interval = selectInterval(request, metrics),
    comparisonRange = request.comparison
      ? previousPeriodRange(request, request.comparison)
      : null;
  const breakdowns = validateDimensions(
    registry,
    grant,
    metrics,
    request.breakdowns,
    true,
  );
  validateDimensions(
    registry,
    grant,
    metrics,
    Object.keys(request.filters).sort(),
    false,
  );
  const generation = await loadGeneration(tx, scope.requested_scope_id),
    sources = await loadSourceAvailability(
      tx,
      scope.authorized_scope_ids,
      metrics,
    ),
    coverages = await loadCoverageAvailability(
      tx,
      scope.authorized_scope_ids,
      metrics,
      request.range_start,
      request.range_end,
    );
  const results: MetricResult[] = [],
    comparisonResults: {
      key: string;
      version: number;
      series: ReportPoint[];
    }[] = [];
  let dataAsOf: Date | null = null;
  for (const metric of metrics) {
    const source = sources.get(metric.key) ?? {
      state: 'not_instrumented',
      reason: 'no source state has been recorded for this metric',
      latest_timestamp: null,
    };
    const coverage =
      coverages.get(metric.domain) ??
      unknownCoverage('no temporal coverage evidence has been recorded');
    dataAsOf = maxDate(dataAsOf, source.latest_timestamp);
    const warnings: string[] = [];
    let series: ReportPoint[] = [],
      projectionSource = 'unknown',
      coverageState = coverage.state;
    const query = (start: Date, end: Date): SeriesQuery => ({
      generation_id: generation!.generation_id,
      metric,
      range_start: start,
      range_end: end,
      interval,
      requested_scope_id: scope.requested_scope_id,
      authorized_scope_ids: scope.authorized_scope_ids,
      include_descendants: request.include_descendants,
      breakdowns,
      filters: request.filters,
    });
    if (generation) {
      if (generation.registry_sha256 !== registry.sha256) {
        coverageState = 'stale';
        warnings.push(
          'projection generation was built from a different metric registry',
        );
      }
      if (generation.processing_status !== 'idle')
        warnings.push(
          `projection checkpoint is ${generation.processing_status}`,
        );
      const queried = await queryMetricSeries(
        tx,
        query(request.range_start, request.range_end),
      );
      series = queried.points;
      projectionSource = queried.projection_source_state;
    } else {
      coverageState = 'unknown';
      warnings.push('no promoted projection generation is available');
    }
    const comparisonSeries =
      generation && comparisonRange
        ? (await queryMetricSeries(tx, query(...comparisonRange))).points
        : [];
    for (const point of series) dataAsOf = maxDate(dataAsOf, point.bucket_end);
    const projectionState = projectionCoverageState(generation),
      [dimensionState, missing] = dimensionCoverageState(series, breakdowns);
    let state = reportAvailabilityState(
      source.state,
      coverageState,
      projectionState,
      series.length > 0,
    );
    if (state === 'available' && projectionSource === 'partial') {
      state = 'partial';
      warnings.push('projection source coverage metadata is partial');
    }
    if (state !== 'available')
      warnings.push(
        coverage.reason ?? source.reason ?? `report availability is ${state}`,
      );
    results.push({
      key: metric.key,
      version: metric.version,
      unit: metric.unit,
      value_type: metric.value_type,
      exactness: metric.exactness,
      availability: { state, reason: source.reason },
      coverage: {
        state:
          !series.length && coverageState === 'available'
            ? 'unknown'
            : coverageState,
        included_points: series.length,
        expected_points: expectedPoints(
          request.range_start,
          request.range_end,
          interval,
        ),
        evidence_layer: coverage.evidence_layer,
        window_start: coverage.window_start,
        window_end: coverage.window_end,
        complete_through: coverage.complete_through,
        projection_state: projectionState,
        projection_source_state: projectionSource,
        required_sources: [...metric.coverage.required_sources],
        dimension_state: dimensionState,
        missing_dimension_points: missing,
      },
      freshness: {
        state: freshnessState(
          source.state,
          source.latest_timestamp,
          metric.freshness.max_age_seconds,
          new Date(),
        ),
        latest_source_timestamp: source.latest_timestamp,
        max_age_seconds: metric.freshness.max_age_seconds,
      },
      warnings,
      series,
    });
    if (comparisonRange)
      comparisonResults.push({
        key: metric.key,
        version: metric.version,
        series: comparisonSeries,
      });
  }
  return {
    scope_id: scope.requested_scope_id,
    scope_kind: scope.scope_kind,
    range_start: request.range_start,
    range_end: request.range_end,
    interval,
    timezone: request.timezone,
    generated_at: new Date(),
    data_as_of: dataAsOf,
    generation_id: generation?.generation_id ?? null,
    projection_version: generation?.projection_version ?? PROJECTION_VERSION,
    registry_sha256: registry.sha256,
    metrics: results,
    comparison: comparisonRange
      ? {
          kind: request.comparison?.kind ?? 'previous_period',
          range_start: comparisonRange[0],
          range_end: comparisonRange[1],
          metrics: comparisonResults,
        }
      : null,
  };
}

export interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
  close?(): Promise<void>;
}
class RedisCacheBackend implements CacheBackend {
  private client: ReturnType<typeof createClient> | null = null;
  private pending: Promise<void> | null = null;
  constructor(private readonly url: string) {}
  private async connection(): Promise<ReturnType<typeof createClient>> {
    if (this.client?.isReady) return this.client;
    if (!this.pending) {
      const client = createClient({
        url: this.url,
        socket: { connectTimeout: 150, reconnectStrategy: false },
      });
      client.on('error', () => {});
      this.client = client;
      this.pending = client
        .connect()
        .then(() => {})
        .catch((error) => {
          if (client.isOpen) client.destroy();
          if (this.client === client) this.client = null;
          throw error;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    await this.pending;
    if (!this.client?.isReady)
      throw Error('redis cache connection unavailable');
    return this.client;
  }
  private async operation<T>(
    run: (client: ReturnType<typeof createClient>) => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.connection().then(run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('redis cache operation timed out')),
            150,
          );
        }),
      ]);
    } catch (error) {
      if (this.client?.isOpen) this.client.destroy();
      this.client = null;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async get(key: string): Promise<string | null> {
    return this.operation((client) => client.get(key));
  }
  async set(key: string, value: string, ttl: number): Promise<void> {
    await this.operation(async (client) => {
      await client.setEx(key, ttl, value);
    });
  }
  async close(): Promise<void> {
    if (this.client?.isOpen) this.client.destroy();
    this.client = null;
  }
}
export type CacheRead =
  | { state: 'disabled' | 'miss' | 'stale' | 'unavailable' }
  | { state: 'hit'; response: ReportResponse };
function nullableDate(value: unknown): Date | null {
  return value == null ? null : typedDate(value);
}
function unsignedNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('expected unsigned integer');
  return value;
}
function unsigned64(value: unknown): number | bigint {
  if (
    typeof value !== 'bigint' &&
    (typeof value !== 'number' || !Number.isSafeInteger(value))
  )
    throw Error('expected u64');
  const n = BigInt(value);
  if (n < 0n || n > 18446744073709551615n) throw Error('expected u64');
  return value;
}
function floatValue(value: unknown): number | null {
  if (value == null) return null;
  const n =
    value instanceof SerdeFloat
      ? value.value
      : typeof value === 'number'
        ? value
        : typeof value === 'bigint'
          ? Number(value)
          : NaN;
  if (!Number.isFinite(n)) throw Error('expected f64');
  return n;
}
function requiredObject(value: unknown): Record<string, unknown> {
  if (!plainObject(value)) throw Error('expected object');
  return value;
}
function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error('expected array');
  return value;
}
function decodePoints(value: unknown): ReportPoint[] {
  return requiredArray(value).map((value) => {
    const row = requiredObject(value);
    if (!('dimensions' in row)) throw Error('missing dimensions');
    return {
      bucket_start: typedDate(row.bucket_start),
      bucket_end: typedDate(row.bucket_end),
      dimensions: row.dimensions,
      value: floatValue(row.value),
      numerator: floatValue(row.numerator),
      denominator: floatValue(row.denominator),
    };
  });
}
/** Cache decoding follows the source typed serde DTOs; corrupt entries never become reports. */
export function decodeCachedResponse(value: unknown): ReportResponse {
  const row = requiredObject(value);
  const metrics = requiredArray(row.metrics).map((value) => {
    const metric = requiredObject(value),
      availability = requiredObject(metric.availability),
      coverage = requiredObject(metric.coverage),
      freshness = requiredObject(metric.freshness);
    const version = unsignedNumber(metric.version);
    if (version > 4294967295) throw Error('expected u32');
    return {
      key: typedString(metric.key),
      version,
      unit: typedString(metric.unit),
      value_type: typedString(metric.value_type),
      exactness: typedString(metric.exactness),
      availability: {
        state: typedString(availability.state),
        reason: optionalString(availability.reason),
      },
      coverage: {
        state: typedString(coverage.state),
        included_points: unsignedNumber(coverage.included_points),
        expected_points:
          coverage.expected_points == null
            ? null
            : unsignedNumber(coverage.expected_points),
        evidence_layer: optionalString(coverage.evidence_layer),
        window_start: nullableDate(coverage.window_start),
        window_end: nullableDate(coverage.window_end),
        complete_through: nullableDate(coverage.complete_through),
        projection_state: typedString(coverage.projection_state),
        projection_source_state: typedString(coverage.projection_source_state),
        required_sources: typedStrings(
          requiredArray(coverage.required_sources),
        ),
        dimension_state: typedString(coverage.dimension_state),
        missing_dimension_points: unsignedNumber(
          coverage.missing_dimension_points,
        ),
      },
      freshness: {
        state: typedString(freshness.state),
        latest_source_timestamp: nullableDate(
          freshness.latest_source_timestamp,
        ),
        max_age_seconds: unsigned64(freshness.max_age_seconds),
      },
      warnings: typedStrings(requiredArray(metric.warnings)),
      series: decodePoints(metric.series),
    };
  });
  let comparison: ReportResponse['comparison'] = null;
  if (row.comparison != null) {
    const data = requiredObject(row.comparison);
    comparison = {
      kind: typedString(data.kind),
      range_start: typedDate(data.range_start),
      range_end: typedDate(data.range_end),
      metrics: requiredArray(data.metrics).map((value) => {
        const metric = requiredObject(value),
          version = unsignedNumber(metric.version);
        if (version > 4294967295) throw Error('expected u32');
        return {
          key: typedString(metric.key),
          version,
          series: decodePoints(metric.series),
        };
      }),
    };
  }
  return {
    scope_id: signedId(row.scope_id),
    scope_kind: typedString(row.scope_kind),
    range_start: typedDate(row.range_start),
    range_end: typedDate(row.range_end),
    interval: typedString(row.interval),
    timezone: typedString(row.timezone),
    generated_at: typedDate(row.generated_at),
    data_as_of: nullableDate(row.data_as_of),
    generation_id:
      row.generation_id == null ? null : signedId(row.generation_id),
    projection_version: typedString(row.projection_version),
    registry_sha256: typedString(row.registry_sha256),
    metrics,
    comparison,
  };
}
function reportWire(response: ReportResponse): unknown {
  const series = (points: ReportPoint[]) =>
    points.map((point) => ({
      ...point,
      value:
        point.value === null
          ? null
          : Number.isFinite(point.value)
            ? new SerdeFloat(point.value)
            : null,
      numerator:
        point.numerator === null
          ? null
          : Number.isFinite(point.numerator)
            ? new SerdeFloat(point.numerator)
            : null,
      denominator:
        point.denominator === null
          ? null
          : Number.isFinite(point.denominator)
            ? new SerdeFloat(point.denominator)
            : null,
    }));
  return {
    ...response,
    metrics: response.metrics.map((metric) => ({
      ...metric,
      series: series(metric.series),
    })),
    comparison: response.comparison
      ? {
          ...response.comparison,
          metrics: response.comparison.metrics.map((metric) => ({
            ...metric,
            series: series(metric.series),
          })),
        }
      : null,
  };
}
export class ReportingCache {
  constructor(
    private readonly backend: CacheBackend | null,
    private readonly ttlSeconds = REPORT_CACHE_TTL_SECONDS,
    private readonly logger?: Pick<AnalyticsContext['metrics'], 'log'>,
  ) {}
  static fromConfig(
    config: AnalyticsConfig,
    logger?: Pick<AnalyticsContext['metrics'], 'log'>,
  ): ReportingCache {
    if (!config.redis_url?.trim()) return ReportingCache.disabled();
    try {
      const url = new URL(config.redis_url);
      if (!['redis:', 'rediss:'].includes(url.protocol)) throw Error();
      return new ReportingCache(
        new RedisCacheBackend(config.redis_url),
        REPORT_CACHE_TTL_SECONDS,
        logger,
      );
    } catch (error) {
      logger?.log('warn', 'dependency.unavailable', {
        dependency: 'redis',
        operation: 'reporting_cache.configure',
        reason: 'invalid_configuration',
        error_type: error instanceof Error ? error.name : 'unknown',
      });
      return ReportingCache.disabled();
    }
  }
  static disabled(): ReportingCache {
    return new ReportingCache(null);
  }
  enabled(): boolean {
    return this.backend !== null;
  }
  async close(): Promise<void> {
    await this.backend?.close?.();
  }
  async read(key: string, now: Date = new Date()): Promise<CacheRead> {
    if (!this.backend) return { state: 'disabled' };
    let value: string | null;
    try {
      value = await this.backend.get(key);
    } catch (error) {
      this.logger?.log('warn', 'dependency.unavailable', {
        dependency: 'redis',
        operation: 'reporting_cache.get',
        error_type: error instanceof Error ? error.name : 'unknown',
      });
      return { state: 'unavailable' };
    }
    if (value === null) return { state: 'miss' };
    try {
      const cached = requiredObject(parseSerdeValueJson(value)),
        cachedAt = typedDate(cached.cached_at),
        response = decodeCachedResponse(cached.response);
      return timestampNanos(cachedAt) + BigInt(this.ttlSeconds) * 1000000000n <=
        timestampNanos(now)
        ? { state: 'stale' }
        : { state: 'hit', response };
    } catch (error) {
      this.logger?.log('warn', 'operation.failed', {
        operation: 'reporting_cache.decode',
        error_type: error instanceof Error ? error.name : 'unknown',
      });
      return { state: 'unavailable' };
    }
  }

  async write(
    key: string,
    response: ReportResponse,
    ttl: number,
  ): Promise<void> {
    if (!this.backend || ttl === 0) return;
    try {
      await this.backend.set(
        key,
        apiJson({ cached_at: new Date(), response: reportWire(response) }),
        ttl,
      );
    } catch (error) {
      this.logger?.log('warn', 'dependency.unavailable', {
        dependency: 'redis',
        operation: 'reporting_cache.set',
        error_type: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
// Cache keys use source struct field order, unlike canonical Value object serialization.
function orderedJson(value: unknown): string {
  if (value instanceof Date)
    return JSON.stringify(value.toISOString().replace(/\.000Z$/, 'Z'));
  if (Array.isArray(value)) return '[' + value.map(orderedJson).join(',') + ']';
  if (plainObject(value))
    return (
      '{' +
      Object.entries(value)
        .map(([key, item]) => JSON.stringify(key) + ':' + orderedJson(item))
        .join(',') +
      '}'
    );
  return canonicalJson(value);
}
export function reportCacheKey(
  grant: ReportingGrant,
  scope: AuthorizedScope,
  request: ReportQueryRequest,
  generation: bigint | null,
  version: string,
  registryHash: string,
): string {
  const serializedGrant = {
    grant_id: grant.grant_id,
    issuer: grant.issuer,
    audience: grant.audience,
    principal_type: grant.principal_type,
    principal_id: grant.principal_id,
    scope_id: grant.scope_id,
    root_scope_id: grant.root_scope_id,
    descendant_mode: grant.descendant_mode,
    explicit_descendant_scope_ids: grant.explicit_descendant_scope_ids,
    permissions: sortedStrings(grant.permissions),
    metric_keys: grant.metric_keys,
    dimension_keys: grant.dimension_keys,
    policy_version: grant.policy_version,
    issued_at: grant.issued_at,
    not_before: grant.not_before,
    expires_at: grant.expires_at,
    correlation_id: grant.correlation_id,
    revoked_at: grant.revoked_at,
  };
  const serializedRequest = {
    reporting_scope_id: request.reporting_scope_id,
    range_start: request.range_start,
    range_end: request.range_end,
    timezone: request.timezone,
    interval: request.interval,
    metrics: request.metrics,
    metric_set: request.metric_set,
    breakdowns: request.breakdowns,
    filters: Object.fromEntries(
      Object.keys(request.filters)
        .sort()
        .map((key) => [key, request.filters[key]]),
    ),
    include_descendants: request.include_descendants,
    comparison: request.comparison,
  };
  const payload = {
    schema_version: 1,
    grant: serializedGrant,
    requested_scope_id: scope.requested_scope_id,
    authorized_scope_ids: scope.authorized_scope_ids,
    generation_id: generation,
    projection_version: version,
    generation_registry_sha256: registryHash,
    request: serializedRequest,
  };
  return `kasitek:analytics:report:v1:${createHash('sha256').update(orderedJson(payload)).digest('hex')}`;
}
export function cacheTtlSeconds(
  grant: ReportingGrant,
  now: Date = new Date(),
): number {
  return Math.min(
    REPORT_CACHE_TTL_SECONDS,
    Math.max(
      0,
      Math.floor((grant.expires_at.getTime() - now.getTime()) / 1000),
    ),
  );
}
function errorResponse(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof ReportingError) {
    if (error.kind === 'unauthorized')
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'unauthorized' });
    if (error.kind === 'forbidden')
      return reply.code(403).send({ error: 'forbidden' });
    return reply
      .code(error.kind === 'invalid_request' ? 422 : 503)
      .send({ error: error.kind, message: error.message });
  }
  request.log.error(
    {
      event: 'operation.failed',
      operation: 'reporting_database.request',
      dependency: 'postgres',
      error_type: error instanceof Error ? error.name : 'unknown',
    },
    'reporting database operation failed',
  );
  return reply.code(500).send({ error: 'internal_error' });
}
export async function registerReportingRoutes(
  app: FastifyInstance,
  context: AnalyticsContext,
  options: { access?: ReportingAuthenticator; cache?: ReportingCache } = {},
): Promise<void> {
  const access =
      options.access ??
      (await ReportingAuthenticator.fromConfig(context.config)),
    cache =
      options.cache ??
      ReportingCache.fromConfig(context.config, context.metrics);
  app.addHook('onClose', async () => {
    await cache.close();
  });
  app.get(CATALOG_PATH, async (request, reply) => {
    const query = typedQuery(
        request.raw.url,
        ['reporting_scope_id'],
        {
          required: ['reporting_scope_id'],
          signedIntegers: ['reporting_scope_id'],
          denyUnknown: true,
        },
      ),
      scopeId = signedId(query.reporting_scope_id as bigint);
    try {
      const grant = await access.authenticate(request),
        response = await transaction(context.pool, async (tx) =>
          catalogResponse(
            context.registry,
            grant,
            await authorizeTransaction(tx, grant, scopeId),
          ),
        );
      return reply.type('application/json').send(apiJson(response));
    } catch (error) {
      return errorResponse(error, request, reply);
    }
  });
  app.post(QUERY_PATH, async (request, reply) => {
    let payload: ReportQueryRequest;
    try {
      payload = decodeReportRequest(request.body);
    } catch {
      return reply.code(400).type('text/plain').send('Json deserialize error');
    }
    try {
      const grant = await access.authenticate(request);
      const result = await transaction(context.pool, async (tx) => {
        const authorized = await authorizeTransaction(
          tx,
          grant,
          payload.reporting_scope_id,
        );
        if (cache.enabled()) {
          let key: string | null = null;
          try {
            const generation = await loadGeneration(
              tx,
              authorized.requested_scope_id,
            );
            key = reportCacheKey(
              grant,
              authorized,
              payload,
              generation?.generation_id ?? null,
              generation?.projection_version ?? PROJECTION_VERSION,
              generation?.registry_sha256 ?? context.registry.sha256,
            );
          } catch (error) {
            request.log.warn(
              {
                event: 'operation.failed',
                operation: 'reporting_generation.lookup',
                reason: 'cache_bypassed',
                error_type: error instanceof Error ? error.name : 'unknown',
              },
              'reporting cache bypassed',
            );
          }
          if (key) {
            const cached = await cache.read(key);
            if (cached.state === 'hit')
              return { response: cached.response, authorized, hit: true };
          }
        }
        return {
          response: await executeReport(
            tx,
            context.registry,
            grant,
            authorized,
            payload,
          ),
          authorized,
          hit: false,
        };
      });
      const { response, authorized, hit } = result;
      if (cache.enabled() && !hit)
        await cache.write(
          reportCacheKey(
            grant,
            authorized,
            payload,
            response.generation_id,
            response.projection_version,
            response.registry_sha256,
          ),
          response,
          cacheTtlSeconds(grant),
        );
      return reply.type('application/json').send(apiJson(reportWire(response)));
    } catch (error) {
      return errorResponse(error, request, reply);
    }
  });
}
