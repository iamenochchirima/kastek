use sqlx::PgPool;

use crate::error::AppError;

pub fn whatsapp_identity_key(phone: &str) -> String {
    format!("whatsapp:{}", phone.trim())
}

pub fn meta_identity_key(channel: &str, scope_id: &str, external_id: &str) -> String {
    format!(
        "{}:{}:{}",
        channel.trim().to_ascii_lowercase(),
        scope_id.trim(),
        external_id.trim()
    )
}

async fn organization_customer(
    pool: &PgPool,
    org_id: &str,
    customer_id: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "Customer" WHERE id = $1 AND "orgId" = $2 LIMIT 1"#,
    )
    .bind(customer_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn ensure_customer_identity(
    pool: &PgPool,
    org_id: &str,
    channel: &str,
    scope_id: Option<&str>,
    external_id: &str,
    identity_key: &str,
    display_name: Option<&str>,
    preferred_customer_id: Option<&str>,
) -> Result<String, AppError> {
    let display_name = display_name
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(customer_id) = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE "CustomerIdentity"
        SET "displayName" = COALESCE("displayName", $1), "updatedAt" = NOW()
        WHERE "orgId" = $2 AND "identityKey" = $3
        RETURNING "customerId"
        "#,
    )
    .bind(display_name)
    .bind(org_id)
    .bind(identity_key)
    .fetch_optional(pool)
    .await?
    {
        sqlx::query(
            r#"
            UPDATE "Customer"
            SET "displayName" = COALESCE("displayName", $1), "updatedAt" = NOW()
            WHERE id = $2 AND "orgId" = $3
            "#,
        )
        .bind(display_name)
        .bind(&customer_id)
        .bind(org_id)
        .execute(pool)
        .await?;
        return Ok(customer_id);
    }

    let preferred_customer_id = match preferred_customer_id {
        Some(customer_id) => organization_customer(pool, org_id, customer_id).await?,
        None => None,
    };
    let created_customer_id = preferred_customer_id.is_none().then(cuid2::create_id);
    let customer_id = preferred_customer_id
        .as_ref()
        .or(created_customer_id.as_ref())
        .expect("a preferred or generated customer id must be available");

    if created_customer_id.is_some() {
        sqlx::query(
            r#"
            INSERT INTO "Customer" (id, "orgId", "displayName", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, NOW(), NOW())
            "#,
        )
        .bind(customer_id)
        .bind(org_id)
        .bind(display_name)
        .execute(pool)
        .await?;
    }

    let identity_id = cuid2::create_id();
    let resolved_customer_id = sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO "CustomerIdentity" (
            id, "orgId", "customerId", channel, "scopeId", "externalId", "identityKey",
            "displayName", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT ("orgId", "identityKey") DO UPDATE SET
            "displayName" = COALESCE("CustomerIdentity"."displayName", EXCLUDED."displayName"),
            "updatedAt" = NOW()
        RETURNING "customerId"
        "#,
    )
    .bind(identity_id)
    .bind(org_id)
    .bind(customer_id)
    .bind(channel)
    .bind(scope_id)
    .bind(external_id)
    .bind(identity_key)
    .bind(display_name)
    .fetch_one(pool)
    .await?;

    if created_customer_id
        .as_deref()
        .is_some_and(|created_id| created_id != resolved_customer_id)
    {
        sqlx::query(
            r#"
            DELETE FROM "Customer"
            WHERE id = $1 AND "orgId" = $2
              AND NOT EXISTS (
                SELECT 1 FROM "CustomerIdentity" identity WHERE identity."customerId" = $1
              )
            "#,
        )
        .bind(customer_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE "Customer"
        SET "displayName" = COALESCE("displayName", $1), "updatedAt" = NOW()
        WHERE id = $2 AND "orgId" = $3
        "#,
    )
    .bind(display_name)
    .bind(&resolved_customer_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    Ok(resolved_customer_id)
}

pub async fn ensure_whatsapp_customer(
    pool: &PgPool,
    org_id: &str,
    phone: &str,
    display_name: Option<&str>,
    preferred_customer_id: Option<&str>,
) -> Result<String, AppError> {
    ensure_customer_identity(
        pool,
        org_id,
        "whatsapp",
        None,
        phone,
        &whatsapp_identity_key(phone),
        display_name,
        preferred_customer_id,
    )
    .await
}

pub async fn ensure_meta_customer(
    pool: &PgPool,
    org_id: &str,
    channel: &str,
    scope_id: &str,
    external_id: &str,
    display_name: Option<&str>,
) -> Result<String, AppError> {
    ensure_customer_identity(
        pool,
        org_id,
        channel,
        Some(scope_id),
        external_id,
        &meta_identity_key(channel, scope_id, external_id),
        display_name,
        None,
    )
    .await
}

pub async fn link_whatsapp_contact(
    pool: &PgPool,
    org_id: &str,
    contact_id: &str,
    phone: &str,
    display_name: Option<&str>,
) -> Result<String, AppError> {
    let preferred_customer_id = sqlx::query_scalar::<_, String>(
        r#"
        SELECT "customerId"
        FROM "WhatsappContact"
        WHERE id = $1 AND "orgId" = $2 AND "customerId" IS NOT NULL
        LIMIT 1
        "#,
    )
    .bind(contact_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?;
    let customer_id = ensure_whatsapp_customer(
        pool,
        org_id,
        phone,
        display_name,
        preferred_customer_id.as_deref(),
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE "WhatsappContact"
        SET "customerId" = $1, "updatedAt" = NOW()
        WHERE id = $2 AND "orgId" = $3
        "#,
    )
    .bind(&customer_id)
    .bind(contact_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    Ok(customer_id)
}

#[cfg(test)]
mod tests {
    use super::{meta_identity_key, whatsapp_identity_key};

    #[test]
    fn whatsapp_identity_is_phone_scoped() {
        assert_eq!(
            whatsapp_identity_key("+27821234567"),
            "whatsapp:+27821234567"
        );
    }

    #[test]
    fn meta_identity_includes_channel_connection_scope() {
        assert_ne!(
            meta_identity_key("instagram", "channel-a", "participant-1"),
            meta_identity_key("instagram", "channel-b", "participant-1")
        );
        assert_ne!(
            meta_identity_key("facebook", "channel-a", "participant-1"),
            meta_identity_key("instagram", "channel-a", "participant-1")
        );
    }

    #[test]
    fn display_names_are_not_part_of_identity_keys() {
        assert_eq!(
            meta_identity_key("facebook", "channel-a", "participant-1"),
            "facebook:channel-a:participant-1"
        );
    }
}
