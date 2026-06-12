use serde_json::{json, Value};

use crate::config::AppConfig;
use crate::error::AppError;

#[derive(Clone)]
pub struct N8nClient {
    client: reqwest::Client,
    api_url: String,
    api_key: String,
}

impl N8nClient {
    pub fn from_config(config: &AppConfig) -> Option<Self> {
        let api_url = config
            .n8n_api_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        let api_key = config
            .n8n_api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())?;

        Some(Self {
            client: reqwest::Client::new(),
            api_url: api_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        })
    }

    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let url = format!("{}/{}", self.api_url, path.trim_start_matches('/'));
        let mut request = self
            .client
            .request(method, url)
            .header("X-N8N-API-KEY", &self.api_key);

        if let Some(payload) = body {
            request = request.json(&payload);
        }

        let response = request.send().await?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AppError::Internal(if text.is_empty() {
                format!("n8n API request failed with status {}", status)
            } else {
                format!("n8n API request failed with status {}: {}", status, text)
            }));
        }

        if text.is_empty() {
            Ok(json!({}))
        } else {
            serde_json::from_str(&text).map_err(|error| {
                AppError::Internal(format!("Failed to parse n8n response JSON: {error}"))
            })
        }
    }

    pub async fn create_workflow(&self, workflow: Value) -> Result<Value, AppError> {
        self.send_json(reqwest::Method::POST, "/workflows", Some(workflow))
            .await
    }

    pub async fn activate_workflow(&self, workflow_id: &str) -> Result<Value, AppError> {
        self.send_json(
            reqwest::Method::POST,
            &format!("/workflows/{workflow_id}/activate"),
            None,
        )
        .await
    }

    pub async fn deactivate_workflow(&self, workflow_id: &str) -> Result<Value, AppError> {
        self.send_json(
            reqwest::Method::POST,
            &format!("/workflows/{workflow_id}/deactivate"),
            None,
        )
        .await
    }
}

pub fn parse_workflow_id(value: &Value) -> Option<String> {
    value.get("id").map(|id| match id {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    })
}
