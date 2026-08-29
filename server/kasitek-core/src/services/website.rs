use chrono::{Duration, Utc};
use reqwest::Url;
use serde_json::json;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    AgentWebsiteAppearanceInput, AgentWebsiteDeliveryEventRow, AgentWebsiteDeploymentRow,
    AgentWebsiteVisitorSessionRow, CreateAgentWebsiteDeploymentRequest,
    ProductWaitlistCreateRequest, QuoteRequestCreateRequest, UpdateAgentWebsiteDeploymentRequest,
};
use crate::error::AppError;
use crate::services::auth::send_email;

const VALID_BUSINESS_TYPES: &[&str] = &[
    "restaurant",
    "retail",
    "healthcare",
    "real_estate",
    "automotive",
    "professional_services",
    "salon_spa",
    "construction",
    "logistics",
    "other",
];

const VALID_SERVICES: &[&str] = &[
    "custom_ai_chatbots",
    "voice_agents",
    "growth_workflows",
    "system_integrations",
    "digital_infrastructure",
    "managed_retainers",
];

const VALID_PRODUCTS: &[&str] = &[
    "kasitek_product_basic",
    "kasitek_product_growth",
    "kasitek_product_scale",
    "feature_agents",
    "feature_campaigns",
    "feature_content",
    // Accepted for old waitlist links during the naming transition.
    "kasiagents",
    "kasireach",
    "kasisocial",
];

const VALID_LAUNCHER_POSITIONS: &[&str] = &["bottom-right", "bottom-left"];
const VALID_COLOR_PRESETS: &[&str] = &["indigo", "violet", "emerald", "blue", "slate"];

pub fn normalize_origin(value: &str) -> Result<String, AppError> {
    let value = value.trim().trim_end_matches('/');
    let parsed = Url::parse(value).map_err(|_| {
        AppError::BadRequest("Allowed origins must be full http(s) origins".to_string())
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(AppError::BadRequest(
            "Allowed origins must be full http(s) origins without a path".to_string(),
        ));
    }
    Ok(parsed.origin().ascii_serialization())
}

fn normalize_origins(values: Option<Vec<String>>) -> Result<Vec<String>, AppError> {
    let mut origins = values
        .unwrap_or_default()
        .iter()
        .map(|value| normalize_origin(value))
        .collect::<Result<Vec<_>, _>>()?;
    origins.sort();
    origins.dedup();
    if origins.len() > 30 {
        return Err(AppError::BadRequest(
            "A website deployment can have at most 30 allowed origins".to_string(),
        ));
    }
    Ok(origins)
}

fn optional_url(value: Option<String>, field: &str) -> Result<Option<String>, AppError> {
    match value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => {
            let parsed = Url::parse(&value).map_err(|_| {
                AppError::BadRequest(format!("{field} must be a valid http(s) URL"))
            })?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(AppError::BadRequest(format!(
                    "{field} must be a valid http(s) URL"
                )));
            }
            Ok(Some(value))
        }
        None => Ok(None),
    }
}

fn optional_short_text(
    value: Option<String>,
    field: &str,
    maximum: usize,
) -> Result<Option<String>, AppError> {
    let value = value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if value.as_ref().is_some_and(|value| value.len() > maximum) {
        return Err(AppError::BadRequest(format!(
            "{field} must be at most {maximum} characters"
        )));
    }
    Ok(value)
}

fn default_primary_color(color_preset: &str) -> &'static str {
    match color_preset {
        "violet" => "#7c3aed",
        "emerald" => "#059669",
        "blue" => "#2563eb",
        "slate" => "#334155",
        _ => "#3730a3",
    }
}

fn normalize_hex_color(value: Option<String>, fallback: &str) -> Result<String, AppError> {
    let value = value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string());
    let valid = (value.len() == 4 || value.len() == 7)
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::BadRequest(
            "Appearance primaryColor must be a hex colour such as #3730a3".to_string(),
        ));
    }
    Ok(value.to_ascii_lowercase())
}

fn normalize_range(
    value: Option<i32>,
    field: &str,
    minimum: i32,
    maximum: i32,
    fallback: i32,
) -> Result<i32, AppError> {
    let value = value.unwrap_or(fallback);
    if !(minimum..=maximum).contains(&value) {
        return Err(AppError::BadRequest(format!(
            "Appearance {field} must be between {minimum} and {maximum}"
        )));
    }
    Ok(value)
}

