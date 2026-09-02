//! Durable, provider-neutral batch publishing for content posts.
//!
//! The batch is the orchestration seam. It validates every configured target
//! before queueing any provider work, records one durable item per publish job,
//! and lets the existing social worker execute and reconcile those items.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;

use crate::{
    db::models::SocialPost,
    error::AppError,
    identity::request_context::RequestContext,
    services::{connection_permissions, connections, social},
};

const SUPPORTED_PLATFORMS: [&str; 7] = [
    "FACEBOOK",
    "INSTAGRAM",
    "THREADS",
    "TIKTOK",
    "BLUESKY",
    "LINKEDIN",
    "X",
];

#[derive(Debug, Clone, Serialize)]
pub struct PublishBatchTarget {
    pub platform: String,
    #[serde(rename = "accountName")]
    pub account_name: String,
    pub handle: Option<String>,
    pub state: String,
    pub status: String,
    #[serde(rename = "requiredCapability")]
    pub required_capability: String,
    #[serde(rename = "remediationMode")]
    pub remediation_mode: String,
    #[serde(rename = "reasonCode", skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishBatchPreflight {
    #[serde(rename = "postId")]
    pub post_id: String,
    pub status: String,
    #[serde(rename = "snapshotHash")]
    pub snapshot_hash: String,
    #[serde(rename = "mediaCount")]
    pub media_count: usize,
    pub targets: Vec<PublishBatchTarget>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishBatchSummary {
    #[serde(rename = "batchId")]
    pub batch_id: String,
    pub status: String,
    #[serde(rename = "postId")]
    pub post_id: String,
    #[serde(rename = "snapshotHash")]
    pub snapshot_hash: String,
    #[serde(rename = "targetCount")]
    pub target_count: i64,
    #[serde(rename = "publishedCount")]
    pub published_count: i64,
    #[serde(rename = "processingCount")]
    pub processing_count: i64,
    #[serde(rename = "unknownCount")]
    pub unknown_count: i64,
    #[serde(rename = "failedCount")]
    pub failed_count: i64,
    #[serde(rename = "blockedCount")]
    pub blocked_count: i64,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(rename = "completedAt", skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    pub targets: Vec<PublishBatchTarget>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishBatchResponse {
    pub post: SocialPost,
    pub batch: PublishBatchSummary,
}

#[derive(Debug, Clone, FromRow)]
struct ChannelAccessRow {
    id: String,
    #[sqlx(rename = "channel_status")]
    channel_status: String,
    #[sqlx(rename = "display_name")]
    display_name: String,
    handle: Option<String>,
    #[sqlx(rename = "external_status")]
    external_status: Option<String>,
    #[sqlx(rename = "health_status")]
    health_status: Option<String>,
    #[sqlx(rename = "social_permission_state")]
    social_permission_state: Option<String>,
    #[sqlx(rename = "media_permission_state")]
    media_permission_state: Option<String>,
}

#[derive(Debug, Clone)]
struct TargetPlan {
    job_id: String,
    platform: String,
    channel_connection_id: Option<String>,
    account_name: String,
    handle: Option<String>,
    state: String,
    status: String,
    required_capability: String,
    reason_code: Option<String>,
    message: Option<String>,
}

impl TargetPlan {
    fn view(&self) -> PublishBatchTarget {
        PublishBatchTarget {
            platform: self.platform.clone(),
            account_name: self.account_name.clone(),
            handle: self.handle.clone(),
            state: self.state.clone(),
            status: self.status.clone(),
            required_capability: self.required_capability.clone(),
            remediation_mode: remediation_mode(&self.state, self.reason_code.as_deref(), false)
                .to_string(),
            reason_code: self.reason_code.clone(),
            message: self.message.clone(),
        }
    }
}

fn remediation_mode(state: &str, reason_code: Option<&str>, retryable: bool) -> &'static str {
    match state {
        "MISSING_ACCESS" => "GRANT_ACCESS",
        "RECONNECT_REQUIRED" => "RECONNECT",
        "UNHEALTHY" => "CHECK_CONNECTION",
        "INVALID_MEDIA" => "FIX_MEDIA",
        "INVALID_CONTENT" => "FIX_CONTENT",
        "UNSUPPORTED" => "REMOVE_TARGET",
        "IN_PROGRESS" | "PROCESSING" | "QUEUED" => "WAIT",
        "UNKNOWN" => "RECONCILE",
        "FAILED" if retryable => "RETRY",
        "FAILED" => "REVIEW",
        "CANCELED" => "RECREATE_DRAFT",
        "BLOCKED" if reason_code == Some("publish_job_canceled") => "RECREATE_DRAFT",
        "BLOCKED" => "REVIEW",
        _ => "NONE",
    }
}

#[derive(Debug, Clone)]
struct PreflightPlan {
    post: SocialPost,
    snapshot_hash: String,
    media_count: usize,
    status: String,
    targets: Vec<TargetPlan>,
}

#[derive(Debug, Clone, FromRow)]
struct BatchRow {
    id: String,
    #[sqlx(rename = "post_id")]
    post_id: String,
    status: String,
    #[sqlx(rename = "snapshot_hash")]
    snapshot_hash: String,
    #[sqlx(rename = "target_count")]
    target_count: i64,
    #[sqlx(rename = "published_count")]
    published_count: i64,
    #[sqlx(rename = "processing_count")]
    processing_count: i64,
    #[sqlx(rename = "unknown_count")]
    unknown_count: i64,
    #[sqlx(rename = "failed_count")]
    failed_count: i64,
    #[sqlx(rename = "blocked_count")]
    blocked_count: i64,
    #[sqlx(rename = "error_code")]
    error_code: Option<String>,
    #[sqlx(rename = "error_message")]
    error_message: Option<String>,
    #[sqlx(rename = "completed_at")]
    completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow)]
struct BatchTargetRow {
    platform: String,
    #[sqlx(rename = "display_name")]
    display_name: Option<String>,
    handle: Option<String>,
    status: String,
    #[sqlx(rename = "retryable")]
    retryable: bool,
    #[sqlx(rename = "error_code")]
    error_code: Option<String>,
    #[sqlx(rename = "error_message")]
    error_message: Option<String>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, FromRow)]
