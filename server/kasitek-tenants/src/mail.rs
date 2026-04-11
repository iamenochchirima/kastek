use chrono::{DateTime, Utc};
use reqwest::StatusCode;

use crate::{config::AppConfig, error::AppError};

pub async fn send_client_invite_email(
    config: &AppConfig,
    to: &str,
    workspace_name: &str,
    tenant_client_name: &str,
    activation_url: &str,
    expires_at: DateTime<Utc>,
) -> Result<bool, AppError> {
    let Some(api_key) = config.resend_api_key.as_ref() else {
        log::warn!(
            "tenant invite email not sent because no Resend key is configured: to={} workspace={} client={}",
            to,
            workspace_name,
            tenant_client_name
        );
        return Ok(false);
    };

    let expires_label = expires_at.format("%Y-%m-%d %H:%M UTC");
    let subject = format!("Activate your access to {}", tenant_client_name);
    let text = format!(
        "You were invited to access {tenant_client_name} inside {workspace_name}.\n\nActivate your account here:\n{activation_url}\n\nThis link expires on {expires_label}.\n"
    );
    let html = format!(
        "<p>You were invited to access <strong>{tenant_client_name}</strong> inside <strong>{workspace_name}</strong>.</p><p><a href=\"{activation_url}\">Activate your account</a></p><p>This link expires on {expires_label}.</p>"
    );

    let response = reqwest::Client::new()
        .post("https://api.resend.com/emails")
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "from": config.resend_from_email,
            "to": [to],
            "subject": subject,
            "text": text,
            "html": html,
        }))
        .send()
        .await?;

    if response.status() != StatusCode::OK && response.status() != StatusCode::CREATED {
        let body = response.text().await.unwrap_or_default();
        log::error!("tenant invite email rejected by resend: {}", body);
        return Err(AppError::Internal("Failed to send invite email".to_string()));
    }

    Ok(true)
}
