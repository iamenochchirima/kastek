//! WhatsApp contact and list-management boundary.
//!
//! Contact imports, organization-scoped list projections, CSV export, contact
//! edits, and list lifecycle operations live here while the stable
//! `whatsapp::` exports remain available to existing controllers.

use actix_multipart::Multipart;
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};

use crate::db::models::{
    WhatsappContactImportInvalidRow, WhatsappContactListQuery, WhatsappContactListRenameRequest,
    WhatsappContactRow, WhatsappContactUpdateRequest, WhatsappListContactRow,
};
use crate::error::AppError;
use crate::services::customers;

use super::whatsapp::{
    extract_contact_metadata, has_confirmed_import_consent, normalize_phone, parse_bool_like,
    parse_csv_tags, pick_first, sanitize_filename, sanitize_list_label, sanitize_tags,
    select_list_contact_row,
};
pub async fn list_contacts(
    pool: &PgPool,
    org_id: &str,
    query: WhatsappContactListQuery,
) -> Result<Value, AppError> {
    let requested_limit = query.limit.unwrap_or(500);
    let normalized_limit = requested_limit.clamp(1, 10_000);

    let contacts = sqlx::query_as::<_, WhatsappListContactRow>(
        r#"
        SELECT
            m.id,
            m."contactId" AS contact_id,
            c."customerId" AS customer_id,
            m."userId" AS user_id,
            c.phone,
            COALESCE(m."fullName", c."fullName") AS full_name,
            COALESCE(m.tags, ARRAY[]::text[]) AS tags,
            COALESCE(m.location, c.location) AS location,
            m."listLabel" AS list_label,
            m.metadata,
            m."optIn" AS opt_in,
            m."optInSource" AS opt_in_source,
            m."optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
            c."lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent,
            m.excluded,
            m.notes,
            m."createdAt" AT TIME ZONE 'UTC' AS created_at,
            m."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappContactListMembership" m
        JOIN "WhatsappContact" c ON c.id = m."contactId"
        WHERE m."orgId" = $1
          AND (
            COALESCE($2, '') = ''
            OR COALESCE(m."fullName", c."fullName", '') ILIKE ('%' || $2 || '%')
            OR c.phone ILIKE ('%' || $2 || '%')
            OR COALESCE(m.location, c.location, '') ILIKE ('%' || $2 || '%')
            OR EXISTS (
              SELECT 1
              FROM unnest(COALESCE(m.tags, ARRAY[]::text[])) AS tag_value
              WHERE tag_value ILIKE $2
            )
            OR EXISTS (
              SELECT 1
              FROM jsonb_each_text(COALESCE(m.metadata, '{}'::jsonb)) AS metadata_entry
              WHERE metadata_entry.value ILIKE ('%' || $2 || '%')
            )
          )
          AND (
            COALESCE($3, 'all') = 'all'
            OR (m."optIn" = true AND $3 = 'true')
            OR (m."optIn" = false AND $3 = 'false')
          )
          AND (
            COALESCE($4, 'all') = 'all'
            OR (m.excluded = true AND $4 = 'true')
            OR (m.excluded = false AND $4 = 'false')
          )
          AND (
            COALESCE($5, '') = ''
            OR EXISTS (
              SELECT 1
              FROM unnest(COALESCE(m.tags, ARRAY[]::text[])) AS tag_filter
              WHERE tag_filter = $5
            )
          )
          AND (
            COALESCE($6, '') = ''
            OR COALESCE(m.location, c.location, '') ILIKE ('%' || $6 || '%')
          )
          AND (
            COALESCE($7, '') = ''
            OR m."listLabel" = $7
          )
        ORDER BY m."createdAt" DESC
        LIMIT $8
        "#,
    )
    .bind(org_id)
    .bind(
        query
            .q
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(query.opt_in.as_deref())
    .bind(query.excluded.as_deref())
    .bind(
        query
            .tag
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        query
            .location
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        query
            .list_label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(normalized_limit)
    .fetch_all(pool)
    .await?;

    let (total_contacts, opted_in_contacts, excluded_contacts, tag_rows, list_rows) = tokio::try_join!(
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "WhatsappContact" WHERE "orgId" = $1"#)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(DISTINCT "contactId") FROM "WhatsappContactListMembership" WHERE "orgId" = $1 AND "optIn" = true"#,
        )
        .bind(org_id)
        .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(DISTINCT "contactId") FROM "WhatsappContactListMembership" WHERE "orgId" = $1 AND excluded = true"#,
        )
        .bind(org_id)
        .fetch_one(pool),
        sqlx::query_scalar::<_, Vec<String>>(r#"SELECT COALESCE(tags, ARRAY[]::text[]) FROM "WhatsappContactListMembership" WHERE "orgId" = $1"#)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query(
            r#"
            SELECT
                "listLabel" AS list_label,
                COUNT(DISTINCT "contactId")::bigint AS total_contacts,
                MIN(NULLIF(location, '')) AS primary_location,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT metadata_key), NULL) AS metadata_keys
            FROM "WhatsappContactListMembership"
            LEFT JOIN LATERAL jsonb_object_keys(COALESCE(metadata, '{}'::jsonb)) AS metadata_key ON TRUE
            WHERE "orgId" = $1
            GROUP BY "listLabel"
            ORDER BY "listLabel" ASC
            "#,
        )
        .bind(org_id)
        .fetch_all(pool),
    )?;

    let mut tag_options = tag_rows
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    tag_options.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));

    let lists = list_rows
        .into_iter()
        .map(|row| {
            let metadata_keys = row
                .get::<Option<Vec<Option<String>>>, _>("metadata_keys")
                .unwrap_or_default()
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            json!({
                "label": row.get::<String, _>("list_label"),
                "totalContacts": row.get::<i64, _>("total_contacts"),
                "primaryLocation": row.get::<Option<String>, _>("primary_location"),
                "metadataKeys": metadata_keys,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "contacts": contacts,
        "lists": lists,
        "tagOptions": tag_options,
        "stats": {
            "totalContacts": total_contacts,
            "optedInContacts": opted_in_contacts,
            "excludedContacts": excluded_contacts,
        }
    }))
}

