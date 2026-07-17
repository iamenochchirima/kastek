use crate::config::AppConfig;
use crate::db::models::{
    BotActionRequest, BotConfigurationRow, BotCreateRequest, BotDeploymentCallbackRequest,
    BotEventCreateRequest,
};
use crate::error::AppError;
use crate::services::agents::provisioning::{
    callbacks as agent_callbacks, channel_config, execute as execute_agent_action,
    template_definition,
};
use crate::services::agents::types::AgentDispatchPayload;
use crate::services::whatsapp;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BotListRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    #[serde(rename = "userId")]
    pub user_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub bot_type: String,
    pub status: String,
    #[sqlx(rename = "greeting_message")]
    #[serde(rename = "greetingMessage")]
    pub greeting_message: Option<String>,
    pub personality: Option<String>,
    pub language: String,
    pub capabilities: Option<Value>,
    #[sqlx(rename = "knowledge_base")]
    #[serde(rename = "knowledgeBase")]
    pub knowledge_base: Option<Value>,
    #[sqlx(rename = "integration_config")]
    #[serde(rename = "integrationConfig")]
    pub integration_config: Option<Value>,
    #[sqlx(rename = "created_at")]
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    #[sqlx(rename = "hit_count")]
    #[serde(rename = "hitCount")]
    pub hit_count: i64,
    #[sqlx(rename = "conversation_count")]
    #[serde(rename = "conversationCount")]
    pub conversation_count: i64,
    #[sqlx(rename = "handoff_count")]
    #[serde(rename = "handoffCount")]
    pub handoff_count: i64,
    #[sqlx(rename = "failure_count")]
    #[serde(rename = "failureCount")]
    pub failure_count: i64,
    #[sqlx(rename = "avg_response_time_ms")]
    #[serde(rename = "avgResponseTimeMs")]
    pub avg_response_time_ms: Option<f64>,
    #[sqlx(rename = "last_active_at")]
    #[serde(rename = "lastActiveAt")]
    pub last_active_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "deployment_status")]
    #[serde(rename = "deploymentStatus")]
    pub deployment_status: Option<String>,
    #[sqlx(rename = "deployment_target")]
    #[serde(rename = "deploymentTarget")]
    pub deployment_target: Option<String>,
    #[sqlx(rename = "workflow_id")]
    #[serde(rename = "workflowId")]
    pub workflow_id: Option<String>,
    #[sqlx(rename = "deployment_version")]
    #[serde(rename = "deploymentVersion")]
    pub deployment_version: Option<i32>,
    #[sqlx(rename = "deployment_error")]
    #[serde(rename = "deploymentError")]
    pub deployment_error: Option<String>,
    #[sqlx(rename = "deployment_payload")]
    #[serde(rename = "deploymentPayload")]
    pub deployment_payload: Option<Value>,
    #[sqlx(rename = "deployed_at")]
    #[serde(rename = "deployedAt")]
    pub deployed_at: Option<DateTime<Utc>>,
}

fn select_bot_sql() -> &'static str {
    r#"
    SELECT id, "userId" AS user_id, name, type AS bot_type, status,
           "greetingMessage" AS greeting_message, personality, language,
           capabilities, "knowledgeBase" AS knowledge_base,
           "integrationConfig" AS integration_config,
           "createdAt" AS created_at, "updatedAt" AS updated_at
    FROM "BotConfiguration"
    "#
}

fn valid_bot_type(bot_type: &str) -> bool {
    matches!(
        bot_type,
        "starter"
            | "growth"
            | "whatsapp_agent"
            | "website_agent"
            | "voice_agent"
            | "support_agent"
            | "booking_agent"
            | "lead_qualification_agent"
    )
}

