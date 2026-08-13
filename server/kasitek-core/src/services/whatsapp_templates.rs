//! WhatsApp template synchronization and authoring boundary.
//!
//! Templates are organization-scoped and use the same connection/token
//! authority as the product connection service. Provider calls and local
//! template projections stay together so callers do not duplicate Graph API
//! mapping or persistence rules.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::db::models::{WhatsappTemplateListQuery, WhatsappTemplateRow};
use crate::error::AppError;

use super::social::decrypt_social_secret;
use super::whatsapp::{
    fetch_graph_json, get_connection_row_for_org, map_template_category, map_template_status,
    variables_count, GraphTemplatesResponse, GRAPH_BASE,
};

pub async fn sync_connection_templates(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    connection_id: &str,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let url = format!(
        "{GRAPH_BASE}/{}/message_templates?fields=name,language,status,category,components&limit=250&access_token={}",
        connection.waba_id,
        urlencoding::encode(&access_token)
    );
    let response: GraphTemplatesResponse =
        fetch_graph_json(&url, reqwest::Client::new().get(&url)).await?;
    let fetched = response.data.as_ref().map(|items| items.len()).unwrap_or(0);
    let templates = response.data.unwrap_or_default();
    let mut synced = 0;

    for template in templates.iter() {
        let Some(category) = map_template_category(template.category.as_deref()) else {
            continue;
        };
        let Some(template_name) = template.name.as_ref() else {
            continue;
        };
        let Some(language) = template.language.as_ref() else {
            continue;
        };
        let header = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("HEADER"))
            })
            .and_then(|part| part.text.clone());
        let body = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("BODY"))
            })
            .and_then(|part| part.text.clone());
        let footer = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("FOOTER"))
            })
            .and_then(|part| part.text.clone());
        let buttons = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("BUTTONS"))
            })
            .and_then(|part| part.buttons.clone());

        sqlx::query(
            r#"
            INSERT INTO "WhatsappTemplate" (
                id, "userId", "orgId", "connectionId", "templateName", language, category, header, body, footer,
                buttons, "variablesCount", status, "lastSynced", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, CAST($7 AS "WhatsappTemplateCategory"), $8, $9, $10,
                $11, $12, CAST($13 AS "WhatsappTemplateStatus"), NOW(), NOW(), NOW()
            )
            ON CONFLICT ("orgId", "templateName", language)
            DO UPDATE SET
                "connectionId" = EXCLUDED."connectionId",
                category = EXCLUDED.category,
                header = EXCLUDED.header,
                body = EXCLUDED.body,
                footer = EXCLUDED.footer,
                buttons = EXCLUDED.buttons,
                "variablesCount" = EXCLUDED."variablesCount",
                status = EXCLUDED.status,
                "lastSynced" = NOW(),
                "updatedAt" = NOW()
            "#,
        )
        .bind(cuid2::create_id())
        .bind(user_id)
        .bind(org_id)
        .bind(&connection.id)
        .bind(template_name)
        .bind(language)
        .bind(category)
        .bind(&header)
        .bind(&body)
        .bind(&footer)
        .bind(buttons.map(Value::Array))
        .bind(variables_count(body.as_deref()))
        .bind(map_template_status(template.status.as_deref()))
        .execute(pool)
        .await?;

        synced += 1;
    }

    Ok(json!({
        "connectionId": connection.id,
        "fetched": fetched,
        "synced": synced
    }))
}
pub async fn create_template(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    connection_id: &str,
    template_name: &str,
    language: &str,
    category: &str,
    header: Option<&str>,
    body: &str,
    footer: Option<&str>,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    if template_name.trim().is_empty() || language.trim().is_empty() || body.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Template name, language, and body are required".to_string(),
        ));
    }
    let normalized_name = template_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let category = map_template_category(Some(category))
        .ok_or_else(|| AppError::BadRequest("Invalid template category".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;

    let components = json!([
        if header
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            json!({
                "type": "HEADER",
                "format": "TEXT",
                "text": header.unwrap().trim()
            })
        } else {
            Value::Null
        },
        json!({
            "type": "BODY",
            "text": body.trim()
        }),
        if footer
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            json!({
                "type": "FOOTER",
                "text": footer.unwrap().trim()
            })
        } else {
            Value::Null
        }
    ]);
    let filtered_components = Value::Array(
        components
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|value| !value.is_null())
            .collect(),
    );

    let url = format!("{GRAPH_BASE}/{}/message_templates", connection.waba_id);
    let response: Value = fetch_graph_json(
        &url,
        reqwest::Client::new()
            .post(&url)
            .bearer_auth(access_token)
            .json(&json!({
                "name": normalized_name,
                "category": category,
                "language": language.trim(),
                "components": filtered_components
            })),
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO "WhatsappTemplate" (
            id, "userId", "orgId", "connectionId", "templateName", language, category, header, body, footer,
            "variablesCount", status, "lastSynced", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, CAST($7 AS "WhatsappTemplateCategory"), $8, $9, $10,
            $11, CAST($12 AS "WhatsappTemplateStatus"), NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", "templateName", language)
        DO UPDATE SET
            "connectionId" = EXCLUDED."connectionId",
            category = EXCLUDED.category,
            header = EXCLUDED.header,
            body = EXCLUDED.body,
            footer = EXCLUDED.footer,
            "variablesCount" = EXCLUDED."variablesCount",
            status = EXCLUDED.status,
            "lastSynced" = NOW(),
            "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(org_id)
    .bind(connection_id)
    .bind(&normalized_name)
    .bind(language.trim())
    .bind(&category)
    .bind(
        header
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(body.trim())
    .bind(
        footer
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(variables_count(Some(body.trim())))
    .bind(map_template_status(
        response.get("status").and_then(|value| value.as_str()),
    ))
    .execute(pool)
    .await?;

    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AT TIME ZONE 'UTC' AS last_synced, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappTemplate"
        WHERE "orgId" = $1 AND "templateName" = $2 AND language = $3
        LIMIT 1
        "#,
    )
    .bind(org_id)
    .bind(&normalized_name)
    .bind(language.trim())
    .fetch_one(pool)
    .await?;

    Ok(json!({
        "template": template,
        "metaTemplateId": response.get("id").and_then(|value| value.as_str()),
        "status": response.get("status").and_then(|value| value.as_str()).unwrap_or("PENDING")
    }))
}
pub async fn list_templates(
    pool: &PgPool,
    org_id: &str,
    query: WhatsappTemplateListQuery,
) -> Result<Value, AppError> {
    let requested_status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_uppercase);

    let templates = sqlx::query(
        r#"
        SELECT
            t.id,
            t."templateName" AS template_name,
            t.language,
            t.category::text AS category,
            t.status::text AS status,
            t."variablesCount" AS variables_count,
            t.header,
            t.body,
            t.footer,
            t.buttons,
            t."lastSynced" AT TIME ZONE 'UTC' AS last_synced,
            t."connectionId" AS connection_id,
            COALESCE(c."phoneDisplayNumber", c."phoneNumberId") AS connection_label
        FROM "WhatsappTemplate" t
        LEFT JOIN "WhatsappConnection" c ON c.id = t."connectionId"
        WHERE t."orgId" = $1
          AND ($2::text IS NULL OR t.status::text = $2)
        ORDER BY t."updatedAt" DESC
        "#,
    )
    .bind(org_id)
    .bind(requested_status)
    .fetch_all(pool)
    .await?;

    let templates = templates
        .into_iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "templateName": row.get::<String, _>("template_name"),
                "language": row.get::<String, _>("language"),
                "category": row.get::<String, _>("category"),
                "status": row.get::<String, _>("status"),
                "variablesCount": row.get::<i32, _>("variables_count"),
                "header": row.get::<Option<String>, _>("header"),
                "body": row.get::<Option<String>, _>("body"),
                "footer": row.get::<Option<String>, _>("footer"),
                "buttons": row.get::<Option<Value>, _>("buttons"),
                "lastSynced": row.get::<Option<chrono::DateTime<Utc>>, _>("last_synced"),
                "connectionId": row.get::<Option<String>, _>("connection_id"),
                "connectionLabel": row.get::<Option<String>, _>("connection_label").unwrap_or_else(|| "-".to_string()),
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({ "templates": templates }))
}