struct RetryBatchItemRow {
    id: String,
    #[sqlx(rename = "job_id")]
    job_id: String,
}

fn media_is_image_or_video(kind: &str) -> bool {
    matches!(kind, "IMAGE" | "VIDEO")
}

fn platform_media_error(
    platform: &str,
    media_kinds: &[String],
    media_count: usize,
) -> Option<(String, String)> {
    let (max_count, image_only) = match platform {
        "FACEBOOK" | "THREADS" | "INSTAGRAM" | "LINKEDIN" => (1, true),
        "TIKTOK" => (1, false),
        "BLUESKY" | "X" => (4, true),
        _ => {
            return Some((
                "unsupported_platform".to_string(),
                "This provider is not supported for batch publishing".to_string(),
            ))
        }
    };
    if media_count > max_count {
        return Some((
            "media_count_exceeded".to_string(),
            format!(
                "{platform} accepts at most {max_count} media item{}",
                if max_count == 1 { "" } else { "s" }
            ),
        ));
    }
    if image_only && media_kinds.iter().any(|kind| kind != "IMAGE") {
        return Some((
            "media_type_unsupported".to_string(),
            format!("{platform} accepts image attachments only"),
        ));
    }
    if !image_only
        && media_kinds
            .iter()
            .any(|kind| !media_is_image_or_video(kind))
    {
        return Some((
            "media_type_unsupported".to_string(),
            format!("{platform} accepts image or video attachments only"),
        ));
    }
    None
}

fn text_length_error(platform: &str, text: &str) -> Option<(String, String)> {
    let limit = match platform {
        "BLUESKY" => 300,
        "X" => 280,
        "LINKEDIN" => 3000,
        _ => return None,
    };
    let length = text.chars().count();
    (length > limit).then(|| {
        (
            "text_length_exceeded".to_string(),
            format!("{platform} accepts at most {limit} characters"),
        )
    })
}

fn safe_error_message(message: Option<String>) -> Option<String> {
    let message = message?.trim().to_string();
    if message.is_empty() {
        return None;
    }
    if [
        "access_token",
        "refresh_token",
        "bearer ",
        "client_secret",
        "private_key",
    ]
    .iter()
    .any(|marker| message.to_ascii_lowercase().contains(marker))
    {
        return Some("The provider returned an error while publishing this target".to_string());
    }
    Some(message.chars().take(240).collect())
}

fn aggregate_batch_status(
    total: i64,
    published: i64,
    processing: i64,
    queued: i64,
    unknown: i64,
    failed: i64,
    blocked: i64,
    canceled: i64,
) -> &'static str {
    if total == 0 {
        return "FAILED";
    }
    if published == total {
        return "SUCCEEDED";
    }
    if blocked == total {
        return "BLOCKED";
    }
    if unknown > 0 {
        return "UNKNOWN";
    }
    if processing > 0 || queued > 0 {
        return "PROCESSING";
    }
    if published > 0 && failed + blocked + canceled > 0 {
        return "PARTIAL";
    }
    if failed + canceled == total {
        return "FAILED";
    }
    if blocked > 0 && failed == 0 && canceled == 0 {
        return "BLOCKED";
    }
    "PARTIAL"
}

fn target_state_for_permission(
    channel: Option<&ChannelAccessRow>,
    required_capability: &str,
) -> Option<(String, String, String)> {
    let Some(channel) = channel else {
        return Some((
            "RECONNECT_REQUIRED".to_string(),
            "connection_not_found".to_string(),
            "The configured account could not be found".to_string(),
        ));
    };
    if channel.channel_status != "CONNECTED" {
        return Some((
            "RECONNECT_REQUIRED".to_string(),
            "connection_not_connected".to_string(),
            "This account needs to be reconnected before publishing".to_string(),
        ));
    }
    if channel.external_status.as_deref() == Some("NEEDS_ATTENTION")
        || channel.health_status.as_deref() == Some("NEEDS_ATTENTION")
    {
        return Some((
            "UNHEALTHY".to_string(),
            "connection_needs_attention".to_string(),
            "This account needs attention before publishing".to_string(),
        ));
    }
    let state = if required_capability == connection_permissions::MEDIA_PUBLISH {
        channel.media_permission_state.as_deref()
    } else {
        channel.social_permission_state.as_deref()
    };
    match state {
        Some("GRANTED") => None,
        Some("UNSUPPORTED") => Some((
            "UNSUPPORTED".to_string(),
            "provider_capability_unsupported".to_string(),
            "This account does not support the required publishing access".to_string(),
        )),
        Some("REQUESTABLE") | Some("NOT_GRANTED") => Some((
            "MISSING_ACCESS".to_string(),
            "missing_provider_permission".to_string(),
            format!("Grant {required_capability} access for this account"),
        )),
        Some("REQUIRES_PROVIDER_APPROVAL") => Some((
            "MISSING_ACCESS".to_string(),
            "requires_provider_approval".to_string(),
            "The provider has not approved the required access for this app".to_string(),
        )),
        Some(_) | None => Some((
            "UNKNOWN".to_string(),
            "permission_status_unknown".to_string(),
            "The required account access could not be verified".to_string(),
        )),
    }
}