fn normalize_appearance(
    input: Option<AgentWebsiteAppearanceInput>,
    color_preset: &str,
) -> Result<serde_json::Value, AppError> {
    let input = input.unwrap_or(AgentWebsiteAppearanceInput {
        primary_color: None,
        launcher_size: None,
        window_width: None,
        window_height: None,
        border_radius: None,
        launcher_offset: None,
        show_branding: None,
    });
    Ok(json!({
        "primaryColor": normalize_hex_color(input.primary_color, default_primary_color(color_preset))?,
        "launcherSize": normalize_range(input.launcher_size, "launcherSize", 44, 96, 56)?,
        "windowWidth": normalize_range(input.window_width, "windowWidth", 300, 600, 390)?,
        "windowHeight": normalize_range(input.window_height, "windowHeight", 360, 800, 620)?,
        "borderRadius": normalize_range(input.border_radius, "borderRadius", 0, 28, 16)?,
        "launcherOffset": normalize_range(input.launcher_offset, "launcherOffset", 8, 48, 16)?,
        "showBranding": input.show_branding.unwrap_or(true),
    }))
}

pub fn normalize_website_deployment_input(
    input: CreateAgentWebsiteDeploymentRequest,
) -> Result<
    (
        Vec<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        serde_json::Value,
        Option<String>,
        Option<String>,
    ),
    AppError,
> {
    let launcher_position = input
        .launcher_position
        .unwrap_or_else(|| "bottom-right".to_string());
    if !VALID_LAUNCHER_POSITIONS.contains(&launcher_position.as_str()) {
        return Err(AppError::BadRequest(
            "Invalid launcher position".to_string(),
        ));
    }
    let color_preset = input.color_preset.unwrap_or_else(|| "indigo".to_string());
    if !VALID_COLOR_PRESETS.contains(&color_preset.as_str()) {
        return Err(AppError::BadRequest("Invalid colour preset".to_string()));
    }
    Ok((
        normalize_origins(input.allowed_origins)?,
        optional_short_text(input.display_name, "Display name", 100)?,
        optional_short_text(input.welcome_text, "Welcome text", 500)?,
        launcher_position,
        color_preset.clone(),
        normalize_appearance(input.appearance, &color_preset)?,
        optional_url(input.avatar_url, "Avatar URL")?,
        optional_url(input.privacy_policy_url, "Privacy policy URL")?,
    ))
}

