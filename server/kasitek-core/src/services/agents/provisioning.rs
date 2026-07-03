use serde_json::{json, Value};

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::agents::client::{parse_workflow_id, N8nClient};
use crate::services::agents::templates::build_workflow;
use crate::services::agents::types::{
    AgentCallbacks, AgentDispatchPayload, AgentDispatchResult, AgentTemplateDefinition,
};

pub fn template_definition(
    bot_type: &str,
    integration_config: Option<&Value>,
) -> AgentTemplateDefinition {
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
        "whatsapp_agent" => AgentTemplateDefinition {
            key: "whatsapp_agent".to_string(),
            channel: channel.to_string(),
            workflow_template: "kasitek_whatsapp_agent_v1".to_string(),
            description: "Managed WhatsApp agent with reply, qualification, and handoff flow."
                .to_string(),
        },
        "website_agent" => AgentTemplateDefinition {
            key: "website_agent".to_string(),
            channel: channel.to_string(),
            workflow_template: "kasitek_website_agent_v1".to_string(),
            description: "Managed website chat agent for lead capture, booking, and quote routing."
                .to_string(),
        },
        "voice_agent" => AgentTemplateDefinition {
            key: "voice_agent".to_string(),
            channel: channel.to_string(),
            workflow_template: "kasitek_voice_agent_v1".to_string(),
            description: "Managed voice workflow for call intake, triage, and escalation."
                .to_string(),
        },
        other => AgentTemplateDefinition {
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

fn derive_n8n_base_url(api_url: &str) -> String {
    api_url
        .trim_end_matches('/')
        .trim_end_matches("/api/v1")
        .trim_end_matches("/api")
        .to_string()
}

fn attach_ingress_urls(config: &AppConfig, payload: &mut Value) {
    let Some(api_url) = config
        .n8n_api_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    let Some(deployment) = payload
        .get_mut("deployment")
        .and_then(|value| value.as_object_mut())
    else {
        return;
    };
    let Some(ingress) = deployment
        .get_mut("ingress")
        .and_then(|value| value.as_object_mut())
    else {
        return;
    };
    let Some(path) = ingress.get("path").and_then(|value| value.as_str()) else {
        return;
    };

    let public_base = derive_n8n_base_url(api_url);
    ingress.insert(
        "url".to_string(),
        Value::String(format!(
            "{}/webhook/{}",
            public_base.trim_end_matches('/'),
            path.trim_start_matches('/')
        )),
    );
}

async fn provision(
    config: &AppConfig,
    client: &N8nClient,
    payload: AgentDispatchPayload,
) -> Result<AgentDispatchResult, AppError> {
    let built = build_workflow(&payload);
    let created = client.create_workflow(built.workflow).await?;
    let workflow_id = parse_workflow_id(&created).ok_or_else(|| {
        AppError::Internal("n8n did not return a workflow id after creation".to_string())
    })?;
    let activated = client.activate_workflow(&workflow_id).await?;

    let mut response_payload = json!({
        "created": created,
        "activated": activated,
        "templateKey": payload.template.key,
        "workflowTemplate": payload.template.workflow_template,
        "deployment": built.deployment_payload,
    });
    attach_ingress_urls(config, &mut response_payload);

    Ok(AgentDispatchResult {
        workflow_id: Some(workflow_id),
        status: Some("active".to_string()),
        message: Some("Workflow provisioned and activated".to_string()),
        payload: Some(response_payload),
    })
}

async fn pause_or_resume(
    client: &N8nClient,
    payload: AgentDispatchPayload,
    resume: bool,
) -> Result<AgentDispatchResult, AppError> {
    let workflow_id = payload.workflow_id.clone().ok_or_else(|| {
        AppError::BadRequest("workflowId is required for pause/resume".to_string())
    })?;

    let n8n_result = if resume {
        client.activate_workflow(&workflow_id).await?
    } else {
        client.deactivate_workflow(&workflow_id).await?
    };

    let next_status = if resume { "active" } else { "paused" };
    let message = if resume {
        "Workflow re-activated"
    } else {
        "Workflow paused"
    };

    Ok(AgentDispatchResult {
        workflow_id: Some(workflow_id.clone()),
        status: Some(next_status.to_string()),
        message: Some(message.to_string()),
        payload: Some(json!({
            "result": n8n_result,
            "action": payload.action,
            "workflowId": workflow_id,
        })),
    })
}

pub async fn execute(
    config: &AppConfig,
    payload: AgentDispatchPayload,
) -> Result<Option<AgentDispatchResult>, AppError> {
    let Some(client) = N8nClient::from_config(config) else {
        return Ok(None);
    };

    log::info!(
        "dispatching agent action={} bot_id={} deployment_id={} type={} version={}",
        payload.action,
        payload.bot_id,
        payload.deployment_id,
        payload.bot_type,
        payload.version_number
    );

    let result = match payload.action.as_str() {
        "provision" => provision(config, &client, payload).await?,
        "pause" => pause_or_resume(&client, payload, false).await?,
        "resume" => pause_or_resume(&client, payload, true).await?,
        other => return Err(AppError::BadRequest(format!("Unsupported action: {other}"))),
    };

    Ok(Some(result))
}

pub fn callbacks(config: &AppConfig, bot_id: &str, deployment_id: &str) -> AgentCallbacks {
    AgentCallbacks {
        deployment_callback_url: format!(
            "{}/api/bots/{}/deployments/{}/callback",
            config.public_api_url.trim_end_matches('/'),
            bot_id,
            deployment_id
        ),
        runtime_event_url: format!(
            "{}/api/bots/{}/events/trusted",
            config.public_api_url.trim_end_matches('/'),
            bot_id
        ),
        auth_token: config.n8n_callback_token.clone(),
    }
}
