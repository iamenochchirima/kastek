use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use crate::error::AppError;

const ADMIN_SOURCES: &[&str] = &["MANUAL", "PROMOTIONAL", "COMPENSATION"];
const SYSTEM_SOURCES: &[&str] = &[
    "PLAN",
    "TRIAL",
    "REFERRAL",
    "PURCHASE",
    "MIGRATION",
    "EARLY_ACCESS",
];

#[derive(Debug, Serialize, FromRow)]
pub struct CreditBalance {
    #[serde(rename = "orgId")]
    #[sqlx(rename = "org_id")]
    pub org_id: String,
    pub balance: i64,
    #[serde(rename = "reservedBalance")]
    #[sqlx(rename = "reserved_balance")]
    pub reserved_balance: i64,
    #[serde(rename = "availableBalance")]
    #[sqlx(rename = "available_balance")]
    pub available_balance: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CreditGrant {
    pub id: String,
    pub source: String,
    pub amount: i64,
    #[serde(rename = "remainingAmount")]
    #[sqlx(rename = "remaining_amount")]
    pub remaining_amount: i64,
    #[serde(rename = "startsAt")]
    #[sqlx(rename = "starts_at")]
    pub starts_at: DateTime<Utc>,
    #[serde(rename = "endsAt")]
    #[sqlx(rename = "ends_at")]
    pub ends_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
    pub reference: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CreditLedgerEntry {
    pub id: String,
    #[serde(rename = "entryType")]
    #[sqlx(rename = "entry_type")]
    pub entry_type: String,
    pub amount: i64,
    #[serde(rename = "balanceAfter")]
    #[sqlx(rename = "balance_after")]
    pub balance_after: i64,
    #[serde(rename = "actionKey")]
    #[sqlx(rename = "action_key")]
    pub action_key: Option<String>,
    #[serde(rename = "sourceType")]
    #[sqlx(rename = "source_type")]
    pub source_type: Option<String>,
    #[serde(rename = "sourceId")]
    #[sqlx(rename = "source_id")]
    pub source_id: Option<String>,
    #[serde(rename = "pricingVersion")]
    #[sqlx(rename = "pricing_version")]
    pub pricing_version: Option<String>,
    #[serde(rename = "createdByAdminId")]
    #[sqlx(rename = "created_by_admin_id")]
    pub created_by_admin_id: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CreditAccountView {
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub balance: i64,
    #[serde(rename = "reservedBalance")]
    pub reserved_balance: i64,
    #[serde(rename = "availableBalance")]
    pub available_balance: i64,
    pub grants: Vec<CreditGrant>,
    pub ledger: Vec<CreditLedgerEntry>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CreditUsageEventView {
    pub id: String,
    #[serde(rename = "actionKey")]
    #[sqlx(rename = "action_key")]
    pub action_key: String,
    pub quantity: i64,
    #[serde(rename = "creditsCharged")]
    #[sqlx(rename = "credits_charged")]
    pub credits_charged: i64,
    pub status: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "fundingSource")]
    #[sqlx(rename = "funding_source")]
    pub funding_source: Option<String>,
    #[serde(rename = "inputTokens")]
    #[sqlx(rename = "input_tokens")]
    pub input_tokens: Option<i64>,
    #[serde(rename = "outputTokens")]
    #[sqlx(rename = "output_tokens")]
    pub output_tokens: Option<i64>,
    #[serde(rename = "pricingVersion")]
    #[sqlx(rename = "pricing_version")]
    pub pricing_version: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CreditMutationResult {
    #[serde(rename = "orgId")]
    pub org_id: String,
    #[serde(rename = "operationId")]
    pub operation_id: String,
    #[serde(rename = "ledgerEntryId")]
    pub ledger_entry_id: Option<String>,
    #[serde(rename = "grantId")]
    pub grant_id: Option<String>,
    pub balance: i64,
    #[serde(rename = "reservedBalance")]
    pub reserved_balance: i64,
    #[serde(rename = "availableBalance")]
    pub available_balance: i64,
    pub amount: i64,
    pub idempotent: bool,
}

#[derive(Debug, Serialize)]
pub struct CreditRevocationResult {
    #[serde(rename = "revokedAmount")]
    pub revoked_amount: i64,
    #[serde(rename = "remainingAmount")]
    pub remaining_amount: i64,
    pub idempotent: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CreditOrganization {
    pub id: String,
    pub name: String,
    pub slug: String,
    #[serde(rename = "ownerEmail")]
    #[sqlx(rename = "owner_email")]
    pub owner_email: Option<String>,
    pub balance: i64,
    #[serde(rename = "reservedBalance")]
    #[sqlx(rename = "reserved_balance")]
    pub reserved_balance: i64,
}

#[derive(Debug, Serialize)]
pub struct CreditReservationView {
    pub id: String,
    #[serde(rename = "orgId")]
    pub org_id: String,
    #[serde(rename = "actionKey")]
    pub action_key: String,
    #[serde(rename = "estimatedCredits")]
    pub estimated_credits: i64,
    #[serde(rename = "capturedCredits")]
    pub captured_credits: i64,
    #[serde(rename = "releasedCredits")]
    pub released_credits: i64,
    pub status: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(rename = "sourceType")]
    pub source_type: Option<String>,
    #[serde(rename = "sourceId")]
    pub source_id: Option<String>,
    #[serde(rename = "pricingVersion")]
    pub pricing_version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreditReservationMutationResult {
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub reservation: CreditReservationView,
    pub balance: i64,
    #[serde(rename = "reservedBalance")]
    pub reserved_balance: i64,
    #[serde(rename = "availableBalance")]
    pub available_balance: i64,
    pub amount: i64,
    pub idempotent: bool,
}

#[derive(Debug, Default)]
pub struct CreditCaptureUsage {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub funding_source: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub provider_cost_usd: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, FromRow)]
struct AccountRow {
    id: String,
    balance: i64,
    #[sqlx(rename = "reserved_balance")]
    reserved_balance: i64,
}

#[derive(Debug, FromRow)]
struct ExistingOperationRow {
    id: String,
    #[sqlx(rename = "org_id")]
    org_id: String,
    #[sqlx(rename = "after_balance")]
    after_balance: i64,
    #[sqlx(rename = "after_reserved_balance")]
    after_reserved_balance: i64,
    #[sqlx(rename = "amount")]
    amount: Option<i64>,
    #[sqlx(rename = "ledger_entry_id")]
    ledger_entry_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct ExistingLedgerRow {
    id: String,
    #[sqlx(rename = "org_id")]
    org_id: String,
    #[sqlx(rename = "balance_after")]
    balance_after: i64,
    amount: i64,
    #[sqlx(rename = "source_id")]
    source_id: Option<String>,
    #[sqlx(rename = "grant_id")]
    grant_id: Option<String>,
    #[sqlx(rename = "entry_type")]
    entry_type: String,
}

#[derive(Debug, FromRow)]
struct ReservationRow {
    id: String,
    #[sqlx(rename = "account_id")]
    account_id: String,
    #[sqlx(rename = "org_id")]
    org_id: String,
    #[sqlx(rename = "action_key")]
    action_key: String,
    #[sqlx(rename = "estimated_credits")]
    estimated_credits: i64,
    #[sqlx(rename = "captured_credits")]
    captured_credits: i64,
    #[sqlx(rename = "released_credits")]
    released_credits: i64,
    status: String,
    #[sqlx(rename = "expires_at")]
    expires_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "source_type")]
    source_type: Option<String>,
    #[sqlx(rename = "source_id")]
    source_id: Option<String>,
    #[sqlx(rename = "pricing_version")]
    pricing_version: Option<String>,
}

#[derive(Debug, FromRow)]
struct GrantBalanceRow {
    id: String,
    #[sqlx(rename = "remaining_amount")]
    remaining_amount: i64,
}

fn required_text(value: &str, field: &str, max_len: usize) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_len {
        return Err(AppError::BadRequest(format!(
            "{field} is required and must be at most {max_len} characters"
        )));
    }
    Ok(value.to_string())
}

fn validate_amount(amount: i64) -> Result<(), AppError> {
    if amount <= 0 {
        return Err(AppError::BadRequest(
            "Credit amount must be greater than zero".to_string(),
        ));
    }
    Ok(())
}

fn validate_non_negative_amount(amount: i64, label: &str) -> Result<(), AppError> {
    if amount < 0 {
        return Err(AppError::BadRequest(format!("{label} cannot be negative")));
    }
    Ok(())
}

fn available_balance(balance: i64, reserved_balance: i64) -> Result<i64, AppError> {
    if reserved_balance < 0 || reserved_balance > balance {
        return Err(AppError::Internal(
            "Credit account balance invariant is invalid".to_string(),
        ));
    }
    Ok(balance - reserved_balance)
}

fn capture_settlement(
    balance: i64,
    reserved_balance: i64,
    estimated_credits: i64,
    actual_credits: i64,
) -> Result<(i64, i64, i64), AppError> {
    validate_non_negative_amount(actual_credits, "Captured credits")?;
    if actual_credits > estimated_credits {
        return Err(AppError::Conflict(
            "Captured credits cannot exceed the reservation".to_string(),
        ));
    }
    if reserved_balance < estimated_credits {
        return Err(AppError::Internal(
            "Credit reservation exceeds the reserved account balance".to_string(),
        ));
    }
    if balance < actual_credits {
        return Err(AppError::Internal(
            "Credit account balance cannot cover the captured credits".to_string(),
        ));
    }
    Ok((
        balance - actual_credits,
        reserved_balance - estimated_credits,
        estimated_credits - actual_credits,
    ))
}

fn release_settlement(
    balance: i64,
    reserved_balance: i64,
    estimated_credits: i64,
) -> Result<(i64, i64), AppError> {
    if reserved_balance < estimated_credits {
        return Err(AppError::Internal(
            "Credit reservation exceeds the reserved account balance".to_string(),
        ));
    }
    available_balance(balance, reserved_balance)?;
    Ok((balance, reserved_balance - estimated_credits))
}

fn validate_source(source: &str) -> Result<String, AppError> {
    let source = source.trim().to_uppercase();
    if !ADMIN_SOURCES.contains(&source.as_str()) {
        return Err(AppError::BadRequest(
            "Admin credit source must be MANUAL, PROMOTIONAL, or COMPENSATION".to_string(),
        ));
    }
    Ok(source)
}

fn validate_system_source(source: &str) -> Result<String, AppError> {
    let source = source.trim().to_uppercase();
    if !SYSTEM_SOURCES.contains(&source.as_str()) {
        return Err(AppError::BadRequest(
            "System credit source must be PLAN, TRIAL, REFERRAL, PURCHASE, MIGRATION, or EARLY_ACCESS"
                .to_string(),
        ));
    }
    Ok(source)
}

fn validate_expiry(ends_at: Option<DateTime<Utc>>) -> Result<(), AppError> {
    if ends_at.is_some_and(|value| value <= Utc::now()) {
        return Err(AppError::BadRequest(
            "Credit expiry must be in the future".to_string(),
        ));
    }
    Ok(())
}

async fn ensure_account(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
) -> Result<AccountRow, AppError> {
    let account_id = cuid2::create_id();
    sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO "CreditAccount" (id, "orgId", balance, "reservedBalance", "createdAt", "updatedAt")
        VALUES ($1, $2, 0, 0, NOW(), NOW())
        ON CONFLICT ("orgId") DO UPDATE SET "updatedAt" = NOW()
        RETURNING id
        "#,
    )
    .bind(account_id)
    .bind(org_id)
    .fetch_one(&mut **tx)
    .await?;