pub async fn export_contact_list(
    pool: &PgPool,
    org_id: &str,
    label: &str,
) -> Result<actix_web::HttpResponse, AppError> {
    let list_label = sanitize_list_label(Some(label));
    let contacts = sqlx::query_as::<_, WhatsappListContactRow>(
        r#"
        SELECT
            m.id,
            m."contactId" AS contact_id,
            c."customerId" AS customer_id,
            m."userId" AS user_id,
            c.phone,
            COALESCE(m."fullName", c."fullName") AS full_name,
            COALESCE(m.tags, ARRAY[]::text[]) AS tags,
            COALESCE(m.location, c.location) AS location,
            m."listLabel" AS list_label,
            m.metadata,
            m."optIn" AS opt_in,
            m."optInSource" AS opt_in_source,
            m."optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
            c."lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent,
            m.excluded,
            m.notes,
            m."createdAt" AT TIME ZONE 'UTC' AS created_at,
            m."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappContactListMembership" m
        JOIN "WhatsappContact" c ON c.id = m."contactId"
        WHERE m."orgId" = $1
          AND m."listLabel" = $2
        ORDER BY m."createdAt" ASC
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .fetch_all(pool)
    .await?;

    if contacts.is_empty() {
        return Err(AppError::NotFound("Contact list not found".to_string()));
    }

    let mut metadata_keys = contacts
        .iter()
        .flat_map(|contact| {
            contact
                .metadata
                .as_ref()
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|metadata| metadata.keys().cloned())
        })
        .collect::<Vec<_>>();
    metadata_keys.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    metadata_keys.dedup();

    let mut writer = csv::Writer::from_writer(Vec::new());
    let mut headers = vec![
        "phone".to_string(),
        "fullName".to_string(),
        "location".to_string(),
        "tags".to_string(),
        "notes".to_string(),
        "optIn".to_string(),
        "excluded".to_string(),
        "listLabel".to_string(),
    ];
    headers.extend(metadata_keys.iter().cloned());
    writer
        .write_record(&headers)
        .map_err(|_| AppError::Internal("Failed to build CSV export".to_string()))?;

    for contact in contacts {
        let metadata = contact.metadata.as_ref().and_then(Value::as_object);
        let mut row = vec![
            contact.phone,
            contact.full_name.unwrap_or_default(),
            contact.location.unwrap_or_default(),
            contact.tags.join(", "),
            contact.notes.unwrap_or_default(),
            contact.opt_in.to_string(),
            contact.excluded.to_string(),
            contact.list_label,
        ];
        row.extend(metadata_keys.iter().map(|key| {
            metadata
                .and_then(|values| values.get(key))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }));
        writer
            .write_record(&row)
            .map_err(|_| AppError::Internal("Failed to build CSV export".to_string()))?;
    }

    let bytes = writer
        .into_inner()
        .map_err(|_| AppError::Internal("Failed to finalize CSV export".to_string()))?;
    let filename = sanitize_filename(&format!("{list_label}.csv"));

    Ok(actix_web::HttpResponse::Ok()
        .append_header(("Content-Type", "text/csv; charset=utf-8"))
        .append_header((
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", filename),
        ))
        .append_header(("Cache-Control", "private, max-age=60"))
        .body(bytes))
}

