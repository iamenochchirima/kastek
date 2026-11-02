import type { Pool } from "pg";
import { createId } from "@paralleldrive/cuid2";
import {
  canonicalJson,
  SerdeFloat,
  wireInteger,
  integer,
} from "@kasitek-labs/server-support/json";
import { readConfig, type CoreConfig } from "../../config.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import { getSocialPost, listSocialPosts } from "./posts.js";
import { bad, parseOptionalDatetime, trimmed } from "./common.js";
import { epochMicros } from "../../analytics/facts.js";
import { facebookPublishedMutationTarget, providerJson, type ProviderOptions } from "./provider-publishing.js";
import { SQL } from "./insights-sql.js";
import type { SocialPost, SocialPublishJob } from "./types.js";
export const NORMALIZED_INSIGHT_METRICS = [
  "impressions",
  "reach",
  "likes",
  "comments",
  "shares",
  "clicks",
  "video_views",
];
export interface SocialPostInsightsFilters {
  platform: string | null;
  metricKeys: string[] | null;
  publishedFrom: Date | null;
  publishedTo: Date | null;
}
export interface InsightOptions extends ProviderOptions {
  config?: CoreConfig;
}
interface Observation {
  id: string;
  org_id: string;
  post_id: string;
  publish_job_id: string;
  platform: string;
  metric_key: string;
  value: string | number | bigint | null;
  availability: string;
  provider_metric_key: string | null;
  observation_key: string;
  observed_at: Date;
  fetched_at: Date;
  window_start: Date | null;
  window_end: Date | null;
  adapter_version: string;
  metadata: unknown;
}
interface SyncState {
  platform: string;
  status: string;
  retryable: boolean;
  consecutive_failures: number;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  next_retry_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
}
interface Metric {
  metricKey: string;
  value: number | bigint | null;
  availability: string;
  providerMetricKey: string | null;
  observedAt: Date;
  fetchedAt: Date;
  windowStart: Date | null;
  windowEnd: Date | null;
  previousValue: number | bigint | null;
  absoluteChange: number | bigint | null;
  percentageChange: SerdeFloat | null;
  history: {
    value: number | bigint | null;
    availability: string;
    observedAt: Date;
    fetchedAt: Date;
  }[];
}
interface PlatformInsights {
  platform: string;
  publishedAt: Date | null;
  dataStatus: string;
  syncStatus: string;
  syncRetryable: boolean;
  syncAttemptCount: number;
  lastSyncAt: Date | null;
  nextRetryAt: Date | null;
  syncErrorCode: string | null;
  metrics: Metric[];
}
export interface SocialPostInsights {
  postId: string;
  title: string | null;
  contentPreview: string;
  publishedAt: Date | null;
  platforms: PlatformInsights[];
  generatedAt: Date;
}
const exactTime = (value: Date | null) =>
  value === null ? -(1n << 100n) : epochMicros(value);