pub async fn list_agent_website_deployments(
    pool: &PgPool,
    organization_id: &str,
    installation_id: &str,
) -> Result<Vec<AgentWebsiteDeploymentRow>, AppError> {
    sqlx::query_as::<_, AgentWebsiteDeploymentRow>(
        r#"SELECT id, "publicId" AS public_id, "orgId" AS org_id,
                  "installationId" AS installation_id, "channelConnectionId" AS channel_connection_id,
                  status, "allowedOrigins" AS allowed_origins, "displayName" AS display_name,
                  "welcomeText" AS welcome_text, "launcherPosition" AS launcher_position,
                  "colorPreset" AS color_preset, appearance, "avatarUrl" AS avatar_url,
                  "privacyPolicyUrl" AS privacy_policy_url, "createdById" AS created_by_id,
                  "publishedAt" AS published_at, "pausedAt" AS paused_at, "revokedAt" AS revoked_at,
                  "lastError" AS last_error, "createdAt" AS created_at, "updatedAt" AS updated_at
           FROM "AgentWebsiteDeployment"
           WHERE "orgId" = $1 AND "installationId" = $2
           ORDER BY "createdAt" DESC"#,
    )
    .bind(organization_id)
    .bind(installation_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

/// Permanently removes Core-owned website deployment data for deleted Agent
/// Platform installations. Visitor sessions and delivery events cascade from
/// the deployment rows in the Prisma schema.
pub async fn delete_agent_website_deployments(
    pool: &PgPool,
    organization_id: &str,
    installation_ids: &[String],
) -> Result<u64, AppError> {
    if installation_ids.is_empty() {
        return Ok(0);
    }
    let result = sqlx::query(
        r#"DELETE FROM "AgentWebsiteDeployment"
           WHERE "orgId" = $1 AND "installationId" = ANY($2)"#,
    )
    .bind(organization_id)
    .bind(installation_ids)
    .execute(pool)
    .await
    .map_err(AppError::from)?;
    Ok(result.rows_affected())
}

pub async fn set_agent_website_deployment_status(
    pool: &PgPool,
    organization_id: &str,
    installation_id: &str,
    deployment_id: &str,
    status: &str,
) -> Result<AgentWebsiteDeploymentRow, AppError> {
    let (published_at, paused_at, revoked_at) = match status {
        "ACTIVE" => (true, false, false),
        "PAUSED" => (false, true, false),
        "REVOKED" => (false, false, true),
        _ => {
            return Err(AppError::BadRequest(
                "Invalid Website Chat status".to_string(),
            ))
        }
    };
    sqlx::query_as::<_, AgentWebsiteDeploymentRow>(
        r#"UPDATE "AgentWebsiteDeployment"
           SET status = $1,
               "publishedAt" = CASE WHEN $2 THEN NOW() ELSE "publishedAt" END,
               "pausedAt" = CASE WHEN $3 THEN NOW() ELSE NULL END,
               "revokedAt" = CASE WHEN $4 THEN NOW() ELSE NULL END,
               "updatedAt" = NOW()
           WHERE id = $5 AND "orgId" = $6 AND "installationId" = $7 AND status <> 'REVOKED'
           RETURNING id, "publicId" AS public_id, "orgId" AS org_id,
                     "installationId" AS installation_id, "channelConnectionId" AS channel_connection_id,
                     status, "allowedOrigins" AS allowed_origins, "displayName" AS display_name,
                     "welcomeText" AS welcome_text, "launcherPosition" AS launcher_position,
                     "colorPreset" AS color_preset, appearance, "avatarUrl" AS avatar_url,
                     "privacyPolicyUrl" AS privacy_policy_url, "createdById" AS created_by_id,
                     "publishedAt" AS published_at, "pausedAt" AS paused_at, "revokedAt" AS revoked_at,
                     "lastError" AS last_error, "createdAt" AS created_at, "updatedAt" AS updated_at"#,
    )
    .bind(status)
    .bind(published_at)
    .bind(paused_at)
    .bind(revoked_at)
    .bind(deployment_id)
    .bind(organization_id)
    .bind(installation_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::NotFound("Website Chat deployment not found".to_string()))
}

pub async fn create_agent_website_deployment(
    pool: &PgPool,
    organization_id: &str,
    installation_id: &str,
    channel_connection_id: &str,
    public_id: &str,
    actor_id: &str,
    input: CreateAgentWebsiteDeploymentRequest,
) -> Result<AgentWebsiteDeploymentRow, AppError> {
    let (
        allowed_origins,
        display_name,
        welcome_text,
        launcher_position,
        color_preset,
        appearance,
        avatar_url,
        privacy_policy_url,
    ) = normalize_website_deployment_input(input)?;
    let id = cuid2::create_id();
    sqlx::query_as::<_, AgentWebsiteDeploymentRow>(
        r#"INSERT INTO "AgentWebsiteDeployment"
             (id, "publicId", "orgId", "installationId", "channelConnectionId", "allowedOrigins",
              "displayName", "welcomeText", "launcherPosition", "colorPreset", appearance,
              "avatarUrl", "privacyPolicyUrl", "createdById", status, "publishedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ACTIVE', NOW(), NOW(), NOW())
           RETURNING id, "publicId" AS public_id, "orgId" AS org_id,
                     "installationId" AS installation_id, "channelConnectionId" AS channel_connection_id,
                     status, "allowedOrigins" AS allowed_origins, "displayName" AS display_name,
                     "welcomeText" AS welcome_text, "launcherPosition" AS launcher_position,
                     "colorPreset" AS color_preset, appearance, "avatarUrl" AS avatar_url,
                     "privacyPolicyUrl" AS privacy_policy_url, "createdById" AS created_by_id,
                     "publishedAt" AS published_at, "pausedAt" AS paused_at, "revokedAt" AS revoked_at,
                     "lastError" AS last_error, "createdAt" AS created_at, "updatedAt" AS updated_at"#,
    )
    .bind(id)
    .bind(public_id)
    .bind(organization_id)
    .bind(installation_id)
    .bind(channel_connection_id)
    .bind(allowed_origins)
    .bind(display_name)
    .bind(welcome_text)
    .bind(launcher_position)
    .bind(color_preset)
    .bind(appearance)
    .bind(avatar_url)
    .bind(privacy_policy_url)
    .bind(actor_id)
    .fetch_one(pool)
    .await
    .map_err(AppError::from)
}

pub async fn update_agent_website_deployment(
    pool: &PgPool,
    organization_id: &str,
    installation_id: &str,
    deployment_id: &str,
    input: UpdateAgentWebsiteDeploymentRequest,
) -> Result<AgentWebsiteDeploymentRow, AppError> {
    let allowed_origins = input
        .allowed_origins
        .map(|origins| normalize_origins(Some(origins)))
        .transpose()?;
    let display_name = input
        .display_name
        .map(|value| optional_short_text(Some(value), "Display name", 100))
        .transpose()?;
    let welcome_text = input
        .welcome_text
        .map(|value| optional_short_text(Some(value), "Welcome text", 500))
        .transpose()?;
    let launcher_position = input
        .launcher_position
        .map(|value| {
            if VALID_LAUNCHER_POSITIONS.contains(&value.as_str()) {
                Ok(value)
            } else {
                Err(AppError::BadRequest(
                    "Invalid launcher position".to_string(),
                ))
            }
        })
        .transpose()?;
    let color_preset = input
        .color_preset
        .map(|value| {
            if VALID_COLOR_PRESETS.contains(&value.as_str()) {
                Ok(value)
            } else {
                Err(AppError::BadRequest("Invalid colour preset".to_string()))
            }
        })
        .transpose()?;
    let appearance = input
        .appearance
        .map(|value| normalize_appearance(Some(value), color_preset.as_deref().unwrap_or("indigo")))
        .transpose()?;
    let avatar_url = input
        .avatar_url
        .map(|value| optional_url(Some(value), "Avatar URL"))
        .transpose()?;
    let privacy_policy_url = input
        .privacy_policy_url
        .map(|value| optional_url(Some(value), "Privacy policy URL"))
        .transpose()?;

    sqlx::query_as::<_, AgentWebsiteDeploymentRow>(
        r#"UPDATE "AgentWebsiteDeployment"
           SET "allowedOrigins" = COALESCE($1, "allowedOrigins"),
               "displayName" = COALESCE($2, "displayName"),
               "welcomeText" = COALESCE($3, "welcomeText"),
               "launcherPosition" = COALESCE($4, "launcherPosition"),
               "colorPreset" = COALESCE($5, "colorPreset"),
               appearance = COALESCE($6, appearance),
               "avatarUrl" = COALESCE($7, "avatarUrl"),
               "privacyPolicyUrl" = COALESCE($8, "privacyPolicyUrl"),
               "updatedAt" = NOW()
           WHERE id = $9 AND "orgId" = $10 AND "installationId" = $11 AND status <> 'REVOKED'
           RETURNING id, "publicId" AS public_id, "orgId" AS org_id,
                     "installationId" AS installation_id, "channelConnectionId" AS channel_connection_id,
                     status, "allowedOrigins" AS allowed_origins, "displayName" AS display_name,
                     "welcomeText" AS welcome_text, "launcherPosition" AS launcher_position,
                     "colorPreset" AS color_preset, appearance, "avatarUrl" AS avatar_url,
                     "privacyPolicyUrl" AS privacy_policy_url, "createdById" AS created_by_id,
                     "publishedAt" AS published_at, "pausedAt" AS paused_at, "revokedAt" AS revoked_at,
                     "lastError" AS last_error, "createdAt" AS created_at, "updatedAt" AS updated_at"#,
    )
    .bind(allowed_origins)
    .bind(display_name.flatten())
    .bind(welcome_text.flatten())
    .bind(launcher_position)
    .bind(color_preset)
    .bind(appearance)
    .bind(avatar_url.flatten())
    .bind(privacy_policy_url.flatten())
    .bind(deployment_id)
    .bind(organization_id)
    .bind(installation_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::NotFound("Website Chat deployment not found".to_string()))
}

pub async fn public_agent_website_deployment(
    pool: &PgPool,
    public_id: &str,
    origin: &str,
    allow_share_origin: bool,
) -> Result<AgentWebsiteDeploymentRow, AppError> {
    let origin = normalize_origin(origin)?;
    sqlx::query_as::<_, AgentWebsiteDeploymentRow>(
        r#"SELECT id, "publicId" AS public_id, "orgId" AS org_id,
                  "installationId" AS installation_id, "channelConnectionId" AS channel_connection_id,
                  status, "allowedOrigins" AS allowed_origins, "displayName" AS display_name,
                  "welcomeText" AS welcome_text, "launcherPosition" AS launcher_position,
                  "colorPreset" AS color_preset, appearance, "avatarUrl" AS avatar_url,
                  "privacyPolicyUrl" AS privacy_policy_url, "createdById" AS created_by_id,
                  "publishedAt" AS published_at, "pausedAt" AS paused_at, "revokedAt" AS revoked_at,
                  "lastError" AS last_error, "createdAt" AS created_at, "updatedAt" AS updated_at
           FROM "AgentWebsiteDeployment"
           WHERE "publicId" = $1
             AND status = 'ACTIVE'
             AND ($2 = ANY("allowedOrigins") OR $3)
           LIMIT 1"#,
    )
    .bind(public_id.trim())
    .bind(origin)
    .bind(allow_share_origin)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::NotFound("Website Chat deployment not found".to_string()))
}

pub async fn create_agent_website_visitor_session(
    pool: &PgPool,
    deployment: &AgentWebsiteDeploymentRow,
    origin: &str,
) -> Result<AgentWebsiteVisitorSessionRow, AppError> {
    let public_session_id = format!("wvs_{}", cuid2::create_id());
    let external_identity = format!("website:{public_session_id}");
    let external_conversation_id = format!("website:{}:{public_session_id}", deployment.public_id);
    let expires_at = Utc::now() + Duration::hours(24);
    sqlx::query_as::<_, AgentWebsiteVisitorSessionRow>(
        r#"INSERT INTO "AgentWebsiteVisitorSession"
             (id, "publicSessionId", "deploymentId", origin, "externalIdentity", "externalConversationId", "expiresAt", "lastSeenAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
           RETURNING id, "publicSessionId" AS public_session_id, "deploymentId" AS deployment_id,
                     origin, "externalIdentity" AS external_identity, "externalConversationId" AS external_conversation_id,
                     status, "expiresAt" AS expires_at, "lastSeenAt" AS last_seen_at,
                     "createdAt" AS created_at, "updatedAt" AS updated_at"#,
    )
    .bind(cuid2::create_id())
    .bind(public_session_id)
    .bind(&deployment.id)
    .bind(normalize_origin(origin)?)
    .bind(external_identity)
    .bind(external_conversation_id)
    .bind(expires_at)
    .fetch_one(pool)
    .await
    .map_err(AppError::from)
}

pub async fn active_agent_website_visitor_session(
    pool: &PgPool,
    public_session_id: &str,
    origin: &str,
) -> Result<AgentWebsiteVisitorSessionRow, AppError> {
    let origin = normalize_origin(origin)?;
    sqlx::query_as::<_, AgentWebsiteVisitorSessionRow>(
        r#"UPDATE "AgentWebsiteVisitorSession"
           SET "lastSeenAt" = NOW(), "updatedAt" = NOW()
           WHERE "publicSessionId" = $1 AND origin = $2 AND status = 'ACTIVE' AND "expiresAt" > NOW()
           RETURNING id, "publicSessionId" AS public_session_id, "deploymentId" AS deployment_id,
                     origin, "externalIdentity" AS external_identity, "externalConversationId" AS external_conversation_id,
                     status, "expiresAt" AS expires_at, "lastSeenAt" AS last_seen_at,
                     "createdAt" AS created_at, "updatedAt" AS updated_at"#,
    )
    .bind(public_session_id.trim())
    .bind(origin)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::NotFound("Website Chat session not found".to_string()))
}

pub async fn record_agent_website_delivery(
    pool: &PgPool,
    external_conversation_id: &str,
    event_key: &str,
    text: &str,
) -> Result<Option<AgentWebsiteDeliveryEventRow>, AppError> {
    let session_id = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "AgentWebsiteVisitorSession" WHERE "externalConversationId" = $1 LIMIT 1"#,
    )
    .bind(external_conversation_id.trim())
    .fetch_optional(pool)
    .await?;
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let event = sqlx::query_as::<_, AgentWebsiteDeliveryEventRow>(
        r#"INSERT INTO "AgentWebsiteDeliveryEvent" (id, "sessionId", "eventKey", "messageText", "createdAt")
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT ("eventKey") DO UPDATE SET "eventKey" = EXCLUDED."eventKey"
           RETURNING id, "eventKey" AS event_key, "messageText" AS message_text, "createdAt" AS created_at"#,
    )
    .bind(cuid2::create_id())
    .bind(session_id)
    .bind(event_key)
    .bind(text)
    .fetch_one(pool)
    .await?;
    Ok(Some(event))
}

pub async fn list_agent_website_deliveries(
    pool: &PgPool,
    session: &AgentWebsiteVisitorSessionRow,
    after: Option<&str>,
) -> Result<Vec<AgentWebsiteDeliveryEventRow>, AppError> {
    sqlx::query_as::<_, AgentWebsiteDeliveryEventRow>(
        r#"SELECT id, "eventKey" AS event_key, "messageText" AS message_text, "createdAt" AS created_at
           FROM "AgentWebsiteDeliveryEvent"
           WHERE "sessionId" = $1
             AND (
                 $2::text IS NULL
                 OR ("createdAt", id) > (
                     SELECT "createdAt", id
                     FROM "AgentWebsiteDeliveryEvent"
                     WHERE id = $2
                 )
             )
           ORDER BY "createdAt" ASC, id ASC LIMIT 100"#,
    )
    .bind(&session.id)
    .bind(after)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

fn normalize_required(value: Option<&str>, field: &str) -> Result<String, AppError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("{field} is required")))
}