fn post_snapshot_hash(post: &SocialPost, targets: &[TargetPlan]) -> String {
    // Job and permission states are mutable execution facts. The approval
    // identity must remain stable while a queued batch moves through them;
    // content, variant, media, and concrete target identity are immutable
    // inputs for this publish admission.
    let mut target_snapshot = targets
        .iter()
        .map(|target| {
            json!({
                "jobId": target.job_id,
                "platform": target.platform,
                "channelConnectionId": target.channel_connection_id,
            })
        })
        .collect::<Vec<_>>();
    target_snapshot.sort_by(|left, right| left.to_string().cmp(&right.to_string()));
    let payload = json!({
        "postId": post.row.id,
        "content": post.row.content,
        "channels": post.row.channels,
        "variants": post.variants.iter().map(|variant| json!({
            "id": variant.id,
            "platform": variant.platform,
            "content": variant.content,
            "status": variant.status,
        })).collect::<Vec<_>>(),
        "media": post.media.iter().map(|media| json!({
            "assetId": media.asset_id,
            "kind": media.kind,
            "sortOrder": media.sort_order,
            "altText": media.alt_text,
            "processingStatus": media.processing_status,
            "scanStatus": media.scan_status,
        })).collect::<Vec<_>>(),
        "targets": target_snapshot,
    });
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&payload).unwrap_or_default());
    hex::encode(digest.finalize())
}

async fn load_channel_access(
    pool: &PgPool,
    org_id: &str,
    channel_ids: &[String],
) -> Result<HashMap<String, ChannelAccessRow>, AppError> {
    if channel_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query_as::<_, ChannelAccessRow>(
        r#"
        SELECT channel.id,
               channel.status::text AS channel_status,
               channel."displayName" AS display_name,
               channel.handle,
               connection.status::text AS external_status,
               connection."healthStatus" AS health_status,
               social_permission.state AS social_permission_state,
               media_permission.state AS media_permission_state
        FROM "SocialChannelConnection" channel
        LEFT JOIN "ExternalConnection" connection
          ON connection."orgId" = $1
         AND connection."sourceType" = 'SOCIAL'
         AND connection."sourceId" = channel.id
        LEFT JOIN "ExternalConnectionPermission" social_permission
          ON social_permission."connectionId" = connection.id
         AND social_permission.key = 'SOCIAL_PUBLISH'
        LEFT JOIN "ExternalConnectionPermission" media_permission
          ON media_permission."connectionId" = connection.id
         AND media_permission.key = 'MEDIA_PUBLISH'
        WHERE channel."orgId" = $1 AND channel.id = ANY($2)
        "#,
    )
    .bind(org_id)
    .bind(channel_ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|row| (row.id.clone(), row)).collect())
}