    sqlx::query_as::<_, AccountRow>(
        r#"
        SELECT id, balance, "reservedBalance" AS reserved_balance
        FROM "CreditAccount"
        WHERE "orgId" = $1
        FOR UPDATE
        "#,
    )
    .bind(org_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Organization credit account not found".to_string()))
}

async fn read_account_balances(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
) -> Result<(i64, i64), AppError> {
    sqlx::query_as::<_, (i64, i64)>(
        r#"
        SELECT balance, "reservedBalance"
        FROM "CreditAccount"
        WHERE "orgId" = $1
        "#,
    )
    .bind(org_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Organization credit account not found".to_string()))
}

/// Remove expired, unreserved credit lots from the account total.
///
/// Reservations protect the account-level balance while an operation is in
/// flight. If an expired lot is needed to cover that protected amount, it is
/// left until settlement; this prevents expiry from breaking an operation that
/// was legitimately reserved before the grant ended.
pub async fn expire_credit_grants(pool: &PgPool, org_id: &str) -> Result<(), AppError> {
    let org_id = required_text(org_id, "Organization id", 160)?;
    let mut tx = pool.begin().await?;
    let account = ensure_account(&mut tx, &org_id).await?;
    let mut balance = account.balance;
    let reserved_balance = account.reserved_balance;
    let mut available = available_balance(balance, reserved_balance)?;
    if available == 0 {
        tx.commit().await?;
        return Ok(());
    }

    let grants = sqlx::query_as::<_, GrantBalanceRow>(
        r#"
        SELECT id, "remainingAmount" AS remaining_amount
        FROM "CreditGrant"
        WHERE "accountId" = $1
          AND "remainingAmount" > 0
          AND "startsAt" <= NOW()
          AND "endsAt" IS NOT NULL
          AND "endsAt" <= NOW()
        ORDER BY "endsAt", "startsAt", id
        FOR UPDATE
        "#,
    )
    .bind(&account.id)
    .fetch_all(&mut *tx)
    .await?;

    for grant in grants {
        if available == 0 {
            break;
        }
        let expired_amount = grant.remaining_amount.min(available);
        sqlx::query(
            r#"UPDATE "CreditGrant"
               SET "remainingAmount" = "remainingAmount" - $1, "updatedAt" = NOW()
               WHERE id = $2"#,
        )
        .bind(expired_amount)
        .bind(&grant.id)
        .execute(&mut *tx)
        .await?;
        balance -= expired_amount;
        available -= expired_amount;
        sqlx::query(
            r#"
            INSERT INTO "CreditLedgerEntry" (
                id, "accountId", "orgId", grantId, type, amount, "balanceAfter",
                "sourceType", "sourceId", metadata, "createdAt"
            )
            VALUES ($1, $2, $3, $4, 'EXPIRY', $5, $6, 'SYSTEM', $4, $7, NOW())
            "#,
        )
        .bind(cuid2::create_id())
        .bind(&account.id)
        .bind(&org_id)
        .bind(&grant.id)
        .bind(-expired_amount)
        .bind(balance)
        .bind(json!({ "reason": "credit_grant_expired" }))
        .execute(&mut *tx)
        .await?;
    }

    if balance != account.balance {
        sqlx::query(
            r#"UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2"#,
        )
        .bind(balance)
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn existing_operation(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    idempotency_key: &str,
) -> Result<Option<ExistingOperationRow>, AppError> {
    let operation = sqlx::query_as::<_, ExistingOperationRow>(
        r#"
        SELECT id, "orgId" AS org_id, "afterBalance" AS after_balance,
               "afterReservedBalance" AS after_reserved_balance,
               amount, "ledgerEntryId" AS ledger_entry_id
        FROM "CreditAdminOperation"
        WHERE "idempotencyKey" = $1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut **tx)
    .await?;
    if operation
        .as_ref()
        .is_some_and(|value| value.org_id != org_id)
    {
        return Err(AppError::Conflict(
            "Credit idempotency key belongs to another organization".to_string(),
        ));
    }
    Ok(operation)
}

async fn existing_ledger(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    idempotency_key: &str,
) -> Result<Option<ExistingLedgerRow>, AppError> {
    let entry = sqlx::query_as::<_, ExistingLedgerRow>(
        r#"
        SELECT id, "orgId" AS org_id, "balanceAfter" AS balance_after, amount,
               "sourceId" AS source_id, "grantId" AS grant_id, type AS entry_type
        FROM "CreditLedgerEntry"
        WHERE "idempotencyKey" = $1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut **tx)
    .await?;
    if entry.as_ref().is_some_and(|value| value.org_id != org_id) {
        return Err(AppError::Conflict(
            "Credit idempotency key belongs to another organization".to_string(),
        ));
    }
    Ok(entry)
}

async fn create_admin_operation(
    tx: &mut Transaction<'_, Postgres>,
    operation_id: &str,
    account_id: &str,
    org_id: &str,
    operation_type: &str,
    amount: i64,
    source: Option<&str>,
    reason: &str,
    reference: Option<&str>,
    actor_id: &str,
    before_balance: i64,
    after_balance: i64,
    before_reserved_balance: i64,
    after_reserved_balance: i64,
    ledger_entry_id: Option<&str>,
    idempotency_key: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "CreditAdminOperation" (
            id, "accountId", "orgId", "operationType", amount, source, reason, reference,
            "actorId", "beforeBalance", "afterBalance", "beforeReservedBalance", "afterReservedBalance",
            "ledgerEntryId", "idempotencyKey",
            status, "createdAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'COMPLETED', NOW())
        "#,
    )
    .bind(operation_id)
    .bind(account_id)
    .bind(org_id)
    .bind(operation_type)
    .bind(amount)
    .bind(source)
    .bind(reason)
    .bind(reference)
    .bind(actor_id)
    .bind(before_balance)
    .bind(after_balance)
    .bind(before_reserved_balance)
    .bind(after_reserved_balance)
    .bind(ledger_entry_id)
    .bind(idempotency_key)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn get_credit_account(
    pool: &PgPool,
    org_id: &str,
) -> Result<CreditAccountView, AppError> {
    expire_credit_grants(pool, org_id).await?;
    let balance = sqlx::query_as::<_, CreditBalance>(
        r#"
        SELECT "orgId" AS org_id,
               balance,
               "reservedBalance" AS reserved_balance,
               (balance - "reservedBalance") AS available_balance
        FROM "CreditAccount"
        WHERE "orgId" = $1
        "#,
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .unwrap_or(CreditBalance {
        org_id: org_id.to_string(),
        balance: 0,
        reserved_balance: 0,
        available_balance: 0,
    });

    let grants = sqlx::query_as::<_, CreditGrant>(
        r#"
        SELECT id, source, amount, "remainingAmount" AS remaining_amount,
               "startsAt" AT TIME ZONE 'UTC' AS starts_at,
               "endsAt" AT TIME ZONE 'UTC' AS ends_at,
               reason, reference
        FROM "CreditGrant"
        WHERE "orgId" = $1 AND "remainingAmount" > 0
        ORDER BY ("endsAt" IS NULL), "endsAt", "startsAt", id
        LIMIT 100
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    let ledger = sqlx::query_as::<_, CreditLedgerEntry>(
        r#"
        SELECT id, type AS entry_type, amount, "balanceAfter" AS balance_after,
               "actionKey" AS action_key, "sourceType" AS source_type,
               "sourceId" AS source_id, "pricingVersion" AS pricing_version,
               "createdByAdminId" AS created_by_admin_id,
               "createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "CreditLedgerEntry"
        WHERE "orgId" = $1
        ORDER BY "createdAt" DESC, id DESC
        LIMIT 100
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    Ok(CreditAccountView {
        org_id: balance.org_id,
        balance: balance.balance,
        reserved_balance: balance.reserved_balance,
        available_balance: balance.available_balance,
        grants,
        ledger,
    })
}

pub async fn get_credit_usage(
    pool: &PgPool,
    org_id: &str,
    limit: i64,
) -> Result<Vec<CreditUsageEventView>, AppError> {
    let limit = limit.clamp(1, 100);
    sqlx::query_as::<_, CreditUsageEventView>(
        r#"
        SELECT id, "actionKey" AS action_key, quantity, "creditsCharged" AS credits_charged,
               status, provider, model, "fundingSource" AS funding_source,
               "inputTokens" AS input_tokens, "outputTokens" AS output_tokens,
               "pricingVersion" AS pricing_version,
               "createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "CreditUsageEvent"
        WHERE "orgId" = $1
        ORDER BY "createdAt" DESC, id DESC
        LIMIT $2
        "#,
    )
    .bind(org_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn search_credit_organizations(
    pool: &PgPool,
    query: Option<&str>,
    limit: i64,
) -> Result<Vec<CreditOrganization>, AppError> {
    let query = query.unwrap_or_default().trim().to_string();
    let limit = limit.clamp(1, 50);
    sqlx::query_as::<_, CreditOrganization>(
        r#"
        SELECT organization.id,
               organization.name,
               organization.slug,
               owner.email AS owner_email,
               COALESCE(account.balance - account."reservedBalance", 0)::bigint AS balance,
               COALESCE(account."reservedBalance", 0)::bigint AS reserved_balance
        FROM "Organization" organization
        INNER JOIN "User" owner ON owner.id = organization."ownerId"
        LEFT JOIN "CreditAccount" account ON account."orgId" = organization.id
        WHERE $1 = ''
           OR organization.id ILIKE '%' || $1 || '%'
           OR organization.name ILIKE '%' || $1 || '%'
           OR organization.slug ILIKE '%' || $1 || '%'
           OR COALESCE(owner.email, '') ILIKE '%' || $1 || '%'
        ORDER BY organization."createdAt" DESC
        LIMIT $2
        "#,
    )
    .bind(query)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn grant_credits(
    pool: &PgPool,
    org_id: &str,
    amount: i64,
    source: &str,
    ends_at: Option<DateTime<Utc>>,
    reason: &str,
    reference: Option<&str>,
    actor_id: &str,
    idempotency_key: &str,
) -> Result<CreditMutationResult, AppError> {
    validate_amount(amount)?;
    let source = validate_source(source)?;
    let reason = required_text(reason, "Reason", 2_000)?;
    let idempotency_key = required_text(idempotency_key, "Idempotency key", 240)?;
    validate_expiry(ends_at)?;
    let reference = reference
        .map(|value| required_text(value, "Reference", 240))
        .transpose()?;
    let org_id = required_text(org_id, "Organization id", 160)?;
    let actor_id = required_text(actor_id, "Admin id", 160)?;

    expire_credit_grants(pool, &org_id).await?;
    let mut tx = pool.begin().await?;
    if let Some(existing) = existing_operation(&mut tx, &org_id, &idempotency_key).await? {
        return Ok(CreditMutationResult {
            org_id,
            operation_id: existing.id,
            ledger_entry_id: existing.ledger_entry_id,
            grant_id: None,
            balance: existing.after_balance,
            reserved_balance: existing.after_reserved_balance,
            available_balance: available_balance(
                existing.after_balance,
                existing.after_reserved_balance,
            )?,
            amount: existing.amount.unwrap_or(amount),
            idempotent: true,
        });
    }
    if let Some(existing) = existing_ledger(&mut tx, &org_id, &idempotency_key).await? {
        let (_, reserved_balance) = read_account_balances(&mut tx, &org_id).await?;
        return Ok(CreditMutationResult {
            org_id,
            operation_id: String::new(),
            ledger_entry_id: Some(existing.id),
            grant_id: None,
            balance: existing.balance_after,
            reserved_balance,
            available_balance: available_balance(existing.balance_after, reserved_balance)?,
            amount: existing.amount,
            idempotent: true,
        });
    }

    let account = ensure_account(&mut tx, &org_id).await?;
    let before_balance = account.balance;
    let reserved_balance = account.reserved_balance;
    let after_balance = before_balance.checked_add(amount).ok_or_else(|| {
        AppError::Conflict("Credit balance exceeds the supported maximum".to_string())
    })?;
    let grant_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditGrant" (
            id, "accountId", "orgId", source, amount, "remainingAmount", "startsAt", "endsAt",
            reason, reference, "createdByAdminId", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $5, NOW(), $6, $7, $8, $9, NOW(), NOW())
        "#,
    )
    .bind(&grant_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(&source)
    .bind(amount)
    .bind(ends_at)
    .bind(&reason)
    .bind(reference.as_deref())
    .bind(&actor_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(r#"UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(after_balance)
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;

    let ledger_entry_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditLedgerEntry" (
            id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",
            "sourceType", "sourceId", "idempotencyKey", "createdByAdminId", "createdAt"
        )
        VALUES ($1, $2, $3, $4, 'GRANT', $5, $6, 'ADMIN', $7, $8, $9, NOW())
        "#,
    )
    .bind(&ledger_entry_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(&grant_id)
    .bind(amount)
    .bind(after_balance)
    .bind(&grant_id)
    .bind(&idempotency_key)
    .bind(&actor_id)
    .execute(&mut *tx)
    .await?;

    let operation_id = cuid2::create_id();
    create_admin_operation(
        &mut tx,
        &operation_id,
        &account.id,
        &org_id,
        "GRANT",
        amount,
        Some(&source),
        &reason,
        reference.as_deref(),
        &actor_id,
        before_balance,
        after_balance,
        reserved_balance,
        reserved_balance,
        Some(&ledger_entry_id),
        &idempotency_key,
    )
    .await?;
    tx.commit().await?;

    Ok(CreditMutationResult {
        org_id,
        operation_id,
        ledger_entry_id: Some(ledger_entry_id),
        grant_id: Some(grant_id),
        balance: after_balance,
        reserved_balance,
        available_balance: available_balance(after_balance, reserved_balance)?,
        amount,
        idempotent: false,
    })
}

/// Issue a non-admin grant from an authoritative product or lifecycle event.
///
/// This deliberately does not create a `CreditAdminOperation`: system grants
/// are audited by their source, reference, metadata, and idempotency key. The
/// account and ledger are still updated in one transaction.
pub async fn grant_system_credits(
    pool: &PgPool,
    org_id: &str,
    amount: i64,
    source: &str,
    ends_at: Option<DateTime<Utc>>,
    reason: &str,
    reference: Option<&str>,
    metadata: Option<&serde_json::Value>,
    idempotency_key: &str,
) -> Result<CreditMutationResult, AppError> {
    validate_amount(amount)?;
    let source = validate_system_source(source)?;
    let reason = required_text(reason, "Reason", 2_000)?;
    let idempotency_key = required_text(idempotency_key, "Idempotency key", 240)?;
    validate_expiry(ends_at)?;
    let reference = reference
        .map(|value| required_text(value, "Reference", 240))
        .transpose()?;
    let org_id = required_text(org_id, "Organization id", 160)?;

    expire_credit_grants(pool, &org_id).await?;
    let mut tx = pool.begin().await?;
    if let Some(existing) = existing_ledger(&mut tx, &org_id, &idempotency_key).await? {
        let (_, reserved_balance) = read_account_balances(&mut tx, &org_id).await?;
        return Ok(CreditMutationResult {
            org_id,
            operation_id: existing.id.clone(),
            ledger_entry_id: Some(existing.id),
            grant_id: existing.grant_id,
            balance: existing.balance_after,
            reserved_balance,
            available_balance: available_balance(existing.balance_after, reserved_balance)?,
            amount: existing.amount,
            idempotent: true,
        });
    }

    let account = ensure_account(&mut tx, &org_id).await?;
    let before_balance = account.balance;
    let reserved_balance = account.reserved_balance;
    let after_balance = before_balance.checked_add(amount).ok_or_else(|| {
        AppError::Conflict("Credit balance exceeds the supported maximum".to_string())
    })?;
    let grant_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditGrant" (
            id, "accountId", "orgId", source, amount, "remainingAmount", "startsAt", "endsAt",
            reason, reference, metadata, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $5, NOW(), $6, $7, $8, $9, NOW(), NOW())
        "#,
    )
    .bind(&grant_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(&source)
    .bind(amount)
    .bind(ends_at)
    .bind(&reason)
    .bind(reference.as_deref())
    .bind(metadata)
    .execute(&mut *tx)
    .await?;

    sqlx::query(r#"UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(after_balance)
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;

    let ledger_entry_id = cuid2::create_id();
    let source_id = reference.as_deref().unwrap_or(&grant_id);
    sqlx::query(
        r#"
        INSERT INTO "CreditLedgerEntry" (
            id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",
            "sourceType", "sourceId", "idempotencyKey", metadata, "createdAt"
        )
        VALUES ($1, $2, $3, $4, 'GRANT', $5, $6, 'SYSTEM', $7, $8, $9, NOW())
        "#,
    )
    .bind(&ledger_entry_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(&grant_id)
    .bind(amount)
    .bind(after_balance)
    .bind(source_id)
    .bind(&idempotency_key)
    .bind(metadata)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(CreditMutationResult {
        org_id,
        operation_id: ledger_entry_id.clone(),
        ledger_entry_id: Some(ledger_entry_id),
        grant_id: Some(grant_id),
        balance: after_balance,
        reserved_balance,
        available_balance: available_balance(after_balance, reserved_balance)?,
        amount,
        idempotent: false,
    })
}

/// Revoke only the unused portion of a system grant.
///
/// Credit history remains append-only: the grant lot is reduced and a
/// compensating `REVOKE` ledger entry records the amount removed. Reserved or
/// already-consumed credits are left in place for support review rather than
/// forcing an account below its available balance.
pub async fn revoke_unspent_system_grant(
    pool: &PgPool,
    org_id: &str,
    grant_id: &str,
    reason: &str,
    idempotency_key: &str,
) -> Result<CreditRevocationResult, AppError> {
    let org_id = required_text(org_id, "Organization id", 160)?;
    let grant_id = required_text(grant_id, "Credit grant id", 160)?;
    let reason = required_text(reason, "Revocation reason", 2_000)?;
    let idempotency_key = required_text(idempotency_key, "Idempotency key", 240)?;

    expire_credit_grants(pool, &org_id).await?;
    let mut tx = pool.begin().await?;
    if let Some(existing) = existing_ledger(&mut tx, &org_id, &idempotency_key).await? {
        if existing.entry_type != "REVOKE" || existing.source_id.as_deref() != Some(&grant_id) {
            return Err(AppError::Conflict(
                "Credit idempotency key is already used by another operation".to_string(),
            ));
        }
        let remaining_amount = sqlx::query_scalar::<_, i64>(
            r#"SELECT "remainingAmount" FROM "CreditGrant" WHERE id = $1 AND "orgId" = $2"#,
        )
        .bind(&grant_id)
        .bind(&org_id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(0);
        tx.commit().await?;
        return Ok(CreditRevocationResult {
            revoked_amount: existing.amount.saturating_abs(),
            remaining_amount,
            idempotent: true,
        });
    }

    let account = ensure_account(&mut tx, &org_id).await?;
    let grant = sqlx::query_as::<_, (String, i64)>(
        r#"
        SELECT id, "remainingAmount"
        FROM "CreditGrant"
        WHERE id = $1 AND "orgId" = $2 AND "accountId" = $3
        FOR UPDATE
        "#,
    )
    .bind(&grant_id)
    .bind(&org_id)
    .bind(&account.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Credit grant not found".to_string()))?;

    let available = available_balance(account.balance, account.reserved_balance)?;
    let revoked_amount = grant.1.min(available);
    let remaining_amount = grant.1 - revoked_amount;
    let balance_after = account.balance - revoked_amount;

    sqlx::query(
        r#"UPDATE "CreditGrant"
           SET "remainingAmount" = $1, "updatedAt" = NOW()
           WHERE id = $2"#,
    )
    .bind(remaining_amount)
    .bind(&grant_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(r#"UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(balance_after)
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO "CreditLedgerEntry" (
            id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",
            "sourceType", "sourceId", "idempotencyKey", metadata, "createdAt"
        )
        VALUES ($1, $2, $3, $4, 'REVOKE', $5, $6, 'SYSTEM', $4, $7, $8, NOW())
        "#,
    )
    .bind(cuid2::create_id())
    .bind(&account.id)
    .bind(&org_id)
    .bind(&grant_id)
    .bind(-revoked_amount)
    .bind(balance_after)
    .bind(&idempotency_key)
    .bind(json!({
        "reason": reason,
        "revokedAmount": revoked_amount,
        "remainingAmount": remaining_amount,
    }))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(CreditRevocationResult {
        revoked_amount,
        remaining_amount,
        idempotent: false,
    })
}

pub async fn set_credit_balance(
    pool: &PgPool,
    org_id: &str,
    target_balance: i64,
    reason: &str,
    reference: Option<&str>,
    actor_id: &str,
    idempotency_key: &str,
) -> Result<CreditMutationResult, AppError> {
    if target_balance < 0 {
        return Err(AppError::BadRequest(
            "Target credit balance cannot be negative".to_string(),
        ));
    }
    let reason = required_text(reason, "Reason", 2_000)?;
    let idempotency_key = required_text(idempotency_key, "Idempotency key", 240)?;
    let reference = reference
        .map(|value| required_text(value, "Reference", 240))
        .transpose()?;
    let org_id = required_text(org_id, "Organization id", 160)?;
    let actor_id = required_text(actor_id, "Admin id", 160)?;

    expire_credit_grants(pool, &org_id).await?;
    let mut tx = pool.begin().await?;
    if let Some(existing) = existing_operation(&mut tx, &org_id, &idempotency_key).await? {
        return Ok(CreditMutationResult {
            org_id,
            operation_id: existing.id,
            ledger_entry_id: existing.ledger_entry_id,
            grant_id: None,
            balance: existing.after_balance,
            reserved_balance: existing.after_reserved_balance,
            available_balance: available_balance(
                existing.after_balance,
                existing.after_reserved_balance,
            )?,
            amount: existing.amount.unwrap_or(0),
            idempotent: true,
        });
    }

    let account = ensure_account(&mut tx, &org_id).await?;
    let before_balance = account.balance;
    let reserved_balance = account.reserved_balance;
    if target_balance < reserved_balance {
        return Err(AppError::Conflict(
            "Target credit balance cannot be below credits held by active reservations".to_string(),
        ));
    }
    let delta = target_balance.checked_sub(before_balance).ok_or_else(|| {
        AppError::Conflict("Credit adjustment exceeds the supported range".to_string())
    })?;
    let operation_id = cuid2::create_id();
    let mut grant_id = None;

    if delta > 0 {
        let new_grant_id = cuid2::create_id();
        sqlx::query(
            r#"
            INSERT INTO "CreditGrant" (
                id, "accountId", "orgId", source, amount, "remainingAmount", "startsAt",
                reason, reference, "createdByAdminId", "createdAt", "updatedAt"
            )
            VALUES ($1, $2, $3, 'COMPENSATION', $4, $4, NOW(), $5, $6, $7, NOW(), NOW())
            "#,
        )
        .bind(&new_grant_id)
        .bind(&account.id)
        .bind(&org_id)
        .bind(delta)
        .bind(&reason)
        .bind(reference.as_deref())
        .bind(&actor_id)
        .execute(&mut *tx)
        .await?;
        grant_id = Some(new_grant_id);
    } else if delta < 0 {
        let mut remaining_to_remove = delta.unsigned_abs() as i64;
        let grants = sqlx::query_as::<_, GrantBalanceRow>(
            r#"
            SELECT id, "remainingAmount" AS remaining_amount
            FROM "CreditGrant"
            WHERE "accountId" = $1
              AND "remainingAmount" > 0
              AND "startsAt" <= NOW()
              AND ("endsAt" IS NULL OR "endsAt" > NOW())
            ORDER BY ("endsAt" IS NULL), "endsAt", "startsAt", id
            FOR UPDATE
            "#,
        )
        .bind(&account.id)
        .fetch_all(&mut *tx)
        .await?;
        for grant in grants {
            if remaining_to_remove == 0 {
                break;
            }
            let amount = grant.remaining_amount.min(remaining_to_remove);
            sqlx::query(
                r#"UPDATE "CreditGrant" SET "remainingAmount" = "remainingAmount" - $1, "updatedAt" = NOW() WHERE id = $2"#,
            )
            .bind(amount)
            .bind(&grant.id)
            .execute(&mut *tx)
            .await?;
            remaining_to_remove -= amount;
        }
        if remaining_to_remove > 0 {
            return Err(AppError::Conflict(
                "Active credit grants cannot cover the requested balance reset".to_string(),
            ));
        }
    }

    sqlx::query(r#"UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(target_balance)
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;

    let ledger_entry_id = if delta == 0 {
        None
    } else {
        let ledger_entry_id = cuid2::create_id();
        sqlx::query(
            r#"
            INSERT INTO "CreditLedgerEntry" (
                id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",
                "sourceType", "sourceId", "idempotencyKey", "createdByAdminId", "createdAt"
            )
            VALUES ($1, $2, $3, $4, 'ADJUSTMENT', $5, $6, 'ADMIN', $7, $8, $9, NOW())
            "#,
        )
        .bind(&ledger_entry_id)
        .bind(&account.id)
        .bind(&org_id)
        .bind(grant_id.as_deref())
        .bind(delta)
        .bind(target_balance)
        .bind(&operation_id)
        .bind(&idempotency_key)
        .bind(&actor_id)
        .execute(&mut *tx)
        .await?;
        Some(ledger_entry_id)
    };

    create_admin_operation(
        &mut tx,
        &operation_id,
        &account.id,
        &org_id,
        "SET_BALANCE",
        delta,
        Some("COMPENSATION"),
        &reason,
        reference.as_deref(),
        &actor_id,
        before_balance,
        target_balance,
        reserved_balance,
        reserved_balance,
        ledger_entry_id.as_deref(),
        &idempotency_key,
    )
    .await?;
    tx.commit().await?;

    Ok(CreditMutationResult {
        org_id,
        operation_id,
        ledger_entry_id,
        grant_id,
        balance: target_balance,
        reserved_balance,
        available_balance: available_balance(target_balance, reserved_balance)?,
        amount: delta,
        idempotent: false,
    })
}

fn reservation_view(reservation: &ReservationRow) -> CreditReservationView {
    CreditReservationView {
        id: reservation.id.clone(),
        org_id: reservation.org_id.clone(),
        action_key: reservation.action_key.clone(),
        estimated_credits: reservation.estimated_credits,
        captured_credits: reservation.captured_credits,
        released_credits: reservation.released_credits,
        status: reservation.status.clone(),
        expires_at: reservation.expires_at,
        source_type: reservation.source_type.clone(),
        source_id: reservation.source_id.clone(),
        pricing_version: reservation.pricing_version.clone(),
    }
}

fn reservation_result(
    reservation: &ReservationRow,
    account: &AccountRow,
    amount: i64,
    idempotent: bool,
) -> Result<CreditReservationMutationResult, AppError> {
    Ok(CreditReservationMutationResult {
        org_id: reservation.org_id.clone(),
        reservation: reservation_view(reservation),
        balance: account.balance,
        reserved_balance: account.reserved_balance,
        available_balance: available_balance(account.balance, account.reserved_balance)?,
        amount,
        idempotent,
    })
}

async fn find_reservation_by_idempotency(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    idempotency_key: &str,
) -> Result<Option<ReservationRow>, AppError> {
    let reservation = sqlx::query_as::<_, ReservationRow>(
        r#"
        SELECT id, "accountId" AS account_id, "orgId" AS org_id, "actionKey" AS action_key,
               "estimatedCredits" AS estimated_credits, "capturedCredits" AS captured_credits,
               "releasedCredits" AS released_credits, status,
               "expiresAt" AT TIME ZONE 'UTC' AS expires_at,
               "sourceType" AS source_type, "sourceId" AS source_id,
               "pricingVersion" AS pricing_version
        FROM "CreditReservation"
        WHERE "idempotencyKey" = $1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut **tx)
    .await?;
    if reservation
        .as_ref()
        .is_some_and(|value| value.org_id != org_id)
    {
        return Err(AppError::Conflict(
            "Credit idempotency key belongs to another organization".to_string(),
        ));
    }
    Ok(reservation)
}

async fn lock_reservation(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    reservation_id: &str,
) -> Result<ReservationRow, AppError> {
    let reservation = sqlx::query_as::<_, ReservationRow>(
        r#"
        SELECT id, "accountId" AS account_id, "orgId" AS org_id, "actionKey" AS action_key,
               "estimatedCredits" AS estimated_credits, "capturedCredits" AS captured_credits,
               "releasedCredits" AS released_credits, status,
               "expiresAt" AT TIME ZONE 'UTC' AS expires_at,
               "sourceType" AS source_type, "sourceId" AS source_id,
               "pricingVersion" AS pricing_version
        FROM "CreditReservation"
        WHERE id = $1 AND "orgId" = $2
        FOR UPDATE
        "#,
    )
    .bind(reservation_id)
    .bind(org_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Credit reservation not found".to_string()))?;
    Ok(reservation)
}

async fn consume_credit_grants(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    amount: i64,
) -> Result<(), AppError> {
    if amount == 0 {
        return Ok(());
    }
    let grants = sqlx::query_as::<_, GrantBalanceRow>(
        r#"
        SELECT id, "remainingAmount" AS remaining_amount
        FROM "CreditGrant"
        WHERE "accountId" = $1
          AND "remainingAmount" > 0
        -- Captures may settle after the grant expiry. A reservation already
        -- held the account balance, so settlement must be allowed to consume
        -- the protected lot instead of failing at the provider callback.
        ORDER BY ("endsAt" IS NULL), "endsAt", "startsAt", id
        FOR UPDATE
        "#,
    )
    .bind(account_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut remaining_to_remove = amount;
    for grant in grants {
        if remaining_to_remove == 0 {
            break;
        }
        let amount = grant.remaining_amount.min(remaining_to_remove);
        sqlx::query(
            r#"UPDATE "CreditGrant" SET "remainingAmount" = "remainingAmount" - $1, "updatedAt" = NOW() WHERE id = $2"#,
        )
        .bind(amount)
        .bind(&grant.id)
        .execute(&mut **tx)
        .await?;
        remaining_to_remove -= amount;
    }
    if remaining_to_remove > 0 {
        return Err(AppError::Conflict(
            "Active credit grants cannot cover the captured credits".to_string(),
        ));
    }
    Ok(())
}

pub async fn reserve_credits(
    pool: &PgPool,
    org_id: &str,
    action_key: &str,
    estimated_credits: i64,
    source_type: Option<&str>,
    source_id: Option<&str>,
    pricing_version: Option<&str>,
    expires_at: Option<DateTime<Utc>>,
    idempotency_key: &str,
) -> Result<CreditReservationMutationResult, AppError> {
    validate_amount(estimated_credits)?;
    let org_id = required_text(org_id, "Organization id", 160)?;
    let action_key = required_text(action_key, "Action key", 240)?;
    let idempotency_key = required_text(idempotency_key, "Idempotency key", 240)?;
    validate_expiry(expires_at).map_err(|_| {
        AppError::BadRequest("Reservation expiry must be in the future".to_string())
    })?;
    let source_type = source_type
        .map(|value| required_text(value, "Source type", 80))
        .transpose()?;
    let source_id = source_id
        .map(|value| required_text(value, "Source id", 240))
        .transpose()?;
    let pricing_version = pricing_version
        .map(|value| required_text(value, "Pricing version", 80))
        .transpose()?;

    expire_credit_grants(pool, &org_id).await?;
    let mut tx = pool.begin().await?;
    if let Some(existing) =
        find_reservation_by_idempotency(&mut tx, &org_id, &idempotency_key).await?
    {
        if existing.action_key != action_key || existing.estimated_credits != estimated_credits {
            return Err(AppError::Conflict(
                "Credit idempotency key was reused with different reservation parameters"
                    .to_string(),
            ));
        }
        let account = ensure_account(&mut tx, &org_id).await?;
        let result = reservation_result(&existing, &account, existing.estimated_credits, true)?;
        tx.commit().await?;
        return Ok(result);
    }
    if existing_ledger(&mut tx, &org_id, &idempotency_key)
        .await?
        .is_some()
    {
        return Err(AppError::Conflict(
            "Credit idempotency key is already used by another operation".to_string(),
        ));
    }

    let account = ensure_account(&mut tx, &org_id).await?;
    let available = available_balance(account.balance, account.reserved_balance)?;
    if estimated_credits > available {
        return Err(AppError::Conflict(format!(
            "Insufficient credits: required {estimated_credits}, available {available}"
        )));
    }
    let reserved_after = account
        .reserved_balance
        .checked_add(estimated_credits)
        .ok_or_else(|| {
            AppError::Conflict("Reserved credits exceed the supported maximum".to_string())
        })?;
    let reservation_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditReservation" (
            id, "accountId", "orgId", "actionKey", "estimatedCredits", "sourceType", "sourceId",
            "pricingVersion", "idempotencyKey", "expiresAt", status, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'RESERVED', NOW(), NOW())
        "#,
    )
    .bind(&reservation_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(&action_key)
    .bind(estimated_credits)
    .bind(source_type.as_deref())
    .bind(source_id.as_deref())
    .bind(pricing_version.as_deref())
    .bind(&idempotency_key)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE "CreditAccount"
        SET "reservedBalance" = $1, "updatedAt" = NOW()
        WHERE id = $2
        "#,
    )
    .bind(reserved_after)
    .bind(&account.id)
    .execute(&mut *tx)
    .await?;

    let ledger_entry_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditLedgerEntry" (
            id, "accountId", "orgId", type, amount, "balanceAfter", "actionKey",
            "sourceType", "sourceId", "pricingVersion", "idempotencyKey", "createdAt"
        )
        VALUES ($1, $2, $3, 'RESERVE', 0, $4, $5, $6, $7, $8, $9, NOW())
        "#,
    )
    .bind(&ledger_entry_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(account.balance)
    .bind(&action_key)
    .bind(source_type.as_deref())
    .bind(&reservation_id)
    .bind(pricing_version.as_deref())
    .bind(&idempotency_key)
    .execute(&mut *tx)
    .await?;

    let reservation = ReservationRow {
        id: reservation_id,
        account_id: account.id.clone(),
        org_id: org_id.clone(),
        action_key,
        estimated_credits,
        captured_credits: 0,
        released_credits: 0,
        status: "RESERVED".to_string(),
        expires_at,
        source_type,
        source_id,
        pricing_version,
    };
    let account = AccountRow {
        id: account.id,
        balance: account.balance,
        reserved_balance: reserved_after,
    };
    let result = reservation_result(&reservation, &account, estimated_credits, false)?;
    tx.commit().await?;
    Ok(result)
}

pub async fn capture_credits(
    pool: &PgPool,
    org_id: &str,
    reservation_id: &str,
    actual_credits: i64,
    usage: CreditCaptureUsage,
    idempotency_key: &str,
) -> Result<CreditReservationMutationResult, AppError> {
    validate_non_negative_amount(actual_credits, "Captured credits")?;
    if usage.input_tokens.is_some_and(|value| value < 0)
        || usage.output_tokens.is_some_and(|value| value < 0)
    {
        return Err(AppError::BadRequest(
            "Model token usage cannot be negative".to_string(),
        ));
    }
    for (value, field, max_len) in [
        (usage.provider.as_deref(), "Provider", 80),
        (usage.model.as_deref(), "Model", 240),
        (usage.funding_source.as_deref(), "Funding source", 40),
    ] {
        if let Some(value) = value {
            required_text(value, field, max_len)?;
        }
    }
    if usage.provider_cost_usd.as_deref().is_some_and(|value| {
        value
            .parse::<f64>()
            .map_or(true, |parsed| !parsed.is_finite() || parsed < 0.0)
    }) {
        return Err(AppError::BadRequest(
            "Provider cost must be a finite non-negative number".to_string(),
        ));
    }
    let org_id = required_text(org_id, "Organization id", 160)?;
    let reservation_id = required_text(reservation_id, "Reservation id", 160)?;
    let idempotency_key = required_text(idempotency_key, "Idempotency key", 240)?;

    let mut tx = pool.begin().await?;
    let reservation = lock_reservation(&mut tx, &org_id, &reservation_id).await?;
    if let Some(existing) = existing_ledger(&mut tx, &org_id, &idempotency_key).await? {
        if existing.entry_type != "DEBIT"
            || existing.source_id.as_deref() != Some(reservation_id.as_str())
            || existing.amount != -actual_credits
        {
            return Err(AppError::Conflict(
                "Credit idempotency key is already used by another operation".to_string(),
            ));
        }
        let account = ensure_account(&mut tx, &org_id).await?;
        let result = reservation_result(&reservation, &account, actual_credits, true)?;
        tx.commit().await?;
        return Ok(result);
    }
    if reservation.status != "RESERVED" {
        return Err(AppError::Conflict(format!(
            "Credit reservation is already {}",
            reservation.status.to_lowercase()
        )));
    }
    if reservation
        .expires_at
        .is_some_and(|value| value <= Utc::now())
    {
        return Err(AppError::Conflict(
            "Credit reservation has expired".to_string(),
        ));
    }

    let account = ensure_account(&mut tx, &org_id).await?;
    if reservation.account_id != account.id {
        return Err(AppError::Internal(
            "Credit reservation account does not match its organization".to_string(),
        ));
    }
    let (balance_after, reserved_after, released_credits) = capture_settlement(
        account.balance,
        account.reserved_balance,
        reservation.estimated_credits,
        actual_credits,
    )?;
    consume_credit_grants(&mut tx, &account.id, actual_credits).await?;
    sqlx::query(
        r#"
        UPDATE "CreditAccount"
        SET balance = $1, "reservedBalance" = $2, "updatedAt" = NOW()
        WHERE id = $3
        "#,
    )
    .bind(balance_after)
    .bind(reserved_after)
    .bind(&account.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE "CreditReservation"
        SET "capturedCredits" = $1, "releasedCredits" = $2, status = 'CAPTURED', "updatedAt" = NOW()
        WHERE id = $3
        "#,
    )
    .bind(actual_credits)
    .bind(released_credits)
    .bind(&reservation_id)
    .execute(&mut *tx)
    .await?;

    let ledger_entry_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditLedgerEntry" (
            id, "accountId", "orgId", type, amount, "balanceAfter", "actionKey",
            "sourceType", "sourceId", "pricingVersion", "idempotencyKey", "createdAt"
        )
        VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6, 'RESERVATION', $7, $8, $9, NOW())
        "#,
    )
    .bind(&ledger_entry_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(-actual_credits)
    .bind(balance_after)
    .bind(&reservation.action_key)
    .bind(&reservation_id)
    .bind(reservation.pricing_version.as_deref())
    .bind(&idempotency_key)
    .execute(&mut *tx)
    .await?;

    let usage_event_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditUsageEvent" (
            id, "accountId", "orgId", "ledgerEntryId", "actionKey", quantity, "creditsCharged",
            status, provider, model, "fundingSource", "inputTokens", "outputTokens", "providerCostUsd",
            "pricingVersion", "idempotencyKey", metadata, "createdAt"
        )
        VALUES ($1, $2, $3, $4, $5, 1, $6, 'COMPLETED', $7, $8, $9, $10, $11, $12::numeric, $13, $14, $15, NOW())
        "#,
    )
    .bind(&usage_event_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(&ledger_entry_id)
    .bind(&reservation.action_key)
    .bind(actual_credits)
    .bind(usage.provider.as_deref())
    .bind(usage.model.as_deref())
    .bind(usage.funding_source.as_deref())
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.provider_cost_usd.as_deref())
    .bind(reservation.pricing_version.as_deref())
    .bind(&idempotency_key)
    .bind(usage.metadata)
    .execute(&mut *tx)
    .await?;

    let reservation = ReservationRow {
        captured_credits: actual_credits,
        released_credits,
        status: "CAPTURED".to_string(),
        ..reservation
    };
    let account = AccountRow {
        id: account.id,
        balance: balance_after,
        reserved_balance: reserved_after,
    };
    let result = reservation_result(&reservation, &account, actual_credits, false)?;
    tx.commit().await?;
    Ok(result)
}

pub async fn release_credits(
    pool: &PgPool,
    org_id: &str,
    reservation_id: &str,
    reason: &str,
    idempotency_key: &str,
) -> Result<CreditReservationMutationResult, AppError> {
    let org_id = required_text(org_id, "Organization id", 160)?;
    let reservation_id = required_text(reservation_id, "Reservation id", 160)?;
    let reason = required_text(reason, "Release reason", 2_000)?;
    let idempotency_key = required_text(idempotency_key, "Idempotency key", 240)?;

    let mut tx = pool.begin().await?;
    let reservation = lock_reservation(&mut tx, &org_id, &reservation_id).await?;
    if let Some(existing) = existing_ledger(&mut tx, &org_id, &idempotency_key).await? {
        if existing.entry_type != "RELEASE"
            || existing.source_id.as_deref() != Some(reservation_id.as_str())
        {
            return Err(AppError::Conflict(
                "Credit idempotency key is already used by another operation".to_string(),
            ));
        }
        let account = ensure_account(&mut tx, &org_id).await?;
        let result = reservation_result(&reservation, &account, 0, true)?;
        tx.commit().await?;
        return Ok(result);
    }
    if reservation.status != "RESERVED" {
        return Err(AppError::Conflict(format!(
            "Credit reservation is already {}",
            reservation.status.to_lowercase()
        )));
    }

    let account = ensure_account(&mut tx, &org_id).await?;
    if reservation.account_id != account.id {
        return Err(AppError::Internal(
            "Credit reservation account does not match its organization".to_string(),
        ));
    }
    let (balance_after, reserved_after) = release_settlement(
        account.balance,
        account.reserved_balance,
        reservation.estimated_credits,
    )?;
    let status = if reservation
        .expires_at
        .is_some_and(|value| value <= Utc::now())
    {
        "EXPIRED"
    } else {
        "RELEASED"
    };
    sqlx::query(
        r#"
        UPDATE "CreditAccount"
        SET "reservedBalance" = $1, "updatedAt" = NOW()
        WHERE id = $2
        "#,
    )
    .bind(reserved_after)
    .bind(&account.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE "CreditReservation"
        SET "releasedCredits" = "estimatedCredits", status = $1, "updatedAt" = NOW()
        WHERE id = $2
        "#,
    )
    .bind(status)
    .bind(&reservation_id)
    .execute(&mut *tx)
    .await?;

    let ledger_entry_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "CreditLedgerEntry" (
            id, "accountId", "orgId", type, amount, "balanceAfter", "actionKey",
            "sourceType", "sourceId", "pricingVersion", "idempotencyKey", metadata, "createdAt"
        )
        VALUES ($1, $2, $3, 'RELEASE', 0, $4, $5, 'RESERVATION', $6, $7, $8, $9, NOW())
        "#,
    )
    .bind(&ledger_entry_id)
    .bind(&account.id)
    .bind(&org_id)
    .bind(balance_after)
    .bind(&reservation.action_key)
    .bind(&reservation_id)
    .bind(reservation.pricing_version.as_deref())
    .bind(&idempotency_key)
    .bind(json!({ "reason": reason }))
    .execute(&mut *tx)
    .await?;

    let reservation = ReservationRow {
        released_credits: reservation.estimated_credits,
        status: status.to_string(),
        ..reservation
    };
    let account = AccountRow {
        id: account.id,
        balance: balance_after,
        reserved_balance: reserved_after,
    };
    let result = reservation_result(&reservation, &account, 0, false)?;
    tx.commit().await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        available_balance, capture_settlement, release_settlement, validate_amount,
        validate_source, validate_system_source,
    };

    #[test]
    fn admin_sources_are_explicit() {
        assert!(validate_source("manual").is_ok());
        assert!(validate_source("trial").is_err());
        assert!(validate_source("purchase").is_err());
    }

    #[test]
    fn system_sources_are_separate_from_admin_sources() {
        assert!(validate_system_source("trial").is_ok());
        assert!(validate_system_source("plan").is_ok());
        assert!(validate_system_source("referral").is_ok());
        assert!(validate_system_source("manual").is_err());
        assert!(validate_system_source("unknown").is_err());
    }

    #[test]
    fn credit_amount_must_be_positive() {
        assert!(validate_amount(1).is_ok());
        assert!(validate_amount(0).is_err());
        assert!(validate_amount(-1).is_err());
    }

    #[test]
    fn reserved_credits_reduce_available_balance_without_reducing_total() {
        assert_eq!(available_balance(100, 30).unwrap(), 70);
        assert!(available_balance(10, 11).is_err());
    }

    #[test]
    fn capture_releases_unused_estimate_and_debits_actual_usage() {
        assert_eq!(capture_settlement(100, 40, 40, 25).unwrap(), (75, 0, 15));
        assert!(capture_settlement(100, 20, 40, 10).is_err());
        assert!(capture_settlement(10, 10, 10, 11).is_err());
    }

    #[test]
    fn release_returns_the_full_estimate_to_available_balance() {
        assert_eq!(release_settlement(100, 40, 40).unwrap(), (100, 0));
        assert!(release_settlement(10, 5, 6).is_err());
    }
}