fn normalize_required_with_limit(
    value: Option<&str>,
    field: &str,
    max_length: usize,
) -> Result<String, AppError> {
    let value = normalize_required(value, field)?;
    if value.chars().count() > max_length {
        return Err(AppError::BadRequest(format!(
            "{field} must be at most {max_length} characters"
        )));
    }
    Ok(value)
}

fn normalize_optional_with_limit(
    value: Option<&str>,
    field: &str,
    max_length: usize,
) -> Result<Option<String>, AppError> {
    let value = normalize_optional(value);
    if value
        .as_deref()
        .is_some_and(|value| value.chars().count() > max_length)
    {
        return Err(AppError::BadRequest(format!(
            "{field} must be at most {max_length} characters"
        )));
    }
    Ok(value)
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn validate_email(email: &str) -> Result<(), AppError> {
    let valid = email.contains('@') && email.split('@').count() == 2 && email.contains('.');
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Please enter a valid email address".to_string(),
        ))
    }
}

fn normalize_string_list(values: Option<&Vec<String>>) -> Vec<String> {
    values
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

async fn list_admin_ids(pool: &PgPool) -> Result<Vec<String>, AppError> {
    sqlx::query_scalar::<_, String>(r#"SELECT id FROM "AdminUser""#)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
}

async fn existing_early_access_application_id(
    pool: &PgPool,
    email: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "ProductWaitlistEntry"
           WHERE lower(email) = lower($1)
             AND status IN ('new', 'approved', 'invited', 'active')
           ORDER BY "createdAt" DESC LIMIT 1"#,
    )
    .bind(email)
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn publish_admin_notification(
    pool: &PgPool,
    event_type: &str,
    title: &str,
    message: &str,
    entity_type: &str,
    entity_id: &str,
    payload: serde_json::Value,
    dedupe_key: &str,
) -> Result<(), AppError> {
    let admin_ids = list_admin_ids(pool).await?;
    if admin_ids.is_empty() {
        return Ok(());
    }

    let existing = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM "NotificationEvent"
        WHERE "scopeType" = 'ADMIN'::"NotificationScopeType"
          AND "scopeId" = 'global'
          AND "dedupeKey" = $1
        LIMIT 1
        "#,
    )
    .bind(dedupe_key)
    .fetch_optional(pool)
    .await?;
    if existing.is_some() {
        return Ok(());
    }

    let event_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "NotificationEvent" (
            id, "scopeType", "scopeId", "eventType", title, message, severity,
            "entityType", "entityId", payload, "dedupeKey", "createdAt"
        )
        VALUES (
            $1, 'ADMIN'::"NotificationScopeType", 'global', $2, $3, $4, 'SUCCESS'::"NotificationSeverity",
            $5, $6, $7, $8, NOW()
        )
        "#,
    )
    .bind(&event_id)
    .bind(event_type)
    .bind(title)
    .bind(message)
    .bind(entity_type)
    .bind(entity_id)
    .bind(payload)
    .bind(dedupe_key)
    .execute(pool)
    .await?;

    for admin_id in admin_ids {
        sqlx::query(
            r#"
            INSERT INTO "Notification" (
                id, "eventId", "recipientType", "recipientId", channel, status, "sentAt", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, 'ADMIN'::"NotificationRecipientType", $3,
                'IN_APP'::"NotificationChannel", 'SENT'::"NotificationStatus", NOW(), NOW(), NOW()
            )
            "#,
        )
        .bind(cuid2::create_id())
        .bind(&event_id)
        .bind(admin_id)
        .execute(pool)
        .await?;
    }

    Ok(())
}

