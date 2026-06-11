use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::AppConfig;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct ProvisionerDispatchPayload {
    pub action: String,
    #[serde(rename = "botId")]
    pub bot_id: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "deploymentId")]
    pub deployment_id: String,
    #[serde(rename = "versionNumber")]
    pub version_number: i32,
    pub name: String,
    #[serde(rename = "type")]
    pub bot_type: String,
    pub status: String,
    pub language: String,
    #[serde(rename = "greetingMessage")]
    pub greeting_message: Option<String>,
    pub personality: Option<String>,
    pub capabilities: Option<Value>,
    #[serde(rename = "knowledgeBase")]
    pub knowledge_base: Option<Value>,
    #[serde(rename = "integrationConfig")]
    pub integration_config: Option<Value>,
    pub template: ProvisionerTemplateDefinition,
    pub callbacks: ProvisionerCallbacks,
    #[serde(rename = "channelConfig")]
    pub channel_config: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProvisionerTemplateDefinition {
    pub key: String,
    pub channel: String,
    #[serde(rename = "workflowTemplate")]
    pub workflow_template: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProvisionerCallbacks {
    #[serde(rename = "deploymentCallbackUrl")]
    pub deployment_callback_url: String,
    #[serde(rename = "runtimeEventUrl")]
    pub runtime_event_url: String,
    #[serde(rename = "authToken")]
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProvisionerDispatchResult {
    #[serde(rename = "workflowId")]
    pub workflow_id: Option<String>,
    pub status: Option<String>,
    pub message: Option<String>,
    pub payload: Option<Value>,
}

pub fn template_definition(bot_type: &str, integration_config: Option<&Value>) -> ProvisionerTemplateDefinition {
    let channel = integration_config
        .and_then(|value| value.get("channel"))
        .and_then(|value| value.as_str())
        .unwrap_or(match bot_type {
            "whatsapp_agent" => "whatsapp",
            "website_agent" => "website",
            "voice_agent" => "voice",
            "support_agent" => "support",
            "booking_agent" => "booking",
            "lead_qualification_agent" => "lead_qualification",
            _ => "general",
        });

    match bot_type {
        "whatsapp_agent" => ProvisionerTemplateDefinition {
            key: "whatsapp_agent".to_string(),
            channel: channel.to_string(),
            workflow_template: "kasitek_whatsapp_agent_v1".to_string(),
            description: "Managed WhatsApp agent with reply, qualification, and handoff flow."
                .to_string(),
        },
        "website_agent" => ProvisionerTemplateDefinition {
            key: "website_agent".to_string(),
            channel: channel.to_string(),
            workflow_template: "kasitek_website_agent_v1".to_string(),
            description: "Managed website chat agent for lead capture, booking, and quote routing."
                .to_string(),
        },
        "voice_agent" => ProvisionerTemplateDefinition {
            key: "voice_agent".to_string(),
            channel: channel.to_string(),
            workflow_template: "kasitek_voice_agent_v1".to_string(),
            description: "Managed voice workflow for call intake, triage, and escalation.".to_string(),
        },
        other => ProvisionerTemplateDefinition {
            key: other.to_string(),
            channel: channel.to_string(),
            workflow_template: format!("kasitek_{other}_v1"),
            description: "Managed KasiAgents workflow template.".to_string(),
        },
    }
}

pub fn channel_config(bot_type: &str, integration_config: Option<&Value>) -> Value {
    let base = integration_config.cloned().unwrap_or_else(|| json!({}));
    match bot_type {
        "whatsapp_agent" => json!({
            "channel": "whatsapp",
            "requires": ["whatsapp_connection", "message_webhook", "human_handoff"],
            "features": ["reply", "qualification", "handoff", "event_tracking"],
            "integration": base,
        }),
        "website_agent" => json!({
            "channel": "website",
            "requires": ["website_widget", "lead_capture", "human_handoff"],
            "features": ["chat", "lead_capture", "booking_or_quote", "event_tracking"],
            "integration": base,
        }),
        _ => json!({
            "channel": integration_config
                .and_then(|value| value.get("channel"))
                .and_then(|value| value.as_str())
                .unwrap_or("general"),
            "integration": base,
        }),
    }
}

pub async fn dispatch_provisioner_action(
    config: &AppConfig,
    payload: &ProvisionerDispatchPayload,
) -> Result<Option<ProvisionerDispatchResult>, AppError> {
    let Some(base_url) = config
        .n8n_provisioner_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let client = reqwest::Client::new();
    let mut request = client.post(base_url).json(payload);

    if let Some(token) = config
        .n8n_provisioner_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.bearer_auth(token);
    }

    let response = request.send().await?;

    if response.status().is_success() {
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        let mut parsed: ProvisionerDispatchResult =
            serde_json::from_value(value.clone()).unwrap_or_default();
        if parsed.payload.is_none() {
          parsed.payload = Some(value);
        }
        Ok(Some(parsed))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(AppError::Internal(if text.is_empty() {
            "Provisioner request failed".to_string()
        } else {
            format!("Provisioner request failed: {text}")
        }))
    }
}
