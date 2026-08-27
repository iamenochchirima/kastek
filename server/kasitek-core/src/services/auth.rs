use chrono::{Duration, Utc};
use reqwest::StatusCode;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;

pub async fn create_session(pool: &PgPool, user_id: &str) -> Result<String, AppError> {
    let session_id = cuid2::create_id();
    let session_token = cuid2::create_id();
    let expires = Utc::now() + Duration::days(30);

    sqlx::query(
        r#"
        INSERT INTO "Session" (id, "sessionToken", "userId", expires)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(session_id)
    .bind(&session_token)
    .bind(user_id)
    .bind(expires)
    .execute(pool)
    .await?;

    Ok(session_token)
}

pub async fn delete_session(pool: &PgPool, session_token: &str) -> Result<(), AppError> {
    sqlx::query(r#"DELETE FROM "Session" WHERE "sessionToken" = $1"#)
        .bind(session_token)
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn issue_verification_token(pool: &PgPool, identifier: &str) -> Result<String, AppError> {
    let token = format!("{}{}", cuid2::create_id(), cuid2::create_id());

    sqlx::query(r#"DELETE FROM "VerificationToken" WHERE identifier = $1"#)
        .bind(identifier)
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO "VerificationToken" (identifier, token, expires)
        VALUES ($1, $2, NOW() + INTERVAL '24 hours')
        "#,
    )
    .bind(identifier)
    .bind(&token)
    .execute(pool)
    .await?;

    Ok(token)
}

pub async fn send_email(
    config: &AppConfig,
    to: &str,
    subject: &str,
    text: &str,
) -> Result<(), AppError> {
    let Some(api_key) = config.resend_api_key.as_ref() else {
        observability::tracing::warn!(
            event = "dependency.unavailable",
            dependency = "resend",
            operation = "auth.email.send",
            reason = "missing_configuration",
            "authentication email not sent"
        );
        return Ok(());
    };

    let response = reqwest::Client::new()
        .post("https://api.resend.com/emails")
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "from": config.resend_from_email,
            "to": [to],
            "subject": subject,
            "text": text,
        }))
        .send()
        .await?;

    if response.status() != StatusCode::OK && response.status() != StatusCode::CREATED {
        observability::tracing::error!(
            event = "provider.call.failed",
            provider = "resend",
            operation = "auth.email.send",
            status = response.status().as_u16(),
            "email provider rejected authentication email"
        );
        return Err(AppError::Internal("Failed to send email".to_string()));
    }

    Ok(())
}

pub async fn send_sms_message(
    config: &AppConfig,
    phone: &str,
    message: &str,
) -> Result<(), AppError> {
    let Some(base_url) = config.zoomconnect_send_url.as_ref() else {
        observability::tracing::warn!(
            event = "dependency.unavailable",
            dependency = "zoomconnect",
            operation = "sms.send",
            reason = "missing_configuration",
            "SMS not sent"
        );
        return Ok(());
    };

    let url = format!(
        "{}.txt?recipientNumber={}&message={}",
        base_url,
        urlencoding::encode(phone),
        urlencoding::encode(message)
    );

    let response = reqwest::get(url).await?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("SMS send failed: {}", body)));
    }

    Ok(())
}