pub fn should_auto_provision(input: &BotCreateRequest) -> bool {
    if input.auto_provision.unwrap_or(false) {
        return true;
    }

    let managed_launch = input
        .integration_config
        .as_ref()
        .and_then(|value| value.get("launchMode"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        == Some("managed");

    let managed_business = input
        .business_details
        .as_ref()
        .and_then(|value| value.get("launchMode"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        == Some("managed");

    let managed_capabilities = input
        .capabilities
        .as_ref()
        .and_then(|value| value.get("deploymentMode"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        == Some("managed");

    managed_launch || managed_business || managed_capabilities
}

pub async fn list_bots(pool: &PgPool, org_id: &str) -> Result<Vec<BotListRow>, AppError> {
    sqlx::query_as::<_, BotListRow>(
        r#"
        SELECT
            b.id,
            b."userId" AS user_id,
            b.name,
            b.type AS bot_type,
            b.status,
            b."greetingMessage" AS greeting_message,
            b.personality,
            b.language,
            b.capabilities,
            b."knowledgeBase" AS knowledge_base,
            b."integrationConfig" AS integration_config,
            b."createdAt" AS created_at,
            b."updatedAt" AS updated_at,
            COALESCE(metrics.hit_count, 0) AS hit_count,
            COALESCE(metrics.conversation_count, 0) AS conversation_count,
            COALESCE(metrics.handoff_count, 0) AS handoff_count,
            COALESCE(metrics.failure_count, 0) AS failure_count,
            metrics.avg_response_time_ms,
            metrics.last_active_at,
            latest_deployment.status AS deployment_status,
            latest_deployment.target AS deployment_target,
            latest_deployment."workflowId" AS workflow_id,
            latest_deployment."versionNumber" AS deployment_version,
            latest_deployment."errorMessage" AS deployment_error,
            latest_deployment."responsePayload" AS deployment_payload,
            latest_deployment."deployedAt" AS deployed_at
        FROM "BotConfiguration" b
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*) FILTER (WHERE e."eventType" IN ('agent.hit', 'agent.started', 'agent.responded')) AS hit_count,
                COUNT(DISTINCT e."conversationId") FILTER (WHERE e."conversationId" IS NOT NULL) AS conversation_count,
                COUNT(*) FILTER (WHERE e."eventType" = 'agent.handoff') AS handoff_count,
                COUNT(*) FILTER (WHERE e."eventType" = 'agent.failed' OR e.status = 'failed') AS failure_count,
                AVG(e."responseTimeMs")::DOUBLE PRECISION AS avg_response_time_ms,
                MAX(e."createdAt") AS last_active_at
            FROM "BotEvent" e
            WHERE e."botId" = b.id
        ) metrics ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                d.status,
                d.target,
                d."workflowId",
                d."versionNumber",
                d."errorMessage",
                d."responsePayload",
                d."deployedAt"
            FROM "BotDeployment" d
            WHERE d."botId" = b.id
            ORDER BY d."createdAt" DESC
            LIMIT 1
        ) latest_deployment ON TRUE
        WHERE b."orgId" = $1
        ORDER BY COALESCE(metrics.last_active_at, b."updatedAt") DESC, b."createdAt" DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

fn normalize_action(action: Option<&str>) -> Result<&str, AppError> {
    match action.map(str::trim).filter(|value| !value.is_empty()) {
        Some("provision") => Ok("provision"),
        Some("pause") => Ok("pause"),
        Some("resume") => Ok("resume"),
        Some(other) => Err(AppError::BadRequest(format!("Unsupported action: {other}"))),
        None => Err(AppError::BadRequest("action is required".to_string())),
    }
}

async fn latest_bot_deployment_status(
    pool: &PgPool,
    bot_id: &str,
) -> Result<Option<(String, String, Option<String>, i32)>, AppError> {
    sqlx::query_as::<_, (String, String, Option<String>, i32)>(
        r#"
        SELECT id, status, "workflowId", "versionNumber"
        FROM "BotDeployment"
        WHERE "botId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 1
        "#,
    )
    .bind(bot_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn resolve_integration_config_for_dispatch(
    pool: &PgPool,
    org_id: &str,
    bot_type: &str,
    integration_config: Option<&Value>,
) -> Result<Option<Value>, AppError> {
    if bot_type != "whatsapp_agent" {
        return Ok(integration_config.cloned());
    }

    let Some(base_config) = integration_config.cloned() else {
        return Err(AppError::BadRequest(
            "A WhatsApp agent requires a connected WhatsApp number".to_string(),
        ));
    };

    let connection_id = base_config
        .get("whatsappConnectionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let Some(connection_id) = connection_id else {
        return Err(AppError::BadRequest(
            "Select a WhatsApp connection before provisioning this agent".to_string(),
        ));
    };

    let permitted = base_config
        .get("permittedConnectionIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .any(|id| id == connection_id)
        })
        .unwrap_or(true);
    if !permitted {
        return Err(AppError::Forbidden(
            "This agent is not permitted to use the selected WhatsApp connection".to_string(),
        ));
    }
    let has_agent_capability = sqlx::query_scalar::<_, bool>(r#"
        SELECT EXISTS (
          SELECT 1 FROM "ExternalConnection" connection
          JOIN "ExternalConnectionCapability" capability ON capability."connectionId" = connection.id
          WHERE connection."orgId" = $1 AND connection."sourceType" = 'WHATSAPP'
            AND connection."sourceId" = $2 AND capability.key = 'AGENT_CHANNEL' AND capability.enabled = true
        )
    "#).bind(org_id).bind(connection_id).fetch_one(pool).await?;
    if !has_agent_capability {
        return Err(AppError::Forbidden(
            "The selected connection does not have the Agents channel capability".to_string(),
        ));
    }

    let connection = whatsapp::get_connection_for_provisioning(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| {
            AppError::BadRequest("Selected WhatsApp connection was not found".to_string())
        })?;

    let mut object = match base_config {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };

    object.insert(
        "whatsappConnectionId".to_string(),
        Value::String(connection.id.clone()),
    );
    object.insert(
        "phoneNumberId".to_string(),
        Value::String(connection.phone_number_id.clone()),
    );
    object.insert(
        "accessToken".to_string(),
        Value::String(connection.access_token),
    );
    object.insert("wabaId".to_string(), Value::String(connection.waba_id));
    if let Some(display_number) = connection.phone_display_number {
        object.insert(
            "phoneDisplayNumber".to_string(),
            Value::String(display_number),
        );
    }

    Ok(Some(Value::Object(object)))
}

pub async fn execute_bot_action(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    org_id: &str,
    bot_id: &str,
    input: BotActionRequest,
) -> Result<BotListRow, AppError> {
    let action = normalize_action(input.action.as_deref())?;
    let bot = get_bot(pool, org_id, bot_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Bot not found".to_string()))?;
    let resolved_integration_config = resolve_integration_config_for_dispatch(
        pool,
        org_id,
        &bot.bot_type,
        bot.integration_config.as_ref(),
    )
    .await?;

    let existing = latest_bot_deployment_status(pool, bot_id).await?;

    match action {
        "provision" => {
            crate::services::billing::require_usage_available(
                pool,
                org_id,
                "agents",
                "deployments",
                1,
            )
            .await?;
            if let Some((_, status, _, _)) = existing.as_ref() {
                if matches!(status.as_str(), "provisioning" | "active" | "paused") {
                    return Err(AppError::Conflict(
                        "This agent already has an active deployment record".to_string(),
                    ));
                }
            }

            let next_version = existing.map(|(_, _, _, version)| version + 1).unwrap_or(1);
            let deployment_id = cuid2::create_id();
            let config_snapshot = json!({
                "name": bot.name,
                "type": bot.bot_type,
                "language": bot.language,
                "greetingMessage": bot.greeting_message,
                "personality": bot.personality,
                "capabilities": bot.capabilities,
                "knowledgeBase": bot.knowledge_base,
                "integrationConfig": resolved_integration_config,
            });

            sqlx::query(
                r#"
                INSERT INTO "BotDeployment" (
                    id, "botId", "userId", "orgId", provider, target, status, "versionNumber",
                    "templateKey", "configSnapshot", "createdAt", "updatedAt"
                )
                VALUES ($1, $2, $3, $4, 'n8n', $5, 'provisioning', $6, $7, $8, NOW(), NOW())
                "#,
            )
            .bind(&deployment_id)
            .bind(bot_id)
            .bind(user_id)
            .bind(org_id)
            .bind(
                bot.integration_config
                    .as_ref()
                    .and_then(|value| value.get("deploymentTarget"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("n8n"),
            )
            .bind(next_version)
            .bind(
                bot.integration_config
                    .as_ref()
                    .and_then(|value| value.get("templateKey"))
                    .and_then(|value| value.as_str())
                    .unwrap_or(bot.bot_type.as_str()),
            )
            .bind(config_snapshot)
            .execute(pool)
            .await?;

            sqlx::query(
                r#"
                UPDATE "BotConfiguration"
                SET status = 'provisioning', "updatedAt" = NOW()
                WHERE id = $1 AND "orgId" = $2
                "#,
            )
            .bind(bot_id)
            .bind(org_id)
            .execute(pool)
            .await?;

            let integration_config_for_dispatch = resolved_integration_config.clone();
            let dispatch = execute_agent_action(
                config,
                AgentDispatchPayload {
                    action: "provision".to_string(),
                    bot_id: bot.id.clone(),
                    user_id: bot.user_id.clone(),
                    deployment_id: deployment_id.clone(),
                    workflow_id: None,
                    version_number: next_version,
                    name: bot.name.clone(),
                    bot_type: bot.bot_type.clone(),
                    status: "provisioning".to_string(),
                    language: bot.language.clone(),
                    greeting_message: bot.greeting_message.clone(),
                    personality: bot.personality.clone(),
                    capabilities: bot.capabilities.clone(),
                    knowledge_base: bot.knowledge_base.clone(),
                    integration_config: integration_config_for_dispatch.clone(),
                    template: template_definition(&bot.bot_type, integration_config_for_dispatch.as_ref()),
                    callbacks: agent_callbacks(config, &bot.id, &deployment_id),
                    channel_config: channel_config(&bot.bot_type, integration_config_for_dispatch.as_ref()),
                },
            )
            .await
            .map_err(|error| {
                let message = error.to_string();
                log::warn!(
                    "bot provisioning dispatch failed for user_id={} bot_id={} deployment_id={}: {}",
                    user_id,
                    bot_id,
                    deployment_id,
                    message
                );
                error
            });

            let dispatch = match dispatch {
                Ok(result) => result,
                Err(error) => {
                    sqlx::query(
                        r#"
                        UPDATE "BotDeployment"
                        SET status = 'error',
                            "errorMessage" = $1,
                            "updatedAt" = NOW()
                        WHERE id = $2
                        "#,
                    )
                    .bind(error.to_string())
                    .bind(&deployment_id)
                    .execute(pool)
                    .await?;

                    sqlx::query(
                        r#"
                        UPDATE "BotConfiguration"
                        SET status = 'error', "updatedAt" = NOW()
                        WHERE id = $1 AND "orgId" = $2
                        "#,
                    )
                    .bind(bot_id)
                    .bind(org_id)
                    .execute(pool)
                    .await?;

                    return Err(error);
                }
            };

            match dispatch {
                Some(result) => {
                    let next_error_message = if result.status.as_deref() == Some("error") {
                        result.message.clone()
                    } else {
                        None
                    };
                    let next_status = result
                        .status
                        .clone()
                        .unwrap_or_else(|| "active".to_string());
                    sqlx::query(
                        r#"
                        UPDATE "BotDeployment"
                        SET status = $1,
                            "workflowId" = COALESCE($2, "workflowId"),
                            "responsePayload" = $3,
                            "errorMessage" = $4,
                            "deployedAt" = CASE WHEN $1 = 'active' THEN NOW() ELSE "deployedAt" END,
                            "updatedAt" = NOW()
                        WHERE id = $5
                        "#,
                    )
                    .bind(&next_status)
                    .bind(result.workflow_id)
                    .bind(result.payload)
                    .bind(next_error_message)
                    .bind(&deployment_id)
                    .execute(pool)
                    .await?;

                    sqlx::query(
                        r#"
                        UPDATE "BotConfiguration"
                        SET status = $1, "updatedAt" = NOW()
                        WHERE id = $2 AND "orgId" = $3
                        "#,
                    )
                    .bind(&next_status)
                    .bind(bot_id)
                    .bind(org_id)
                    .execute(pool)
                    .await?;
                }
                None => {
                    sqlx::query(
                        r#"
                        UPDATE "BotDeployment"
                        SET status = 'pending_manual',
                            "errorMessage" = 'N8N provisioner not configured',
                            "updatedAt" = NOW()
                        WHERE id = $1
                        "#,
                    )
                    .bind(&deployment_id)
                    .execute(pool)
                    .await?;

                    sqlx::query(
                        r#"
                        UPDATE "BotConfiguration"
                        SET status = 'pending_manual', "updatedAt" = NOW()
                        WHERE id = $1 AND "orgId" = $2
                        "#,
                    )
                    .bind(bot_id)
                    .bind(org_id)
                    .execute(pool)
                    .await?;
                }
            }
        }
        "pause" | "resume" => {
            let (deployment_id, current_status, workflow_id, version_number) =
                latest_bot_deployment_status(pool, bot_id)
                    .await?
                    .ok_or_else(|| {
                        AppError::Conflict("This agent has no deployment to manage".to_string())
                    })?;

            if action == "pause" && current_status != "active" {
                return Err(AppError::Conflict(
                    "Only active deployments can be paused".to_string(),
                ));
            }
            if action == "resume" && current_status != "paused" {
                return Err(AppError::Conflict(
                    "Only paused deployments can be resumed".to_string(),
                ));
            }

            let integration_config_for_dispatch = resolved_integration_config.clone();
            let dispatch = execute_agent_action(
                config,
                AgentDispatchPayload {
                    action: action.to_string(),
                    bot_id: bot.id.clone(),
                    user_id: bot.user_id.clone(),
                    deployment_id: deployment_id.clone(),
                    workflow_id: workflow_id.clone(),
                    version_number,
                    name: bot.name.clone(),
                    bot_type: bot.bot_type.clone(),
                    status: current_status.clone(),
                    language: bot.language.clone(),
                    greeting_message: bot.greeting_message.clone(),
                    personality: bot.personality.clone(),
                    capabilities: bot.capabilities.clone(),
                    knowledge_base: bot.knowledge_base.clone(),
                    integration_config: integration_config_for_dispatch.clone(),
                    template: template_definition(
                        &bot.bot_type,
                        integration_config_for_dispatch.as_ref(),
                    ),
                    callbacks: agent_callbacks(config, &bot.id, &deployment_id),
                    channel_config: channel_config(
                        &bot.bot_type,
                        integration_config_for_dispatch.as_ref(),
                    ),
                },
            )
            .await?;

            let next_status = if action == "pause" {
                "paused"
            } else {
                "active"
            };
            sqlx::query(
                r#"
                UPDATE "BotDeployment"
                SET status = $1,
                    "workflowId" = COALESCE($2, "workflowId"),
                    "responsePayload" = COALESCE($3, "responsePayload"),
                    "pausedAt" = CASE WHEN $1 = 'paused' THEN NOW() ELSE NULL END,
                    "errorMessage" = CASE WHEN $4 THEN "errorMessage" ELSE NULL END,
                    "updatedAt" = NOW()
                WHERE "botId" = $5
                  AND "versionNumber" = $6
                "#,
            )
            .bind(next_status)
            .bind(workflow_id)
            .bind(dispatch.and_then(|item| item.payload))
            .bind(config.n8n_api_url.is_none())
            .bind(bot_id)
            .bind(version_number)
            .execute(pool)
            .await?;

            sqlx::query(
                r#"
                UPDATE "BotConfiguration"
                SET status = $1, "updatedAt" = NOW()
                WHERE id = $2 AND "orgId" = $3
                "#,
            )
            .bind(next_status)
            .bind(bot_id)
            .bind(org_id)
            .execute(pool)
            .await?;
        }
        _ => {}
    }

    list_bots(pool, org_id)
        .await?
        .into_iter()
        .find(|bot_row| bot_row.id == bot_id)
        .ok_or_else(|| AppError::Internal("Failed to reload agent".to_string()))
}

pub async fn list_agent_activity(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let activity = sqlx::query(r#"
        SELECT * FROM (
          SELECT e.id, 'event'::text AS kind, e."createdAt" AT TIME ZONE 'UTC' AS created_at,
                 b.name AS bot_name, e."eventType" AS title, e.status, e.channel,
                 e."conversationId" AS conversation_id, e."responseTimeMs" AS response_time_ms,
                 NULL::text AS detail
          FROM "BotEvent" e JOIN "BotConfiguration" b ON b.id = e."botId"
          WHERE e."orgId" = $1 AND b."orgId" = $1
          UNION ALL
          SELECT d.id, 'deployment'::text AS kind, d."updatedAt" AT TIME ZONE 'UTC' AS created_at,
                 b.name AS bot_name, d.status AS title, d.status, d.target AS channel,
                 NULL::text AS conversation_id, NULL::int AS response_time_ms, d."errorMessage" AS detail
          FROM "BotDeployment" d JOIN "BotConfiguration" b ON b.id = d."botId"
          WHERE d."orgId" = $1 AND b."orgId" = $1
        ) activity ORDER BY created_at DESC LIMIT 100
    "#).bind(org_id).fetch_all(pool).await?;
    Ok(json!({ "activity": activity.into_iter().map(|row| json!({
        "id": row.get::<String, _>("id"), "kind": row.get::<String, _>("kind"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "botName": row.get::<String, _>("bot_name"), "title": row.get::<String, _>("title"),
        "status": row.get::<Option<String>, _>("status"), "channel": row.get::<Option<String>, _>("channel"),
        "conversationId": row.get::<Option<String>, _>("conversation_id"), "responseTimeMs": row.get::<Option<i32>, _>("response_time_ms"),
        "detail": row.get::<Option<String>, _>("detail"),
    })).collect::<Vec<_>>() }))
}

pub async fn apply_deployment_callback(
    pool: &PgPool,
    bot_id: &str,
    deployment_id: &str,
    input: BotDeploymentCallbackRequest,
) -> Result<(), AppError> {
    let status = input
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("status is required".to_string()))?;

    let bot_scope = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT "userId", "orgId" FROM "BotConfiguration" WHERE id = $1 LIMIT 1"#,
    )
    .bind(bot_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Bot not found".to_string()))?;
    let org_id = bot_scope.1.ok_or_else(|| {
        AppError::Internal("Bot does not have an organisation assignment".to_string())
    })?;

    let updated = sqlx::query(
        r#"
        UPDATE "BotDeployment"
        SET status = $1,
            "workflowId" = COALESCE($2, "workflowId"),
            "responsePayload" = COALESCE($3, "responsePayload"),
            "errorMessage" = $4,
            "deployedAt" = CASE WHEN $1 = 'active' THEN NOW() ELSE "deployedAt" END,
            "pausedAt" = CASE WHEN $1 = 'paused' THEN NOW() ELSE "pausedAt" END,
            "updatedAt" = NOW()
        WHERE id = $5 AND "botId" = $6
        "#,
    )
    .bind(status)
    .bind(input.workflow_id)
    .bind(input.payload)
    .bind(input.message)
    .bind(deployment_id)
    .bind(bot_id)
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound("Deployment not found".to_string()));
    }

    sqlx::query(
        r#"
        UPDATE "BotConfiguration"
        SET status = $1, "updatedAt" = NOW()
        WHERE id = $2 AND "orgId" = $3
        "#,
    )
    .bind(status)
    .bind(bot_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn create_bot(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    input: BotCreateRequest,
) -> Result<BotConfigurationRow, AppError> {
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Name and type are required".to_string()))?;
    let bot_type = input
        .bot_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Name and type are required".to_string()))?;
    if !valid_bot_type(bot_type) {
        return Err(AppError::BadRequest("Unsupported agent type".to_string()));
    }
    let id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "BotConfiguration" (
            id, "userId", "orgId", name, type, status, language, "greetingMessage", personality,
            capabilities, "knowledgeBase", "integrationConfig", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(user_id)
    .bind(org_id)
    .bind(name)
    .bind(bot_type)
    .bind(input.language.as_deref().unwrap_or("en"))
    .bind(
        input
            .greeting_message
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        input
            .personality
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(input.capabilities)
    .bind(input.business_details)
    .bind(input.integration_config)
    .execute(pool)
    .await?;

    get_bot(pool, org_id, &id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload bot".to_string()))
}

pub async fn get_bot(
    pool: &PgPool,
    org_id: &str,
    bot_id: &str,
) -> Result<Option<BotConfigurationRow>, AppError> {
    let sql = format!(
        "{} WHERE id = $1 AND \"orgId\" = $2 LIMIT 1",
        select_bot_sql()
    );
    sqlx::query_as::<_, BotConfigurationRow>(&sql)
        .bind(bot_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::from)
}

pub async fn update_bot(
    pool: &PgPool,
    org_id: &str,
    bot_id: &str,
    body: Value,
) -> Result<BotConfigurationRow, AppError> {
    if get_bot(pool, org_id, bot_id).await?.is_none() {
        return Err(AppError::NotFound("Bot not found".to_string()));
    }

    if let Some(bot_type) = body
        .get("type")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !valid_bot_type(bot_type) {
            return Err(AppError::BadRequest("Unsupported agent type".to_string()));
        }
    }

    sqlx::query(
        r#"
        UPDATE "BotConfiguration"
        SET name = COALESCE($1, name),
            type = COALESCE($2, type),
            status = COALESCE($3, status),
            "greetingMessage" = COALESCE($4, "greetingMessage"),
            personality = COALESCE($5, personality),
            language = COALESCE($6, language),
            capabilities = COALESCE($7, capabilities),
            "knowledgeBase" = COALESCE($8, "knowledgeBase"),
            "integrationConfig" = COALESCE($9, "integrationConfig"),
            "updatedAt" = NOW()
        WHERE id = $10 AND "orgId" = $11
        "#,
    )
    .bind(
        body.get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("type")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("status")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("greetingMessage")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("personality")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("language")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(body.get("capabilities").cloned())
    .bind(body.get("knowledgeBase").cloned())
    .bind(body.get("integrationConfig").cloned())
    .bind(bot_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    get_bot(pool, org_id, bot_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload bot".to_string()))
}

pub async fn delete_bot(pool: &PgPool, org_id: &str, bot_id: &str) -> Result<(), AppError> {
    let result = sqlx::query(r#"DELETE FROM "BotConfiguration" WHERE id = $1 AND "orgId" = $2"#)
        .bind(bot_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Bot not found".to_string()));
    }
    Ok(())
}

pub async fn record_bot_event(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    bot_id: &str,
    input: BotEventCreateRequest,
) -> Result<(), AppError> {
    let _bot = get_bot(pool, org_id, bot_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Bot not found".to_string()))?;
    record_bot_event_internal(pool, bot_id, user_id, org_id, input).await
}

async fn record_bot_event_internal(
    pool: &PgPool,
    bot_id: &str,
    user_id: &str,
    org_id: &str,
    input: BotEventCreateRequest,
) -> Result<(), AppError> {
    let event_type = input
        .event_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("eventType is required".to_string()))?;
    let customer_id = resolve_event_customer_id(
        pool,
        org_id,
        input.customer_id.as_deref(),
        input.conversation_id.as_deref(),
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO "BotEvent" (
            id, "botId", "userId", "orgId", "eventType", channel, status, "conversationId",
            "customerId", "responseTimeMs", metadata, "createdAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        "#,
    )
    .bind(cuid2::create_id())
    .bind(bot_id)
    .bind(user_id)
    .bind(org_id)
    .bind(event_type)
    .bind(
        input
            .channel
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        input
            .status
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        input
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(customer_id)
    .bind(input.response_time_ms)
    .bind(input.metadata)
    .execute(pool)
    .await?;

    Ok(())
}

async fn resolve_event_customer_id(
    pool: &PgPool,
    org_id: &str,
    customer_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    let customer_id = customer_id.map(str::trim).filter(|value| !value.is_empty());
    let conversation_id = conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let explicit_customer_id = match customer_id {
        Some(customer_id) => sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM "Customer" WHERE id = $1 AND "orgId" = $2 LIMIT 1"#,
        )
        .bind(customer_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Customer not found".to_string()))
        .map(Some)?,
        None => None,
    };

    let conversation_customer_id = match conversation_id {
        Some(conversation_id) => sqlx::query_scalar::<_, Option<String>>(
            r#"
            SELECT "customerId"
            FROM "Conversation"
            WHERE id = $1 AND "orgId" = $2
            LIMIT 1
            "#,
        )
        .bind(conversation_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?,
        None => None,
    };

    if let (Some(explicit_customer_id), Some(conversation_customer_id)) =
        (&explicit_customer_id, &conversation_customer_id)
    {
        if explicit_customer_id != conversation_customer_id {
            return Err(AppError::BadRequest(
                "customerId does not match the conversation customer".to_string(),
            ));
        }
    }

    Ok(explicit_customer_id.or(conversation_customer_id))
}

pub async fn record_bot_event_trusted(
    pool: &PgPool,
    bot_id: &str,
    input: BotEventCreateRequest,
) -> Result<(), AppError> {
    let bot_scope = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT "userId", "orgId" FROM "BotConfiguration" WHERE id = $1 LIMIT 1"#,
    )
    .bind(bot_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Bot not found".to_string()))?;

    let org_id = bot_scope.1.ok_or_else(|| {
        AppError::Internal("Bot does not have an organisation assignment".to_string())
    })?;
    record_bot_event_internal(pool, bot_id, &bot_scope.0, &org_id, input).await
}