export function parseInsightsFilters(
  platform?: string | null,
  metrics?: string | null,
  from?: string | null,
  to?: string | null,
): SocialPostInsightsFilters {
  const normalized =
    trimmed(platform)?.replace(/[a-z]/g, (char) => char.toUpperCase()) ?? null;
  const keys =
    metrics
      ?.split(",")
      .map((value) =>
        value.trim().replace(/[A-Z]/g, (char) => char.toLowerCase()),
      )
      .filter(Boolean) ?? [];
  for (const key of keys)
    if (!NORMALIZED_INSIGHT_METRICS.includes(key))
      throw bad(`Invalid insight metric: ${key}`);
  const parse = (value: string | null | undefined, label: string) => {
    try {
      return parseOptionalDatetime(value);
    } catch {
      throw bad(`Invalid ${label} date`);
    }
  };
  const publishedFrom = parse(from, "publishedFrom"),
    publishedTo = parse(to, "publishedTo");
  if (
    publishedFrom &&
    publishedTo &&
    exactTime(publishedFrom) > exactTime(publishedTo)
  )
    throw bad("publishedFrom must be before publishedTo");
  return {
    platform: normalized,
    metricKeys: keys.length ? keys : null,
    publishedFrom,
    publishedTo,
  };
}
async function latestObservations(
  pool: Pool,
  org: string,
  post: string,
  filters: SocialPostInsightsFilters,
): Promise<Observation[]> {
  const params: unknown[] = [org, post];
  let query = SQL[0] + "$1" + SQL[1] + "$2";
  if (filters.platform) {
    params.push(filters.platform);
    query += SQL[2] + `$${params.length}` + SQL[3];
  }
  if (filters.metricKeys) {
    query +=
      SQL[4] +
      filters.metricKeys
        .map((key) => {
          params.push(key);
          return `$${params.length}`;
        })
        .join(", ") +
      ")";
  }
  query += SQL[5];
  return (await pool.query<Observation>(query, params)).rows;
}
async function loadSyncStates(
  pool: Pool,
  org: string,
): Promise<Map<string, SyncState>> {
  const rows = (await pool.query<SyncState>(SQL[6], [org])).rows;
  return new Map(rows.map((row) => [row.platform, row]));
}
function buildPostInsights(
  post: SocialPost,
  rows: Observation[],
  filters: SocialPostInsightsFilters,
  states: Map<string, SyncState>,
): SocialPostInsights {
  const grouped = new Map<string, Observation[]>();
  for (const row of rows) {
    const key = `${row.publish_job_id}\0${row.metric_key}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const byJob = new Map<string, Metric[]>();
  for (const [, items] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    items.sort((a, b) =>
      exactTime(a.observed_at) > exactTime(b.observed_at)
        ? -1
        : exactTime(a.observed_at) < exactTime(b.observed_at)
          ? 1
          : 0,
    );
    const latest = items[0]!,
      previous = items[1];
    const value = latest.value === null ? null : wireInteger(latest.value),
      previousValue =
        previous?.value == null ? null : wireInteger(previous.value);
    const difference =
      value !== null && previousValue !== null
        ? integer(value) - integer(previousValue)
        : null;
    const metric: Metric = {
      metricKey: latest.metric_key,
      value,
      availability: latest.availability,
      providerMetricKey: latest.provider_metric_key,
      observedAt: latest.observed_at,
      fetchedAt: latest.fetched_at,
      windowStart: latest.window_start,
      windowEnd: latest.window_end,
      previousValue,
      absoluteChange: difference === null ? null : wireInteger(difference),
      percentageChange:
        difference === null || integer(previousValue!) === 0n
          ? null
          : new SerdeFloat(
              (Number(difference) / Number(integer(previousValue!))) * 100,
            ),
      history: items.map((item) => ({
        value: item.value === null ? null : wireInteger(item.value),
        availability: item.availability,
        observedAt: item.observed_at,
        fetchedAt: item.fetched_at,
      })),
    };
    byJob.set(latest.publish_job_id, [
      ...(byJob.get(latest.publish_job_id) ?? []),
      metric,
    ]);
  }
  const jobs = post.publishJobs
    .filter(
      (job) =>
        job.status === "PUBLISHED" &&
        job.external_post_id !== null &&
        (!filters.platform || job.platform === filters.platform),
    )
    .sort((a, b) =>
      exactTime(a.published_at) > exactTime(b.published_at)
        ? -1
        : exactTime(a.published_at) < exactTime(b.published_at)
          ? 1
          : 0,
    );
  const selected = new Map<string, SocialPublishJob>();
  for (const job of jobs)
    if (!selected.has(job.platform)) selected.set(job.platform, job);
  const platforms = [...selected]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, job]) => {
      const metrics = (byJob.get(job.id) ?? [])
        .filter(
          (metric) =>
            !filters.metricKeys ||
            filters.metricKeys.includes(metric.metricKey),
        )
        .sort((a, b) => a.metricKey.localeCompare(b.metricKey));
      const state = states.get(platform);
      return {
        platform,
        publishedAt: job.published_at,
        dataStatus: !metrics.length
          ? "not_synced"
          : metrics.some((metric) => metric.value !== null)
            ? "available"
            : metrics[0]!.availability,
        syncStatus: state?.status ?? "IDLE",
        syncRetryable: state?.retryable ?? false,
        syncAttemptCount: state?.consecutive_failures ?? 0,
        lastSyncAt: state?.last_attempt_at ?? null,
        nextRetryAt: state?.next_retry_at ?? null,
        syncErrorCode: state?.last_error_code ?? null,
        metrics,
      };
    });
  const chars = Array.from(post.content.trim());
  return {
    postId: post.id,
    title: post.title,
    contentPreview:
      chars.slice(0, 240).join("") + (chars.length > 240 ? "…" : ""),
    publishedAt: post.published_at,
    platforms,
    generatedAt: new Date(),
  };
}
export async function getSocialPostInsights(
  pool: Pool,
  org: string,
  id: string,
  filters: SocialPostInsightsFilters,
): Promise<SocialPostInsights | undefined> {
  const post = await getSocialPost(pool, org, id);
  if (!post) return undefined;
  return buildPostInsights(
    post,
    await latestObservations(pool, org, id, filters),
    filters,
    await loadSyncStates(pool, org),
  );
}
export async function listSocialPostInsights(
  pool: Pool,
  org: string,
  filters: SocialPostInsightsFilters,
  limit: number,
) {
  let posts = (await listSocialPosts(pool, org)).filter(
    (post) =>
      post.status === "PUBLISHED" &&
      (!filters.platform ||
        post.publishJobs.some(
          (job) =>
            job.status === "PUBLISHED" &&
            job.platform.toUpperCase() === filters.platform,
        )) &&
      (!filters.publishedFrom ||
        (post.published_at !== null &&
          exactTime(post.published_at) >= exactTime(filters.publishedFrom))) &&
      (!filters.publishedTo ||
        (post.published_at !== null &&
          exactTime(post.published_at) <= exactTime(filters.publishedTo))),
  );
  posts.sort((a, b) =>
    exactTime(a.published_at) > exactTime(b.published_at)
      ? -1
      : exactTime(a.published_at) < exactTime(b.published_at)
        ? 1
        : 0,
  );
  const totalPosts = posts.length,
    hasMore = posts.length > Math.max(1, Math.min(100, limit));
  posts = posts.slice(0, Math.max(1, Math.min(100, limit)));
  const states = await loadSyncStates(pool, org);
  const result: SocialPostInsights[] = [];
  for (const post of posts)
    result.push(
      buildPostInsights(
        post,
        await latestObservations(pool, org, post.id, filters),
        filters,
        states,
      ),
    );
  const sums = new Map<
      string,
      {
        platform: string;
        metricKey: string;
        totalValue: bigint;
        postsWithValue: number;
      }
    >(),
    coverage = new Map<
      string,
      {
        platform: string;
        postCount: number;
        syncedPostCount: number;
        reportedMetricCount: number;
        availableMetricCount: number;
      }
    >();
  for (const post of result)
    for (const platform of post.platforms) {
      const item = coverage.get(platform.platform) ?? {
        platform: platform.platform,
        postCount: 0,
        syncedPostCount: 0,
        reportedMetricCount: 0,
        availableMetricCount: 0,
      };
      item.postCount++;
      if (platform.dataStatus !== "not_synced") item.syncedPostCount++;
      for (const metric of platform.metrics) {
        item.reportedMetricCount++;
        if (metric.value !== null) {
          item.availableMetricCount++;
          const key = `${platform.platform}\0${metric.metricKey}`,
            aggregate = sums.get(key) ?? {
              platform: platform.platform,
              metricKey: metric.metricKey,
              totalValue: 0n,
              postsWithValue: 0,
            };
          aggregate.totalValue += integer(metric.value);
          aggregate.postsWithValue++;
          sums.set(key, aggregate);
        }
      }
      coverage.set(platform.platform, item);
    }
  return {
    posts: result,
    totalPosts,
    hasMore,
    aggregates: [...sums]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => ({ ...row, totalValue: wireInteger(row.totalValue) })),
    coverage: [...coverage]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row),
    generatedAt: new Date(),
  };
}
export async function insertObservation(
  pool: Pool,
  row: Observation,
): Promise<void> {
  await pool.query(SQL[7], [
    row.id,
    row.org_id,
    row.post_id,
    row.publish_job_id,
    row.platform,
    row.metric_key,
    row.value,
    row.availability,
    row.provider_metric_key,
    row.observation_key,
    row.observed_at.toISOString(),
    row.fetched_at.toISOString(),
    row.window_start?.toISOString() ?? null,
    row.window_end?.toISOString() ?? null,
    row.adapter_version,
    row.metadata == null ? null : canonicalJson(row.metadata),
  ]);
}
interface Reading {
  value: bigint | null;
  availability: string;
  providerMetricKey: string | null;
}
function emptyReadings(availability: string): Map<string, Reading> {
  return new Map(
    NORMALIZED_INSIGHT_METRICS.map((metric) => [
      metric,
      { value: null, availability, providerMetricKey: null },
    ]),
  );
}
export function numericValue(value: unknown): bigint | null {
  if (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    const parsed = BigInt(value);
    return parsed >= -(1n << 63n) && parsed < 1n << 63n ? parsed : null;
  }
  if (
    value &&
    typeof value === "object" &&
    !(value instanceof SerdeFloat) &&
    !Array.isArray(value)
  ) {
    let total = 0n;
    for (const item of Object.values(value)) {
      const current = numericValue(item);
      if (current === null) return null;
      total += current;
      total =
        total < -(1n << 63n)
          ? -(1n << 63n)
          : total >= 1n << 63n
            ? (1n << 63n) - 1n
            : total;
    }
    return total;
  }
  return null;
}
function reading(value: bigint | null, key: string): Reading {
  return {
    value,
    availability: value === null ? "not_reported" : "available",
    providerMetricKey: key,
  };
}
function graphMetricValue(
  payload: Record<string, any>,
  key: string,
): bigint | null {
  for (const item of Array.isArray(payload.data) ? payload.data : []) {
    if ((item.name ?? item.metric) !== key) continue;
    const values = Array.isArray(item.values) ? item.values : [],
      last = values.at(-1);
    const value = last === undefined ? null : numericValue(last?.value ?? last);
    if (value !== null) return value;
    const direct = numericValue(item.value);
    if (direct !== null) return direct;
  }
  return null;
}
export async function fetchProviderMetrics(
  platform: string,
  id: string,
  token: string | null,
  metadata: Record<string, unknown> | null,
  options: ProviderOptions = {},
): Promise<Map<string, Reading>> {
  const readings = emptyReadings("not_reported");
  const put = (metric: string, value: unknown, key: string) =>
    readings.set(metric, reading(numericValue(value), key));
  const bearer = () => {
    if (token === null)
      throw bad(
        `${platform === "LINKEDIN" ? "LinkedIn" : platform === "TIKTOK" ? "TikTok" : platform} connection is missing an access token`,
      );
    return { Authorization: `Bearer ${token}` };
  };
  if (platform === "BLUESKY") {
    const result = await providerJson(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${new URLSearchParams({ uris: id })}`,
      {},
      "Bluesky post insights request failed",
      options,
    );
    const post = Array.isArray(result.posts) ? result.posts[0] : undefined;
    if (!post) throw bad("Bluesky post was not found");
    for (const [metric, key] of [
      ["likes", "likeCount"],
      ["comments", "replyCount"],
      ["shares", "repostCount"],
    ])
      put(metric!, post[key!], key!);
    return readings;
  }
  if (platform === "X") {
    const result = await providerJson(
      `https://api.x.com/2/tweets/${id}?tweet.fields=public_metrics`,
      { headers: bearer() },
      "X post insights request failed",
      options,
    );
    if (result.data?.public_metrics)
      for (const [metric, key] of [
        ["impressions", "impression_count"],
        ["likes", "like_count"],
        ["comments", "reply_count"],
        ["shares", "retweet_count"],
      ])
        put(metric!, result.data.public_metrics[key!], key!);
    return readings;
  }
  if (platform === "LINKEDIN") {
    const auth = bearer();
    if (
      typeof metadata?.scope === "string" &&
      !metadata.scope.split(/\s+/).includes("r_member_postAnalytics")
    )
      return emptyReadings("not_authorized");
    const result = await providerJson(
      `https://api.linkedin.com/rest/memberCreatorPostAnalytics?${new URLSearchParams({ q: "entity", entity: id, aggregation: "TOTAL" })}`,
      {
        headers: {
          ...auth,
          "Linkedin-Version": "202606",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
      "LinkedIn post insights request failed",
      options,
    );
    for (const [metric, key] of [
      ["impressions", "IMPRESSION"],
      ["reach", "MEMBERS_REACHED"],
      ["likes", "REACTION"],
      ["comments", "COMMENT"],
      ["shares", "RESHARE"],
      ["clicks", "LINK_CLICKS"],
      ["video_views", "VIDEO_VIEW"],
    ]) {
      let value: bigint | null = null;
      for (const item of Array.isArray(result.elements)
        ? result.elements
        : []) {
        if ((item.metricType ?? item.metric) === key) {
          const candidate = item.metricValue ?? item.value;
          if (typeof candidate === "number" || typeof candidate === "bigint")
            value = numericValue(candidate);
          if (value !== null) break;
        }
      }
      readings.set(metric!, reading(value, key!));
    }
    return readings;
  }
  if (["FACEBOOK", "INSTAGRAM", "THREADS"].includes(platform)) {
    bearer();
    const mapping: Record<string, string[]> =
      platform === "FACEBOOK"
        ? {
            impressions: ["post_impressions"],
            reach: ["post_reach"],
            likes: ["post_reactions_by_type_total"],
            comments: ["post_comments"],
            shares: ["post_shares"],
            clicks: ["post_clicks"],
            video_views: ["post_video_views"],
          }
        : platform === "INSTAGRAM"
          ? {
              impressions: ["impressions"],
              reach: ["reach"],
              likes: ["likes"],
              comments: ["comments"],
              shares: ["shares"],
              clicks: ["saved"],
              video_views: ["video_views"],
            }
          : {
              impressions: ["views"],
              reach: ["views"],
              likes: ["likes"],
              comments: ["replies"],
              shares: ["reposts"],
              clicks: ["quotes"],
              video_views: ["views"],
            };
    const metrics =
      platform === "FACEBOOK"
        ? "post_impressions,post_reach,post_reactions_by_type_total,post_comments,post_shares,post_clicks,post_video_views"
        : platform === "INSTAGRAM"
          ? "impressions,reach,likes,comments,shares,saved,video_views"
          : "views,likes,replies,reposts,quotes";
    const graph =
      platform === "INSTAGRAM"
        ? "https://graph.instagram.com/v23.0"
        : platform === "THREADS"
          ? "https://graph.threads.com/v1.0"
          : "https://graph.facebook.com/v23.0";
    const result = await providerJson(
      `${graph}/${id}/insights?${new URLSearchParams({ metric: metrics, access_token: token! })}`,
      {},
      "Meta post insights request failed",
      options,
    );
    for (const [metric, [key]] of Object.entries(mapping))
      readings.set(metric, reading(graphMetricValue(result, key!), key!));
    return readings;
  }
  if (platform === "TIKTOK") {
    const result = await providerJson(
      "https://open.tiktokapis.com/v2/video/query/",
      {
        method: "POST",
        headers: { ...bearer(), "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: { video_ids: [id] },
          fields: [
            "id",
            "view_count",
            "like_count",
            "comment_count",
            "share_count",
          ],
        }),
      },
      "TikTok post insights request failed",
      options,
    );
    const video = Array.isArray(result.data?.videos)
      ? result.data.videos[0]
      : undefined;
    if (!video) throw bad("TikTok post was not found");
    for (const [metric, key] of [
      ["impressions", "view_count"],
      ["reach", "view_count"],
      ["likes", "like_count"],
      ["comments", "comment_count"],
      ["shares", "share_count"],
    ])
      put(metric!, video[key!], key!);
    return readings;
  }
  return emptyReadings("unsupported");
}
interface Outcome {
  status: string;
  retryable: boolean;
  errorCode: string | null;
}
const success = (): Outcome => ({
  status: "SUCCESS",
  retryable: false,
  errorCode: null,
});
const notAuthorized = (): Outcome => ({
  status: "NOT_AUTHORIZED",
  retryable: false,
  errorCode: "token_unavailable",
});
async function writeJobObservations(
  pool: Pool,
  org: string,
  post: SocialPost,
  job: SocialPublishJob,
  config: CoreConfig,
  options: ProviderOptions,
): Promise<Outcome> {
  const observed = new Date(),
    bucket = Math.trunc(observed.getTime() / 300000);
  const credentials =
    job.channel_connection_id === null
      ? undefined
      : (await pool.query(SQL[8], [job.channel_connection_id, org])).rows[0];
  let readings: Map<string, Reading>, outcome: Outcome;
  if (!credentials) {
    readings = emptyReadings("not_configured");
    outcome = {
      status: "NOT_CONFIGURED",
      retryable: false,
      errorCode: "connection_unavailable",
    };
  } else {
    let token: string | null;
    try {
      token =
        credentials.access_token === null
          ? null
          : decryptSocialSecret(config, credentials.access_token);
    } catch {
      token = null;
      readings = emptyReadings("not_authorized");
      outcome = notAuthorized();
      await persist(readings, outcome);
      return outcome;
    }
    try {
      readings = await fetchProviderMetrics(
        credentials.platform,
        credentials.platform === "FACEBOOK"
          ? facebookPublishedMutationTarget(job.external_post_id ?? "", job.metadata)
          : job.external_post_id ?? "",
        token,
        credentials.metadata,
        options,
      );
      outcome = success();
    } catch (error) {
      readings = emptyReadings("temporarily_unavailable");
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      outcome = /401|403|unauthorized|forbidden/.test(message)
        ? notAuthorized()
        : {
            status: "RETRYABLE_FAILURE",
            retryable: true,
            errorCode: "provider_fetch_failed",
          };
    }
  }
  async function persist(values: Map<string, Reading>, result: Outcome) {
    for (const metric of NORMALIZED_INSIGHT_METRICS) {
      const current = values.get(metric) ?? {
        value: null,
        availability: "unsupported",
        providerMetricKey: null,
      };
      await insertObservation(pool, {
        id: createId(),
        org_id: org,
        post_id: post.id,
        publish_job_id: job.id,
        platform: job.platform,
        metric_key: metric,
        value: current.value,
        availability: current.availability,
        provider_metric_key: current.providerMetricKey,
        observation_key: `${job.id}:${metric}:${bucket}`,
        observed_at: observed,
        fetched_at: new Date(),
        window_start: null,
        window_end: null,
        adapter_version: "social-insights-v1",
        metadata:
          result.errorCode === null ? null : { status: result.errorCode },
      });
    }
  }
  await persist(readings, outcome);
  return outcome;
}
async function recordSyncState(
  pool: Pool,
  org: string,
  platform: string,
  outcome: Outcome,
) {
  const now = new Date();
  await pool.query(SQL[9], [
    createId(),
    org,
    platform,
    outcome.status,
    outcome.retryable,
    now.toISOString(),
    outcome.status === "SUCCESS"
      ? null
      : new Date(now.getTime() + 900000).toISOString(),
    outcome.errorCode,
    now.toISOString(),
  ]);
}
async function syncInsights(
  pool: Pool,
  org: string,
  postId: string | null,
  limit: number,
  force: boolean,
  options: InsightOptions,
): Promise<number> {
  const config = options.config ?? readConfig();
  const posts = (await listSocialPosts(pool, org))
    .filter(
      (post) =>
        post.status === "PUBLISHED" && (postId === null || post.id === postId),
    )
    .sort((a, b) =>
      exactTime(a.published_at) > exactTime(b.published_at)
        ? -1
        : exactTime(a.published_at) < exactTime(b.published_at)
          ? 1
          : 0,
    )
    .slice(0, Math.max(1, Math.min(100, limit)));
  const states = await loadSyncStates(pool, org),
    now = new Date();
  let count = 0;
  for (const post of posts)
    for (const job of post.publishJobs.filter(
      (job) =>
        job.status === "PUBLISHED" &&
        job.external_post_id !== null &&
        (force ||
          !states.get(job.platform)?.next_retry_at ||
          exactTime(states.get(job.platform)!.next_retry_at) <= exactTime(now)),
    )) {
      const outcome = await writeJobObservations(
        pool,
        org,
        post,
        job,
        config,
        options,
      );
      await recordSyncState(pool, org, job.platform, outcome);
      count++;
    }
  return count;
}
export function syncSocialPostInsights(
  pool: Pool,
  org: string,
  postId: string | null,
  limit: number,
  options: InsightOptions = {},
) {
  return syncInsights(pool, org, postId, limit, false, options);
}
export function forceSyncSocialPostInsights(
  pool: Pool,
  org: string,
  postId: string | null,
  limit: number,
  options: InsightOptions = {},
) {
  return syncInsights(pool, org, postId, limit, true, options);
}
export async function syncAllSocialPostInsights(
  pool: Pool,
  limit: number,
  options: InsightOptions = {},
): Promise<number> {
  const orgs = (await pool.query<{ id: string }>(SQL[10])).rows;
  let synced = 0;
  for (const org of orgs)
    synced += await syncSocialPostInsights(pool, org.id, null, limit, options);
  return synced;
}
