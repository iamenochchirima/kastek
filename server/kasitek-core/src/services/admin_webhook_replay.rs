//! Durable, dual-control replay commands for core-owned public webhooks.
//!
//! Agent delivery attempts live in the Agent database and use the Agent
//! command ledger. Public API webhook deliveries are core-owned, so this
//! module keeps their operator command and audit state in the same database.
//! The replay operation only moves a failed delivery back to PENDING after a
//! second operator approves the exact delivery version that was requested.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use crate::error::AppError;

const REQUIRED_APPROVALS: usize = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReplayRequest {
    pub delivery_id: String,
    pub expected_status: String,
    pub expected_attempt_count: i32,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCommand {
    pub id: String,
    pub idempotency_key: String,
    pub delivery_id: String,
    pub actor_id: String,
    pub expected_status: String,
    pub expected_attempt_count: i32,
    pub approver_ids: Vec<String>,
    pub status: String,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FailedDelivery {
    pub id: String,
    pub subscription_id: String,
    pub organization_id: String,
    pub event_id: String,
    pub event_type: String,
    pub status: String,
    pub attempt_count: i32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct DeliveryVersion {
    id: String,
    status: String,
    attempt_count: i32,
    subscription_status: String,
    event_type: String,
}

fn normalize_delivery_id(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 160 {
        return Err(AppError::BadRequest(
            "deliveryId must be between 1 and 160 characters".to_string(),
        ));
    }
    Ok(value.to_string())
}

fn normalize_expected_status(value: &str) -> Result<String, AppError> {
    let value = value.trim().to_ascii_uppercase();
    if value != "FAILED" {
        return Err(AppError::BadRequest(
            "expectedStatus must be FAILED for a webhook replay".to_string(),
        ));
    }
    Ok(value)
}

fn validate_request(input: &CreateReplayRequest) -> Result<(String, String), AppError> {
    if input.expected_attempt_count < 0 {
        return Err(AppError::BadRequest(
            "expectedAttemptCount must be zero or greater".to_string(),
        ));
    }
    Ok((
        normalize_delivery_id(&input.delivery_id)?,
        normalize_expected_status(&input.expected_status)?,
    ))
}

async fn load_command<'e, E>(
    executor: E,
    idempotency_key: &str,
) -> Result<Option<ReplayCommand>, AppError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    Ok(sqlx::query_as::<_, ReplayCommand>(
        r#"
        SELECT "id", "idempotencyKey" AS idempotency_key,
               "deliveryId" AS delivery_id, "actorId" AS actor_id,
               "expectedStatus" AS expected_status,
               "expectedAttemptCount" AS expected_attempt_count,
               "approverIds" AS approver_ids, "status", "error", "result",
               "completedAt" AT TIME ZONE 'UTC' AS completed_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "AdminWebhookReplayCommand"
        WHERE "idempotencyKey" = $1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(executor)
    .await?)
}

async fn record_audit(
    transaction: &mut Transaction<'_, Postgres>,
    command_id: &str,
    actor_id: &str,
    action: &str,
    metadata: Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"INSERT INTO "AdminWebhookReplayAuditEvent"
           ("id", "commandId", "actorId", "action", "metadata")
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(cuid2::create_id())
    .bind(command_id)
    .bind(actor_id)
    .bind(action)
    .bind(metadata)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub async fn list_failed_deliveries(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<FailedDelivery>, AppError> {
    let limit = limit.clamp(1, 100);
    Ok(sqlx::query_as::<_, FailedDelivery>(
        r#"
        SELECT d."id", d."subscriptionId" AS subscription_id,
               s."orgId" AS organization_id, d."eventId" AS event_id,
               d."eventType" AS event_type, d."status",
               d."attemptCount" AS attempt_count,
               d."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "PublicApiWebhookDelivery" d
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE d."status" = 'FAILED' AND s."status" = 'ACTIVE'
        ORDER BY d."updatedAt" DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

pub async fn create(
    pool: &PgPool,
    actor_id: &str,
    idempotency_key: &str,
    input: CreateReplayRequest,
) -> Result<ReplayCommand, AppError> {
    let (delivery_id, expected_status) = validate_request(&input)?;
    let idempotency_key = idempotency_key.trim();
    if idempotency_key.len() < 8 || idempotency_key.len() > 240 {
        return Err(AppError::BadRequest(
            "idempotency-key must be 8-240 characters".to_string(),
        ));
    }

    if let Some(existing) = load_command(pool, idempotency_key).await? {
        if existing.delivery_id != delivery_id
            || existing.expected_status != expected_status
            || existing.expected_attempt_count != input.expected_attempt_count
        {
            return Err(AppError::Conflict(
                "idempotency key is already bound to a different replay request".to_string(),
            ));
        }
        return Ok(existing);
    }

    let mut transaction = pool.begin().await?;
    let delivery = sqlx::query_as::<_, DeliveryVersion>(
        r#"
        SELECT d."id", d."status", d."attemptCount" AS attempt_count,
               s."status" AS subscription_status, d."eventType" AS event_type
        FROM "PublicApiWebhookDelivery" d
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE d."id" = $1
        FOR UPDATE
        "#,
    )
    .bind(&delivery_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| AppError::NotFound("Webhook delivery not found".to_string()))?;
    if delivery.status != expected_status || delivery.attempt_count != input.expected_attempt_count
    {
        return Err(AppError::Conflict(
            "Webhook delivery changed; refresh the operator queue".to_string(),
        ));
    }
    if delivery.subscription_status != "ACTIVE" {
        return Err(AppError::Conflict(
            "Webhook subscription is not active".to_string(),
        ));
    }

    let command_id = cuid2::create_id();
    let inserted = sqlx::query_as::<_, ReplayCommand>(
        r#"
        INSERT INTO "AdminWebhookReplayCommand"
          ("id", "idempotencyKey", "deliveryId", "actorId", "expectedStatus",
           "expectedAttemptCount", "approverIds", "status", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$4]::TEXT[], 'awaiting_approval', NOW())
        RETURNING "id", "idempotencyKey" AS idempotency_key,
                  "deliveryId" AS delivery_id, "actorId" AS actor_id,
                  "expectedStatus" AS expected_status,
                  "expectedAttemptCount" AS expected_attempt_count,
                  "approverIds" AS approver_ids, "status", "error", "result",
                  "completedAt" AT TIME ZONE 'UTC' AS completed_at,
                  "createdAt" AT TIME ZONE 'UTC' AS created_at,
                  "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        "#,
    )
    .bind(&command_id)
    .bind(idempotency_key)
    .bind(&delivery_id)
    .bind(actor_id)
    .bind(&expected_status)
    .bind(input.expected_attempt_count)
    .fetch_optional(&mut *transaction)
    .await?;

    let command = if let Some(command) = inserted {
        command
    } else {
        transaction.rollback().await?;
        return load_command(pool, idempotency_key).await?.ok_or_else(|| {
            AppError::Conflict("Replay request was concurrently created".to_string())
        });
    };
    record_audit(
        &mut transaction,
        &command.id,
        actor_id,
        "replay_requested",
        json!({
            "deliveryId": delivery.id,
            "expectedStatus": expected_status,
            "expectedAttemptCount": input.expected_attempt_count,
            "eventType": delivery.event_type,
        }),
    )
    .await?;
    transaction.commit().await?;
    Ok(command)
}

pub async fn get(pool: &PgPool, command_id: &str) -> Result<ReplayCommand, AppError> {
    sqlx::query_as::<_, ReplayCommand>(
        r#"
        SELECT "id", "idempotencyKey" AS idempotency_key,
               "deliveryId" AS delivery_id, "actorId" AS actor_id,
               "expectedStatus" AS expected_status,
               "expectedAttemptCount" AS expected_attempt_count,
               "approverIds" AS approver_ids, "status", "error", "result",
               "completedAt" AT TIME ZONE 'UTC' AS completed_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "AdminWebhookReplayCommand" WHERE "id" = $1
        "#,
    )
    .bind(command_id.trim())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Webhook replay command not found".to_string()))
}

pub async fn approve(
    pool: &PgPool,
    command_id: &str,
    actor_id: &str,
) -> Result<ReplayCommand, AppError> {
    let mut transaction = pool.begin().await?;
    let mut command = sqlx::query_as::<_, ReplayCommand>(
        r#"
        SELECT "id", "idempotencyKey" AS idempotency_key,
               "deliveryId" AS delivery_id, "actorId" AS actor_id,
               "expectedStatus" AS expected_status,
               "expectedAttemptCount" AS expected_attempt_count,
               "approverIds" AS approver_ids, "status", "error", "result",
               "completedAt" AT TIME ZONE 'UTC' AS completed_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "AdminWebhookReplayCommand"
        WHERE "id" = $1
        FOR UPDATE
        "#,
    )
    .bind(command_id.trim())
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| AppError::NotFound("Webhook replay command not found".to_string()))?;

    if command.status != "awaiting_approval" {
        transaction.commit().await?;
        return Ok(command);
    }
    if command.approver_ids.iter().any(|id| id == actor_id) {
        return Err(AppError::Conflict(
            "A second, distinct operator approval is required".to_string(),
        ));
    }
    command.approver_ids.push(actor_id.to_string());
    if command.approver_ids.len() < REQUIRED_APPROVALS {
        sqlx::query(
            r#"UPDATE "AdminWebhookReplayCommand"
               SET "approverIds" = $2, "updatedAt" = NOW()
               WHERE "id" = $1"#,
        )
        .bind(&command.id)
        .bind(&command.approver_ids)
        .execute(&mut *transaction)
        .await?;
        record_audit(
            &mut transaction,
            &command.id,
            actor_id,
            "replay_approved",
            json!({ "approvalCount": command.approver_ids.len() }),
        )
        .await?;
        transaction.commit().await?;
        return get(pool, &command.id).await;
    }

    let delivery = sqlx::query_as::<_, DeliveryVersion>(
        r#"
        SELECT d."id", d."status", d."attemptCount" AS attempt_count,
               s."status" AS subscription_status, d."eventType" AS event_type
        FROM "PublicApiWebhookDelivery" d
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE d."id" = $1
        FOR UPDATE
        "#,
    )
    .bind(&command.delivery_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(delivery) = delivery else {
        let message = "Webhook delivery no longer exists";
        fail_command(&mut transaction, &command, actor_id, message).await?;
        transaction.commit().await?;
        return get(pool, &command.id).await;
    };
    if delivery.status != command.expected_status
        || delivery.attempt_count != command.expected_attempt_count
        || delivery.subscription_status != "ACTIVE"
    {
        let message = "Webhook delivery changed or its subscription is inactive";
        fail_command(&mut transaction, &command, actor_id, message).await?;
        transaction.commit().await?;
        return get(pool, &command.id).await;
    }

    sqlx::query(
        r#"
        UPDATE "PublicApiWebhookDelivery"
        SET "status" = 'PENDING', "attemptCount" = 0,
            "nextAttemptAt" = NOW(), "lastStatusCode" = NULL,
            "lastError" = NULL, "deliveredAt" = NULL, "updatedAt" = NOW()
        WHERE "id" = $1 AND "status" = $2 AND "attemptCount" = $3
        "#,
    )
    .bind(&command.delivery_id)
    .bind(&command.expected_status)
    .bind(command.expected_attempt_count)
    .execute(&mut *transaction)
    .await?;
    let result = json!({
        "deliveryId": command.delivery_id,
        "status": "PENDING",
        "attemptCount": 0,
        "eventType": delivery.event_type,
    });
    sqlx::query(
        r#"UPDATE "AdminWebhookReplayCommand"
           SET "approverIds" = $2, "status" = 'completed', "result" = $3,
               "completedAt" = NOW(), "updatedAt" = NOW()
           WHERE "id" = $1"#,
    )
    .bind(&command.id)
    .bind(&command.approver_ids)
    .bind(&result)
    .execute(&mut *transaction)
    .await?;
    record_audit(
        &mut transaction,
        &command.id,
        actor_id,
        "replay_queued",
        json!({
            "deliveryId": command.delivery_id,
            "previousStatus": command.expected_status,
            "previousAttemptCount": command.expected_attempt_count,
        }),
    )
    .await?;
    transaction.commit().await?;
    get(pool, &command.id).await
}

async fn fail_command(
    transaction: &mut Transaction<'_, Postgres>,
    command: &ReplayCommand,
    actor_id: &str,
    message: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE "AdminWebhookReplayCommand"
           SET "approverIds" = $2, "status" = 'failed', "error" = $3,
               "updatedAt" = NOW()
           WHERE "id" = $1"#,
    )
    .bind(&command.id)
    .bind(&command.approver_ids)
    .bind(message)
    .execute(&mut **transaction)
    .await?;
    record_audit(
        transaction,
        &command.id,
        actor_id,
        "replay_rejected",
        json!({ "reason": message }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{normalize_expected_status, validate_request, CreateReplayRequest};

    #[test]
    fn replay_requires_failed_version() {
        assert!(normalize_expected_status("failed").is_ok());
        assert!(normalize_expected_status("PENDING").is_err());
        assert!(validate_request(&CreateReplayRequest {
            delivery_id: "delivery-1".to_string(),
            expected_status: "FAILED".to_string(),
            expected_attempt_count: 10,
        })
        .is_ok());
    }

    #[test]
    fn replay_rejects_negative_attempt_versions() {
        assert!(validate_request(&CreateReplayRequest {
            delivery_id: "delivery-1".to_string(),
            expected_status: "FAILED".to_string(),
            expected_attempt_count: -1,
        })
        .is_err());
    }
}
