use actix_web::http::StatusCode;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};

use crate::error::AppError;
use crate::services::credits;

const PROGRAM_VERSION: &str = "credits-referral-v1";

#[derive(Debug, Clone, Copy)]
pub struct ReferralRewardConfig {
    pub referrer_credits: i64,
    pub referee_credits: i64,
    pub reward_expiry_days: i64,
    pub attribution_window_days: i64,
}

impl ReferralRewardConfig {
    pub fn from_config(config: &crate::config::AppConfig) -> Self {
        Self {
            referrer_credits: config.referral_referrer_credits,
            referee_credits: config.referral_referee_credits,
            reward_expiry_days: config.referral_reward_expiry_days,
            attribution_window_days: config.referral_attribution_window_days,
        }
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct ReferralCodeView {
    pub code: String,
    pub status: String,
    #[serde(rename = "disabledAt")]
    #[sqlx(rename = "disabled_at")]
    pub disabled_at: Option<DateTime<Utc>>,
    #[serde(rename = "disabledReason")]
    #[sqlx(rename = "disabled_reason")]
    pub disabled_reason: Option<String>,
    #[serde(rename = "redemptionCount")]
    #[sqlx(rename = "redemption_count")]
    pub redemption_count: i32,
    #[serde(rename = "attributedCount")]
    #[sqlx(rename = "attributed_count")]
    pub attributed_count: i32,
    #[serde(rename = "maxRedemptions")]
    #[sqlx(rename = "max_redemptions")]
    pub max_redemptions: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct ReferralSummary {
    #[serde(flatten)]
    pub code: ReferralCodeView,
    #[serde(rename = "shareUrl")]
    pub share_url: String,
    #[serde(rename = "referrerRewardCredits")]
    pub referrer_reward_credits: i64,
    #[serde(rename = "refereeRewardCredits")]
    pub referee_reward_credits: i64,
    #[serde(rename = "rewardExpiryDays")]
    pub reward_expiry_days: i64,
    #[serde(rename = "attributionWindowDays")]
    pub attribution_window_days: i64,
    #[serde(rename = "pendingCount")]
    pub pending_count: i64,
    #[serde(rename = "qualifiedCount")]
    pub qualified_count: i64,
    #[serde(rename = "awardedCount")]
    pub awarded_count: i64,
    #[serde(rename = "expiredCount")]
    pub expired_count: i64,
    #[serde(rename = "rejectedCount")]
    pub rejected_count: i64,
    #[serde(rename = "reversedCount")]
    pub reversed_count: i64,
    pub recent: Vec<ReferralHistoryView>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ReferralHistoryView {
    pub id: String,
    pub status: String,
    #[serde(rename = "refereeOrgName")]
    #[sqlx(rename = "referee_org_name")]
    pub referee_org_name: String,
    #[serde(rename = "attributedAt")]
    #[sqlx(rename = "attributed_at")]
    pub attributed_at: DateTime<Utc>,
    #[serde(rename = "attributionExpiresAt")]
    #[sqlx(rename = "attribution_expires_at")]
    pub attribution_expires_at: Option<DateTime<Utc>>,
    #[serde(rename = "qualifiedAt")]
    #[sqlx(rename = "qualified_at")]
    pub qualified_at: Option<DateTime<Utc>>,
    #[serde(rename = "awardedAt")]
    #[sqlx(rename = "awarded_at")]
    pub awarded_at: Option<DateTime<Utc>>,
    #[serde(rename = "reversedAt")]
    #[sqlx(rename = "reversed_at")]
    pub reversed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ReferralAdminView {
    pub id: String,
    pub code: String,
    #[serde(rename = "codeStatus")]
    #[sqlx(rename = "code_status")]
    pub code_status: String,
    pub status: String,
    #[serde(rename = "referrerOrgId")]
    #[sqlx(rename = "referrer_org_id")]
    pub referrer_org_id: String,
    #[serde(rename = "referrerOrgName")]
    #[sqlx(rename = "referrer_org_name")]
    pub referrer_org_name: String,
    #[serde(rename = "refereeOrgId")]
    #[sqlx(rename = "referee_org_id")]
    pub referee_org_id: String,
    #[serde(rename = "refereeOrgName")]
    #[sqlx(rename = "referee_org_name")]
    pub referee_org_name: String,
    #[serde(rename = "attributedAt")]
    #[sqlx(rename = "attributed_at")]
    pub attributed_at: DateTime<Utc>,
    #[serde(rename = "attributionExpiresAt")]
    #[sqlx(rename = "attribution_expires_at")]
    pub attribution_expires_at: Option<DateTime<Utc>>,
    #[serde(rename = "qualifiedAt")]
    #[sqlx(rename = "qualified_at")]
    pub qualified_at: Option<DateTime<Utc>>,
    #[serde(rename = "awardedAt")]
    #[sqlx(rename = "awarded_at")]
    pub awarded_at: Option<DateTime<Utc>>,
    #[serde(rename = "reversedAt")]
    #[sqlx(rename = "reversed_at")]
    pub reversed_at: Option<DateTime<Utc>>,
    #[serde(rename = "qualificationReference")]
    #[sqlx(rename = "qualification_reference")]
    pub qualification_reference: Option<String>,
    #[serde(rename = "reversalReason")]
    #[sqlx(rename = "reversal_reason")]
    pub reversal_reason: Option<String>,
    #[serde(rename = "referrerGrantId")]
    #[sqlx(rename = "referrer_grant_id")]
    pub referrer_grant_id: Option<String>,
    #[serde(rename = "refereeGrantId")]
    #[sqlx(rename = "referee_grant_id")]
    pub referee_grant_id: Option<String>,
    pub metadata: Option<Value>,
}

fn required_code(code: &str) -> Result<String, AppError> {
    let code = code.trim().to_ascii_uppercase();
    if code.is_empty() || code.len() > 80 {
        return Err(AppError::referral(
            "referral_code_invalid",
            "Referral code is required and must be at most 80 characters",
            StatusCode::BAD_REQUEST,
        ));
    }
    Ok(code)
}

fn validate_reward_config(config: ReferralRewardConfig) -> Result<(), AppError> {
    if config.referrer_credits < 0
        || config.referee_credits < 0
        || config.reward_expiry_days < 1
        || config.attribution_window_days < 1
    {
        return Err(AppError::referral(
            "referral_unavailable",
            "Referral reward configuration is invalid",
            StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }
    Ok(())
}

pub fn share_url(frontend_url: &str, code: &str) -> String {
    format!(
        "{}/signup?referralCode={}",
        frontend_url.trim_end_matches('/'),
        code
    )
}

pub async fn ensure_referral_code(pool: &PgPool, org_id: &str) -> Result<String, AppError> {
    if let Some(code) =
        sqlx::query_scalar::<_, String>(r#"SELECT code FROM "ReferralCode" WHERE "orgId" = $1"#)
            .bind(org_id)
            .fetch_optional(pool)
            .await?
    {
        return Ok(code);
    }

    for _ in 0..5 {
        let suffix = cuid2::create_id();
        let code = format!(
            "KASI-{}",
            &suffix[..suffix.len().min(10)].to_ascii_uppercase()
        );
        let inserted = sqlx::query(
            r#"
            INSERT INTO "ReferralCode" (id, "orgId", code, status, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())
            ON CONFLICT ("orgId") DO NOTHING
            "#,
        )
        .bind(cuid2::create_id())
        .bind(org_id)
        .bind(&code)
        .execute(pool)
        .await?;
        if inserted.rows_affected() == 1 {
            return Ok(code);
        }
        if let Some(existing) =
            sqlx::query_scalar::<_, String>(r#"SELECT code FROM "ReferralCode" WHERE "orgId" = $1"#)
                .bind(org_id)
                .fetch_optional(pool)
                .await?
        {
            return Ok(existing);
        }
    }
    Err(AppError::referral(
        "referral_code_unavailable",
        "Could not create a unique referral code",
        StatusCode::CONFLICT,
    ))
}

pub async fn get_referral_code(pool: &PgPool, org_id: &str) -> Result<ReferralCodeView, AppError> {
    ensure_referral_code(pool, org_id).await?;
    sqlx::query_as::<_, ReferralCodeView>(
        r#"
        SELECT code, status,
               "disabledAt" AT TIME ZONE 'UTC' AS disabled_at,
               "disabledReason" AS disabled_reason,
               "redemptionCount" AS redemption_count,
               "attributionCount" AS attributed_count,
               "maxRedemptions" AS max_redemptions
        FROM "ReferralCode" WHERE "orgId" = $1
        "#,
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::referral(
            "referral_code_unavailable",
            "Referral code not found",
            StatusCode::NOT_FOUND,
        )
    })
}

pub async fn expire_attributions(pool: &PgPool, limit: i64) -> Result<u64, AppError> {
    let limit = limit.clamp(1, 1_000);
    let result = sqlx::query(
        r#"
        WITH expired AS (
            SELECT id
            FROM "ReferralAttribution"
            WHERE status = 'ATTRIBUTED'
              AND "attributionExpiresAt" IS NOT NULL
              AND "attributionExpiresAt" <= NOW()
            ORDER BY "attributionExpiresAt", id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
        )
        UPDATE "ReferralAttribution" AS attribution
        SET status = 'EXPIRED',
            metadata = COALESCE(attribution.metadata, '{}'::jsonb) ||
                jsonb_build_object('expiredReason', 'attribution_window_elapsed'),
            "updatedAt" = NOW()
        FROM expired
        WHERE attribution.id = expired.id
        "#,
    )
    .bind(limit)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn get_referral_summary(
    pool: &PgPool,
    org_id: &str,
    config: ReferralRewardConfig,
    frontend_url: &str,
) -> Result<ReferralSummary, AppError> {
    validate_reward_config(config)?;
    expire_attributions(pool, 200).await?;
    let code = get_referral_code(pool, org_id).await?;
    let counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
        r#"
        SELECT
          COUNT(*) FILTER (WHERE status = 'ATTRIBUTED'),
          COUNT(*) FILTER (WHERE status = 'QUALIFIED'),
          COUNT(*) FILTER (WHERE status = 'AWARDED'),
          COUNT(*) FILTER (WHERE status = 'EXPIRED'),
          COUNT(*) FILTER (WHERE status = 'REJECTED'),
          COUNT(*) FILTER (WHERE status = 'REVERSED')
        FROM "ReferralAttribution"
        WHERE "referrerOrgId" = $1
        "#,
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?;
    let recent = sqlx::query_as::<_, ReferralHistoryView>(
        r#"
        SELECT attribution.id, attribution.status,
               CONCAT('Workspace ', RIGHT(referee.id, 6)) AS referee_org_name,
               attribution."attributedAt" AT TIME ZONE 'UTC' AS attributed_at,
               attribution."attributionExpiresAt" AT TIME ZONE 'UTC' AS attribution_expires_at,
               attribution."qualifiedAt" AT TIME ZONE 'UTC' AS qualified_at,
               attribution."awardedAt" AT TIME ZONE 'UTC' AS awarded_at,
               attribution."reversedAt" AT TIME ZONE 'UTC' AS reversed_at
        FROM "ReferralAttribution" attribution
        JOIN "Organization" referee ON referee.id = attribution."refereeOrgId"
        WHERE attribution."referrerOrgId" = $1
        ORDER BY attribution."attributedAt" DESC
        LIMIT 25
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    Ok(ReferralSummary {
        share_url: share_url(frontend_url, &code.code),
        code,
        referrer_reward_credits: config.referrer_credits,
        referee_reward_credits: config.referee_credits,
        reward_expiry_days: config.reward_expiry_days,
        attribution_window_days: config.attribution_window_days,
        pending_count: counts.0,
        qualified_count: counts.1,
        awarded_count: counts.2,
        expired_count: counts.3,
        rejected_count: counts.4,
        reversed_count: counts.5,
        recent,
    })
}

pub async fn list_referral_attributions(
    pool: &PgPool,
    org_id: Option<&str>,
    status: Option<&str>,
    limit: i64,
) -> Result<Vec<ReferralAdminView>, AppError> {
    let limit = limit.clamp(1, 200);
    sqlx::query_as::<_, ReferralAdminView>(
        r#"
        SELECT attribution.id, code.code, code.status AS code_status, attribution.status,
               attribution."referrerOrgId" AS referrer_org_id,
               referrer.name AS referrer_org_name,
               attribution."refereeOrgId" AS referee_org_id,
               referee.name AS referee_org_name,
               attribution."attributedAt" AT TIME ZONE 'UTC' AS attributed_at,
               attribution."attributionExpiresAt" AT TIME ZONE 'UTC' AS attribution_expires_at,
               attribution."qualifiedAt" AT TIME ZONE 'UTC' AS qualified_at,
               attribution."awardedAt" AT TIME ZONE 'UTC' AS awarded_at,
               attribution."reversedAt" AT TIME ZONE 'UTC' AS reversed_at,
               attribution."qualificationReference" AS qualification_reference,
               attribution."reversalReason" AS reversal_reason,
               attribution."referrerGrantId" AS referrer_grant_id,
               attribution."refereeGrantId" AS referee_grant_id,
               attribution.metadata
        FROM "ReferralAttribution" attribution
        JOIN "ReferralCode" code ON code.id = attribution."codeId"
        JOIN "Organization" referrer ON referrer.id = attribution."referrerOrgId"
        JOIN "Organization" referee ON referee.id = attribution."refereeOrgId"
        WHERE ($1::text IS NULL OR attribution."referrerOrgId" = $1 OR attribution."refereeOrgId" = $1)
          AND ($2::text IS NULL OR attribution.status = $2)
        ORDER BY attribution."attributedAt" DESC
        LIMIT $3
        "#,
    )
    .bind(org_id)
    .bind(status)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn set_referral_code_status(
    pool: &PgPool,
    org_id: &str,
    status: &str,
    reason: &str,
) -> Result<bool, AppError> {
    let status = status.trim().to_ascii_uppercase();
    let reason = reason.trim();
    if !matches!(status.as_str(), "ACTIVE" | "DISABLED") || reason.is_empty() {
        return Err(AppError::referral(
            "referral_support_invalid",
            "A valid code status and support reason are required",
            StatusCode::BAD_REQUEST,
        ));
    }
    if reason.len() > 2_000 {
        return Err(AppError::referral(
            "referral_support_invalid",
            "Support reason is too long",
            StatusCode::BAD_REQUEST,
        ));
    }
    let result = sqlx::query(
        r#"
        UPDATE "ReferralCode"
        SET status = $2,
            "disabledAt" = CASE WHEN $2 = 'DISABLED' THEN NOW() ELSE NULL END,
            "disabledReason" = CASE WHEN $2 = 'DISABLED' THEN $3 ELSE NULL END,
            "updatedAt" = NOW()
        WHERE "orgId" = $1
        "#,
    )
    .bind(org_id)
    .bind(&status)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn reject_referral_attribution(
    pool: &PgPool,
    attribution_id: &str,
    reason: &str,
    support_reference: &str,
) -> Result<bool, AppError> {
    let reason = reason.trim();
    let support_reference = support_reference.trim();
    if reason.is_empty() || support_reference.is_empty() {
        return Err(AppError::referral(
            "referral_support_invalid",
            "A support reason and reference are required",
            StatusCode::BAD_REQUEST,
        ));
    }
    let result = sqlx::query(
        r#"
        UPDATE "ReferralAttribution"
        SET status = 'REJECTED',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'rejectedReason', $2,
                'supportReference', $3
            ),
            "updatedAt" = NOW()
        WHERE id = $1 AND status IN ('ATTRIBUTED', 'QUALIFIED')
        "#,
    )
    .bind(attribution_id)
    .bind(reason)
    .bind(support_reference)
    .execute(pool)
    .await?;
    if result.rows_affected() == 1 {
        return Ok(true);
    }
    let status = sqlx::query_scalar::<_, String>(
        r#"SELECT status FROM "ReferralAttribution" WHERE id = $1"#,
    )
    .bind(attribution_id)
    .fetch_optional(pool)
    .await?;
    match status.as_deref() {
        Some("REJECTED") => Ok(true),
        Some("AWARDED") => Err(AppError::referral(
            "referral_support_requires_reversal",
            "Awarded referrals must use the reversal action",
            StatusCode::CONFLICT,
        )),
        Some(_) => Ok(false),
        None => Err(AppError::referral(
            "referral_unavailable",
            "Referral attribution not found",
            StatusCode::NOT_FOUND,
        )),
    }
}

pub async fn reverse_referral_attribution(
    pool: &PgPool,
    attribution_id: &str,
    reason: &str,
    reversal_reference: &str,
) -> Result<bool, AppError> {
    let referee_org_id = sqlx::query_scalar::<_, String>(
        r#"SELECT "refereeOrgId" FROM "ReferralAttribution" WHERE id = $1"#,
    )
    .bind(attribution_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::referral(
            "referral_unavailable",
            "Referral attribution not found",
            StatusCode::NOT_FOUND,
        )
    })?;
    reverse_referral(pool, &referee_org_id, reason, reversal_reference).await
}

pub async fn attribute_referral(
    pool: &PgPool,
    referee_org_id: &str,
    raw_code: &str,
    config: ReferralRewardConfig,
) -> Result<bool, AppError> {
    validate_reward_config(config)?;
    let code = required_code(raw_code)?;
    let mut tx = pool.begin().await?;
    let code_row = sqlx::query_as::<_, (String, String, String, Option<i32>, i32, String)>(
        r#"
        SELECT code.id, code."orgId", code.status, code."maxRedemptions",
               code."redemptionCount", owner."ownerId"
        FROM "ReferralCode" code
        JOIN "Organization" owner ON owner.id = code."orgId"
        WHERE code.code = $1
        FOR UPDATE
        "#,
    )
    .bind(&code)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::referral(
            "referral_code_unavailable",
            "Referral code not found",
            StatusCode::NOT_FOUND,
        )
    })?;

    if code_row.1 == referee_org_id {
        return Err(AppError::referral(
            "referral_self_referral",
            "An organisation cannot use its own referral code",
            StatusCode::BAD_REQUEST,
        ));
    }
    let referee_owner_id =
        sqlx::query_scalar::<_, String>(r#"SELECT "ownerId" FROM "Organization" WHERE id = $1"#)
            .bind(referee_org_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                AppError::referral(
                    "referral_unavailable",
                    "Referee organisation not found",
                    StatusCode::NOT_FOUND,
                )
            })?;
    if code_row.5 == referee_owner_id {
        return Err(AppError::referral(
            "referral_self_referral",
            "An account cannot refer itself",
            StatusCode::BAD_REQUEST,
        ));
    }
    if code_row.2 != "ACTIVE" {
        return Err(AppError::referral(
            "referral_code_disabled",
            "Referral code is not active",
            StatusCode::CONFLICT,
        ));
    }
    if let Some(existing) = sqlx::query_as::<_, (String, String)>(
        r#"SELECT "codeId", status FROM "ReferralAttribution" WHERE "refereeOrgId" = $1 FOR UPDATE"#,
    )
    .bind(referee_org_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if existing.0 == code_row.0 {
            tx.commit().await?;
            return Ok(false);
        }
        return Err(AppError::referral(
            "referral_attribution_duplicate",
            "This organisation already has a referral attribution",
            StatusCode::CONFLICT,
        ));
    }

    if code_row.3.is_some_and(|limit| code_row.4 >= limit) {
        return Err(AppError::referral(
            "referral_limit_reached",
            "Referral code has reached its qualified referral limit",
            StatusCode::CONFLICT,
        ));
    }

    let expires_at = Utc::now() + Duration::days(config.attribution_window_days);
    sqlx::query(
        r#"
        INSERT INTO "ReferralAttribution" (
            id, "codeId", "referrerOrgId", "refereeOrgId", status,
            "attributedAt", "attributionExpiresAt", "referrerRewardCredits",
            "refereeRewardCredits", "rewardExpiryDays", "programVersion",
            "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'ATTRIBUTED', NOW(), $5, $6, $7, $8, $9, NOW(), NOW())
        "#,
    )
    .bind(cuid2::create_id())
    .bind(&code_row.0)
    .bind(&code_row.1)
    .bind(referee_org_id)
    .bind(expires_at)
    .bind(config.referrer_credits)
    .bind(config.referee_credits)
    .bind(config.reward_expiry_days)
    .bind(PROGRAM_VERSION)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"UPDATE "ReferralCode" SET "attributionCount" = "attributionCount" + 1, "updatedAt" = NOW() WHERE id = $1"#,
    )
    .bind(&code_row.0)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn qualify_referral(
    pool: &PgPool,
    referee_org_id: &str,
    qualification_reference: &str,
    config: ReferralRewardConfig,
) -> Result<bool, AppError> {
    validate_reward_config(config)?;
    let qualification_reference = qualification_reference.trim();
    if qualification_reference.is_empty() || qualification_reference.len() > 240 {
        return Err(AppError::referral(
            "referral_qualification_invalid",
            "Referral qualification reference is required",
            StatusCode::BAD_REQUEST,
        ));
    }

    let mut tx = pool.begin().await?;
    let attribution = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            Option<DateTime<Utc>>,
            Option<i32>,
            Option<i32>,
            Option<i32>,
        ),
    >(
        r#"
        SELECT id, "codeId", "referrerOrgId", status,
               COALESCE("qualificationReference", ''),
               "attributionExpiresAt" AT TIME ZONE 'UTC',
               "referrerRewardCredits", "refereeRewardCredits", "rewardExpiryDays"
        FROM "ReferralAttribution"
        WHERE "refereeOrgId" = $1
        FOR UPDATE
        "#,
    )
    .bind(referee_org_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((
        attribution_id,
        code_id,
        referrer_org_id,
        status,
        existing_reference,
        attribution_expires_at,
        stored_referrer_credits,
        stored_referee_credits,
        stored_expiry_days,
    )) = attribution
    else {
        tx.commit().await?;
        return Ok(false);
    };
    if status == "AWARDED" {
        tx.commit().await?;
        return Ok(true);
    }
    if matches!(status.as_str(), "REJECTED" | "EXPIRED" | "REVERSED") {
        tx.commit().await?;
        return Ok(false);
    }
    if status == "ATTRIBUTED"
        && attribution_expires_at.is_some_and(|expires_at| expires_at <= Utc::now())
    {
        sqlx::query(
            r#"UPDATE "ReferralAttribution" SET status = 'EXPIRED', metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('expiredReason', 'attribution_window_elapsed'), "updatedAt" = NOW() WHERE id = $1 AND status = 'ATTRIBUTED'"#,
        )
        .bind(&attribution_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(false);
    }

    if let Some(existing_id) = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM "ReferralAttribution"
        WHERE "qualificationReference" = $1 AND id <> $2
        LIMIT 1
        "#,
    )
    .bind(qualification_reference)
    .bind(&attribution_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        return Err(AppError::referral(
            "referral_qualification_duplicate",
            format!("Qualification reference already belongs to referral {existing_id}"),
            StatusCode::CONFLICT,
        ));
    }

    let code_limits = sqlx::query_as::<_, (Option<i32>, i32)>(
        r#"SELECT "maxRedemptions", "redemptionCount" FROM "ReferralCode" WHERE id = $1 FOR UPDATE"#,
    )
    .bind(&code_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::referral(
            "referral_unavailable",
            "Referral code not found",
            StatusCode::NOT_FOUND,
        )
    })?;
    if status == "ATTRIBUTED" && code_limits.0.is_some_and(|limit| code_limits.1 >= limit) {
        sqlx::query(
            r#"UPDATE "ReferralAttribution" SET status = 'REJECTED', metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('rejectedReason', 'qualified_referral_limit_reached'), "updatedAt" = NOW() WHERE id = $1 AND status = 'ATTRIBUTED'"#,
        )
        .bind(&attribution_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(false);
    }

    let reference = if existing_reference.is_empty() {
        qualification_reference.to_string()
    } else {
        existing_reference
    };
    if status == "ATTRIBUTED" {
        sqlx::query(
            r#"
            UPDATE "ReferralAttribution"
            SET status = 'QUALIFIED', "qualifiedAt" = COALESCE("qualifiedAt", NOW()),
                "qualificationReference" = $2, "updatedAt" = NOW()
            WHERE id = $1 AND status = 'ATTRIBUTED'
            "#,
        )
        .bind(&attribution_id)
        .bind(&reference)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let referrer_credits = stored_referrer_credits
        .map(i64::from)
        .unwrap_or(config.referrer_credits);
    let referee_credits = stored_referee_credits
        .map(i64::from)
        .unwrap_or(config.referee_credits);
    let reward_expiry_days = stored_expiry_days
        .map(i64::from)
        .unwrap_or(config.reward_expiry_days);
    let ends_at = Utc::now() + Duration::days(reward_expiry_days);
    let metadata = serde_json::json!({
        "attributionId": attribution_id,
        "qualificationReference": reference,
        "programVersion": PROGRAM_VERSION,
        "referrerCredits": referrer_credits,
        "refereeCredits": referee_credits,
    });
    let referrer_grant_id = if referrer_credits > 0 {
        Some(
            credits::grant_system_credits(
                pool,
                &referrer_org_id,
                referrer_credits,
                "REFERRAL",
                Some(ends_at),
                "Successful referral reward",
                Some(&format!("referral:{attribution_id}:referrer")),
                Some(&metadata),
                &format!("referral-referrer:{attribution_id}"),
            )
            .await?
            .grant_id
            .ok_or_else(|| AppError::Internal("Referral grant id was not recorded".to_string()))?,
        )
    } else {
        None
    };
    let referee_grant_id = if referee_credits > 0 {
        Some(
            credits::grant_system_credits(
                pool,
                referee_org_id,
                referee_credits,
                "REFERRAL",
                Some(ends_at),
                "Referral welcome reward",
                Some(&format!("referral:{attribution_id}:referee")),
                Some(&metadata),
                &format!("referral-referee:{attribution_id}"),
            )
            .await?
            .grant_id
            .ok_or_else(|| AppError::Internal("Referral grant id was not recorded".to_string()))?,
        )
    } else {
        None
    };

    let updated = sqlx::query(
        r#"
        UPDATE "ReferralAttribution"
        SET status = 'AWARDED', "awardedAt" = COALESCE("awardedAt", NOW()),
            "referrerGrantId" = $2, "refereeGrantId" = $3, "updatedAt" = NOW()
        WHERE id = $1 AND status = 'QUALIFIED'
        "#,
    )
    .bind(&attribution_id)
    .bind(&referrer_grant_id)
    .bind(&referee_grant_id)
    .execute(pool)
    .await?;
    if updated.rows_affected() == 1 {
        sqlx::query(
            r#"UPDATE "ReferralCode" SET "redemptionCount" = "redemptionCount" + 1, "updatedAt" = NOW() WHERE id = $1"#,
        )
        .bind(&code_id)
        .execute(pool)
        .await?;
        return Ok(true);
    }

    // A refund or support reversal can invalidate a qualified attribution
    // while the two system grants are being created. Do not leave those
    // grants orphaned if the conditional award transition loses that race.
    for (org_id, grant_id, side) in [
        (
            referrer_org_id.as_str(),
            referrer_grant_id.as_deref(),
            "referrer",
        ),
        (referee_org_id, referee_grant_id.as_deref(), "referee"),
    ] {
        if let Some(grant_id) = grant_id {
            credits::revoke_unspent_system_grant(
                pool,
                org_id,
                grant_id,
                "Referral qualification was invalidated before award completion",
                &format!("referral-reversal-race:{attribution_id}:{side}"),
            )
            .await?;
        }
    }
    Ok(false)
}

/// Reverse a referral after a full refund or a confirmed support decision.
///
/// The attribution is transitioned conditionally before the transaction is
/// committed. Any unused reward lots are then reduced through compensating
/// credit ledger entries. Consumed or reserved amounts remain visible for
/// support review instead of creating an implicit negative balance.
pub async fn reverse_referral(
    pool: &PgPool,
    referee_org_id: &str,
    reason: &str,
    reversal_reference: &str,
) -> Result<bool, AppError> {
    let reason = reason.trim();
    let reversal_reference = reversal_reference.trim();
    if reason.is_empty() || reason.len() > 2_000 {
        return Err(AppError::referral(
            "referral_reversal_invalid",
            "Referral reversal reason is required",
            StatusCode::BAD_REQUEST,
        ));
    }
    if reversal_reference.is_empty() || reversal_reference.len() > 240 {
        return Err(AppError::referral(
            "referral_reversal_invalid",
            "Referral reversal reference is required",
            StatusCode::BAD_REQUEST,
        ));
    }

    let mut tx = pool.begin().await?;
    let attribution =
        sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>)>(
            r#"
        SELECT id, status, "referrerOrgId", "referrerGrantId", "refereeGrantId"
        FROM "ReferralAttribution"
        WHERE "refereeOrgId" = $1
        FOR UPDATE
        "#,
        )
        .bind(referee_org_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((attribution_id, status, referrer_org_id, referrer_grant_id, referee_grant_id)) =
        attribution
    else {
        tx.commit().await?;
        return Ok(false);
    };

    if status == "REVERSED" {
        tx.commit().await?;
        return Ok(true);
    }
    if !matches!(status.as_str(), "ATTRIBUTED" | "QUALIFIED" | "AWARDED") {
        tx.commit().await?;
        return Ok(false);
    }

    let mut revoked = Vec::new();
    if status == "AWARDED" {
        if let Some(grant_id) = referrer_grant_id.as_deref() {
            let result = credits::revoke_unspent_system_grant(
                pool,
                &referrer_org_id,
                grant_id,
                reason,
                &format!("referral-reversal:{attribution_id}:referrer"),
            )
            .await?;
            revoked.push(serde_json::json!({
                "side": "referrer",
                "grantId": grant_id,
                "revokedAmount": result.revoked_amount,
                "remainingAmount": result.remaining_amount,
            }));
        }
        if let Some(grant_id) = referee_grant_id.as_deref() {
            let result = credits::revoke_unspent_system_grant(
                pool,
                referee_org_id,
                grant_id,
                reason,
                &format!("referral-reversal:{attribution_id}:referee"),
            )
            .await?;
            revoked.push(serde_json::json!({
                "side": "referee",
                "grantId": grant_id,
                "revokedAmount": result.revoked_amount,
                "remainingAmount": result.remaining_amount,
            }));
        }
    }

    let updated = sqlx::query(
        r#"
        UPDATE "ReferralAttribution"
        SET status = 'REVERSED', "reversedAt" = COALESCE("reversedAt", NOW()),
            "reversalReason" = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'reversalReference', $3,
                'rewards', $4::jsonb
            ),
            "updatedAt" = NOW()
        WHERE id = $1 AND status = $5
        "#,
    )
    .bind(&attribution_id)
    .bind(reason)
    .bind(reversal_reference)
    .bind(serde_json::to_value(revoked).map_err(|error| {
        AppError::Internal(format!(
            "Could not encode referral reversal metadata: {error}"
        ))
    })?)
    .bind(&status)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(updated.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::{required_code, share_url};

    #[test]
    fn referral_codes_are_normalized_and_bounded() {
        assert_eq!(required_code(" kasi-demo ").unwrap(), "KASI-DEMO");
        assert!(required_code("").is_err());
        assert!(required_code(&"x".repeat(81)).is_err());
    }

    #[test]
    fn referral_share_urls_use_the_public_signup_route() {
        assert_eq!(
            share_url("https://app.example/", "KASI-DEMO"),
            "https://app.example/signup?referralCode=KASI-DEMO"
        );
    }
}
