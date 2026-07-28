use serde_json::json;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{ProductWaitlistCreateRequest, QuoteRequestCreateRequest};
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

fn normalize_required(value: Option<&str>, field: &str) -> Result<String, AppError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("{field} is required")))
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

async fn publish_admin_notification(
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
    let business_name = normalize_required(input.business_name.as_deref(), "Business name")?;
    let contact_person = normalize_required(input.contact_person.as_deref(), "Contact person")?;
    let email = normalize_required(input.email.as_deref(), "Email")?.to_lowercase();
    validate_email(&email)?;
    let business_type = normalize_optional(input.business_type.as_deref());
    if business_type
        .as_deref()
        .is_some_and(|value| !VALID_BUSINESS_TYPES.contains(&value))
    {
        return Err(AppError::BadRequest("Invalid business type".to_string()));
    }

    let products = normalize_string_list(input.products.as_ref());
    if products.is_empty()
        || products
            .iter()
            .any(|product| !VALID_PRODUCTS.contains(&product.as_str()))
    {
        return Err(AppError::BadRequest(
            "Invalid product selection".to_string(),
        ));
    }

    let id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "ProductWaitlistEntry" (
            id, "businessName", "contactPerson", phone, email, "businessType",
            products, notes, source, status, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'website', 'new', NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(&business_name)
    .bind(&contact_person)
    .bind(normalize_optional(input.phone.as_deref()))
    .bind(&email)
    .bind(&business_type)
    .bind(&products)
    .bind(normalize_optional(input.notes.as_deref()))
    .execute(pool)
    .await?;

    let _ = publish_admin_notification(
        pool,
        "product_waitlist.created",
        "New product waitlist signup",
        &format!(
            "{} joined the waitlist for {}.",
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
        &format!("product_waitlist.created:{id}"),
    )
    .await;

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
        "message": "Waitlist signup submitted successfully",
        "id": id
    }))
}
