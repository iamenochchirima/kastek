use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

use crate::db::models::{BookingRow, BookingServiceRow};
use crate::error::AppError;

const BOOKING_SELECT: &str = r#"
    SELECT
        b.id,
        b."orgId" AS org_id,
        b."serviceId" AS service_id,
        service.name AS service_name,
        b."customerId" AS customer_id,
        customer."displayName" AS customer_name,
        b."contactName" AS contact_name,
        b."contactPhone" AS contact_phone,
        b."scheduledStart" AS scheduled_start,
        b."scheduledEnd" AS scheduled_end,
        b.timezone,
        b.status::text AS status,
        b.notes,
        b."createdAt" AS created_at,
        b."updatedAt" AS updated_at
    FROM "Booking" b
    JOIN "BookingService" service ON service.id = b."serviceId"
    LEFT JOIN "Customer" customer
      ON customer.id = b."customerId" AND customer."orgId" = b."orgId"
"#;

pub async fn list_services(pool: &PgPool, org_id: &str) -> Result<Vec<BookingServiceRow>, AppError> {
    Ok(sqlx::query_as::<_, BookingServiceRow>(
        r#"
        SELECT id, "orgId" AS org_id, name, description,
               "durationMinutes" AS duration_minutes, active,
               "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "BookingService"
        WHERE "orgId" = $1
        ORDER BY active DESC, name ASC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?)
}

pub async fn create_service(
    pool: &PgPool,
    org_id: &str,
    name: &str,
    description: Option<&str>,
    duration_minutes: i32,
) -> Result<BookingServiceRow, AppError> {
    Ok(sqlx::query_as::<_, BookingServiceRow>(
        r#"
        INSERT INTO "BookingService" (
            id, "orgId", name, description, "durationMinutes", active, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
        RETURNING id, "orgId" AS org_id, name, description,
                  "durationMinutes" AS duration_minutes, active,
                  "createdAt" AS created_at, "updatedAt" AS updated_at
        "#,
    )
    .bind(cuid2::create_id())
    .bind(org_id)
    .bind(name)
    .bind(description)
    .bind(duration_minutes)
    .fetch_one(pool)
    .await?)
}

pub async fn update_service(
    pool: &PgPool,
    org_id: &str,
    service_id: &str,
    name: Option<&str>,
    description: Option<Option<&str>>,
    duration_minutes: Option<i32>,
    active: Option<bool>,
) -> Result<Option<BookingServiceRow>, AppError> {
    Ok(sqlx::query_as::<_, BookingServiceRow>(
        r#"
        UPDATE "BookingService"
        SET name = COALESCE($1, name),
            description = CASE WHEN $2 THEN $3 ELSE description END,
            "durationMinutes" = COALESCE($4, "durationMinutes"),
            active = COALESCE($5, active),
            "updatedAt" = NOW()
        WHERE id = $6 AND "orgId" = $7
        RETURNING id, "orgId" AS org_id, name, description,
                  "durationMinutes" AS duration_minutes, active,
                  "createdAt" AS created_at, "updatedAt" AS updated_at
        "#,
    )
    .bind(name)
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(duration_minutes)
    .bind(active)
    .bind(service_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn list_bookings(pool: &PgPool, org_id: &str) -> Result<Vec<BookingRow>, AppError> {
    let query = format!(
        "{} WHERE b.\"orgId\" = $1 ORDER BY b.\"scheduledStart\" ASC",
        BOOKING_SELECT
    );
    Ok(sqlx::query_as::<_, BookingRow>(&query)
        .bind(org_id)
        .fetch_all(pool)
        .await?)
}

pub async fn list_bookings_for_customer(
    pool: &PgPool,
    org_id: &str,
    customer_id: &str,
) -> Result<Vec<BookingRow>, AppError> {
    let query = format!(
        "{} WHERE b.\"orgId\" = $1 AND b.\"customerId\" = $2 ORDER BY b.\"scheduledStart\" DESC",
        BOOKING_SELECT
    );
    Ok(sqlx::query_as::<_, BookingRow>(&query)
        .bind(org_id)
        .bind(customer_id)
        .fetch_all(pool)
        .await?)
}

pub async fn create_booking(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    service_id: &str,
    customer_id: Option<&str>,
    contact_name: &str,
    contact_phone: Option<&str>,
    scheduled_start: DateTime<Utc>,
    timezone: &str,
    notes: Option<&str>,
) -> Result<BookingRow, AppError> {
    let duration_minutes = sqlx::query_scalar::<_, i32>(
        r#"SELECT "durationMinutes" FROM "BookingService" WHERE id = $1 AND "orgId" = $2 AND active = true"#,
    )
    .bind(service_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Active booking service not found".to_string()))?;

    if let Some(customer_id) = customer_id {
        let exists = sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM "Customer" WHERE id = $1 AND "orgId" = $2"#,
        )
        .bind(customer_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .is_some();
        if !exists {
            return Err(AppError::BadRequest("Contact does not belong to this workspace".to_string()));
        }
    }

    let scheduled_end = scheduled_start + Duration::minutes(i64::from(duration_minutes));
    let overlaps = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM "Booking"
            WHERE "serviceId" = $1
              AND status NOT IN ('CANCELLED'::"BookingStatus", 'NO_SHOW'::"BookingStatus")
              AND "scheduledStart" < $3
              AND "scheduledEnd" > $2
        )
        "#,
    )
    .bind(service_id)
    .bind(scheduled_start)
    .bind(scheduled_end)
    .fetch_one(pool)
    .await?;

    if overlaps {
        return Err(AppError::Conflict(
            "This service already has a booking in that time slot".to_string(),
        ));
    }

    let booking_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "Booking" (
            id, "orgId", "serviceId", "customerId", "contactName", "contactPhone",
            "scheduledStart", "scheduledEnd", timezone, status, notes, "createdById", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SCHEDULED'::"BookingStatus", $10, $11, NOW(), NOW())
        "#,
    )
    .bind(&booking_id)
    .bind(org_id)
    .bind(service_id)
    .bind(customer_id)
    .bind(contact_name)
    .bind(contact_phone)
    .bind(scheduled_start)
    .bind(scheduled_end)
    .bind(timezone)
    .bind(notes)
    .bind(user_id)
    .execute(pool)
    .await?;

    get_booking(pool, org_id, &booking_id)
        .await?
        .ok_or_else(|| AppError::Internal("Created booking could not be loaded".to_string()))
}

pub async fn update_booking(
    pool: &PgPool,
    org_id: &str,
    booking_id: &str,
    status: Option<&str>,
    notes: Option<Option<&str>>,
) -> Result<Option<BookingRow>, AppError> {
    let query = format!(
        r#"
        WITH updated AS (
            UPDATE "Booking"
            SET status = COALESCE($1::"BookingStatus", status),
                notes = CASE WHEN $2 THEN $3 ELSE notes END,
                "updatedAt" = NOW()
            WHERE id = $4 AND "orgId" = $5
            RETURNING id
        )
        {} WHERE b.id IN (SELECT id FROM updated)
        "#,
        BOOKING_SELECT
    );
    Ok(sqlx::query_as::<_, BookingRow>(&query)
        .bind(status)
        .bind(notes.is_some())
        .bind(notes.flatten())
        .bind(booking_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?)
}

async fn get_booking(
    pool: &PgPool,
    org_id: &str,
    booking_id: &str,
) -> Result<Option<BookingRow>, AppError> {
    let query = format!("{} WHERE b.id = $1 AND b.\"orgId\" = $2", BOOKING_SELECT);
    Ok(sqlx::query_as::<_, BookingRow>(&query)
        .bind(booking_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?)
}
