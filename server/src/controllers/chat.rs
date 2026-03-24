use actix_web::{web, HttpResponse};

use crate::db::models::ChatRequest;
use crate::error::AppError;

fn parse_streamed_response(raw: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
        for key in ["output", "text", "content"] {
            if let Some(value) = parsed.get(key).and_then(|value| value.as_str()) {
                return value.to_string();
            }
        }
        if let Some(value) = parsed.as_str() {
            return value.to_string();
        }
    }

    let regex = regex::Regex::new(r#""type"\s*:\s*"item"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)""#)
        .expect("valid regex");
    let contents = regex
        .captures_iter(raw)
        .filter_map(|capture| capture.get(1))
        .map(|value| {
            value
                .as_str()
                .replace("\\n", "\n")
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
        })
        .collect::<Vec<_>>();
    if contents.is_empty() {
        raw.to_string()
    } else {
        contents.join("")
    }
}

pub async fn post(body: web::Json<ChatRequest>) -> Result<HttpResponse, AppError> {
    let message = body
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Message is required.".to_string()))?;
    let session_id = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(cuid2::create_id);
    let url = std::env::var("N8N_CHAT_WEBHOOK_URL").unwrap_or_else(|_| {
        "https://primary-production-738c.up.railway.app/webhook/a21d3f79-cfa7-44b1-b0e3-93ab1e51176d/chat"
            .to_string()
    });
    let upstream = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({
            "action": "sendMessage",
            "sessionId": session_id,
            "chatInput": message,
            "metadata": body.metadata.clone().unwrap_or(serde_json::json!({}))
        }))
        .send()
        .await?;
    let status = upstream.status();
    let raw = upstream.text().await.unwrap_or_default();
    let reply = parse_streamed_response(&raw).trim().to_string();

    if !status.is_success() {
        return Ok(HttpResponse::build(actix_web::http::StatusCode::from_u16(status.as_u16()).unwrap_or(actix_web::http::StatusCode::BAD_GATEWAY))
            .json(serde_json::json!({
                "error": "The assistant is currently unavailable.",
                "details": if reply.is_empty() { raw } else { reply }
            })));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "sessionId": session_id,
        "reply": reply
    })))
}