pub async fn create_quote_request(
    pool: &PgPool,
    config: &AppConfig,
    input: QuoteRequestCreateRequest,
) -> Result<serde_json::Value, AppError> {
    let business_name = normalize_required(input.business_name.as_deref(), "Business name")?;
    let contact_person = normalize_required(input.contact_person.as_deref(), "Contact person")?;
    let phone = normalize_required(input.phone.as_deref(), "Phone")?;
    let email = normalize_required(input.email.as_deref(), "Email")?.to_lowercase();
    validate_email(&email)?;
    let business_type = normalize_required(input.business_type.as_deref(), "Business type")?;
    if !VALID_BUSINESS_TYPES.contains(&business_type.as_str()) {
        return Err(AppError::BadRequest("Invalid business type".to_string()));
    }

    let services = normalize_string_list(input.services.as_ref());
    let invalid_service = services
        .iter()
        .any(|service| !VALID_SERVICES.contains(&service.as_str()) && service.len() > 120);
    if services.is_empty() || invalid_service {
        return Err(AppError::BadRequest(
            "Invalid service selection".to_string(),
        ));
    }

    let id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "QuoteRequest" (
            id, "businessName", "contactPerson", phone, email, "businessType",
            services, description, source, status, notes, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'website', 'new', '[]'::jsonb, NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(&business_name)
    .bind(&contact_person)
    .bind(&phone)
    .bind(&email)
    .bind(&business_type)
    .bind(&services)
    .bind(normalize_optional(input.description.as_deref()))
    .execute(pool)
    .await?;

    let _ = publish_admin_notification(
        pool,
        "quote_request.created",
        "New quote request",
        &format!(
            "{} submitted a new quote request for {} service{}.",
            business_name,
            services.len(),
            if services.len() == 1 { "" } else { "s" }
        ),
        "quote_request",
        &id,
        json!({
            "businessName": business_name,
            "contactPerson": contact_person,
            "phone": phone,
            "email": email,
            "businessType": business_type,
            "services": services,
        }),
        &format!("quote_request.created:{id}"),
    )
    .await;

    let admin_email =
        std::env::var("ADMIN_EMAIL").unwrap_or_else(|_| "iamenochchirima@gmail.com".to_string());
    let _ = send_email(
        config,
        &admin_email,
        &format!("New Quote Request: {business_name}"),
        &format!(
            "Business: {business_name}\nContact: {contact_person}\nPhone: {phone}\nEmail: {email}\nType: {business_type}\nServices: {}",
            services.join(", ")
        ),
    )
    .await;

    Ok(json!({
        "message": "Quote request submitted successfully",
        "id": id
    }))
}

pub async fn create_waitlist_entry(
    pool: &PgPool,
    config: &AppConfig,
    input: ProductWaitlistCreateRequest,
) -> Result<serde_json::Value, AppError> {
    let business_name =
        normalize_required_with_limit(input.business_name.as_deref(), "Business name", 160)?;
    let contact_person =
        normalize_required_with_limit(input.contact_person.as_deref(), "Contact person", 160)?;
    let email = normalize_required_with_limit(input.email.as_deref(), "Email", 320)?.to_lowercase();
    validate_email(&email)?;
    let business_type =
        normalize_optional_with_limit(input.business_type.as_deref(), "Business type", 80)?;
    if business_type
        .as_deref()
        .is_some_and(|value| !VALID_BUSINESS_TYPES.contains(&value))
    {
        return Err(AppError::BadRequest("Invalid business type".to_string()));
    }

    let products = normalize_string_list(input.products.as_ref());
    if products.len() > 10
        || products.iter().any(|product| product.chars().count() > 80)
        || products.is_empty()
        || products
            .iter()
            .any(|product| !VALID_PRODUCTS.contains(&product.as_str()))
    {
        return Err(AppError::BadRequest(
            "Invalid product selection".to_string(),
        ));
    }
    if input.contact_consent != Some(true) {
        return Err(AppError::BadRequest(
            "Consent to be contacted is required".to_string(),
        ));
    }
    if input
        .website
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(AppError::BadRequest("Invalid application".to_string()));
    }
    let phone = normalize_optional_with_limit(input.phone.as_deref(), "Phone", 40)?;
    let notes = normalize_optional_with_limit(input.notes.as_deref(), "Primary use case", 4_000)?;

    if let Some(existing_id) = existing_early_access_application_id(pool, &email).await? {
        return Ok(json!({
            "message": "Early-access application received",
            "id": existing_id
        }));
    }

    let id = cuid2::create_id();
    match sqlx::query(
        r#"
        INSERT INTO "ProductWaitlistEntry" (
            id, "businessName", "contactPerson", phone, email, "businessType",
            products, notes, source, status, "contactConsentAt", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'website', 'new', NOW(), NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(&business_name)
    .bind(&contact_person)
    .bind(phone)
    .bind(&email)
    .bind(&business_type)
    .bind(&products)
    .bind(notes)
    .execute(pool)
    .await
    {
        Ok(_) => {}
        Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23505") => {
            if let Some(existing_id) = existing_early_access_application_id(pool, &email).await? {
                return Ok(json!({
                    "message": "Early-access application received",
                    "id": existing_id
                }));
            }
            return Err(AppError::Conflict(
                "An active early-access application already exists".to_string(),
            ));
        }
        Err(error) => return Err(error.into()),
    }

    let _ = publish_admin_notification(
        pool,
        "early_access.submitted",
        "New early-access application",
        &format!(
            "{} applied for early access to {}.",
            business_name,
            products.join(", ")
        ),
        "product_waitlist_entry",
        &id,
        json!({
            "businessName": business_name,
            "contactPerson": contact_person,
            "email": email,
            "products": products,
        }),
        &format!("early_access.submitted:{id}"),
    )
    .await;

    if let Err(error) = crate::services::early_access::record_submission(pool, &id).await {
        observability::tracing::error!(
            event = "operation.failed",
            operation = "early_access.submission_audit",
            application_id = %id,
            error_type = %std::any::type_name_of_val(&error),
            "early-access submission audit failed"
        );
    }

    let admin_email =
        std::env::var("ADMIN_EMAIL").unwrap_or_else(|_| "iamenochchirima@gmail.com".to_string());
    let _ = send_email(
        config,
        &admin_email,
        &format!("New Product Waitlist Signup: {business_name}"),
        &format!(
            "Business: {business_name}\nContact: {contact_person}\nEmail: {email}\nProducts: {}",
            products.join(", ")
        ),
    )
    .await;

    Ok(json!({
        "message": "Early-access application received",
        "id": id
    }))
}

#[cfg(test)]
mod website_chat_tests {
    use super::{normalize_origin, normalize_website_deployment_input};
    use crate::db::models::{AgentWebsiteAppearanceInput, CreateAgentWebsiteDeploymentRequest};

    #[test]
    fn origin_normalization_accepts_origins_and_rejects_paths() {
        assert_eq!(
            normalize_origin("https://example.com/").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            normalize_origin("http://localhost:3000").unwrap(),
            "http://localhost:3000"
        );
        assert!(normalize_origin("https://example.com/chat").is_err());
        assert!(normalize_origin("javascript:alert(1)").is_err());
        assert!(normalize_origin("https://example.com?x=1").is_err());
    }

    #[test]
    fn appearance_normalization_applies_defaults_and_bounds() {
        let (_, _, _, _, _, appearance, _, _) =
            normalize_website_deployment_input(CreateAgentWebsiteDeploymentRequest {
                allowed_origins: Some(vec!["https://example.com".to_string()]),
                display_name: None,
                welcome_text: None,
                launcher_position: None,
                color_preset: Some("blue".to_string()),
                avatar_url: None,
                privacy_policy_url: None,
                appearance: Some(AgentWebsiteAppearanceInput {
                    primary_color: Some("#ABCDEF".to_string()),
                    launcher_size: Some(72),
                    window_width: None,
                    window_height: Some(700),
                    border_radius: None,
                    launcher_offset: None,
                    show_branding: Some(false),
                }),
            })
            .unwrap();
        assert_eq!(appearance["primaryColor"], "#abcdef");
        assert_eq!(appearance["launcherSize"], 72);
        assert_eq!(appearance["windowWidth"], 390);
        assert_eq!(appearance["windowHeight"], 700);
        assert_eq!(appearance["showBranding"], false);
    }

    #[test]
    fn appearance_normalization_rejects_unsafe_values() {
        let input = CreateAgentWebsiteDeploymentRequest {
            allowed_origins: None,
            display_name: None,
            welcome_text: None,
            launcher_position: None,
            color_preset: None,
            avatar_url: None,
            privacy_policy_url: None,
            appearance: Some(AgentWebsiteAppearanceInput {
                primary_color: Some("red".to_string()),
                launcher_size: Some(120),
                window_width: None,
                window_height: None,
                border_radius: None,
                launcher_offset: None,
                show_branding: None,
            }),
        };
        assert!(normalize_website_deployment_input(input).is_err());
    }
}