async fn preflight_internal(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
) -> Result<PreflightPlan, AppError> {
    connections::sync_org_connections(pool, &context.organization_id).await?;
    connection_permissions::sync_permission_inventory(pool, &context.organization_id).await?;
    let post = social::get_social_post(pool, &context.organization_id, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;

    let mut jobs = post
        .publish_jobs
        .iter()
        .filter(|job| {
            post.row
                .channels
                .iter()
                .any(|channel| channel == &job.platform)
        })
        .cloned()
        .collect::<Vec<_>>();
    jobs.sort_by(|left, right| {
        left.platform
            .cmp(&right.platform)
            .then(left.id.cmp(&right.id))
    });
    if jobs.is_empty() {
        return Err(AppError::BadRequest(
            "Content post has no configured publishing targets".to_string(),
        ));
    }
    if post
        .row
        .channels
        .iter()
        .any(|platform| !jobs.iter().any(|job| &job.platform == platform))
    {
        return Err(AppError::BadRequest(
            "Content post targets are incomplete; recreate the draft before publishing".to_string(),
        ));
    }

    let channel_ids = jobs
        .iter()
        .filter_map(|job| job.channel_connection_id.clone())
        .collect::<Vec<_>>();
    let channels = load_channel_access(pool, &context.organization_id, &channel_ids).await?;
    let media_count = post.media.len();
    let media_kinds = post
        .media
        .iter()
        .map(|media| media.kind.clone())
        .collect::<Vec<_>>();
    let media_ready = post
        .media
        .iter()
        .all(|media| media.processing_status == "READY" && media.scan_status == "CLEAN");
    let mut targets = Vec::with_capacity(jobs.len());

    for job in jobs {
        let variant_content = job
            .variant_id
            .as_ref()
            .and_then(|variant_id| {
                post.variants
                    .iter()
                    .find(|variant| &variant.id == variant_id)
            })
            .map(|variant| variant.content.as_str())
            .unwrap_or(post.row.content.as_str());
        let required_capability = if media_count > 0 {
            connection_permissions::MEDIA_PUBLISH
        } else {
            connection_permissions::SOCIAL_PUBLISH
        };
        let channel = job
            .channel_connection_id
            .as_ref()
            .and_then(|channel_id| channels.get(channel_id));
        let (account_name, handle) = channel
            .map(|channel| (channel.display_name.clone(), channel.handle.clone()))
            .unwrap_or_else(|| (format!("{} account", job.platform), None));
        let mut state = "READY".to_string();
        let mut status = "READY".to_string();
        let mut reason_code = None;
        let mut message = None;

        if job.status == "PUBLISHED" && job.external_post_id.is_some() {
            state = "ALREADY_PUBLISHED".to_string();
            status = "PUBLISHED".to_string();
        } else if job
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("_kasitek_outcome"))
            .and_then(Value::as_str)
            == Some("UNKNOWN")
        {
            state = "UNKNOWN".to_string();
            status = "UNKNOWN".to_string();
            reason_code = Some("provider_outcome_unknown".to_string());
            message = Some(
                "The provider did not confirm the result; reconcile before retrying".to_string(),
            );
        } else if matches!(job.status.as_str(), "PROCESSING" | "QUEUED") {
            state = "IN_PROGRESS".to_string();
            status = job.status.clone();
            reason_code = Some("publish_already_in_progress".to_string());
            message = Some("A publish attempt is already in progress for this account".to_string());
        } else if job.status == "CANCELED" {
            state = "BLOCKED".to_string();
            status = "BLOCKED".to_string();
            reason_code = Some("publish_job_canceled".to_string());
            message = Some("This publish target was canceled and must be recreated".to_string());
        } else if let Some((permission_state, permission_reason, permission_message)) =
            target_state_for_permission(channel, required_capability)
        {
            state = permission_state;
            status = "BLOCKED".to_string();
            reason_code = Some(permission_reason);
            message = Some(permission_message);
        } else if !media_ready {
            state = "INVALID_MEDIA".to_string();
            status = "BLOCKED".to_string();
            reason_code = Some("media_not_ready".to_string());
            message = Some(
                "Every attached media item must be ready and pass the safety scan".to_string(),
            );
        } else if matches!(job.platform.as_str(), "INSTAGRAM" | "TIKTOK")
            && media_count == 0
            && post
                .row
                .metadata
                .as_ref()
                .and_then(|metadata| {
                    metadata.get(if job.platform == "INSTAGRAM" {
                        "instagramImageUrl"
                    } else {
                        "tiktokMediaUrl"
                    })
                })
                .and_then(|value| value.as_str())
                .is_none_or(|value| value.trim().is_empty())
        {
            state = "INVALID_MEDIA".to_string();
            status = "BLOCKED".to_string();
            reason_code = Some("media_required".to_string());
            message = Some(format!(
                "{} requires an attached media item or a provider media URL",
                job.platform
            ));
        } else if let Some((media_reason, media_message)) =
            platform_media_error(&job.platform, &media_kinds, media_count)
        {
            state = "INVALID_MEDIA".to_string();
            status = "BLOCKED".to_string();
            reason_code = Some(media_reason);
            message = Some(media_message);
        } else if let Some((text_reason, text_message)) =
            text_length_error(&job.platform, variant_content)
        {
            state = "INVALID_CONTENT".to_string();
            status = "BLOCKED".to_string();
            reason_code = Some(text_reason);
            message = Some(text_message);
        } else if !SUPPORTED_PLATFORMS.contains(&job.platform.as_str()) {
            state = "UNSUPPORTED".to_string();
            status = "BLOCKED".to_string();
            reason_code = Some("unsupported_platform".to_string());
            message = Some("This provider is not supported for batch publishing".to_string());
        }

        targets.push(TargetPlan {
            job_id: job.id,
            platform: job.platform,
            channel_connection_id: job.channel_connection_id,
            account_name,
            handle,
            state,
            status,
            required_capability: required_capability.to_string(),
            reason_code,
            message,
        });
    }

    let blocked = targets
        .iter()
        .any(|target| !matches!(target.state.as_str(), "READY" | "ALREADY_PUBLISHED"));
    let has_unknown = targets.iter().any(|target| target.state == "UNKNOWN");
    let snapshot_hash = post_snapshot_hash(&post, &targets);
    let has_in_progress = targets.iter().any(|target| target.state == "IN_PROGRESS");
    let status = if has_unknown {
        "UNKNOWN"
    } else if has_in_progress {
        "PROCESSING"
    } else if blocked {
        "BLOCKED"
    } else {
        "READY"
    };
    observability::tracing::info!(
        event = "content.publish_batch.preflight",
        org_id = %context.organization_id,
        post_id = %post_id,
        target_count = targets.len(),
        status = status,
        "content batch preflight completed"
    );
    Ok(PreflightPlan {
        post,
        snapshot_hash,
        media_count,
        status: status.to_string(),
        targets,
    })
}

pub async fn preflight(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
) -> Result<PublishBatchPreflight, AppError> {
    let plan = preflight_internal(pool, context, post_id).await?;
    Ok(PublishBatchPreflight {
        post_id: post_id.to_string(),
        status: plan.status,
        snapshot_hash: plan.snapshot_hash,
        media_count: plan.media_count,
        targets: plan.targets.iter().map(TargetPlan::view).collect(),
    })
}

async fn load_batch(pool: &PgPool, org_id: &str, batch_id: &str) -> Result<BatchRow, AppError> {
    sqlx::query_as::<_, BatchRow>(
        r#"SELECT id, "postId" AS post_id, status, "snapshotHash" AS snapshot_hash,
                   "targetCount"::bigint AS target_count, "publishedCount"::bigint AS published_count,
                   "processingCount"::bigint AS processing_count, "unknownCount"::bigint AS unknown_count,
                   "failedCount"::bigint AS failed_count,
                   "blockedCount"::bigint AS blocked_count, "errorCode" AS error_code,
                   "errorMessage" AS error_message, "completedAt" AT TIME ZONE 'UTC' AS completed_at
            FROM "SocialPublishBatch"
            WHERE id = $1 AND "orgId" = $2
            LIMIT 1"#,
    )
    .bind(batch_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Publish batch not found".to_string()))
}

async fn load_batch_targets(
    pool: &PgPool,
    batch_id: &str,
) -> Result<Vec<BatchTargetRow>, AppError> {
    Ok(sqlx::query_as::<_, BatchTargetRow>(
        r#"SELECT item.platform::text AS platform,
                   channel."displayName" AS display_name,
                   channel.handle,
                   item.status,
                   item.retryable,
                   item."errorCode" AS error_code,
                   item."errorMessage" AS error_message,
                   item.metadata
            FROM "SocialPublishBatchItem" item
            LEFT JOIN "SocialChannelConnection" channel
              ON channel.id = item."channelConnectionId"
            WHERE item."batchId" = $1
            ORDER BY item."createdAt" ASC, item.platform ASC"#,
    )
    .bind(batch_id)
    .fetch_all(pool)
    .await?)
}

fn batch_target_view(row: BatchTargetRow) -> PublishBatchTarget {
    let state = match row.status.as_str() {
        "PUBLISHED" => "PUBLISHED",
        "PROCESSING" | "QUEUED" => "PROCESSING",
        "FAILED" => "FAILED",
        "UNKNOWN" => "UNKNOWN",
        "BLOCKED" => "BLOCKED",
        "CANCELED" => "CANCELED",
        _ => row.status.as_str(),
    };
    let required_capability = row
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("requiredCapability"))
        .and_then(Value::as_str)
        .unwrap_or(connection_permissions::SOCIAL_PUBLISH)
        .to_string();
    let remediation_mode = remediation_mode(&state, row.error_code.as_deref(), row.retryable);
    PublishBatchTarget {
        platform: row.platform,
        account_name: row
            .display_name
            .unwrap_or_else(|| "Connected account".to_string()),
        handle: row.handle,
        state: state.to_string(),
        status: row.status.clone(),
        required_capability,
        remediation_mode: remediation_mode.to_string(),
        reason_code: row.error_code,
        message: safe_error_message(row.error_message).or_else(|| {
            if row.status == "UNKNOWN" {
                Some(
                    "The provider did not confirm the result; reconcile before retrying"
                        .to_string(),
                )
            } else {
                row.retryable
                    .then_some("This target can be retried".to_string())
            }
        }),
    }
}

