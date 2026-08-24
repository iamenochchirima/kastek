//! Organization-scoped, provider-neutral social post insight observations.
//!
//! Provider adapters write observations here; the product and Agent Platform
//! read the same projection. Missing provider data is represented explicitly
//! and is never converted into a zero.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, QueryBuilder};
use std::collections::{BTreeMap, HashMap};

use crate::db::models::{
    SocialPost, SocialPostInsightObservationRow, SocialPostInsightSyncStateRow, SocialPublishJobRow,
};
use crate::error::AppError;
use crate::services::social_posts;

pub const NORMALIZED_INSIGHT_METRICS: [&str; 7] = [
    "impressions",
    "reach",
    "likes",
    "comments",
    "shares",
    "clicks",
    "video_views",
];

#[derive(Debug, Clone, Default)]
pub struct SocialPostInsightsFilters {
    pub platform: Option<String>,
    pub metric_keys: Option<Vec<String>>,
    pub published_from: Option<DateTime<Utc>>,
    pub published_to: Option<DateTime<Utc>>,
}

/// Parse the public query representation once so the product API and the
/// agent API apply exactly the same validation and filtering rules.
pub fn parse_insights_filters(
    platform: Option<&str>,
    metrics: Option<&str>,
    published_from: Option<&str>,
    published_to: Option<&str>,
) -> Result<SocialPostInsightsFilters, AppError> {
    let platform = platform
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase());
    let metric_keys = metrics
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|metric| !metric.is_empty())
                .map(str::to_ascii_lowercase)
                .collect::<Vec<_>>()
        })
        .filter(|metrics| !metrics.is_empty());

    if let Some(metric_keys) = metric_keys.as_ref() {
        if let Some(metric) = metric_keys
            .iter()
            .find(|metric| !NORMALIZED_INSIGHT_METRICS.contains(&metric.as_str()))
        {
            return Err(AppError::BadRequest(format!(
                "Invalid insight metric: {metric}"
            )));
        }
    }

    let parse_date = |value: Option<&str>, label: &str| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                DateTime::parse_from_rfc3339(value)
                    .map(|date| date.with_timezone(&Utc))
                    .map_err(|_| AppError::BadRequest(format!("Invalid {label} date")))
            })
            .transpose()
    };
    let published_from = parse_date(published_from, "publishedFrom")?;
    let published_to = parse_date(published_to, "publishedTo")?;
    if let (Some(from), Some(to)) = (published_from, published_to) {
        if from > to {
            return Err(AppError::BadRequest(
                "publishedFrom must be before publishedTo".to_string(),
            ));
        }
    }

    Ok(SocialPostInsightsFilters {
        platform,
        metric_keys,
        published_from,
        published_to,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPostInsightMetric {
    pub metric_key: String,
    pub value: Option<i64>,
    pub availability: String,
    pub provider_metric_key: Option<String>,
    pub observed_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    pub window_start: Option<DateTime<Utc>>,
    pub window_end: Option<DateTime<Utc>>,
    pub previous_value: Option<i64>,
    pub absolute_change: Option<i64>,
    pub percentage_change: Option<f64>,
    pub history: Vec<SocialPostInsightPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPostInsightPoint {
    pub value: Option<i64>,
    pub availability: String,
    pub observed_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPlatformInsights {
    pub platform: String,
    pub published_at: Option<DateTime<Utc>>,
    pub data_status: String,
    pub sync_status: String,
    pub sync_retryable: bool,
    pub sync_attempt_count: i32,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub sync_error_code: Option<String>,
    pub metrics: Vec<SocialPostInsightMetric>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPostInsights {
    pub post_id: String,
    pub title: Option<String>,
    pub content_preview: String,
    pub published_at: Option<DateTime<Utc>>,
    pub platforms: Vec<SocialPlatformInsights>,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPostInsightsReport {
    pub posts: Vec<SocialPostInsights>,
    pub total_posts: usize,
    pub has_more: bool,
    pub aggregates: Vec<SocialInsightAggregate>,
    pub coverage: Vec<SocialInsightCoverage>,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialInsightAggregate {
    pub platform: String,
    pub metric_key: String,
    pub total_value: i64,
    pub posts_with_value: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialInsightCoverage {
    pub platform: String,
    pub post_count: usize,
    pub synced_post_count: usize,
    pub reported_metric_count: usize,
    pub available_metric_count: usize,
}

#[derive(Debug, Clone)]
struct MetricHistory {
    latest: SocialPostInsightObservationRow,
    previous: Option<SocialPostInsightObservationRow>,
    history: Vec<SocialPostInsightPoint>,
}

fn content_preview(content: &str) -> String {
    let preview = content.trim().chars().take(240).collect::<String>();
    if content.trim().chars().count() > 240 {
        format!("{preview}…")
    } else {
        preview
    }
}

fn percentage_change(previous: Option<i64>, latest: Option<i64>) -> Option<f64> {
    let (Some(previous), Some(latest)) = (previous, latest) else {
        return None;
    };
    if previous == 0 {
        return None;
    }
    Some(((latest - previous) as f64 / previous as f64) * 100.0)
}

fn metric_from_history(history: MetricHistory) -> SocialPostInsightMetric {
    let previous_value = history.previous.as_ref().and_then(|row| row.value);
    let latest_value = history.latest.value;
    SocialPostInsightMetric {
        metric_key: history.latest.metric_key,
        value: latest_value,
        availability: history.latest.availability,
        provider_metric_key: history.latest.provider_metric_key,
        observed_at: history.latest.observed_at,
        fetched_at: history.latest.fetched_at,
        window_start: history.latest.window_start,
        window_end: history.latest.window_end,
        previous_value,
        absolute_change: latest_value
            .zip(previous_value)
            .map(|(latest, previous)| latest - previous),
        percentage_change: percentage_change(previous_value, latest_value),
        history: history.history,
    }
}

fn histories(rows: Vec<SocialPostInsightObservationRow>) -> HashMap<String, Vec<MetricHistory>> {
    let mut grouped = BTreeMap::<(String, String), Vec<SocialPostInsightObservationRow>>::new();
    for row in rows {
        grouped
            .entry((row.publish_job_id.clone(), row.metric_key.clone()))
            .or_default()
            .push(row);
    }

    let mut result = HashMap::<String, Vec<MetricHistory>>::new();
    for ((publish_job_id, _), mut values) in grouped {
        values.sort_by(|left, right| right.observed_at.cmp(&left.observed_at));
        let mut values = values.into_iter();
        if let Some(latest) = values.next() {
            let previous = values.next();
            let mut history = vec![SocialPostInsightPoint {
                value: latest.value,
                availability: latest.availability.clone(),
                observed_at: latest.observed_at,
                fetched_at: latest.fetched_at,
            }];
            if let Some(previous) = previous.as_ref() {
                history.push(SocialPostInsightPoint {
                    value: previous.value,
                    availability: previous.availability.clone(),
                    observed_at: previous.observed_at,
                    fetched_at: previous.fetched_at,
                });
            }
            history.extend(values.map(|row| SocialPostInsightPoint {
                value: row.value,
                availability: row.availability,
                observed_at: row.observed_at,
                fetched_at: row.fetched_at,
            }));
            result
                .entry(publish_job_id)
                .or_default()
                .push(MetricHistory {
                    latest,
                    previous,
                    history,
                });
        }
    }
    result
}

async fn load_latest_observations(
    pool: &PgPool,
    org_id: &str,
    post_id: &str,
    filters: &SocialPostInsightsFilters,
) -> Result<Vec<SocialPostInsightObservationRow>, AppError> {
    let mut query = QueryBuilder::<Postgres>::new(
        r#"
        WITH ranked AS (
            SELECT id, "orgId" AS org_id, "postId" AS post_id,
                   "publishJobId" AS publish_job_id, platform::text AS platform,
                   "metricKey" AS metric_key, value, availability,
                   "providerMetricKey" AS provider_metric_key,
                   "observationKey" AS observation_key,
                   "observedAt" AT TIME ZONE 'UTC' AS observed_at,
                   "fetchedAt" AT TIME ZONE 'UTC' AS fetched_at,
                   "windowStart" AT TIME ZONE 'UTC' AS window_start,
                   "windowEnd" AT TIME ZONE 'UTC' AS window_end,
                   "adapterVersion" AS adapter_version, metadata,
                   ROW_NUMBER() OVER (
                       PARTITION BY "publishJobId", "metricKey"
                       ORDER BY "observedAt" DESC
                   ) AS observation_rank
            FROM "SocialPostInsightObservation"
            WHERE "orgId" =
        "#,
    );
    query.push_bind(org_id);
    query.push(r#" AND "postId" = "#);
    query.push_bind(post_id);
    if let Some(platform) = filters.platform.as_deref() {
        query.push(r#" AND platform = "#);
        query.push_bind(platform.to_string());
        query.push(r#"::"SocialPlatform""#);
    }
    if let Some(metric_keys) = filters.metric_keys.as_ref() {
        query.push(r#" AND "metricKey" IN ("#);
        for (index, metric_key) in metric_keys.iter().enumerate() {
            if index > 0 {
                query.push(", ");
            }
            query.push_bind(metric_key);
        }
        query.push(")");
    }
    query.push(
        r#"
        )
        SELECT id, org_id, post_id, publish_job_id, platform, metric_key, value,
               availability, provider_metric_key, observation_key, observed_at,
               fetched_at, window_start, window_end, adapter_version, metadata
        FROM ranked
        WHERE observation_rank <= 50
        ORDER BY observed_at DESC
        "#,
    );

    sqlx::query_as::<_, SocialPostInsightObservationRow>(query.sql())
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
}

async fn load_sync_states(
    pool: &PgPool,
    org_id: &str,
) -> Result<HashMap<String, SocialPostInsightSyncStateRow>, AppError> {
    let states = sqlx::query_as::<_, SocialPostInsightSyncStateRow>(
        r#"
        SELECT platform::text AS platform,
               status,
               retryable,
               "consecutiveFailures" AS consecutive_failures,
               "lastAttemptAt" AT TIME ZONE 'UTC' AS last_attempt_at,
               "lastSuccessAt" AT TIME ZONE 'UTC' AS last_success_at,
               "nextRetryAt" AT TIME ZONE 'UTC' AS next_retry_at,
               "lastErrorCode" AS last_error_code,
               "lastErrorMessage" AS last_error_message
        FROM "SocialPostInsightSyncState"
        WHERE "orgId" = $1
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)?;
    Ok(states
        .into_iter()
        .map(|state| (state.platform.clone(), state))
        .collect())
}

fn platform_insights(
    post: &SocialPost,
    histories_by_job: &HashMap<String, Vec<MetricHistory>>,
    filters: &SocialPostInsightsFilters,
    sync_states: &HashMap<String, SocialPostInsightSyncStateRow>,
) -> Vec<SocialPlatformInsights> {
    let mut jobs = post
        .publish_jobs
        .iter()
        .filter(|job| job.status == "PUBLISHED" && job.external_post_id.is_some())
        .filter(|job| {
            filters
                .platform
                .as_deref()
                .is_none_or(|platform| job.platform == platform)
        })
        .collect::<Vec<_>>();
    jobs.sort_by(|left, right| right.published_at.cmp(&left.published_at));

    let mut selected = BTreeMap::<String, &SocialPublishJobRow>::new();
    for job in jobs {
        selected.entry(job.platform.clone()).or_insert(job);
    }

    selected
        .into_iter()
        .map(|(platform, job)| {
            let mut metrics = histories_by_job
                .get(&job.id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(metric_from_history)
                .filter(|metric| {
                    filters
                        .metric_keys
                        .as_ref()
                        .is_none_or(|keys| keys.iter().any(|key| key == &metric.metric_key))
                })
                .collect::<Vec<_>>();
            metrics.sort_by(|left, right| left.metric_key.cmp(&right.metric_key));
            let data_status = if metrics.is_empty() {
                "not_synced".to_string()
            } else if metrics.iter().any(|metric| metric.value.is_some()) {
                "available".to_string()
            } else {
                metrics
                    .first()
                    .map(|metric| metric.availability.clone())
                    .unwrap_or_else(|| "not_synced".to_string())
            };
            let sync_state = sync_states.get(&platform);
            SocialPlatformInsights {
                platform,
                published_at: job.published_at,
                data_status,
                sync_status: sync_state
                    .map(|state| state.status.clone())
                    .unwrap_or_else(|| "IDLE".to_string()),
                sync_retryable: sync_state.is_some_and(|state| state.retryable),
                sync_attempt_count: sync_state
                    .map(|state| state.consecutive_failures)
                    .unwrap_or_default(),
                last_sync_at: sync_state.and_then(|state| state.last_attempt_at),
                next_retry_at: sync_state.and_then(|state| state.next_retry_at),
                sync_error_code: sync_state.and_then(|state| state.last_error_code.clone()),
                metrics,
            }
        })
        .collect()
}

fn build_post_insights(
    post: SocialPost,
    rows: Vec<SocialPostInsightObservationRow>,
    filters: &SocialPostInsightsFilters,
    sync_states: &HashMap<String, SocialPostInsightSyncStateRow>,
) -> SocialPostInsights {
    let histories_by_job = histories(rows);
    SocialPostInsights {
        post_id: post.row.id.clone(),
        title: post.row.title.clone(),
        content_preview: content_preview(&post.row.content),
        published_at: post.row.published_at,
        platforms: platform_insights(&post, &histories_by_job, filters, sync_states),
        generated_at: Utc::now(),
    }
}

pub async fn get_social_post_insights(
    pool: &PgPool,
    org_id: &str,
    post_id: &str,
    filters: &SocialPostInsightsFilters,
) -> Result<Option<SocialPostInsights>, AppError> {
    let Some(post) = social_posts::get_social_post(pool, org_id, post_id).await? else {
        return Ok(None);
    };
    let rows = load_latest_observations(pool, org_id, post_id, filters).await?;
    let sync_states = load_sync_states(pool, org_id).await?;
    Ok(Some(build_post_insights(post, rows, filters, &sync_states)))
}

pub async fn list_social_post_insights(
    pool: &PgPool,
    org_id: &str,
    filters: &SocialPostInsightsFilters,
    limit: i64,
) -> Result<SocialPostInsightsReport, AppError> {
    let posts = social_posts::list_social_posts(pool, org_id).await?;
    let mut published = posts
        .into_iter()
        .filter(|post| post.row.status == "PUBLISHED")
        .filter(|post| {
            filters.platform.as_deref().is_none_or(|wanted| {
                post.publish_jobs.iter().any(|job| {
                    job.status == "PUBLISHED" && job.platform.eq_ignore_ascii_case(wanted)
                })
            })
        })
        .filter(|post| {
            filters.published_from.is_none_or(|from| {
                post.row
                    .published_at
                    .is_some_and(|published| published >= from)
            })
        })
        .filter(|post| {
            filters.published_to.is_none_or(|to| {
                post.row
                    .published_at
                    .is_some_and(|published| published <= to)
            })
        })
        .collect::<Vec<_>>();
    published.sort_by(|left, right| right.row.published_at.cmp(&left.row.published_at));

    let limit = limit.clamp(1, 100) as usize;
    let has_more = published.len() > limit;
    let total_posts = published.len();
    published.truncate(limit);

    let sync_states = load_sync_states(pool, org_id).await?;
    let mut result = Vec::with_capacity(published.len());
    for post in published {
        let rows = load_latest_observations(pool, org_id, &post.row.id, filters).await?;
        result.push(build_post_insights(post, rows, filters, &sync_states));
    }

    let (aggregates, coverage) = summarize_report(&result);

    Ok(SocialPostInsightsReport {
        total_posts,
        posts: result,
        has_more,
        aggregates,
        coverage,
        generated_at: Utc::now(),
    })
}

fn summarize_report(
    posts: &[SocialPostInsights],
) -> (Vec<SocialInsightAggregate>, Vec<SocialInsightCoverage>) {
    let mut aggregates = BTreeMap::<(String, String), (i64, usize)>::new();
    let mut coverage = BTreeMap::<String, SocialInsightCoverage>::new();

    for post in posts {
        for platform in &post.platforms {
            let entry = coverage
                .entry(platform.platform.clone())
                .or_insert_with(|| SocialInsightCoverage {
                    platform: platform.platform.clone(),
                    post_count: 0,
                    synced_post_count: 0,
                    reported_metric_count: 0,
                    available_metric_count: 0,
                });
            entry.post_count += 1;
            if platform.data_status != "not_synced" {
                entry.synced_post_count += 1;
            }
            for metric in &platform.metrics {
                entry.reported_metric_count += 1;
                if let Some(value) = metric.value {
                    entry.available_metric_count += 1;
                    let aggregate = aggregates
                        .entry((platform.platform.clone(), metric.metric_key.clone()))
                        .or_insert((0, 0));
                    aggregate.0 += value;
                    aggregate.1 += 1;
                }
            }
        }
    }

    let aggregates = aggregates
        .into_iter()
        .map(
            |((platform, metric_key), (total_value, posts_with_value))| SocialInsightAggregate {
                platform,
                metric_key,
                total_value,
                posts_with_value,
            },
        )
        .collect();
    (aggregates, coverage.into_values().collect())
}

pub async fn insert_observation(
    pool: &PgPool,
    observation: &SocialPostInsightObservationRow,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "SocialPostInsightObservation" (
            id, "orgId", "postId", "publishJobId", platform, "metricKey", value,
            availability, "providerMetricKey", "observationKey", "observedAt",
            "fetchedAt", "windowStart", "windowEnd", "adapterVersion", metadata
        ) VALUES ($1, $2, $3, $4, CAST($5 AS "SocialPlatform"), $6, $7, $8, $9, $10,
                  $11, $12, $13, $14, $15, $16)
        ON CONFLICT ("observationKey") DO UPDATE SET
            value = EXCLUDED.value,
            availability = EXCLUDED.availability,
            "providerMetricKey" = EXCLUDED."providerMetricKey",
            "fetchedAt" = EXCLUDED."fetchedAt",
            metadata = EXCLUDED.metadata
        "#,
    )
    .bind(&observation.id)
    .bind(&observation.org_id)
    .bind(&observation.post_id)
    .bind(&observation.publish_job_id)
    .bind(&observation.platform)
    .bind(&observation.metric_key)
    .bind(observation.value)
    .bind(&observation.availability)
    .bind(&observation.provider_metric_key)
    .bind(&observation.observation_key)
    .bind(observation.observed_at)
    .bind(observation.fetched_at)
    .bind(observation.window_start)
    .bind(observation.window_end)
    .bind(&observation.adapter_version)
    .bind(&observation.metadata)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(AppError::from)
}

#[derive(Debug, Clone)]
struct InsightReading {
    value: Option<i64>,
    availability: &'static str,
    provider_metric_key: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct InsightChannelCredentials {
    platform: String,
    #[sqlx(rename = "access_token")]
    access_token: Option<String>,
    metadata: Option<Value>,
}

fn empty_readings(availability: &'static str) -> HashMap<String, InsightReading> {
    NORMALIZED_INSIGHT_METRICS
        .iter()
        .map(|metric| {
            (
                (*metric).to_string(),
                InsightReading {
                    value: None,
                    availability,
                    provider_metric_key: None,
                },
            )
        })
        .collect()
}

fn reading(value: Option<i64>, provider_metric_key: &str) -> InsightReading {
    InsightReading {
        value,
        availability: if value.is_some() {
            "available"
        } else {
            "not_reported"
        },
        provider_metric_key: Some(provider_metric_key.to_string()),
    }
}

fn numeric_value(payload: &Value) -> Option<i64> {
    if let Some(value) = payload.as_i64() {
        return Some(value);
    }
    if let Some(value) = payload.as_u64() {
        return i64::try_from(value).ok();
    }
    if let Some(values) = payload.as_object() {
        let total = values
            .values()
            .map(numeric_value)
            .try_fold(0_i64, |total, value| {
                value.map(|value| total.saturating_add(value))
            })?;
        return Some(total);
    }
    None
}

fn put_metric(
    readings: &mut HashMap<String, InsightReading>,
    normalized_key: &str,
    payload: &Value,
    provider_metric_key: &str,
) {
    let value = numeric_value(payload);
    if readings.contains_key(normalized_key) {
        readings.insert(
            normalized_key.to_string(),
            reading(value, provider_metric_key),
        );
    }
}

fn graph_metric_value(payload: &Value, provider_metric_key: &str) -> Option<i64> {
    payload
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                let name = item
                    .get("name")
                    .or_else(|| item.get("metric"))
                    .and_then(Value::as_str)?;
                if name != provider_metric_key {
                    return None;
                }
                item.get("values")
                    .and_then(Value::as_array)
                    .and_then(|values| values.last())
                    .and_then(|value| numeric_value(value.get("value").unwrap_or(value)))
                    .or_else(|| item.get("value").and_then(numeric_value))
            })
        })
}

fn linkedin_metric_value(payload: &Value, provider_metric_key: &str) -> Option<i64> {
    payload
        .get("elements")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                let name = item
                    .get("metricType")
                    .or_else(|| item.get("metric"))
                    .and_then(Value::as_str)?;
                if name != provider_metric_key {
                    return None;
                }
                item.get("metricValue")
                    .or_else(|| item.get("value"))
                    .and_then(Value::as_i64)
            })
        })
}

fn scope_contains(metadata: Option<&Value>, required: &str) -> bool {
    metadata
        .and_then(|value| value.get("scope"))
        .and_then(Value::as_str)
        .map(|scope| scope.split_whitespace().any(|entry| entry == required))
        .unwrap_or(true)
}

async fn fetch_x_metrics(
    external_post_id: &str,
    access_token: &str,
) -> Result<HashMap<String, InsightReading>, AppError> {
    let payload: Value = crate::services::social::fetch_json(
        reqwest::Client::new()
            .get(format!("https://api.x.com/2/tweets/{external_post_id}"))
            .bearer_auth(access_token)
            .query(&[("tweet.fields", "public_metrics")]),
        "X post insights request failed",
    )
    .await?;
    let metrics = payload
        .get("data")
        .and_then(|data| data.get("public_metrics"));
    let mut readings = empty_readings("not_reported");
    if let Some(metrics) = metrics {
        put_metric(
            &mut readings,
            "impressions",
            metrics.get("impression_count").unwrap_or(&Value::Null),
            "impression_count",
        );
        put_metric(
            &mut readings,
            "likes",
            metrics.get("like_count").unwrap_or(&Value::Null),
            "like_count",
        );
        put_metric(
            &mut readings,
            "comments",
            metrics.get("reply_count").unwrap_or(&Value::Null),
            "reply_count",
        );
        put_metric(
            &mut readings,
            "shares",
            metrics.get("retweet_count").unwrap_or(&Value::Null),
            "retweet_count",
        );
    }
    Ok(readings)
}

async fn fetch_bluesky_metrics(
    external_post_id: &str,
) -> Result<HashMap<String, InsightReading>, AppError> {
    let payload: Value = crate::services::social::fetch_json(
        reqwest::Client::new()
            .get("https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts")
            .query(&[("uris", external_post_id)]),
        "Bluesky post insights request failed",
    )
    .await?;
    let post = payload
        .get("posts")
        .and_then(Value::as_array)
        .and_then(|posts| posts.first())
        .ok_or_else(|| AppError::BadRequest("Bluesky post was not found".to_string()))?;
    let mut readings = empty_readings("not_reported");
    put_metric(
        &mut readings,
        "likes",
        post.get("likeCount").unwrap_or(&Value::Null),
        "likeCount",
    );
    put_metric(
        &mut readings,
        "comments",
        post.get("replyCount").unwrap_or(&Value::Null),
        "replyCount",
    );
    put_metric(
        &mut readings,
        "shares",
        post.get("repostCount").unwrap_or(&Value::Null),
        "repostCount",
    );
    Ok(readings)
}

async fn fetch_linkedin_metrics(
    external_post_id: &str,
    access_token: &str,
    metadata: Option<&Value>,
) -> Result<HashMap<String, InsightReading>, AppError> {
    if !scope_contains(metadata, "r_member_postAnalytics") {
        return Ok(empty_readings("not_authorized"));
    }
    let payload: Value = crate::services::social::fetch_json(
        reqwest::Client::new()
            .get("https://api.linkedin.com/rest/memberCreatorPostAnalytics")
            .bearer_auth(access_token)
            .header("Linkedin-Version", "202606")
            .header("X-Restli-Protocol-Version", "2.0.0")
            .query(&[
                ("q", "entity"),
                ("entity", external_post_id),
                ("aggregation", "TOTAL"),
            ]),
        "LinkedIn post insights request failed",
    )
    .await?;
    let mut readings = empty_readings("not_reported");
    for (normalized, provider) in [
        ("impressions", "IMPRESSION"),
        ("reach", "MEMBERS_REACHED"),
        ("likes", "REACTION"),
        ("comments", "COMMENT"),
        ("shares", "RESHARE"),
        ("clicks", "LINK_CLICKS"),
        ("video_views", "VIDEO_VIEW"),
    ] {
        let value = linkedin_metric_value(&payload, provider);
        readings.insert(normalized.to_string(), reading(value, provider));
    }
    Ok(readings)
}

async fn fetch_meta_metrics(
    platform: &str,
    external_post_id: &str,
    access_token: &str,
) -> Result<HashMap<String, InsightReading>, AppError> {
    let metrics = match platform {
        "FACEBOOK" => "post_impressions,post_reach,post_reactions_by_type_total,post_comments,post_shares,post_clicks,post_video_views",
        "INSTAGRAM" => "impressions,reach,likes,comments,shares,saved,video_views",
        "THREADS" => "views,likes,replies,reposts,quotes",
        _ => return Ok(empty_readings("unsupported")),
    };
    let payload: Value = crate::services::social::fetch_json(
        reqwest::Client::new()
            .get(format!(
                "{}/{external_post_id}/insights",
                match platform {
                    "INSTAGRAM" => "https://graph.instagram.com/v23.0",
                    "THREADS" => "https://graph.threads.com/v1.0",
                    _ => "https://graph.facebook.com/v23.0",
                }
            ))
            .query(&[("metric", metrics), ("access_token", access_token)]),
        "Meta post insights request failed",
    )
    .await?;
    let mut readings = empty_readings("not_reported");
    let mapping = match platform {
        "FACEBOOK" => [
            ("impressions", "post_impressions"),
            ("reach", "post_reach"),
            ("likes", "post_reactions_by_type_total"),
            ("comments", "post_comments"),
            ("shares", "post_shares"),
            ("clicks", "post_clicks"),
            ("video_views", "post_video_views"),
        ],
        "INSTAGRAM" => [
            ("impressions", "impressions"),
            ("reach", "reach"),
            ("likes", "likes"),
            ("comments", "comments"),
            ("shares", "shares"),
            ("clicks", "saved"),
            ("video_views", "video_views"),
        ],
        _ => [
            ("impressions", "views"),
            ("reach", "views"),
            ("likes", "likes"),
            ("comments", "replies"),
            ("shares", "reposts"),
            ("clicks", "quotes"),
            ("video_views", "views"),
        ],
    };
    for (normalized, provider) in mapping {
        let value = graph_metric_value(&payload, provider);
        readings.insert(normalized.to_string(), reading(value, provider));
    }
    Ok(readings)
}

async fn fetch_tiktok_metrics(
    external_post_id: &str,
    access_token: &str,
) -> Result<HashMap<String, InsightReading>, AppError> {
    let payload: Value = crate::services::social::fetch_json(
        reqwest::Client::new()
            .post("https://open.tiktokapis.com/v2/video/query/")
            .bearer_auth(access_token)
            .json(&json!({
                "filters": { "video_ids": [external_post_id] },
                "fields": ["id", "view_count", "like_count", "comment_count", "share_count"]
            })),
        "TikTok post insights request failed",
    )
    .await?;
    let video = payload
        .get("data")
        .and_then(|data| data.get("videos"))
        .and_then(Value::as_array)
        .and_then(|videos| videos.first())
        .ok_or_else(|| AppError::BadRequest("TikTok post was not found".to_string()))?;
    let mut readings = empty_readings("not_reported");
    put_metric(
        &mut readings,
        "impressions",
        video.get("view_count").unwrap_or(&Value::Null),
        "view_count",
    );
    put_metric(
        &mut readings,
        "reach",
        video.get("view_count").unwrap_or(&Value::Null),
        "view_count",
    );
    put_metric(
        &mut readings,
        "likes",
        video.get("like_count").unwrap_or(&Value::Null),
        "like_count",
    );
    put_metric(
        &mut readings,
        "comments",
        video.get("comment_count").unwrap_or(&Value::Null),
        "comment_count",
    );
    put_metric(
        &mut readings,
        "shares",
        video.get("share_count").unwrap_or(&Value::Null),
        "share_count",
    );
    Ok(readings)
}

async fn fetch_provider_metrics(
    platform: &str,
    external_post_id: &str,
    access_token: Option<&str>,
    metadata: Option<&Value>,
) -> Result<HashMap<String, InsightReading>, AppError> {
    match platform {
        "BLUESKY" => fetch_bluesky_metrics(external_post_id).await,
        "X" => {
            let token = access_token.ok_or_else(|| {
                AppError::BadRequest("X connection is missing an access token".to_string())
            })?;
            fetch_x_metrics(external_post_id, token).await
        }
        "LINKEDIN" => {
            let token = access_token.ok_or_else(|| {
                AppError::BadRequest("LinkedIn connection is missing an access token".to_string())
            })?;
            fetch_linkedin_metrics(external_post_id, token, metadata).await
        }
        "FACEBOOK" | "INSTAGRAM" | "THREADS" => {
            let token = access_token.ok_or_else(|| {
                AppError::BadRequest(format!("{platform} connection is missing an access token"))
            })?;
            fetch_meta_metrics(platform, external_post_id, token).await
        }
        "TIKTOK" => {
            let token = access_token.ok_or_else(|| {
                AppError::BadRequest("TikTok connection is missing an access token".to_string())
            })?;
            fetch_tiktok_metrics(external_post_id, token).await
        }
        _ => Ok(empty_readings("unsupported")),
    }
}

async fn load_channel_credentials(
    pool: &PgPool,
    org_id: &str,
    channel_id: Option<&str>,
) -> Result<Option<InsightChannelCredentials>, AppError> {
    let Some(channel_id) = channel_id else {
        return Ok(None);
    };
    sqlx::query_as::<_, InsightChannelCredentials>(
        r#"
        SELECT platform::text AS platform, "accessToken" AS access_token, metadata
        FROM "SocialChannelConnection"
        WHERE id = $1 AND "orgId" = $2 AND status = 'CONNECTED'::"SocialChannelStatus"
        LIMIT 1
        "#,
    )
    .bind(channel_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn write_job_observations(
    pool: &PgPool,
    org_id: &str,
    post: &SocialPost,
    job: &SocialPublishJobRow,
) -> Result<InsightSyncOutcome, AppError> {
    let observed_at = Utc::now();
    let bucket = observed_at.timestamp() / 300;
    let credentials =
        load_channel_credentials(pool, org_id, job.channel_connection_id.as_deref()).await?;
    let (readings, outcome) = match credentials {
        None => (
            empty_readings("not_configured"),
            InsightSyncOutcome::not_configured(),
        ),
        Some(credentials) => {
            let access_token = credentials
                .access_token
                .as_deref()
                .map(crate::services::social::decrypt_social_secret)
                .transpose();
            match access_token {
                Ok(access_token) => match fetch_provider_metrics(
                    &credentials.platform,
                    job.external_post_id.as_deref().unwrap_or_default(),
                    access_token.as_deref(),
                    credentials.metadata.as_ref(),
                )
                .await
                {
                    Ok(readings) => (readings, InsightSyncOutcome::success()),
                    Err(error) => (
                        empty_readings("temporarily_unavailable"),
                        provider_error_outcome(&error),
                    ),
                },
                Err(_) => (
                    empty_readings("not_authorized"),
                    InsightSyncOutcome::not_authorized(),
                ),
            }
        }
    };

    for metric in NORMALIZED_INSIGHT_METRICS {
        let current = readings
            .get(metric)
            .cloned()
            .unwrap_or_else(|| InsightReading {
                value: None,
                availability: "unsupported",
                provider_metric_key: None,
            });
        insert_observation(
            pool,
            &SocialPostInsightObservationRow {
                id: cuid2::create_id(),
                org_id: org_id.to_string(),
                post_id: post.row.id.clone(),
                publish_job_id: job.id.clone(),
                platform: job.platform.clone(),
                metric_key: metric.to_string(),
                value: current.value,
                availability: current.availability.to_string(),
                provider_metric_key: current.provider_metric_key,
                observation_key: format!("{}:{}:{}", job.id, metric, bucket),
                observed_at,
                fetched_at: Utc::now(),
                window_start: None,
                window_end: None,
                adapter_version: "social-insights-v1".to_string(),
                metadata: outcome.error_code.map(|status| json!({ "status": status })),
            },
        )
        .await?;
    }
    Ok(outcome)
}

#[derive(Debug, Clone)]
struct InsightSyncOutcome {
    status: &'static str,
    retryable: bool,
    error_code: Option<&'static str>,
}

impl InsightSyncOutcome {
    fn success() -> Self {
        Self {
            status: "SUCCESS",
            retryable: false,
            error_code: None,
        }
    }

    fn not_configured() -> Self {
        Self {
            status: "NOT_CONFIGURED",
            retryable: false,
            error_code: Some("connection_unavailable"),
        }
    }

    fn not_authorized() -> Self {
        Self {
            status: "NOT_AUTHORIZED",
            retryable: false,
            error_code: Some("token_unavailable"),
        }
    }
}

fn provider_error_outcome(error: &AppError) -> InsightSyncOutcome {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("401")
        || message.contains("403")
        || message.contains("unauthorized")
        || message.contains("forbidden")
    {
        return InsightSyncOutcome::not_authorized();
    }
    InsightSyncOutcome {
        status: "RETRYABLE_FAILURE",
        retryable: true,
        error_code: Some("provider_fetch_failed"),
    }
}

async fn record_sync_state(
    pool: &PgPool,
    org_id: &str,
    platform: &str,
    outcome: &InsightSyncOutcome,
) -> Result<(), AppError> {
    let now = Utc::now();
    let next_retry_at = (outcome.status != "SUCCESS").then(|| now + Duration::minutes(15));
    sqlx::query(
        r#"
        INSERT INTO "SocialPostInsightSyncState" (
            id, "orgId", platform, status, retryable, "consecutiveFailures",
            "lastAttemptAt", "lastSuccessAt", "nextRetryAt", "lastErrorCode", "updatedAt"
        ) VALUES ($1, $2, CAST($3 AS "SocialPlatform"), $4, $5,
                  CASE WHEN $5 THEN 1 ELSE 0 END, $6,
                  CASE WHEN $4 = 'SUCCESS' THEN $6 ELSE NULL END, $7, $8, $9)
        ON CONFLICT ("orgId", platform) DO UPDATE SET
            status = EXCLUDED.status,
            retryable = EXCLUDED.retryable,
            "consecutiveFailures" = CASE
                WHEN EXCLUDED.retryable
                    THEN "SocialPostInsightSyncState"."consecutiveFailures" + 1
                ELSE 0
            END,
            "lastAttemptAt" = EXCLUDED."lastAttemptAt",
            "lastSuccessAt" = CASE
                WHEN EXCLUDED.status = 'SUCCESS' THEN EXCLUDED."lastSuccessAt"
                ELSE "SocialPostInsightSyncState"."lastSuccessAt"
            END,
            "nextRetryAt" = EXCLUDED."nextRetryAt",
            "lastErrorCode" = EXCLUDED."lastErrorCode",
            "lastErrorMessage" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        "#,
    )
    .bind(cuid2::create_id())
    .bind(org_id)
    .bind(platform)
    .bind(outcome.status)
    .bind(outcome.retryable)
    .bind(now)
    .bind(next_retry_at)
    .bind(outcome.error_code)
    .bind(now)
    .execute(pool)
    .await
    .map_err(AppError::from)?;
    Ok(())
}

pub async fn sync_social_post_insights(
    pool: &PgPool,
    org_id: &str,
    post_id: Option<&str>,
    limit: i64,
) -> Result<usize, AppError> {
    sync_social_post_insights_inner(pool, org_id, post_id, limit, false).await
}

pub async fn force_sync_social_post_insights(
    pool: &PgPool,
    org_id: &str,
    post_id: Option<&str>,
    limit: i64,
) -> Result<usize, AppError> {
    sync_social_post_insights_inner(pool, org_id, post_id, limit, true).await
}

async fn sync_social_post_insights_inner(
    pool: &PgPool,
    org_id: &str,
    post_id: Option<&str>,
    limit: i64,
    force: bool,
) -> Result<usize, AppError> {
    let mut posts = social_posts::list_social_posts(pool, org_id).await?;
    posts.retain(|post| {
        post.row.status == "PUBLISHED" && post_id.is_none_or(|wanted| post.row.id == wanted)
    });
    posts.sort_by(|left, right| right.row.published_at.cmp(&left.row.published_at));
    posts.truncate(limit.clamp(1, 100) as usize);
    let sync_states = load_sync_states(pool, org_id).await?;
    let now = Utc::now();

    let mut synced = 0;
    for post in &posts {
        for job in post
            .publish_jobs
            .iter()
            .filter(|job| job.status == "PUBLISHED" && job.external_post_id.is_some())
            .filter(|job| {
                force || {
                    sync_states.get(&job.platform).is_none_or(|state| {
                        state
                            .next_retry_at
                            .is_none_or(|next_retry_at| next_retry_at <= now)
                    })
                }
            })
        {
            let outcome = write_job_observations(pool, org_id, post, job).await?;
            record_sync_state(pool, org_id, &job.platform, &outcome).await?;
            synced += 1;
        }
    }
    Ok(synced)
}

pub async fn sync_all_social_post_insights(pool: &PgPool, limit: i64) -> Result<usize, AppError> {
    let organizations = sqlx::query_scalar::<_, String>(r#"SELECT id FROM "Organization""#)
        .fetch_all(pool)
        .await?;
    let mut synced = 0;
    for org_id in organizations {
        synced += sync_social_post_insights(pool, &org_id, None, limit).await?;
    }
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::{
        graph_metric_value, linkedin_metric_value, numeric_value, parse_insights_filters,
        percentage_change,
    };
    use serde_json::json;

    #[test]
    fn percentage_change_is_not_invented_for_zero_baselines() {
        assert_eq!(percentage_change(Some(0), Some(4)), None);
        assert_eq!(percentage_change(Some(10), Some(15)), Some(50.0));
        assert_eq!(percentage_change(None, Some(15)), None);
    }

    #[test]
    fn provider_payload_numbers_are_normalized_without_false_zeroes() {
        assert_eq!(numeric_value(&json!(12)), Some(12));
        assert_eq!(numeric_value(&json!({ "LIKE": 4, "LOVE": 3 })), Some(7));
        assert_eq!(numeric_value(&json!({ "unknown": true })), None);

        let graph = json!({
            "data": [{ "name": "post_reach", "values": [{ "value": 42 }] }]
        });
        assert_eq!(graph_metric_value(&graph, "post_reach"), Some(42));
    }

    #[test]
    fn linkedin_metric_payload_is_read_by_provider_metric_name() {
        let payload = json!({
            "elements": [
                { "metricType": "IMPRESSION", "metricValue": 120 },
                { "metricType": "REACTION", "metricValue": 8 }
            ]
        });
        assert_eq!(linkedin_metric_value(&payload, "IMPRESSION"), Some(120));
        assert_eq!(linkedin_metric_value(&payload, "COMMENT"), None);
    }

    #[test]
    fn insight_filters_normalize_and_validate_query_values() {
        let filters = parse_insights_filters(
            Some("threads"),
            Some("likes, comments"),
            Some("2030-01-01T00:00:00Z"),
            Some("2030-01-31T23:59:59Z"),
        )
        .expect("valid insight filters");
        assert_eq!(filters.platform.as_deref(), Some("THREADS"));
        assert_eq!(
            filters.metric_keys,
            Some(vec!["likes".to_string(), "comments".to_string()])
        );
        assert!(parse_insights_filters(None, Some("bookmarks"), None, None).is_err());
        assert!(parse_insights_filters(
            None,
            None,
            Some("2030-02-01T00:00:00Z"),
            Some("2030-01-01T00:00:00Z"),
        )
        .is_err());
    }
}
