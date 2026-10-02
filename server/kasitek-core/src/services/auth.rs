use reqwest::StatusCode;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;

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
    if !config.is_production() {
        if let Ok(base) = std::env::var("LOCAL_MAILPIT_URL") {
            let parsed = url::Url::parse(&base)
                .map_err(|_| AppError::BadRequest("Invalid local mail sink URL".into()))?;
            if !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
                return Err(AppError::BadRequest(
                    "Local mail sink must use loopback".into(),
                ));
            }
            let response=reqwest::Client::new().post(format!("{}/api/v1/send",base.trim_end_matches('/'))).json(&serde_json::json!({"From":{"Email":"growth@kasitek.local","Name":"KasiTek Growth"},"To":[{"Email":to}],"Subject":subject,"Text":text})).send().await?;
            if !response.status().is_success() {
                return Err(AppError::ServiceUnavailable(
                    "Local email delivery failed".into(),
                ));
            }
            return Ok(());
        }
    }
    let api_key = config
        .resend_api_key
        .as_ref()
        .ok_or_else(|| AppError::ServiceUnavailable("Email delivery is not configured".into()))?;
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