async fn summary_from_row(pool: &PgPool, row: BatchRow) -> Result<PublishBatchSummary, AppError> {
    let targets = load_batch_targets(pool, &row.id)
        .await?
        .into_iter()
        .map(batch_target_view)
        .collect();
    Ok(PublishBatchSummary {
        batch_id: row.id,
        status: row.status.clone(),
        post_id: row.post_id,
        snapshot_hash: row.snapshot_hash,
        target_count: row.target_count,
        published_count: row.published_count,
        processing_count: row.processing_count,
        unknown_count: row.unknown_count,
        failed_count: row.failed_count,
        blocked_count: row.blocked_count,
        error_code: row.error_code,
        error_message: safe_error_message(row.error_message),
        completed_at: row.completed_at,
        targets,
    })
}

pub async fn refresh_batch_status(
    pool: &PgPool,
    batch_id: &str,
    org_id: &str,
) -> Result<PublishBatchSummary, AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"UPDATE "SocialPublishBatchItem" item
           SET status = CASE
               WHEN item.status IN ('BLOCKED', 'UNKNOWN') THEN item.status
               WHEN job.metadata->>'_kasitek_outcome' = 'UNKNOWN' THEN 'UNKNOWN'
               ELSE job.status::text
           END,
           retryable = CASE
               WHEN item.status IN ('BLOCKED', 'UNKNOWN') THEN false
               WHEN job.metadata->>'_kasitek_outcome' = 'UNKNOWN' THEN false
               ELSE job.status = 'FAILED'::"SocialPublishJobStatus"
           END,
           "errorCode" = CASE
               WHEN item.status IN ('BLOCKED', 'UNKNOWN') THEN item."errorCode"
               WHEN job.metadata->>'_kasitek_outcome' = 'UNKNOWN' THEN 'provider_outcome_unknown'
               ELSE NULL
           END,
           "errorMessage" = CASE
               WHEN item.status IN ('BLOCKED', 'UNKNOWN') THEN item."errorMessage"
               WHEN job.metadata->>'_kasitek_outcome' = 'UNKNOWN' THEN 'The provider did not confirm the result; reconcile before retrying'
               ELSE job."errorMessage"
           END,
           metadata = CASE
               WHEN job.metadata->>'_kasitek_outcome' = 'UNKNOWN'
                   THEN COALESCE(item.metadata, '{}'::jsonb) || '{"outcome":"UNKNOWN"}'::jsonb
               ELSE item.metadata
           END,
           "updatedAt" = NOW()
           FROM "SocialPublishJob" job
           WHERE item."batchId" = $1 AND item."jobId" = job.id"#,
    )
    .bind(batch_id)
    .execute(&mut *tx)
    .await?;

    let counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64, i64, i64)>(
        r#"SELECT
             COUNT(*)::bigint,
             COUNT(*) FILTER (WHERE status = 'PUBLISHED')::bigint,
             COUNT(*) FILTER (WHERE status = 'PROCESSING')::bigint,
             COUNT(*) FILTER (WHERE status = 'QUEUED')::bigint,
             COUNT(*) FILTER (WHERE status = 'UNKNOWN')::bigint,
             COUNT(*) FILTER (WHERE status = 'FAILED')::bigint,
             COUNT(*) FILTER (WHERE status = 'BLOCKED')::bigint,
             COUNT(*) FILTER (WHERE status = 'CANCELED')::bigint
           FROM "SocialPublishBatchItem"
           WHERE "batchId" = $1"#,
    )
    .bind(batch_id)
    .fetch_one(&mut *tx)
    .await?;
    let status = aggregate_batch_status(
        counts.0, counts.1, counts.2, counts.3, counts.4, counts.5, counts.6, counts.7,
    );
    observability::tracing::info!(
        event = "content.publish_batch.status_refreshed",
        org_id = %org_id,
        batch_id = %batch_id,
        status = status,
        target_count = counts.0,
        published_count = counts.1,
        processing_count = counts.2 + counts.3,
        unknown_count = counts.4,
        failed_count = counts.5 + counts.7,
        blocked_count = counts.6,
        "content batch status refreshed"
    );
    sqlx::query(
        r#"UPDATE "SocialPublishBatch"
           SET status = $2,
            "targetCount" = $3,
               "publishedCount" = $4,
               "processingCount" = $5,
            "unknownCount" = $6,
               "failedCount" = $7,
               "blockedCount" = $8,
               "completedAt" = CASE WHEN $2 IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED') THEN COALESCE("completedAt", NOW()) ELSE NULL END,
               "updatedAt" = NOW()
           WHERE id = $1 AND "orgId" = $9"#,
    )
    .bind(batch_id)
    .bind(status)
    .bind(counts.0)
    .bind(counts.1)
    .bind(counts.2 + counts.3)
    .bind(counts.4)
    .bind(counts.5 + counts.7)
    .bind(counts.6)
    .bind(org_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"UPDATE "SocialPost" post
           SET status = CASE
               WHEN $2 = 'SUCCEEDED' THEN 'PUBLISHED'
               WHEN $2 = 'FAILED' THEN 'FAILED'
               WHEN $2 = 'BLOCKED' AND post.status <> 'PUBLISHED'::"SocialPostStatus" THEN 'DRAFT'
               ELSE 'PROCESSING'
           END::"SocialPostStatus",
               "updatedAt" = NOW()
           FROM "SocialPublishBatch" batch
           WHERE batch.id = $1 AND batch."orgId" = $3 AND post.id = batch."postId" AND post."orgId" = $3"#,
    )
    .bind(batch_id)
    .bind(status)
    .bind(org_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    summary_from_row(pool, load_batch(pool, org_id, batch_id).await?).await
}