pub async fn update_contact(
    pool: &PgPool,
    org_id: &str,
    contact_id: &str,
    input: WhatsappContactUpdateRequest,
) -> Result<Value, AppError> {
    let existing = select_list_contact_row(pool, org_id, contact_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Contact not found".to_string()))?;

    let normalized_phone = match input.phone.as_deref() {
        Some(phone) => {
            let normalized = normalize_phone(phone);
            if normalized.is_empty() {
                return Err(AppError::BadRequest(
                    "Invalid phone number format".to_string(),
                ));
            }
            Some(normalized)
        }
        None => None,
    };

    if let Some(phone) = normalized_phone.as_deref() {
        let duplicate = sqlx::query_scalar::<_, String>(
            r#"
            SELECT id
            FROM "WhatsappContact"
            WHERE "orgId" = $1 AND phone = $2 AND id <> $3
            LIMIT 1
            "#,
        )
        .bind(org_id)
        .bind(phone)
        .bind(&existing.contact_id)
        .fetch_optional(pool)
        .await?;
        if duplicate.is_some() {
            return Err(AppError::Conflict(
                "A contact with this phone already exists".to_string(),
            ));
        }
    }

    let tags = input.tags.as_ref().map(|value| sanitize_tags(value));
    let list_label = input
        .list_label
        .as_deref()
        .map(|value| sanitize_list_label(Some(value)));
    let opt_in = input.opt_in;
    let opt_in_source = if opt_in.is_some() {
        Some("dashboard".to_string())
    } else {
        existing.opt_in_source.clone()
    };
    let opt_in_date = match opt_in {
        Some(true) => existing.opt_in_date.or(Some(Utc::now())),
        Some(false) => None,
        None => existing.opt_in_date,
    };

    if let Some(phone) = normalized_phone {
        sqlx::query(
            r#"
            UPDATE "WhatsappContact"
            SET phone = $1, "updatedAt" = NOW()
            WHERE id = $2 AND "orgId" = $3
            "#,
        )
        .bind(phone)
        .bind(&existing.contact_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    }

    if let Some(next_label) = list_label.as_deref() {
        let duplicate_membership = sqlx::query_scalar::<_, String>(
            r#"
            SELECT id
            FROM "WhatsappContactListMembership"
            WHERE "orgId" = $1
              AND "contactId" = $2
              AND "listLabel" = $3
              AND id <> $4
            LIMIT 1
            "#,
        )
        .bind(org_id)
        .bind(&existing.contact_id)
        .bind(next_label)
        .bind(contact_id)
        .fetch_optional(pool)
        .await?;
        if duplicate_membership.is_some() {
            return Err(AppError::Conflict(
                "This contact is already in that list".to_string(),
            ));
        }
    }

    sqlx::query(
        r#"
        UPDATE "WhatsappContactListMembership"
        SET "fullName" = COALESCE($1, "fullName"),
            location = COALESCE($2, location),
            tags = COALESCE($3, tags),
            notes = COALESCE($4, notes),
            "listLabel" = COALESCE($5, "listLabel"),
            metadata = COALESCE($6, metadata),
            "optIn" = COALESCE($7, "optIn"),
            "optInSource" = $8,
            "optInDate" = $9,
            excluded = COALESCE($10, excluded),
            "updatedAt" = NOW()
        WHERE id = $11 AND "orgId" = $12
        "#,
    )
    .bind(
        input
            .full_name
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(
        input
            .location
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(tags.as_ref())
    .bind(
        input
            .notes
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(list_label)
    .bind(input.metadata.as_ref())
    .bind(opt_in)
    .bind(opt_in_source)
    .bind(opt_in_date)
    .bind(input.excluded)
    .bind(contact_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    let contact = select_list_contact_row(pool, org_id, contact_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload contact".to_string()))?;
    customers::link_whatsapp_contact(
        pool,
        org_id,
        &contact.contact_id,
        &contact.phone,
        contact.full_name.as_deref(),
    )
    .await?;

    Ok(json!({ "contact": contact }))
}

pub async fn import_contacts(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    mut payload: Multipart,
) -> Result<Value, AppError> {
    let mut csv_bytes = Vec::new();
    let mut default_opt_in = false;
    let mut consent_confirmed = false;
    let mut requested_list_label: Option<String> = None;

    while let Some(field) = payload.next().await {
        let mut field = field
            .map_err(|_| AppError::BadRequest("Failed to read multipart payload".to_string()))?;
        let Some(name) = field.name() else { continue };
        let name = name.to_string();
        let mut bytes = Vec::new();
        while let Some(chunk) = field.next().await {
            let chunk = chunk
                .map_err(|_| AppError::BadRequest("Failed to read multipart field".to_string()))?;
            bytes.extend_from_slice(&chunk);
        }
        if name == "file" {
            csv_bytes = bytes;
        } else if name == "defaultOptIn" {
            default_opt_in =
                parse_bool_like(std::str::from_utf8(&bytes).unwrap_or("")).unwrap_or(false);
        } else if name == "consentConfirmed" {
            consent_confirmed =
                parse_bool_like(std::str::from_utf8(&bytes).unwrap_or("")).unwrap_or(false);
        } else if name == "listLabel" {
            let raw = std::str::from_utf8(&bytes).unwrap_or("").trim().to_string();
            if !raw.is_empty() {
                requested_list_label = Some(raw);
            }
        }
    }

    if csv_bytes.is_empty() {
        return Err(AppError::BadRequest(
            "CSV file is required in form-data field: file".to_string(),
        ));
    }

    let csv_text = String::from_utf8(csv_bytes)
        .map_err(|_| AppError::BadRequest("CSV file must be valid UTF-8 text".to_string()))?;
    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(csv_text.as_bytes());
    let headers = reader
        .headers()
        .map_err(|_| AppError::BadRequest("Failed to parse CSV headers".to_string()))?
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if headers.is_empty() {
        return Err(AppError::BadRequest("CSV has no rows".to_string()));
    }

    let mut invalid_rows = Vec::new();
    let mut total_rows = 0usize;
    let mut deduped: HashMap<
        String,
        (
            Option<String>,
            Option<String>,
            Vec<String>,
            Option<String>,
            bool,
            Option<String>,
            Option<chrono::DateTime<Utc>>,
            String,
            Option<Value>,
        ),
    > = HashMap::new();
    let now = Utc::now();

    for (index, record) in reader.records().enumerate() {
        total_rows += 1;
        let record = match record {
            Ok(value) => value,
            Err(_) => {
                invalid_rows.push(WhatsappContactImportInvalidRow {
                    index,
                    error: "Failed to parse CSV row".to_string(),
                    row: HashMap::new(),
                });
                continue;
            }
        };
        let row = headers
            .iter()
            .cloned()
            .zip(record.iter().map(ToString::to_string))
            .collect::<HashMap<_, _>>();
        let Some(phone_raw) = pick_first(
            &row,
            &[
                "phone",
                "Phone",
                "mobile",
                "Mobile",
                "whatsapp",
                "whatsappNumber",
                "number",
            ],
        ) else {
            invalid_rows.push(WhatsappContactImportInvalidRow {
                index,
                error: "Missing phone column".to_string(),
                row,
            });
            continue;
        };
        let phone = normalize_phone(phone_raw);
        if phone.is_empty() {
            invalid_rows.push(WhatsappContactImportInvalidRow {
                index,
                error: format!("Invalid phone format: {phone_raw}"),
                row,
            });
            continue;
        }

        let explicit_opt_in = pick_first(
            &row,
            &["optIn", "opt_in", "optedIn", "subscribed", "consent"],
        )
        .and_then(parse_bool_like);
        let list_label = sanitize_list_label(
            pick_first(&row, &["listLabel", "list"]).or(requested_list_label.as_deref()),
        );
        let metadata = extract_contact_metadata(&row);
        deduped.insert(
            phone,
            (
                pick_first(&row, &["fullName", "name", "Name", "contactName"])
                    .map(ToString::to_string),
                pick_first(&row, &["location", "city", "province", "region"])
                    .map(ToString::to_string),
                parse_csv_tags(pick_first(&row, &["tags", "segment", "groups"])),
                pick_first(&row, &["notes", "note"]).map(ToString::to_string),
                explicit_opt_in.unwrap_or(default_opt_in),
                pick_first(&row, &["optInSource", "consentSource"])
                    .map(ToString::to_string)
                    .or_else(|| explicit_opt_in.map(|_| "csv-import".to_string())),
                if explicit_opt_in == Some(true) || default_opt_in {
                    Some(now)
                } else {
                    None
                },
                list_label,
                metadata,
            ),
        );
    }

    if deduped.is_empty() && invalid_rows.is_empty() {
        return Err(AppError::BadRequest("CSV has no rows".to_string()));
    }

    let includes_opted_in_contact = deduped
        .values()
        .any(|(_, _, _, _, opt_in, _, _, _, _)| *opt_in);
    if !has_confirmed_import_consent(includes_opted_in_contact, consent_confirmed) {
        return Err(AppError::BadRequest(
            "Confirm that you have permission to record consent before importing opted-in contacts"
                .to_string(),
        ));
    }

    let phones = deduped.keys().cloned().collect::<Vec<_>>();
    let existing_contacts = if phones.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, WhatsappContactRow>(
            r#"
            SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, COALESCE(tags, ARRAY[]::text[]) AS tags, location,
                   COALESCE("listLabel", 'default') AS list_label, metadata,
                   "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
                   "lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent, excluded, notes,
                   "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
            FROM "WhatsappContact"
            WHERE "orgId" = $1 AND phone = ANY($2)
            "#,
        )
        .bind(org_id)
        .bind(&phones)
        .fetch_all(pool)
        .await?
    };
    let existing_by_phone = existing_contacts
        .into_iter()
        .map(|contact| (contact.phone.clone(), contact))
        .collect::<HashMap<_, _>>();

    let existing_contact_ids = existing_by_phone
        .values()
        .map(|contact| contact.id.clone())
        .collect::<Vec<_>>();
    let existing_memberships = if existing_contact_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            r#"
            SELECT id, "contactId" AS contact_id, "listLabel" AS list_label
            FROM "WhatsappContactListMembership"
            WHERE "orgId" = $1 AND "contactId" = ANY($2)
            "#,
        )
        .bind(org_id)
        .bind(&existing_contact_ids)
        .fetch_all(pool)
        .await?
    };
    let existing_membership_by_contact_and_label = existing_memberships
        .into_iter()
        .map(|row| {
            (
                (
                    row.get::<String, _>("contact_id"),
                    row.get::<String, _>("list_label"),
                ),
                row.get::<String, _>("id"),
            )
        })
        .collect::<HashMap<_, _>>();

    let mut created = 0usize;
    let mut updated = 0usize;

    for (
        phone,
        (
            full_name,
            location,
            tags,
            notes,
            opt_in,
            opt_in_source,
            opt_in_date,
            list_label,
            metadata,
        ),
    ) in deduped
    {
        let (contact_id, existing_opt_in_date) = if let Some(existing) =
            existing_by_phone.get(&phone)
        {
            sqlx::query(
                r#"
                UPDATE "WhatsappContact"
                SET "fullName" = COALESCE("fullName", $1),
                    location = COALESCE(location, $2),
                    "optIn" = CASE WHEN $3 THEN true ELSE "optIn" END,
                    "optInSource" = CASE
                        WHEN $3 AND "optInSource" IS NULL THEN $4
                        ELSE "optInSource"
                    END,
                    "optInDate" = CASE
                        WHEN $3 THEN COALESCE("optInDate", $5)
                        ELSE "optInDate"
                    END,
                    "updatedAt" = NOW()
                WHERE id = $6
                "#,
            )
            .bind(full_name.as_deref())
            .bind(location.as_deref())
            .bind(opt_in)
            .bind(opt_in_source.as_deref())
            .bind(opt_in_date)
            .bind(&existing.id)
            .execute(pool)
            .await?;
            (existing.id.clone(), existing.opt_in_date)
        } else {
            let contact_id = cuid2::create_id();
            sqlx::query(
                    r#"
                INSERT INTO "WhatsappContact" (
                    id, "userId", "orgId", phone, "fullName", tags, location, notes, "listLabel", metadata,
                    "optIn", "optInSource", "optInDate", excluded, "createdAt", "updatedAt"
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, NOW(), NOW())
                "#,
                )
                .bind(&contact_id)
                .bind(user_id)
                .bind(org_id)
                .bind(&phone)
                .bind(full_name.as_deref())
                .bind(Vec::<String>::new())
                .bind(location.as_deref())
                .bind(None::<&str>)
                .bind(&list_label)
                .bind(None::<&Value>)
                .bind(opt_in)
                .bind(opt_in_source.as_deref())
                .bind(opt_in_date)
                .execute(pool)
                .await?;
            (contact_id, None)
        };

        customers::link_whatsapp_contact(pool, org_id, &contact_id, &phone, full_name.as_deref())
            .await?;

        if let Some(existing_membership_id) =
            existing_membership_by_contact_and_label.get(&(contact_id.clone(), list_label.clone()))
        {
            sqlx::query(
                r#"
                UPDATE "WhatsappContactListMembership"
                SET "fullName" = COALESCE("fullName", $1),
                    location = $2,
                    tags = $3,
                    notes = $4,
                    metadata = $5,
                    "optIn" = CASE WHEN $6 THEN true ELSE "optIn" END,
                    "optInSource" = CASE
                        WHEN $6 AND "optInSource" IS NULL THEN $7
                        ELSE "optInSource"
                    END,
                    "optInDate" = CASE
                        WHEN $6 THEN COALESCE("optInDate", $8)
                        ELSE "optInDate"
                    END,
                    "updatedAt" = NOW()
                WHERE id = $9
                "#,
            )
            .bind(full_name.as_deref())
            .bind(location.as_deref())
            .bind(sanitize_tags(&tags))
            .bind(notes.as_deref())
            .bind(metadata.as_ref())
            .bind(opt_in)
            .bind(opt_in_source.as_deref())
            .bind(if opt_in {
                existing_opt_in_date.or(opt_in_date)
            } else {
                None
            })
            .bind(existing_membership_id)
            .execute(pool)
            .await?;
            updated += 1;
        } else {
            sqlx::query(
                r#"
                INSERT INTO "WhatsappContactListMembership" (
                    id, "userId", "orgId", "contactId", "listLabel", "fullName", tags, location, metadata,
                    "optIn", "optInSource", "optInDate", excluded, notes, "createdAt", "updatedAt"
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, NOW(), NOW())
                "#,
            )
            .bind(cuid2::create_id())
            .bind(user_id)
            .bind(org_id)
            .bind(&contact_id)
            .bind(&list_label)
            .bind(full_name.as_deref())
            .bind(sanitize_tags(&tags))
            .bind(location.as_deref())
            .bind(metadata.as_ref())
            .bind(opt_in)
            .bind(opt_in_source.as_deref())
            .bind(opt_in_date)
            .bind(notes.as_deref())
            .execute(pool)
            .await?;
            created += 1;
        }
    }

    Ok(json!({
        "summary": {
            "totalRows": total_rows,
            "validRows": created + updated,
            "invalidRows": invalid_rows.len(),
            "created": created,
            "updated": updated
        },
        "invalidRows": invalid_rows.into_iter().take(100).collect::<Vec<_>>()
    }))
}

pub async fn rename_contact_list(
    pool: &PgPool,
    org_id: &str,
    label: &str,
    input: &WhatsappContactListRenameRequest,
) -> Result<Value, AppError> {
    let current_label = sanitize_list_label(Some(label));
    let next_label = sanitize_list_label(input.next_label.as_deref());
    if current_label == next_label {
        return Ok(json!({ "label": next_label, "renamedContacts": 0, "updatedCampaigns": 0 }));
    }

    let updated_memberships = sqlx::query(
        r#"
        UPDATE "WhatsappContactListMembership"
        SET "listLabel" = $1, "updatedAt" = NOW()
        WHERE "orgId" = $2 AND "listLabel" = $3
        "#,
    )
    .bind(&next_label)
    .bind(org_id)
    .bind(&current_label)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        UPDATE "WhatsappContact"
        SET "listLabel" = $1, "updatedAt" = NOW()
        WHERE "orgId" = $2 AND COALESCE("listLabel", 'default') = $3
        "#,
    )
    .bind(&next_label)
    .bind(org_id)
    .bind(&current_label)
    .execute(pool)
    .await?;

    let updated_campaigns = sqlx::query(
        r#"
        UPDATE "WhatsappCampaign"
        SET "listLabel" = $1, "updatedAt" = NOW()
        WHERE "orgId" = $2 AND COALESCE("listLabel", 'default') = $3
        "#,
    )
    .bind(&next_label)
    .bind(org_id)
    .bind(&current_label)
    .execute(pool)
    .await?;

    Ok(json!({
        "label": next_label,
        "renamedContacts": updated_memberships.rows_affected(),
        "updatedCampaigns": updated_campaigns.rows_affected(),
    }))
}

pub async fn delete_contact_list(
    pool: &PgPool,
    org_id: &str,
    label: &str,
) -> Result<Value, AppError> {
    let list_label = sanitize_list_label(Some(label));
    let active_campaign_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM "WhatsappCampaign"
        WHERE "orgId" = $1
          AND COALESCE("listLabel", 'default') = $2
          AND status IN (
            'DRAFT'::"WhatsappCampaignStatus",
            'SCHEDULED'::"WhatsappCampaignStatus",
            'SENDING'::"WhatsappCampaignStatus",
            'PAUSED'::"WhatsappCampaignStatus"
          )
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .fetch_one(pool)
    .await?;

    if active_campaign_count > 0 {
        return Err(AppError::Conflict(
            "This list is still attached to active campaigns".to_string(),
        ));
    }

    let contact_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT "contactId"
        FROM "WhatsappContactListMembership"
        WHERE "orgId" = $1 AND "listLabel" = $2
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .fetch_all(pool)
    .await?;

    let deleted_contacts = sqlx::query(
        r#"
        DELETE FROM "WhatsappContactListMembership"
        WHERE "orgId" = $1 AND "listLabel" = $2
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .execute(pool)
    .await?;

    if !contact_ids.is_empty() {
        sqlx::query(
            r#"
            UPDATE "WhatsappContact" c
            SET "listLabel" = COALESCE(
                    (
                        SELECT m."listLabel"
                        FROM "WhatsappContactListMembership" m
                        WHERE m."contactId" = c.id
                          AND m."orgId" = $1
                        ORDER BY m."createdAt" ASC
                        LIMIT 1
                    ),
                    'default'
                ),
                "updatedAt" = NOW()
            WHERE c."orgId" = $1
              AND c.id = ANY($2)
              AND COALESCE(c."listLabel", 'default') = $3
            "#,
        )
        .bind(org_id)
        .bind(&contact_ids)
        .bind(&list_label)
        .execute(pool)
        .await?;
    }

    Ok(json!({
        "label": list_label,
        "deletedContacts": deleted_contacts.rows_affected(),
    }))
}