pub async fn get_batch(
    pool: &PgPool,
    context: &RequestContext,
    batch_id: &str,
) -> Result<PublishBatchSummary, AppError> {
    load_batch(pool, &context.organization_id, batch_id).await?;
    refresh_batch_status(pool, batch_id, &context.organization_id).await
}

/// Re-queue only provider-confirmed failed targets from an admitted batch.
///
/// This intentionally does not accept a new post, platform, account, or
/// media selection. The original batch remains the authority, published
/// targets are never touched, and an indeterminate outcome remains blocked
/// until a provider reconciliation marks it safe to retry.
pub async fn retry_failed_batch(
    pool: &PgPool,
    context: &RequestContext,
    batch_id: &str,
) -> Result<PublishBatchResponse, AppError> {
    let retry_key = context.idempotency_key.as_deref().ok_or_else(|| {
        AppError::BadRequest("idempotency-key is required for batch retry".to_string())
    })?;
    let batch = load_batch(pool, &context.organization_id, batch_id).await?;
    let _ = refresh_batch_status(pool, batch_id, &context.organization_id).await?;
    let plan = preflight_internal(pool, context, &batch.post_id).await?;
    if plan.snapshot_hash != batch.snapshot_hash {
        return Err(AppError::Conflict(
            "The content changed after this batch was admitted; update the draft and publish a new batch"
                .to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    let lock_key = format!(
        "kasitek.content.publish_batch.retry:{}:{}",
        context.organization_id, batch_id
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(lock_key)
        .execute(&mut *tx)
        .await?;

    if sqlx::query_scalar::<_, String>(
        r#"SELECT item.id
           FROM "SocialPublishBatchItem" item
           WHERE item."batchId" = $1
             AND item.metadata->>'lastRetryIdempotencyKey' = $2
           LIMIT 1"#,
    )
    .bind(batch_id)
    .bind(retry_key)
    .fetch_optional(&mut *tx)
    .await?
    .is_some()
    {
        tx.commit().await?;
        let refreshed = refresh_batch_status(pool, batch_id, &context.organization_id).await?;
        let post = social::get_social_post(pool, &context.organization_id, &batch.post_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
        return Ok(PublishBatchResponse {
            post,
            batch: refreshed,
        });
    }

    let retry_items = sqlx::query_as::<_, RetryBatchItemRow>(
        r#"SELECT item.id, item."jobId" AS job_id
           FROM "SocialPublishBatchItem" item
           INNER JOIN "SocialPublishJob" job ON job.id = item."jobId"
           WHERE item."batchId" = $1
             AND item.status = 'FAILED'
             AND item.retryable = true
             AND job.status = 'FAILED'::"SocialPublishJobStatus"
             AND COALESCE(job.metadata->>'_kasitek_outcome', '') <> 'UNKNOWN'
           FOR UPDATE OF item, job"#,
    )
    .bind(batch_id)
    .fetch_all(&mut *tx)
    .await?;
    if retry_items.is_empty() {
        return Err(AppError::Conflict(
            "No confirmed failed destinations are available to retry; unknown outcomes require provider reconciliation"
                .to_string(),
        ));
    }

    for item in &retry_items {
        let target = plan
            .targets
            .iter()
            .find(|target| target.job_id == item.job_id)
            .ok_or_else(|| {
                AppError::Conflict(
                    "The batch target no longer exists; create a new draft before retrying"
                        .to_string(),
                )
            })?;
        if target.state != "READY" {
            return Err(AppError::Conflict(format!(
                "{} cannot be retried yet: {}",
                target.account_name,
                target
                    .message
                    .as_deref()
                    .unwrap_or("the destination is not ready")
            )));
        }

        let updated = sqlx::query(
            r#"UPDATE "SocialPublishJob"
               SET status = 'QUEUED'::"SocialPublishJobStatus",
                   "scheduledFor" = NULL,
                   "errorMessage" = NULL,
                   metadata = (COALESCE(metadata, '{}'::jsonb) - '_kasitek_outcome') || $2,
                   "updatedAt" = NOW()
               WHERE id = $1 AND "orgId" = $3
                 AND status = 'FAILED'::"SocialPublishJobStatus"
                 AND COALESCE(metadata->>'_kasitek_outcome', '') <> 'UNKNOWN'"#,
        )
        .bind(&item.job_id)
        .bind(json!({
            "_kasitek_batch_id": batch_id,
            "lastRetryIdempotencyKey": retry_key,
        }))
        .bind(&context.organization_id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(AppError::Conflict(
                "This destination changed while it was being prepared for retry".to_string(),
            ));
        }

        sqlx::query(
            r#"UPDATE "SocialPublishBatchItem"
               SET status = 'QUEUED', retryable = false, "errorCode" = NULL,
                   "errorMessage" = NULL,
                   metadata = COALESCE(metadata, '{}'::jsonb) || $2,
                   "updatedAt" = NOW()
               WHERE id = $1 AND "batchId" = $3"#,
        )
        .bind(&item.id)
        .bind(json!({ "lastRetryIdempotencyKey": retry_key }))
        .bind(batch_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let refreshed = refresh_batch_status(pool, batch_id, &context.organization_id).await?;
    let post = social::get_social_post(pool, &context.organization_id, &batch.post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    observability::tracing::info!(
        event = "content.publish_batch.retry_admitted",
        org_id = %context.organization_id,
        batch_id = %batch_id,
        target_count = retry_items.len(),
        status = %refreshed.status,
        "confirmed failed content batch targets requeued"
    );
    Ok(PublishBatchResponse {
        post,
        batch: refreshed,
    })
}

pub async fn get_latest_batch_for_post(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
) -> Result<Option<PublishBatchSummary>, AppError> {
    let batch_id = sqlx::query_scalar::<_, String>(
        r#"SELECT id
           FROM "SocialPublishBatch"
           WHERE "orgId" = $1 AND "postId" = $2
           ORDER BY "updatedAt" DESC, "createdAt" DESC
           LIMIT 1"#,
    )
    .bind(&context.organization_id)
    .bind(post_id)
    .fetch_optional(pool)
    .await?;

    match batch_id {
        Some(batch_id) => get_batch(pool, context, &batch_id).await.map(Some),
        None => Ok(None),
    }
}

pub async fn publish_batch(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
    expected_snapshot_hash: Option<&str>,
) -> Result<PublishBatchResponse, AppError> {
    let idempotency_key = context.idempotency_key.as_deref().ok_or_else(|| {
        AppError::BadRequest("idempotency-key is required for batch content publishing".to_string())
    })?;
    let plan = preflight_internal(pool, context, post_id).await?;
    if let Some(expected_snapshot_hash) = expected_snapshot_hash {
        if expected_snapshot_hash != plan.snapshot_hash {
            return Err(AppError::Conflict(
                "The approved content changed before publishing; review and approve the updated batch".to_string(),
            ));
        }
    }

    let mut tx = pool.begin().await?;
    let lock_key = format!(
        "kasitek.content.publish_batch:{}:{}",
        context.organization_id, post_id
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(lock_key)
        .execute(&mut *tx)
        .await?;
    if let Some(existing_id) = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "SocialPublishBatch" WHERE "orgId" = $1 AND "idempotencyKey" = $2 LIMIT 1"#,
    )
    .bind(&context.organization_id)
    .bind(idempotency_key)
    .fetch_optional(&mut *tx)
    .await?
    {
        let existing = sqlx::query_as::<_, BatchRow>(
        r#"SELECT id, "postId" AS post_id, status, "snapshotHash" AS snapshot_hash,
                       "targetCount"::bigint AS target_count, "publishedCount"::bigint AS published_count,
                       "processingCount"::bigint AS processing_count, "unknownCount"::bigint AS unknown_count,
                       "failedCount"::bigint AS failed_count,
                       "blockedCount"::bigint AS blocked_count, "errorCode" AS error_code,
                       "errorMessage" AS error_message, "completedAt" AT TIME ZONE 'UTC' AS completed_at
                FROM "SocialPublishBatch" WHERE id = $1"#,
        )
        .bind(existing_id)
        .fetch_one(&mut *tx)
        .await?;
        if existing.post_id != post_id || existing.snapshot_hash != plan.snapshot_hash {
            return Err(AppError::Conflict(
                "This idempotency key was already used for a different content revision".to_string(),
            ));
        }
        tx.commit().await?;
        let batch = refresh_batch_status(pool, &existing.id, &context.organization_id).await?;
        observability::tracing::info!(
            event = "content.publish_batch.idempotent_replay",
            org_id = %context.organization_id,
            post_id = %post_id,
            batch_id = %existing.id,
            "content batch request reused an existing admission"
        );
        let post = social::get_social_post(pool, &context.organization_id, post_id)
            .await?
            .unwrap_or(plan.post);
        return Ok(PublishBatchResponse { post, batch });
    }

    let batch_id = cuid2::create_id();
    // A batch is all-or-nothing at admission. A target that was READY during
    // preflight is only queued when every selected target is READY or already
    // published. This prevents a blocked account from silently turning the
    // request into an unapproved subset publish.
    let queue_allowed = plan.status == "READY";
    let ready_targets = plan
        .targets
        .iter()
        .filter(|target| queue_allowed && target.state == "READY")
        .count() as i64;
    let initial_status = plan.status.as_str();
    sqlx::query(
        r#"INSERT INTO "SocialPublishBatch" (
             id, "userId", "orgId", "postId", status, "idempotencyKey", "snapshotHash",
             "targetCount", "publishedCount", "unknownCount", "blockedCount", "createdAt", "updatedAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())"#,
    )
    .bind(&batch_id)
    .bind(&plan.post.row.user_id)
    .bind(&context.organization_id)
    .bind(post_id)
    .bind(initial_status)
    .bind(idempotency_key)
    .bind(&plan.snapshot_hash)
    .bind(plan.targets.len() as i64)
    .bind(
        plan.targets
            .iter()
            .filter(|target| target.state == "ALREADY_PUBLISHED")
            .count() as i64,
    )
    .bind(
        plan.targets
            .iter()
            .filter(|target| target.state == "UNKNOWN")
            .count() as i64,
    )
    .bind(
        plan.targets
            .iter()
            .filter(|target| {
                target.state != "READY"
                    && target.state != "ALREADY_PUBLISHED"
                    && target.state != "UNKNOWN"
            })
            .count() as i64,
    )
    .execute(&mut *tx)
    .await?;

    for target in &plan.targets {
        let item_status = match target.state.as_str() {
            "ALREADY_PUBLISHED" => "PUBLISHED",
            "READY" if queue_allowed => "QUEUED",
            "IN_PROGRESS" => "PROCESSING",
            "UNKNOWN" => "UNKNOWN",
            _ => "BLOCKED",
        };
        let blocked_by_batch = target.state == "READY" && !queue_allowed;
        let item_error_code = if blocked_by_batch {
            Some("batch_preflight_blocked".to_string())
        } else {
            target.reason_code.clone()
        };
        let item_error_message = if blocked_by_batch {
            Some(
                "This destination was not queued because another selected destination failed preflight"
                    .to_string(),
            )
        } else {
            target.message.clone()
        };
        sqlx::query(
            r#"INSERT INTO "SocialPublishBatchItem" (
                 id, "batchId", "jobId", platform, "channelConnectionId", status,
                 retryable, "errorCode", "errorMessage", metadata, "createdAt", "updatedAt"
               ) VALUES ($1,$2,$3,CAST($4 AS "SocialPlatform"),$5,$6,$7,$8,$9,$10,NOW(),NOW())"#,
        )
        .bind(cuid2::create_id())
        .bind(&batch_id)
        .bind(&target.job_id)
        .bind(&target.platform)
        .bind(&target.channel_connection_id)
        .bind(item_status)
        .bind(false)
        .bind(&item_error_code)
        .bind(&item_error_message)
        .bind(json!({ "requiredCapability": target.required_capability }))
        .execute(&mut *tx)
        .await?;

        if queue_allowed && target.state == "READY" {
            sqlx::query(
                r#"UPDATE "SocialPublishJob"
                   SET status = 'QUEUED'::"SocialPublishJobStatus",
                       "scheduledFor" = NULL,
                       metadata = COALESCE(metadata, '{}'::jsonb) || $2,
                       "errorMessage" = NULL,
                       "updatedAt" = NOW()
                   WHERE id = $1 AND "orgId" = $3
                     AND status IN ('PENDING'::"SocialPublishJobStatus", 'FAILED'::"SocialPublishJobStatus", 'QUEUED'::"SocialPublishJobStatus")"#,
            )
            .bind(&target.job_id)
            .bind(json!({ "_kasitek_batch_id": batch_id }))
            .bind(&context.organization_id)
            .execute(&mut *tx)
            .await?;
        }
    }
    if ready_targets > 0 {
        sqlx::query(
            r#"UPDATE "SocialPost"
               SET status = 'PROCESSING'::"SocialPostStatus", "updatedAt" = NOW()
               WHERE id = $1 AND "orgId" = $2 AND status IN ('DRAFT'::"SocialPostStatus", 'FAILED'::"SocialPostStatus")"#,
        )
        .bind(post_id)
        .bind(&context.organization_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let batch = refresh_batch_status(pool, &batch_id, &context.organization_id).await?;
    observability::tracing::info!(
        event = "content.publish_batch.admitted",
        org_id = %context.organization_id,
        post_id = %post_id,
        batch_id = %batch_id,
        target_count = batch.target_count,
        blocked_count = batch.blocked_count,
        status = %batch.status,
        "content batch admitted"
    );
    let post = social::get_social_post(pool, &context.organization_id, post_id)
        .await?
        .unwrap_or(plan.post);
    Ok(PublishBatchResponse { post, batch })
}

pub async fn refresh_active_batches(pool: &PgPool, limit: i64) -> Result<i64, AppError> {
    let batch_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "SocialPublishBatch"
           WHERE status IN ('PROCESSING', 'UNKNOWN')
           ORDER BY "updatedAt" ASC
           LIMIT $1"#,
    )
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;
    let mut refreshed = 0;
    for batch_id in batch_ids {
        let org_id = sqlx::query_scalar::<_, String>(
            r#"SELECT "orgId" FROM "SocialPublishBatch" WHERE id = $1"#,
        )
        .bind(&batch_id)
        .fetch_optional(pool)
        .await?;
        if let Some(org_id) = org_id {
            refresh_batch_status(pool, &batch_id, &org_id).await?;
            refreshed += 1;
        }
    }
    Ok(refreshed)
}

#[cfg(test)]
mod tests {
    use super::{aggregate_batch_status, platform_media_error, text_length_error};

    #[test]
    fn aggregate_status_preserves_partial_results() {
        assert_eq!(aggregate_batch_status(3, 2, 0, 0, 0, 1, 0, 0), "PARTIAL");
        assert_eq!(aggregate_batch_status(3, 0, 1, 1, 0, 1, 0, 0), "PROCESSING");
        assert_eq!(aggregate_batch_status(3, 0, 0, 0, 0, 0, 3, 0), "BLOCKED");
        assert_eq!(aggregate_batch_status(3, 3, 0, 0, 0, 0, 0, 0), "SUCCEEDED");
        assert_eq!(aggregate_batch_status(3, 1, 0, 0, 1, 0, 0, 1), "UNKNOWN");
    }

    #[test]
    fn adapter_limits_are_checked_before_queueing() {
        assert!(
            platform_media_error("INSTAGRAM", &["IMAGE".to_string(), "IMAGE".to_string()], 2)
                .is_some()
        );
        assert!(platform_media_error("TIKTOK", &["VIDEO".to_string()], 1).is_none());
        assert!(text_length_error("X", &"x".repeat(281)).is_some());
        assert!(text_length_error("INSTAGRAM", &"x".repeat(10_000)).is_none());
    }
}
