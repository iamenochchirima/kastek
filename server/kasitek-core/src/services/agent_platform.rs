use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use rand::RngCore;
use reqwest::{
    header::HeaderMap,
    multipart::{Form, Part},
    Client, Method, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::AppConfig;
use crate::error::AppError;

type HmacSha256 = Hmac<Sha256>;

fn new_correlation_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InternalClaims<'a> {
    organization_id: &'a str,
    actor_id: &'a str,
    correlation_id: String,
    audience: &'a str,
    expires_at: u64,
    scopes: &'a [&'a str],
    #[serde(skip_serializing_if = "Option::is_none")]
    operator: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UpstreamError {
    error: Option<String>,
    code: Option<String>,
}

pub struct AgentPlatformClient {
    client: Client,
    base_url: String,
    secret: String,
    audience: String,
    timeout: Duration,
}

impl AgentPlatformClient {
    pub fn from_config(config: &AppConfig) -> Result<Self, AppError> {
        let base_url = config
            .agents_api_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::ServiceUnavailable("Agent Platform is not configured".to_string())
            })?;
        let secret = config
            .agents_internal_auth_secret
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::ServiceUnavailable(
                    "Agent Platform authentication is not configured".to_string(),
                )
            })?;
        let client = Client::builder()
            .connect_timeout(Duration::from_millis(config.agents_api_timeout_ms as u64))
            .build()
            .map_err(|error| {
                AppError::Internal(format!("Agent Platform client setup failed: {error}"))
            })?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.to_string(),
            audience: config.agents_internal_auth_audience.clone(),
            timeout: Duration::from_millis(config.agents_api_timeout_ms as u64),
        })
    }

    pub async fn ensure_kasiai(
        &self,
        organization_id: &str,
        actor_id: &str,
        settings: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/system-agents/kasiai/installation",
            organization_id,
            actor_id,
            &["kasiai:write"],
            Some(settings),
        )
        .await
    }

    pub async fn list_agents(
        &self,
        organization_id: &str,
        actor_id: &str,
        environment: Option<&str>,
    ) -> Result<Value, AppError> {
        let path = environment
            .map(|value| format!("/v1/agents?environment={value}"))
            .unwrap_or_else(|| "/v1/agents".to_string());
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn get_model_catalog(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/models/catalog",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_capabilities(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/capabilities",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_capability_directory(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/capabilities/directory",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_connection_directory(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/connection-directory"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn create_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/agents",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn create_studio_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/studio/agents",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn update_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::PATCH,
            &format!("/v1/agents/{agent_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn delete_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/agents/{agent_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn verify_provider_credential(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/credentials/verify",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn create_provider_credential(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/credentials",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn list_provider_credentials(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/credentials",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn create_external_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/external-agents",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn list_external_agents(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/external-agents",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn get_external_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/external-agents/{installation_id}"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn get_external_agent_health(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/external-agents/{installation_id}/health"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn archive_external_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/external-agents/{installation_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn set_external_agent_status(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        status: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/external-agents/{installation_id}/status/{status}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn create_agent_version(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/agents/{agent_id}/versions"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn operations_summary(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/operations/summary",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn operations_runs(
        &self,
        organization_id: &str,
        actor_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = match limit {
            Some(limit) => format!("/v1/operations/runs?limit={limit}"),
            None => "/v1/operations/runs".to_string(),
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn operations_health(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/operations/health",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn operations_effects_reconciliation(
        &self,
        organization_id: &str,
        actor_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = match limit {
            Some(limit) => format!("/v1/operations/effects/reconciliation?limit={limit}"),
            None => "/v1/operations/effects/reconciliation".to_string(),
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn reconcile_effect(
        &self,
        organization_id: &str,
        actor_id: &str,
        effect_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/operations/effects/{effect_id}/reconcile"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn list_kill_switches(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/operations/kill-switches",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn create_kill_switch(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/operations/kill-switches",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn disable_kill_switch(
        &self,
        organization_id: &str,
        actor_id: &str,
        switch_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/operations/kill-switches/{switch_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn list_audit(
        &self,
        organization_id: &str,
        actor_id: &str,
        action: Option<&str>,
        resource_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        if let Some(action) = action.filter(|value| !value.trim().is_empty()) {
            query.push(format!("action={}", urlencoding::encode(action)));
        }
        if let Some(resource_type) = resource_type.filter(|value| !value.trim().is_empty()) {
            query.push(format!(
                "resourceType={}",
                urlencoding::encode(resource_type)
            ));
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        let path = if query.is_empty() {
            "/v1/audit".to_string()
        } else {
            format!("/v1/audit?{}", query.join("&"))
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn operator_summary(&self, operator_id: &str) -> Result<Value, AppError> {
        self.request_operator_json(
            Method::GET,
            "/v1/operator/summary",
            operator_id,
            &["operator:read"],
            None,
        )
        .await
    }

    pub async fn operator_runs(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/runs?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/runs".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_exports(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/exports?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/exports".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_kill_switches(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/kill-switches?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/kill-switches".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_feature_flags(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/feature-flags?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/feature-flags".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_audio_transcription_jobs(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/audio-transcription/jobs?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/audio-transcription/jobs".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_holds(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/holds?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/holds".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_retention_policies(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/retention/policies?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/retention/policies".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_legal_holds(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/retention/legal-holds?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/retention/legal-holds".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_retention_preview(
        &self,
        operator_id: &str,
        organization_id: &str,
    ) -> Result<Value, AppError> {
        self.request_operator_json(
            Method::GET,
            &format!(
                "/v1/operator/retention/preview/{}",
                urlencoding::encode(organization_id)
            ),
            operator_id,
            &["operator:read"],
            None,
        )
        .await
    }

    pub async fn operator_health(&self, operator_id: &str) -> Result<Value, AppError> {
        self.request_operator_json(
            Method::GET,
            "/v1/operator/health",
            operator_id,
            &["operator:read"],
            None,
        )
        .await
    }

    pub async fn operator_effects_reconciliation(
        &self,
        operator_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = limit
            .map(|value| format!("/v1/operator/effects/reconciliation?limit={value}"))
            .unwrap_or_else(|| "/v1/operator/effects/reconciliation".to_string());
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_audit(
        &self,
        operator_id: &str,
        action: Option<&str>,
        resource_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        if let Some(value) = action.filter(|value| !value.trim().is_empty()) {
            query.push(format!("action={}", urlencoding::encode(value)));
        }
        if let Some(value) = resource_type.filter(|value| !value.trim().is_empty()) {
            query.push(format!("resourceType={}", urlencoding::encode(value)));
        }
        if let Some(value) = limit {
            query.push(format!("limit={value}"));
        }
        let path = if query.is_empty() {
            "/v1/operator/audit".to_string()
        } else {
            format!("/v1/operator/audit?{}", query.join("&"))
        };
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_search(
        &self,
        operator_id: &str,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let mut path = format!("/v1/operator/search?q={}", urlencoding::encode(query));
        if let Some(value) = limit {
            path.push_str(&format!("&limit={value}"));
        }
        self.request_operator_json(Method::GET, &path, operator_id, &["operator:read"], None)
            .await
    }

    pub async fn operator_create_command(
        &self,
        operator_id: &str,
        idempotency_key: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_operator_command(
            Method::POST,
            "/v1/operator/commands",
            operator_id,
            &["operator:write"],
            Some(idempotency_key),
            Some(body),
        )
        .await
    }

    pub async fn operator_get_command(
        &self,
        operator_id: &str,
        command_id: &str,
    ) -> Result<Value, AppError> {
        self.request_operator_command(
            Method::GET,
            &format!("/v1/operator/commands/{}", urlencoding::encode(command_id)),
            operator_id,
            &["operator:read"],
            None,
            None,
        )
        .await
    }

    pub async fn operator_approve_command(
        &self,
        operator_id: &str,
        command_id: &str,
    ) -> Result<Value, AppError> {
        self.request_operator_command(
            Method::POST,
            &format!(
                "/v1/operator/commands/{}/approve",
                urlencoding::encode(command_id)
            ),
            operator_id,
            &["operator:write"],
            None,
            Some(json!({})),
        )
        .await
    }

    pub async fn operator_projection(
        &self,
        operator_id: &str,
        projection_key: &str,
    ) -> Result<Value, AppError> {
        self.request_operator_json(
            Method::GET,
            &format!(
                "/v1/operator/projections/{}",
                urlencoding::encode(projection_key)
            ),
            operator_id,
            &["operator:read"],
            None,
        )
        .await
    }

    pub async fn operator_rebuild_projections(
        &self,
        operator_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_operator_command(
            Method::POST,
            "/v1/operator/projections/rebuild",
            operator_id,
            &["operator:write"],
            None,
            Some(body),
        )
        .await
    }

    pub async fn list_templates(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/templates",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn install_template(
        &self,
        organization_id: &str,
        actor_id: &str,
        template_key: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/templates/{template_key}/install"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn set_installation_status(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        status: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/status/{status}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn set_installation_settings(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        settings: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::PATCH,
            &format!("/v1/installations/{installation_id}/settings"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(settings),
        )
        .await
    }

    pub async fn list_installation_credentials(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/credentials"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn create_installation_credential(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/credentials"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn revoke_installation_credential(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        credential_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/installations/{installation_id}/credentials/{credential_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn rotate_installation_credential(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        credential_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/credentials/{credential_id}/rotate"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn list_installation_capabilities(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        credential_id: Option<&str>,
    ) -> Result<Value, AppError> {
        let path = credential_id
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                format!(
                    "/v1/installations/{installation_id}/capabilities?credentialId={}",
                    urlencoding::encode(value)
                )
            })
            .unwrap_or_else(|| format!("/v1/installations/{installation_id}/capabilities"));
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn get_installation_readiness(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/readiness"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_skills(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/skills",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_skill_directory(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_version_id: Option<&str>,
    ) -> Result<Value, AppError> {
        let path = agent_version_id
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                format!(
                    "/v1/skills/directory?agentVersionId={}",
                    urlencoding::encode(value)
                )
            })
            .unwrap_or_else(|| "/v1/skills/directory".to_string());
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_plugin_directory(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/plugins/directory",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn install_skill_catalog(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        catalog_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/skills/catalog/{catalog_id}/install"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn install_plugin_catalog(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        catalog_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/plugins/catalog/{catalog_id}/install"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn list_extension_packages(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/extensions/packages",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_skill_versions(
        &self,
        organization_id: &str,
        actor_id: &str,
        skill_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/skills/{skill_id}/versions"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_pinned_skills(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/agent-versions/{agent_version_id}/skills"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn pin_skill(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_version_id: &str,
        skill_version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/agent-versions/{agent_version_id}/skills/{skill_version_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn unpin_skill(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_version_id: &str,
        skill_version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/agent-versions/{agent_version_id}/skills/{skill_version_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn list_mcp_providers(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/mcp/providers",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn connect_mcp_catalog(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        catalog_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/mcp/catalog/{catalog_id}/connect"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn start_mcp_catalog_oauth(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        catalog_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/mcp/catalog/{catalog_id}/oauth/start"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn complete_mcp_oauth_callback(&self, query: &str) -> Result<Value, AppError> {
        let path = if query.trim().is_empty() {
            "/v1/integrations/mcp/oauth/callback".to_string()
        } else {
            format!("/v1/integrations/mcp/oauth/callback?{query}")
        };
        self.request_oauth_callback(&path).await
    }

    pub async fn complete_google_calendar_oauth_callback(
        &self,
        query: &str,
    ) -> Result<Value, AppError> {
        let path = if query.trim().is_empty() {
            "/v1/integrations/google.calendar/oauth/callback".to_string()
        } else {
            format!("/v1/integrations/google.calendar/oauth/callback?{query}")
        };
        self.request_oauth_callback(&path).await
    }

    pub async fn create_mcp_provider(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/mcp/providers",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn discover_mcp_provider(
        &self,
        organization_id: &str,
        actor_id: &str,
        provider_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/mcp/providers/{provider_id}/discover"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn health_mcp_provider(
        &self,
        organization_id: &str,
        actor_id: &str,
        provider_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/mcp/providers/{provider_id}/health"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn list_mcp_provider_versions(
        &self,
        organization_id: &str,
        actor_id: &str,
        provider_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/mcp/providers/{provider_id}/versions"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn publish_mcp_provider_version(
        &self,
        organization_id: &str,
        actor_id: &str,
        provider_id: &str,
        version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/mcp/providers/{provider_id}/versions/{version_id}/publish"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn revoke_mcp_provider(
        &self,
        organization_id: &str,
        actor_id: &str,
        provider_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/mcp/providers/{provider_id}/revoke"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn list_pinned_mcp_providers(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/agent-versions/{agent_version_id}/mcp-providers"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn pin_mcp_provider(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_version_id: &str,
        provider_version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/agent-versions/{agent_version_id}/mcp-providers/{provider_version_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn unpin_mcp_provider(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_version_id: &str,
        provider_version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/agent-versions/{agent_version_id}/mcp-providers/{provider_version_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn list_integrations_catalog(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/integrations/catalog",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_installation_integrations(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/integrations"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn start_google_calendar_oauth(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!(
                "/v1/installations/{installation_id}/integrations/google.calendar/oauth/start"
            ),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn save_integration_api_key(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        integration_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/integrations/{integration_id}/api-key"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn save_integration_local_connector(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        integration_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!(
                "/v1/installations/{installation_id}/integrations/{integration_id}/local-connector"
            ),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn disconnect_integration(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        integration_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/installations/{installation_id}/integrations/{integration_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn grant_installation_tool(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        tool_name: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/tools"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(json!({ "toolName": tool_name })),
        )
        .await
    }

    pub async fn list_installation_grants(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/grants"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn grant_installation_resource(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/grants/resources"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn list_connectors(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/connectors",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_installation_connectors(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/connectors"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn grant_installation_connector(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/grants/connectors"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn list_installation_runs(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let path = match limit {
            Some(limit) => format!("/v1/installations/{installation_id}/runs?limit={limit}"),
            None => format!("/v1/installations/{installation_id}/runs"),
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_installation_schedules(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/schedules"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn create_installation_schedule(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/schedules"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn set_schedule_status(
        &self,
        organization_id: &str,
        actor_id: &str,
        schedule_id: &str,
        status: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/schedules/{schedule_id}/status/{status}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn list_knowledge_sources(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: Option<&str>,
        installation_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        if let Some(agent_id) = agent_id.filter(|value| !value.trim().is_empty()) {
            query.push(format!("agentId={}", urlencoding::encode(agent_id)));
        }
        if let Some(installation_id) = installation_id.filter(|value| !value.trim().is_empty()) {
            query.push(format!(
                "installationId={}",
                urlencoding::encode(installation_id)
            ));
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        let path = if query.is_empty() {
            "/v1/knowledge/sources".to_string()
        } else {
            format!("/v1/knowledge/sources?{}", query.join("&"))
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn create_knowledge_source(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/knowledge/sources",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn get_knowledge_source(
        &self,
        organization_id: &str,
        actor_id: &str,
        source_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/knowledge/sources/{source_id}"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn ingest_knowledge_source_url(
        &self,
        organization_id: &str,
        actor_id: &str,
        source_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/knowledge/sources/{source_id}/ingest-url"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn ingest_knowledge_source_text(
        &self,
        organization_id: &str,
        actor_id: &str,
        source_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/knowledge/sources/{source_id}/ingest-text"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn ingest_knowledge_source_file(
        &self,
        organization_id: &str,
        actor_id: &str,
        source_id: &str,
        content_type: String,
        body: Bytes,
    ) -> Result<Value, AppError> {
        self.request_bytes(
            Method::POST,
            &format!("/v1/knowledge/sources/{source_id}/ingest-file"),
            organization_id,
            actor_id,
            &["agents:write"],
            content_type,
            body,
        )
        .await
    }

    pub async fn delete_knowledge_source(
        &self,
        organization_id: &str,
        actor_id: &str,
        source_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/knowledge/sources/{source_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn map_agent_website(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/knowledge/websites/map",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn start_agent_website_crawl(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/knowledge/websites/crawl",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn get_agent_website_crawl(
        &self,
        organization_id: &str,
        actor_id: &str,
        source_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/knowledge/websites/crawl/{source_id}"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn cancel_agent_website_crawl(
        &self,
        organization_id: &str,
        actor_id: &str,
        source_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/knowledge/websites/crawl/{source_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn list_memory(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
        installation_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let mut query = vec![format!("agentId={}", urlencoding::encode(agent_id))];
        if let Some(installation_id) = installation_id.filter(|value| !value.trim().is_empty()) {
            query.push(format!(
                "installationId={}",
                urlencoding::encode(installation_id)
            ));
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        self.request_json(
            Method::GET,
            &format!("/v1/memory?{}", query.join("&")),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn delete_memory(
        &self,
        organization_id: &str,
        actor_id: &str,
        memory_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/memory/{memory_id}"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn revalidate_memory(
        &self,
        organization_id: &str,
        actor_id: &str,
        memory_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/memory/{memory_id}/revalidate"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn list_agent_versions(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/agents/{agent_id}/versions"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn publish_agent_version(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
        version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/agents/{agent_id}/versions/{version_id}/publish"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn create_installation(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/installations",
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn rollback_agent_version(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
        version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/agents/{agent_id}/versions/{version_id}/rollback"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn retire_agent_version(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
        version_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/agents/{agent_id}/versions/{version_id}/retire"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn archive_agent(
        &self,
        organization_id: &str,
        actor_id: &str,
        agent_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/agents/{agent_id}/archive"),
            organization_id,
            actor_id,
            &["agents:write"],
            None,
        )
        .await
    }

    pub async fn resolve_platform_conversation(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/platform/conversation"),
            organization_id,
            actor_id,
            &["chat:read"],
            Some(json!({})),
        )
        .await
    }

    pub async fn create_platform_conversation(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/platform/conversation/new"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn clear_platform_conversations(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/platform/conversations/clear"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn list_conversations(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/conversations"),
            organization_id,
            actor_id,
            &["chat:read"],
            None,
        )
        .await
    }

    pub async fn list_handoffs(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: Option<&str>,
        agent_id: Option<&str>,
        channel_type: Option<&str>,
        reason: Option<&str>,
        status: Option<&str>,
        assignment: Option<&str>,
        priority: Option<&str>,
        search: Option<&str>,
        limit: Option<u32>,
        cursor: Option<&str>,
        before: Option<&str>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        for (key, value) in [
            ("installationId", installation_id),
            ("agentId", agent_id),
            ("channelType", channel_type),
            ("reason", reason),
            ("status", status),
            ("assignment", assignment),
            ("priority", priority),
            ("search", search),
            ("cursor", cursor),
            ("before", before),
        ] {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                query.push(format!("{key}={}", urlencoding::encode(value)));
            }
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        let path = if query.is_empty() {
            "/v1/conversations/handoffs".to_string()
        } else {
            format!("/v1/conversations/handoffs?{}", query.join("&"))
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn stream_conversation_feed_events(
        &self,
        organization_id: &str,
        actor_id: &str,
    ) -> Result<Response, AppError> {
        let correlation_id = new_correlation_id();
        let request = self
            .client
            .get(format!("{}/v1/conversations/events/stream", self.base_url))
            .header("accept", "text/event-stream")
            .header(
                "Authorization",
                format!(
                    "Bearer {}",
                    self.token(organization_id, actor_id, &["agents:read"], &correlation_id)?
                ),
            )
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id);
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(self.map_status(response).await)
    }

    pub async fn list_live_conversations(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: Option<&str>,
        agent_id: Option<&str>,
        channel_type: Option<&str>,
        search: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        for (key, value) in [
            ("installationId", installation_id),
            ("agentId", agent_id),
            ("channelType", channel_type),
            ("search", search),
        ] {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                query.push(format!("{key}={}", urlencoding::encode(value)));
            }
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        let path = if query.is_empty() {
            "/v1/conversations/live".to_string()
        } else {
            format!("/v1/conversations/live?{}", query.join("&"))
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn list_customer_conversations(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: Option<&str>,
        agent_id: Option<&str>,
        channel_type: Option<&str>,
        search: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        for (key, value) in [
            ("installationId", installation_id),
            ("agentId", agent_id),
            ("channelType", channel_type),
            ("search", search),
        ] {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                query.push(format!("{key}={}", urlencoding::encode(value)));
            }
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        let path = if query.is_empty() {
            "/v1/conversations/customer".to_string()
        } else {
            format!("/v1/conversations/customer?{}", query.join("&"))
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn get_conversation_summary(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: Option<&str>,
        agent_id: Option<&str>,
        channel_type: Option<&str>,
        search: Option<&str>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        for (key, value) in [
            ("installationId", installation_id),
            ("agentId", agent_id),
            ("channelType", channel_type),
            ("search", search),
        ] {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                query.push(format!("{key}={}", urlencoding::encode(value)));
            }
        }
        let path = if query.is_empty() {
            "/v1/conversations/summary".to_string()
        } else {
            format!("/v1/conversations/summary?{}", query.join("&"))
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn stream_conversation_events(
        &self,
        organization_id: &str,
        actor_id: &str,
        conversation_id: &str,
        after: Option<u64>,
    ) -> Result<Response, AppError> {
        let mut url = format!(
            "{}/v1/conversations/{conversation_id}/events/stream",
            self.base_url
        );
        if let Some(after) = after {
            url.push_str(&format!("?after={after}"));
        }
        let correlation_id = new_correlation_id();
        let request = self
            .client
            .get(url)
            .header("accept", "text/event-stream")
            .header(
                "Authorization",
                format!(
                    "Bearer {}",
                    self.token(organization_id, actor_id, &["agents:read"], &correlation_id)?
                ),
            )
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id);
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(self.map_status(response).await)
    }

    pub async fn get_handoff(
        &self,
        organization_id: &str,
        actor_id: &str,
        handoff_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/conversations/handoffs/{handoff_id}"),
            organization_id,
            actor_id,
            &["agents:read"],
            None,
        )
        .await
    }

    pub async fn claim_handoff(
        &self,
        organization_id: &str,
        actor_id: &str,
        handoff_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/handoffs/{handoff_id}/claim"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn release_handoff(
        &self,
        organization_id: &str,
        actor_id: &str,
        handoff_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/handoffs/{handoff_id}/release"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn expire_handoff(
        &self,
        organization_id: &str,
        actor_id: &str,
        handoff_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/handoffs/{handoff_id}/expire"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn continue_handoff(
        &self,
        organization_id: &str,
        actor_id: &str,
        handoff_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/handoffs/{handoff_id}/continue"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn resolve_handoff(
        &self,
        organization_id: &str,
        actor_id: &str,
        handoff_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/handoffs/{handoff_id}/resolve"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn send_human_message(
        &self,
        organization_id: &str,
        actor_id: &str,
        handoff_id: &str,
        body: Value,
        idempotency_key: &str,
    ) -> Result<Value, AppError> {
        let mut body = body;
        if let Value::Object(ref mut object) = body {
            object.insert(
                "idempotencyKey".to_string(),
                Value::String(idempotency_key.to_string()),
            );
        }
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/handoffs/{handoff_id}/messages"),
            organization_id,
            actor_id,
            &["agents:write"],
            Some(body),
        )
        .await
    }

    pub async fn kasiai_home(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/kasiai/home"),
            organization_id,
            actor_id,
            &["kasiai:read"],
            Some(json!({})),
        )
        .await
    }

    pub async fn kasiai_preferences(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/kasiai/preferences"),
            organization_id,
            actor_id,
            &["kasiai:read"],
            None,
        )
        .await
    }

    pub async fn update_kasiai_preferences(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::PATCH,
            &format!("/v1/installations/{installation_id}/kasiai/preferences"),
            organization_id,
            actor_id,
            &["kasiai:write"],
            Some(body),
        )
        .await
    }

    pub async fn update_conversation(
        &self,
        organization_id: &str,
        actor_id: &str,
        conversation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::PATCH,
            &format!("/v1/conversations/{conversation_id}"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(body),
        )
        .await
    }

    pub async fn set_channel_default_conversation(
        &self,
        organization_id: &str,
        actor_id: &str,
        conversation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/{conversation_id}/channel-default"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn set_conversation_status(
        &self,
        organization_id: &str,
        actor_id: &str,
        conversation_id: &str,
        status: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/{conversation_id}/status/{status}"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn restore_conversation(
        &self,
        organization_id: &str,
        actor_id: &str,
        conversation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/conversations/{conversation_id}/restore"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn send_platform_message(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/platform/messages"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(body),
        )
        .await
    }

    pub async fn send_platform_audio(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        bytes: Vec<u8>,
        mime_type: &str,
        file_name: Option<&str>,
        idempotency_key: &str,
        conversation_id: &str,
        caption: Option<&str>,
        context_route: Option<&str>,
        context_title: Option<&str>,
    ) -> Result<Value, AppError> {
        let mut part = Part::bytes(bytes)
            .mime_str(mime_type)
            .map_err(|_| AppError::BadRequest("Audio MIME type is invalid".to_string()))?;
        if let Some(file_name) = file_name.filter(|value| !value.trim().is_empty()) {
            part = part.file_name(file_name.to_string());
        }
        let correlation_id = new_correlation_id();
        let token = self.token(organization_id, actor_id, &["chat:write"], &correlation_id)?;
        let mut request = self
            .client
            .request(
                Method::POST,
                format!(
                    "{}/v1/installations/{installation_id}/platform/audio",
                    self.base_url
                ),
            )
            .timeout(self.timeout)
            .header("Authorization", format!("Bearer {token}"))
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id)
            .header("x-audio-idempotency-key", idempotency_key)
            .header("x-audio-conversation-id", conversation_id);
        if let Some(caption) = caption.filter(|value| !value.trim().is_empty()) {
            request = request.header("x-audio-caption", caption);
        }
        if let Some(route) = context_route.filter(|value| !value.trim().is_empty()) {
            request = request.header("x-audio-context-route", route);
        }
        if let Some(title) = context_title.filter(|value| !value.trim().is_empty()) {
            request = request.header("x-audio-context-title", title);
        }
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request
                    .headers(trace_headers)
                    .multipart(Form::new().part("file", part))
                    .send()
                    .await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "audio.message",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid audio message JSON"
            );
            AppError::BadGateway("Agent Platform returned an invalid response".to_string())
        })
    }

    pub async fn ingest_channel_message(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/channels/inbound",
            organization_id,
            actor_id,
            &["channels:ingest"],
            Some(body),
        )
        .await
    }

    pub async fn get_audio_transcription_job(
        &self,
        organization_id: &str,
        actor_id: &str,
        job_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/audio/transcription-jobs/{job_id}"),
            organization_id,
            actor_id,
            &["chat:read"],
            None,
        )
        .await
    }

    pub async fn retry_audio_transcription(
        &self,
        organization_id: &str,
        actor_id: &str,
        job_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/audio/transcription-jobs/{job_id}/retry"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn transcribe_audio(
        &self,
        organization_id: &str,
        actor_id: &str,
        bytes: Vec<u8>,
        mime_type: &str,
        file_name: Option<&str>,
    ) -> Result<Value, AppError> {
        let mut part = Part::bytes(bytes)
            .mime_str(mime_type)
            .map_err(|_| AppError::BadRequest("Audio MIME type is invalid".to_string()))?;
        if let Some(file_name) = file_name.filter(|value| !value.trim().is_empty()) {
            part = part.file_name(file_name.to_string());
        }
        self.request_multipart(
            Method::POST,
            "/v1/audio/transcriptions",
            organization_id,
            actor_id,
            &["channels:ingest"],
            Form::new().part("file", part),
        )
        .await
    }

    pub async fn forward_telegram_webhook(
        &self,
        connection_id: &str,
        provider_secret: Option<&str>,
        body: Value,
    ) -> Result<Value, AppError> {
        let mut request = self
            .client
            .request(
                Method::POST,
                format!("{}/v1/webhooks/telegram/{connection_id}", self.base_url),
            )
            .timeout(self.timeout)
            .header("x-kasitek-core-forward-secret", &self.secret);
        if let Some(provider_secret) = provider_secret.filter(|value| !value.trim().is_empty()) {
            request = request.header("x-telegram-bot-api-secret-token", provider_secret);
        }
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).json(&body).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "telegram_webhook",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid Telegram webhook JSON"
            );
            AppError::BadGateway("Agent Platform returned an invalid response".to_string())
        })
    }

    pub async fn update_channel_delivery_status(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/channels/delivery-status",
            organization_id,
            actor_id,
            &["channels:ingest"],
            Some(body),
        )
        .await
    }

    pub async fn consume_channel_pairing(
        &self,
        organization_id: &str,
        actor_id: &str,
        token: &str,
        external_identity: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/channel-pairing/consume",
            organization_id,
            actor_id,
            &["channels:ingest"],
            Some(json!({
                "token": token,
                "externalIdentity": external_identity,
            })),
        )
        .await
    }

    pub async fn list_installation_channels(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/installations/{installation_id}/channels"),
            organization_id,
            actor_id,
            &["channels:read"],
            None,
        )
        .await
    }

    pub async fn ensure_channel_connection(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/channels"),
            organization_id,
            actor_id,
            &["channels:write"],
            Some(body),
        )
        .await
    }

    pub async fn revoke_channel_connection(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        connection_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/installations/{installation_id}/channels/{connection_id}"),
            organization_id,
            actor_id,
            &["channels:write"],
            None,
        )
        .await
    }

    pub async fn update_channel_connection(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        connection_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::PATCH,
            &format!("/v1/installations/{installation_id}/channels/{connection_id}"),
            organization_id,
            actor_id,
            &["channels:write"],
            Some(body),
        )
        .await
    }

    pub async fn issue_channel_pairing(
        &self,
        organization_id: &str,
        actor_id: &str,
        installation_id: &str,
        connection_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/installations/{installation_id}/channels/{connection_id}/pairing"),
            organization_id,
            actor_id,
            &["channels:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn revoke_channel_binding(
        &self,
        organization_id: &str,
        actor_id: &str,
        binding_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::DELETE,
            &format!("/v1/channel-bindings/{binding_id}"),
            organization_id,
            actor_id,
            &["channels:write"],
            None,
        )
        .await
    }

    pub async fn get_conversation(
        &self,
        organization_id: &str,
        actor_id: &str,
        conversation_id: &str,
        limit: Option<u32>,
        before: Option<&str>,
    ) -> Result<Value, AppError> {
        let mut query = Vec::new();
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        if let Some(before) = before.filter(|value| !value.trim().is_empty()) {
            query.push(format!("before={}", urlencoding::encode(before)));
        }
        let path = if query.is_empty() {
            format!("/v1/conversations/{conversation_id}")
        } else {
            format!("/v1/conversations/{conversation_id}?{}", query.join("&"))
        };
        self.request_json(
            Method::GET,
            &path,
            organization_id,
            actor_id,
            &["chat:read"],
            None,
        )
        .await
    }

    pub async fn get_run(
        &self,
        organization_id: &str,
        actor_id: &str,
        run_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/runs/{run_id}"),
            organization_id,
            actor_id,
            &["runs:read"],
            None,
        )
        .await
    }

    pub async fn get_run_timeline(
        &self,
        organization_id: &str,
        actor_id: &str,
        run_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            &format!("/v1/runs/{run_id}/timeline"),
            organization_id,
            actor_id,
            &["runs:read"],
            None,
        )
        .await
    }

    pub async fn cancel_run(
        &self,
        organization_id: &str,
        actor_id: &str,
        run_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/runs/{run_id}/cancel"),
            organization_id,
            actor_id,
            &["runs:cancel"],
            Some(body),
        )
        .await
    }

    pub async fn retry_run(
        &self,
        organization_id: &str,
        actor_id: &str,
        run_id: &str,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/runs/{run_id}/retry"),
            organization_id,
            actor_id,
            &["chat:write"],
            Some(json!({})),
        )
        .await
    }

    pub async fn signal_external_event(
        &self,
        organization_id: &str,
        actor_id: &str,
        run_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/runs/{run_id}/external-event"),
            organization_id,
            actor_id,
            &["runs:write"],
            Some(body),
        )
        .await
    }

    pub async fn approve_run(
        &self,
        organization_id: &str,
        actor_id: &str,
        run_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            &format!("/v1/runs/{run_id}/approval"),
            organization_id,
            actor_id,
            &["runs:approve"],
            Some(body),
        )
        .await
    }

    pub async fn decide_channel_approval(
        &self,
        organization_id: &str,
        actor_id: &str,
        body: Value,
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::POST,
            "/v1/channel-approvals/decide",
            organization_id,
            actor_id,
            &["channels:ingest"],
            Some(body),
        )
        .await
    }

    pub async fn stream_run_events(
        &self,
        organization_id: &str,
        actor_id: &str,
        run_id: &str,
        after: Option<u64>,
    ) -> Result<Response, AppError> {
        let mut url = format!("{}/v1/runs/{run_id}/events/stream", self.base_url);
        if let Some(after) = after {
            url.push_str(&format!("?after={after}"));
        }
        let correlation_id = new_correlation_id();
        let request = self
            .client
            .get(url)
            // Run-event SSE is intentionally long-lived; the browser closes the
            // stream after the run reaches a terminal state or on navigation.
            // Keep the client-level connect timeout, but do not apply the
            // normal finite JSON request timeout to the response body.
            .header("accept", "text/event-stream")
            .header(
                "Authorization",
                format!(
                    "Bearer {}",
                    self.token(organization_id, actor_id, &["runs:read"], &correlation_id)?
                ),
            )
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id);
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(self.map_status(response).await)
    }

    async fn request_oauth_callback(&self, path: &str) -> Result<Value, AppError> {
        let correlation_id = new_correlation_id();
        let token = self.token("oauth-callback", "oauth-callback", &[], &correlation_id)?;
        let request = self
            .client
            .get(format!("{}{}", self.base_url, path))
            .timeout(self.timeout)
            .header("Authorization", format!("Bearer {token}"))
            .header("x-organization-id", "oauth-callback")
            .header("x-actor-id", "oauth-callback")
            .header("x-correlation-id", &correlation_id)
            .header("x-kasitek-oauth-proxy", "1");
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.json::<Value>().await;
            if let Ok(value) = body {
                if value.is_object() {
                    return Ok(value);
                }
            }
            return Err(AppError::BadGateway(format!(
                "Agent Platform OAuth callback failed with status {status}"
            )));
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "oauth.callback",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid OAuth callback JSON"
            );
            AppError::BadGateway(
                "Agent Platform returned an invalid OAuth callback response".to_string(),
            )
        })
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        organization_id: &str,
        actor_id: &str,
        scopes: &[&str],
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let correlation_id = new_correlation_id();
        let token = self.token(organization_id, actor_id, scopes, &correlation_id)?;
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .timeout(self.timeout)
            .header("Authorization", format!("Bearer {token}"))
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "http.request",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid JSON"
            );
            AppError::BadGateway("Agent Platform returned an invalid response".to_string())
        })
    }

    async fn request_bytes(
        &self,
        method: Method,
        path: &str,
        organization_id: &str,
        actor_id: &str,
        scopes: &[&str],
        content_type: String,
        body: Bytes,
    ) -> Result<Value, AppError> {
        let correlation_id = new_correlation_id();
        let token = self.token(organization_id, actor_id, scopes, &correlation_id)?;
        let request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .timeout(self.timeout)
            .header("Authorization", format!("Bearer {token}"))
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id)
            .header("content-type", content_type)
            .body(body);
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "http.request",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid JSON"
            );
            AppError::BadGateway("Agent Platform returned an invalid response".to_string())
        })
    }

    async fn request_multipart(
        &self,
        method: Method,
        path: &str,
        organization_id: &str,
        actor_id: &str,
        scopes: &[&str],
        body: Form,
    ) -> Result<Value, AppError> {
        let correlation_id = new_correlation_id();
        let token = self.token(organization_id, actor_id, scopes, &correlation_id)?;
        let request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .timeout(self.timeout)
            .header("Authorization", format!("Bearer {token}"))
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id)
            .multipart(body);
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "audio.transcription",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid transcription JSON"
            );
            AppError::BadGateway("Agent Platform returned an invalid response".to_string())
        })
    }

    fn token(
        &self,
        organization_id: &str,
        actor_id: &str,
        scopes: &[&str],
        correlation_id: &str,
    ) -> Result<String, AppError> {
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AppError::Internal("System clock is before Unix epoch".to_string()))?
            .as_secs()
            + 60;
        let claims = InternalClaims {
            organization_id,
            actor_id,
            correlation_id: correlation_id.to_string(),
            audience: &self.audience,
            expires_at,
            scopes,
            operator: None,
        };
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| {
            AppError::Internal("Unable to encode Agent Platform claims".to_string())
        })?);
        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes())
            .map_err(|_| AppError::Internal("Invalid Agent Platform signing secret".to_string()))?;
        mac.update(payload.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok(format!("{payload}.{signature}"))
    }

    async fn request_operator_json(
        &self,
        method: Method,
        path: &str,
        operator_id: &str,
        scopes: &[&str],
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let correlation_id = new_correlation_id();
        let token = self.operator_token(operator_id, scopes, &correlation_id)?;
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .timeout(self.timeout)
            .header("Authorization", format!("Bearer {token}"))
            .header("x-organization-id", "platform")
            .header("x-actor-id", operator_id)
            .header("x-kasitek-operator", "true")
            .header("x-correlation-id", &correlation_id);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "operator.http.request",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid operator JSON"
            );
            AppError::BadGateway("Agent Platform returned an invalid response".to_string())
        })
    }

    async fn request_operator_command(
        &self,
        method: Method,
        path: &str,
        operator_id: &str,
        scopes: &[&str],
        idempotency_key: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let correlation_id = new_correlation_id();
        let token = self.operator_token(operator_id, scopes, &correlation_id)?;
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .timeout(self.timeout)
            .header("Authorization", format!("Bearer {token}"))
            .header("x-organization-id", "platform")
            .header("x-actor-id", operator_id)
            .header("x-kasitek-operator", "true")
            .header("x-correlation-id", &correlation_id);
        if let Some(key) = idempotency_key {
            request = request.header("idempotency-key", key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = observability::provider_result_span_with(
            "kasitek-agents",
            "http.request",
            move || async move {
                let mut trace_headers = HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                request.headers(trace_headers).send().await
            },
        )
        .await
        .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        response.json::<Value>().await.map_err(|error| {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "operator.command",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform returned invalid operator command JSON"
            );
            AppError::BadGateway("Agent Platform returned an invalid response".to_string())
        })
    }

    fn operator_token(
        &self,
        operator_id: &str,
        scopes: &[&str],
        correlation_id: &str,
    ) -> Result<String, AppError> {
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AppError::Internal("System clock is before Unix epoch".to_string()))?
            .as_secs()
            + 60;
        let claims = InternalClaims {
            organization_id: "platform",
            actor_id: operator_id,
            correlation_id: correlation_id.to_string(),
            audience: &self.audience,
            expires_at,
            scopes,
            operator: Some(true),
        };
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| {
            AppError::Internal("Unable to encode Agent Platform operator claims".to_string())
        })?);
        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes())
            .map_err(|_| AppError::Internal("Invalid Agent Platform signing secret".to_string()))?;
        mac.update(payload.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok(format!("{payload}.{signature}"))
    }

    fn map_request_error(&self, error: reqwest::Error) -> AppError {
        if error.is_timeout() {
            AppError::GatewayTimeout("Agent Platform request timed out".to_string())
        } else if error.is_connect() {
            AppError::ServiceUnavailable("Agent Platform is unavailable".to_string())
        } else {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "kasitek-agents",
                operation = "http.request",
                error_type = %std::any::type_name_of_val(&error),
                "Agent Platform request failed"
            );
            AppError::BadGateway("Agent Platform request failed".to_string())
        }
    }

    async fn map_status(&self, response: Response) -> AppError {
        let status = response.status();
        let detail = response.json::<UpstreamError>().await.ok();
        let code = detail.as_ref().and_then(|value| value.code.as_deref());
        let message = detail
            .as_ref()
            .and_then(|value| value.error.clone())
            .unwrap_or_else(|| "Agent Platform request failed".to_string());
        if code == Some("conversation_handoff_active") {
            return AppError::referral(
                "conversation_handoff_active",
                message,
                actix_web::http::StatusCode::CONFLICT,
            );
        }
        let detail = message;
        match status {
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
                AppError::BadRequest(detail)
            }
            StatusCode::UNAUTHORIZED => AppError::Unauthorized,
            StatusCode::FORBIDDEN => AppError::Forbidden(detail),
            StatusCode::NOT_FOUND => AppError::NotFound(detail),
            StatusCode::CONFLICT => AppError::Conflict(detail),
            StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => {
                AppError::GatewayTimeout(detail)
            }
            StatusCode::SERVICE_UNAVAILABLE => AppError::ServiceUnavailable(detail),
            _ => AppError::BadGateway(detail),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    async fn mock_agent_server(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut requests = Vec::with_capacity(responses.len());
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0_u8; 4096];
                    let read = stream.read(&mut chunk).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                    let Some(header_end) =
                        bytes.windows(4).position(|window| window == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':').and_then(|(name, value)| {
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                        })
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let reason = match status {
                    200 => "OK",
                    403 => "Forbidden",
                    _ => "Error",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
                stream.shutdown().await.unwrap();
            }
            requests
        });
        (format!("http://{address}"), handle)
    }

    fn test_client(base_url: &str) -> AgentPlatformClient {
        AgentPlatformClient {
            client: Client::new(),
            base_url: base_url.to_string(),
            secret: "test-secret".to_string(),
            audience: "kasitek-agents".to_string(),
            timeout: Duration::from_secs(2),
        }
    }

    #[tokio::test]
    async fn conversation_feed_uses_the_organization_stream_and_read_scope() {
        let (base_url, server) =
            mock_agent_server(vec![(200, "event: conversation.ready\\ndata: {}\\n\\n")]).await;
        let client = test_client(&base_url);

        let response = client
            .stream_conversation_feed_events("org-1", "actor-1")
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let _ = response.bytes().await.unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /v1/conversations/events/stream HTTP/1.1"));
        assert_eq!(
            request_header(&requests[0], "accept").as_deref(),
            Some("text/event-stream")
        );
        assert_scoped_request(&requests[0], "agents:read");
    }

    #[tokio::test]
    async fn handoff_assignment_filter_is_forwarded_to_agent_platform() {
        let (base_url, server) = mock_agent_server(vec![(200, r#"{"items":[]}"#)]).await;
        let client = test_client(&base_url);

        client
            .list_handoffs(
                "org-1",
                "actor-1",
                Some("install-1"),
                Some("agent-1"),
                Some("whatsapp"),
                Some("customer_requested"),
                Some("pending,claimed"),
                Some("mine"),
                Some("urgent"),
                Some("acme"),
                Some(10),
                Some("next-page"),
                None,
            )
            .await
            .unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /v1/conversations/handoffs?"));
        assert!(requests[0].contains("assignment=mine"));
        assert_scoped_request(&requests[0], "agents:read");
    }

    #[tokio::test]
    async fn capability_catalog_routes_are_forwarded_to_agent_platform() {
        let (base_url, server) = mock_agent_server(vec![
            (200, r#"{"capabilities":[]}"#),
            (200, r#"{"directory":[],"toolsets":[]}"#),
        ])
        .await;
        let client = test_client(&base_url);

        client.list_capabilities("org-1", "actor-1").await.unwrap();
        client
            .list_capability_directory("org-1", "actor-1")
            .await
            .unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /v1/capabilities HTTP/1.1"));
        assert!(requests[1].starts_with("GET /v1/capabilities/directory HTTP/1.1"));
        assert_scoped_request(&requests[0], "agents:read");
        assert_scoped_request(&requests[1], "agents:read");
    }

    #[tokio::test]
    async fn reviewed_directory_and_activation_routes_are_forwarded() {
        let (base_url, server) = mock_agent_server(vec![
            (200, r#"{"connections":[]}"#),
            (200, r#"{"skills":[]}"#),
            (200, r#"{"plugins":[]}"#),
            (201, r#"{"skill":{}}"#),
            (201, r#"{"plugin":{}}"#),
            (201, r#"{"provider":{}}"#),
            (200, r#"{"authorizationUrl":"https://example.test/oauth"}"#),
            (200, r#"{"connection":"hermes.mcp.example","status":"connected","installationId":"install-1"}"#),
            (200, r#"{"integration":"google.calendar","status":"connected","installationId":"install-1"}"#),
        ])
        .await;
        let client = test_client(&base_url);

        client
            .list_connection_directory("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .list_skill_directory("org-1", "actor-1", Some("version-1"))
            .await
            .unwrap();
        client
            .list_plugin_directory("org-1", "actor-1")
            .await
            .unwrap();
        client
            .install_skill_catalog(
                "org-1",
                "actor-1",
                "install-1",
                "hermes.skill.example",
                json!({}),
            )
            .await
            .unwrap();
        client
            .install_plugin_catalog("org-1", "actor-1", "install-1", "hermes.plugin.example")
            .await
            .unwrap();
        client
            .connect_mcp_catalog(
                "org-1",
                "actor-1",
                "install-1",
                "hermes.mcp.example",
                json!({"apiKey":"secret"}),
            )
            .await
            .unwrap();
        client
            .start_mcp_catalog_oauth(
                "org-1",
                "actor-1",
                "install-1",
                "hermes.mcp.example",
                json!({}),
            )
            .await
            .unwrap();
        client
            .complete_mcp_oauth_callback("code=oauth-code&state=oauth-state")
            .await
            .unwrap();
        client
            .complete_google_calendar_oauth_callback("code=google-code&state=google-state")
            .await
            .unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 9);
        assert!(requests[0]
            .starts_with("GET /v1/installations/install-1/connection-directory HTTP/1.1"));
        assert!(
            requests[1].starts_with("GET /v1/skills/directory?agentVersionId=version-1 HTTP/1.1")
        );
        assert!(requests[2].starts_with("GET /v1/plugins/directory HTTP/1.1"));
        assert!(requests[3].starts_with(
            "POST /v1/installations/install-1/skills/catalog/hermes.skill.example/install HTTP/1.1"
        ));
        assert!(requests[4].starts_with("POST /v1/installations/install-1/plugins/catalog/hermes.plugin.example/install HTTP/1.1"));
        assert!(requests[5].starts_with(
            "POST /v1/installations/install-1/mcp/catalog/hermes.mcp.example/connect HTTP/1.1"
        ));
        assert!(requests[6].starts_with(
            "POST /v1/installations/install-1/mcp/catalog/hermes.mcp.example/oauth/start HTTP/1.1"
        ));
        assert!(requests[7].starts_with(
            "GET /v1/integrations/mcp/oauth/callback?code=oauth-code&state=oauth-state HTTP/1.1"
        ));
        assert!(requests[8].starts_with(
            "GET /v1/integrations/google.calendar/oauth/callback?code=google-code&state=google-state HTTP/1.1"
        ));
        for (index, request) in requests.iter().take(7).enumerate() {
            assert_scoped_request(
                request,
                if index < 3 {
                    "agents:read"
                } else {
                    "agents:write"
                },
            );
        }
        for request in requests.iter().skip(7) {
            assert_eq!(
                request_header(request, "x-organization-id").as_deref(),
                Some("oauth-callback")
            );
            assert_eq!(
                request_header(request, "x-actor-id").as_deref(),
                Some("oauth-callback")
            );
            assert!(request_header(request, "authorization").is_some());
        }
    }

    #[tokio::test]
    async fn channel_handoff_conflicts_preserve_the_upstream_reason_code() {
        let (base_url, server) = mock_agent_server(vec![
            (409, r#"{"error":"Agent execution is paused while this conversation is owned by a human","code":"conversation_handoff_active"}"#),
        ]).await;
        let client = test_client(&base_url);
        let error = client
            .ingest_channel_message("org-1", "actor-1", json!({"channelType": "website"}))
            .await
            .expect_err("active handoff should be surfaced as a conflict");
        match error {
            AppError::Referral {
                code,
                message,
                status,
            } => {
                assert_eq!(code, "conversation_handoff_active");
                assert!(message.contains("owned by a human"));
                assert_eq!(status, actix_web::http::StatusCode::CONFLICT);
            }
            other => panic!("unexpected error: {other:?}"),
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn provider_credential_routes_use_the_scoped_agent_boundary() {
        let (base_url, server) = mock_agent_server(vec![
            (200, r#"{"verification":{"status":"verified"}}"#),
            (201, r#"{"id":"credential-1"}"#),
            (200, r#"{"credentials":[]}"#),
        ])
        .await;
        let client = test_client(&base_url);
        client
            .verify_provider_credential(
                "org-1",
                "actor-1",
                json!({"provider":"openai","apiKey":"secret-key"}),
            )
            .await
            .unwrap();
        client
            .create_provider_credential(
                "org-1",
                "actor-1",
                json!({"provider":"openai","apiKey":"secret-key","label":"primary"}),
            )
            .await
            .unwrap();
        client
            .list_provider_credentials("org-1", "actor-1")
            .await
            .unwrap();
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("POST /v1/credentials/verify HTTP/1.1"));
        assert!(requests[1].starts_with("POST /v1/credentials HTTP/1.1"));
        assert!(requests[2].starts_with("GET /v1/credentials HTTP/1.1"));
        assert_scoped_request(&requests[0], "agents:write");
        assert_scoped_request(&requests[1], "agents:write");
        assert_scoped_request(&requests[2], "agents:read");
        assert!(request_body(&requests[0]).contains("secret-key"));
        assert!(request_body(&requests[1]).contains("secret-key"));
    }

    fn request_header(request: &str, name: &str) -> Option<String> {
        request.lines().find_map(|line| {
            line.split_once(':').and_then(|(key, value)| {
                key.eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_string())
            })
        })
    }

    fn request_body(request: &str) -> &str {
        request
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or("")
    }

    fn assert_operator_request(request: &str, expected_scope: &str) {
        assert_eq!(
            request_header(request, "x-organization-id").as_deref(),
            Some("platform")
        );
        assert_eq!(
            request_header(request, "x-kasitek-operator").as_deref(),
            Some("true")
        );
        assert_eq!(
            request_header(request, "x-actor-id").as_deref(),
            Some("operator-1")
        );
        let correlation_id = request_header(request, "x-correlation-id").unwrap();
        let authorization = request_header(request, "authorization").unwrap();
        let token = authorization.strip_prefix("Bearer ").unwrap();
        let payload = token.split('.').next().unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(claims["organizationId"], "platform");
        assert_eq!(claims["actorId"], "operator-1");
        assert_eq!(claims["audience"], "kasitek-agents");
        assert_eq!(claims["operator"], true);
        assert_eq!(claims["scopes"], json!([expected_scope]));
        assert_eq!(claims["correlationId"], correlation_id);
    }

    fn assert_scoped_request(request: &str, expected_scope: &str) {
        assert_eq!(
            request_header(request, "x-organization-id").as_deref(),
            Some("org-1")
        );
        assert_eq!(
            request_header(request, "x-actor-id").as_deref(),
            Some("actor-1")
        );
        assert!(request_header(request, "x-kasitek-operator").is_none());
        let correlation_id = request_header(request, "x-correlation-id").unwrap();
        let authorization = request_header(request, "authorization").unwrap();
        let token = authorization.strip_prefix("Bearer ").unwrap();
        let payload = token.split('.').next().unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(claims["organizationId"], "org-1");
        assert_eq!(claims["actorId"], "actor-1");
        assert_eq!(claims["audience"], "kasitek-agents");
        assert_eq!(claims["scopes"], json!([expected_scope]));
        assert_eq!(claims["correlationId"], correlation_id);
    }

    #[test]
    fn internal_claims_use_the_agents_wire_format() {
        let claims = InternalClaims {
            organization_id: "org-1",
            actor_id: "user-1",
            correlation_id: "00000000-0000-4000-8000-000000000001".to_string(),
            audience: "kasitek-agents",
            expires_at: 1_900_000_000,
            scopes: &["chat:write"],
            operator: None,
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let value: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        assert_eq!(value["organizationId"], "org-1");
        assert_eq!(value["actorId"], "user-1");
        assert_eq!(
            value["correlationId"],
            "00000000-0000-4000-8000-000000000001"
        );
        assert_eq!(value["scopes"][0], "chat:write");
        assert!(value.get("operator").is_none());
    }

    #[tokio::test]
    async fn operator_reads_and_commands_use_the_scoped_core_to_agent_boundary() {
        let (base_url, server) = mock_agent_server(vec![(200, r#"{"ok":true}"#); 19]).await;
        let client = test_client(&base_url);

        client.operator_summary("operator-1").await.unwrap();
        client.operator_runs("operator-1", Some(25)).await.unwrap();
        client
            .operator_exports("operator-1", Some(25))
            .await
            .unwrap();
        client
            .operator_kill_switches("operator-1", Some(25))
            .await
            .unwrap();
        client
            .operator_feature_flags("operator-1", Some(25))
            .await
            .unwrap();
        client
            .operator_audio_transcription_jobs("operator-1", Some(25))
            .await
            .unwrap();
        client.operator_holds("operator-1", Some(25)).await.unwrap();
        client
            .operator_retention_policies("operator-1", Some(25))
            .await
            .unwrap();
        client
            .operator_legal_holds("operator-1", Some(25))
            .await
            .unwrap();
        client
            .operator_retention_preview("operator-1", "org/a?")
            .await
            .unwrap();
        client.operator_health("operator-1").await.unwrap();
        client
            .operator_effects_reconciliation("operator-1", Some(10))
            .await
            .unwrap();
        client
            .operator_audit(
                "operator-1",
                Some("operator command"),
                Some("run"),
                Some(10),
            )
            .await
            .unwrap();
        client
            .operator_search("operator-1", "foo bar", Some(5))
            .await
            .unwrap();
        client
            .operator_projection("operator-1", "health")
            .await
            .unwrap();
        client
            .operator_get_command("operator-1", "cmd/1")
            .await
            .unwrap();
        client
            .operator_create_command(
                "operator-1",
                "operator-command-1",
                json!({ "commandType": "cancel_run", "targetId": "run-1" }),
            )
            .await
            .unwrap();
        client
            .operator_approve_command("operator-1", "cmd/1")
            .await
            .unwrap();
        client
            .operator_rebuild_projections("operator-1", json!({ "keys": ["summary"] }))
            .await
            .unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 19);
        let expected_paths = [
            "GET /v1/operator/summary HTTP/1.1",
            "GET /v1/operator/runs?limit=25 HTTP/1.1",
            "GET /v1/operator/exports?limit=25 HTTP/1.1",
            "GET /v1/operator/kill-switches?limit=25 HTTP/1.1",
            "GET /v1/operator/feature-flags?limit=25 HTTP/1.1",
            "GET /v1/operator/audio-transcription/jobs?limit=25 HTTP/1.1",
            "GET /v1/operator/holds?limit=25 HTTP/1.1",
            "GET /v1/operator/retention/policies?limit=25 HTTP/1.1",
            "GET /v1/operator/retention/legal-holds?limit=25 HTTP/1.1",
            "GET /v1/operator/retention/preview/org%2Fa%3F HTTP/1.1",
            "GET /v1/operator/health HTTP/1.1",
            "GET /v1/operator/effects/reconciliation?limit=10 HTTP/1.1",
            "GET /v1/operator/audit?action=operator%20command&resourceType=run&limit=10 HTTP/1.1",
            "GET /v1/operator/search?q=foo%20bar&limit=5 HTTP/1.1",
            "GET /v1/operator/projections/health HTTP/1.1",
            "GET /v1/operator/commands/cmd%2F1 HTTP/1.1",
            "POST /v1/operator/commands HTTP/1.1",
            "POST /v1/operator/commands/cmd%2F1/approve HTTP/1.1",
            "POST /v1/operator/projections/rebuild HTTP/1.1",
        ];
        for (request, expected_path) in requests.iter().zip(expected_paths) {
            assert!(
                request.starts_with(expected_path),
                "unexpected request: {request}"
            );
        }
        for request in requests.iter().take(16) {
            assert_operator_request(request, "operator:read");
        }
        for request in requests.iter().skip(16) {
            assert_operator_request(request, "operator:write");
        }
        assert_eq!(
            request_header(&requests[16], "idempotency-key").as_deref(),
            Some("operator-command-1")
        );
        assert_eq!(
            request_body(&requests[16]),
            r#"{"commandType":"cancel_run","targetId":"run-1"}"#
        );
        assert_eq!(request_body(&requests[17]), "{}");
        assert_eq!(request_body(&requests[18]), r#"{"keys":["summary"]}"#);
    }

    #[tokio::test]
    async fn every_non_operator_adapter_uses_the_scoped_agent_boundary() {
        let (base_url, server) = mock_agent_server(vec![(200, r#"{"ok":true}"#); 80]).await;
        let client = test_client(&base_url);
        let body = json!({"value": "test"});

        client
            .ensure_kasiai("org-1", "actor-1", body.clone())
            .await
            .unwrap();
        client.list_agents("org-1", "actor-1", None).await.unwrap();
        client.get_model_catalog("org-1", "actor-1").await.unwrap();
        client
            .create_agent("org-1", "actor-1", body.clone())
            .await
            .unwrap();
        client
            .update_agent("org-1", "actor-1", "agent-1", body.clone())
            .await
            .unwrap();
        client
            .delete_agent("org-1", "actor-1", "agent-1")
            .await
            .unwrap();
        client
            .create_agent_version("org-1", "actor-1", "agent-1", body.clone())
            .await
            .unwrap();
        client.operations_summary("org-1", "actor-1").await.unwrap();
        client
            .operations_runs("org-1", "actor-1", Some(25))
            .await
            .unwrap();
        client.operations_health("org-1", "actor-1").await.unwrap();
        client
            .operations_effects_reconciliation("org-1", "actor-1", Some(10))
            .await
            .unwrap();
        client
            .reconcile_effect("org-1", "actor-1", "effect-1", body.clone())
            .await
            .unwrap();
        client.list_kill_switches("org-1", "actor-1").await.unwrap();
        client
            .create_kill_switch("org-1", "actor-1", body.clone())
            .await
            .unwrap();
        client
            .disable_kill_switch("org-1", "actor-1", "switch-1")
            .await
            .unwrap();
        client
            .list_audit(
                "org-1",
                "actor-1",
                Some("run completed"),
                Some("run"),
                Some(25),
            )
            .await
            .unwrap();
        client.list_templates("org-1", "actor-1").await.unwrap();
        client
            .install_template("org-1", "actor-1", "content", body.clone())
            .await
            .unwrap();
        client
            .set_installation_status("org-1", "actor-1", "install-1", "paused")
            .await
            .unwrap();
        client
            .set_installation_settings("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client
            .list_installation_credentials("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .create_installation_credential("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client
            .revoke_installation_credential("org-1", "actor-1", "install-1", "credential-1")
            .await
            .unwrap();
        client
            .rotate_installation_credential("org-1", "actor-1", "install-1", "credential-1")
            .await
            .unwrap();
        client
            .list_installation_capabilities("org-1", "actor-1", "install-1", Some("credential-1"))
            .await
            .unwrap();
        client
            .get_installation_readiness("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .grant_installation_tool("org-1", "actor-1", "install-1", "platform.current_time")
            .await
            .unwrap();
        client
            .list_installation_grants("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .grant_installation_resource("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client.list_connectors("org-1", "actor-1").await.unwrap();
        client
            .list_installation_connectors("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .grant_installation_connector("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client
            .list_installation_runs("org-1", "actor-1", "install-1", Some(25))
            .await
            .unwrap();
        client
            .list_installation_schedules("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .create_installation_schedule("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client
            .set_schedule_status("org-1", "actor-1", "schedule-1", "active")
            .await
            .unwrap();
        client
            .list_knowledge_sources(
                "org-1",
                "actor-1",
                Some("agent-1"),
                Some("install-1"),
                Some(25),
            )
            .await
            .unwrap();
        client
            .create_knowledge_source("org-1", "actor-1", body.clone())
            .await
            .unwrap();
        client
            .get_knowledge_source("org-1", "actor-1", "source-1")
            .await
            .unwrap();
        client
            .ingest_knowledge_source_url("org-1", "actor-1", "source-1", body.clone())
            .await
            .unwrap();
        client
            .ingest_knowledge_source_text("org-1", "actor-1", "source-1", body.clone())
            .await
            .unwrap();
        client
            .ingest_knowledge_source_file(
                "org-1",
                "actor-1",
                "source-1",
                "multipart/form-data; boundary=test".to_string(),
                Bytes::from_static(b"file"),
            )
            .await
            .unwrap();
        client
            .delete_knowledge_source("org-1", "actor-1", "source-1", body.clone())
            .await
            .unwrap();
        client
            .list_memory("org-1", "actor-1", "agent-1", Some("install-1"), Some(25))
            .await
            .unwrap();
        client
            .delete_memory("org-1", "actor-1", "memory-1", body.clone())
            .await
            .unwrap();
        client
            .revalidate_memory("org-1", "actor-1", "memory-1", body.clone())
            .await
            .unwrap();
        client
            .list_agent_versions("org-1", "actor-1", "agent-1")
            .await
            .unwrap();
        client
            .publish_agent_version("org-1", "actor-1", "agent-1", "version-1")
            .await
            .unwrap();
        client
            .create_installation("org-1", "actor-1", body.clone())
            .await
            .unwrap();
        client
            .rollback_agent_version("org-1", "actor-1", "agent-1", "version-1")
            .await
            .unwrap();
        client
            .retire_agent_version("org-1", "actor-1", "agent-1", "version-1")
            .await
            .unwrap();
        client
            .archive_agent("org-1", "actor-1", "agent-1")
            .await
            .unwrap();
        client
            .resolve_platform_conversation("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .create_platform_conversation("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .clear_platform_conversations("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .list_conversations("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .kasiai_home("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .kasiai_preferences("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .update_kasiai_preferences("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client
            .update_conversation("org-1", "actor-1", "conversation-1", body.clone())
            .await
            .unwrap();
        client
            .set_channel_default_conversation("org-1", "actor-1", "conversation-1")
            .await
            .unwrap();
        client
            .set_conversation_status("org-1", "actor-1", "conversation-1", "archived")
            .await
            .unwrap();
        client
            .restore_conversation("org-1", "actor-1", "conversation-1")
            .await
            .unwrap();
        client
            .send_platform_message("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client
            .ingest_channel_message("org-1", "actor-1", body.clone())
            .await
            .unwrap();
        client
            .update_channel_delivery_status("org-1", "actor-1", body.clone())
            .await
            .unwrap();
        client
            .consume_channel_pairing(
                "org-1",
                "actor-1",
                "pairing-token-1234567890",
                "external-user-1",
            )
            .await
            .unwrap();
        client
            .list_installation_channels("org-1", "actor-1", "install-1")
            .await
            .unwrap();
        client
            .ensure_channel_connection("org-1", "actor-1", "install-1", body.clone())
            .await
            .unwrap();
        client
            .update_channel_connection(
                "org-1",
                "actor-1",
                "install-1",
                "connection-1",
                body.clone(),
            )
            .await
            .unwrap();
        client
            .issue_channel_pairing("org-1", "actor-1", "install-1", "connection-1")
            .await
            .unwrap();
        client
            .revoke_channel_binding("org-1", "actor-1", "binding-1")
            .await
            .unwrap();
        client
            .get_conversation(
                "org-1",
                "actor-1",
                "conversation-1",
                Some(20),
                Some("cursor-1"),
            )
            .await
            .unwrap();
        client.get_run("org-1", "actor-1", "run-1").await.unwrap();
        client
            .get_run_timeline("org-1", "actor-1", "run-1")
            .await
            .unwrap();
        client
            .cancel_run("org-1", "actor-1", "run-1", body.clone())
            .await
            .unwrap();
        client.retry_run("org-1", "actor-1", "run-1").await.unwrap();
        client
            .signal_external_event("org-1", "actor-1", "run-1", body.clone())
            .await
            .unwrap();
        client
            .approve_run("org-1", "actor-1", "run-1", body)
            .await
            .unwrap();
        client
            .stream_run_events("org-1", "actor-1", "run-1", Some(3))
            .await
            .unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 80);
        let expected_paths = [
            "POST /v1/system-agents/kasiai/installation HTTP/1.1",
            "GET /v1/agents HTTP/1.1",
            "GET /v1/models/catalog HTTP/1.1",
            "POST /v1/agents HTTP/1.1",
            "PATCH /v1/agents/agent-1 HTTP/1.1",
            "DELETE /v1/agents/agent-1 HTTP/1.1",
            "POST /v1/agents/agent-1/versions HTTP/1.1",
            "GET /v1/operations/summary HTTP/1.1",
            "GET /v1/operations/runs?limit=25 HTTP/1.1",
            "GET /v1/operations/health HTTP/1.1",
            "GET /v1/operations/effects/reconciliation?limit=10 HTTP/1.1",
            "POST /v1/operations/effects/effect-1/reconcile HTTP/1.1",
            "GET /v1/operations/kill-switches HTTP/1.1",
            "POST /v1/operations/kill-switches HTTP/1.1",
            "DELETE /v1/operations/kill-switches/switch-1 HTTP/1.1",
            "GET /v1/audit?action=run%20completed&resourceType=run&limit=25 HTTP/1.1",
            "GET /v1/templates HTTP/1.1",
            "POST /v1/templates/content/install HTTP/1.1",
            "POST /v1/installations/install-1/status/paused HTTP/1.1",
            "PATCH /v1/installations/install-1/settings HTTP/1.1",
            "GET /v1/installations/install-1/credentials HTTP/1.1",
            "POST /v1/installations/install-1/credentials HTTP/1.1",
            "DELETE /v1/installations/install-1/credentials/credential-1 HTTP/1.1",
            "POST /v1/installations/install-1/credentials/credential-1/rotate HTTP/1.1",
            "GET /v1/installations/install-1/capabilities?credentialId=credential-1 HTTP/1.1",
            "GET /v1/installations/install-1/readiness HTTP/1.1",
            "POST /v1/installations/install-1/tools HTTP/1.1",
            "GET /v1/installations/install-1/grants HTTP/1.1",
            "POST /v1/installations/install-1/grants/resources HTTP/1.1",
            "GET /v1/connectors HTTP/1.1",
            "GET /v1/installations/install-1/connectors HTTP/1.1",
            "POST /v1/installations/install-1/grants/connectors HTTP/1.1",
            "GET /v1/installations/install-1/runs?limit=25 HTTP/1.1",
            "GET /v1/installations/install-1/schedules HTTP/1.1",
            "POST /v1/installations/install-1/schedules HTTP/1.1",
            "POST /v1/schedules/schedule-1/status/active HTTP/1.1",
            "GET /v1/knowledge/sources?agentId=agent-1&installationId=install-1&limit=25 HTTP/1.1",
            "POST /v1/knowledge/sources HTTP/1.1",
            "GET /v1/knowledge/sources/source-1 HTTP/1.1",
            "POST /v1/knowledge/sources/source-1/ingest-url HTTP/1.1",
            "POST /v1/knowledge/sources/source-1/ingest-text HTTP/1.1",
            "POST /v1/knowledge/sources/source-1/ingest-file HTTP/1.1",
            "DELETE /v1/knowledge/sources/source-1 HTTP/1.1",
            "GET /v1/memory?agentId=agent-1&installationId=install-1&limit=25 HTTP/1.1",
            "DELETE /v1/memory/memory-1 HTTP/1.1",
            "POST /v1/memory/memory-1/revalidate HTTP/1.1",
            "GET /v1/agents/agent-1/versions HTTP/1.1",
            "POST /v1/agents/agent-1/versions/version-1/publish HTTP/1.1",
            "POST /v1/installations HTTP/1.1",
            "POST /v1/agents/agent-1/versions/version-1/rollback HTTP/1.1",
            "POST /v1/agents/agent-1/versions/version-1/retire HTTP/1.1",
            "POST /v1/agents/agent-1/archive HTTP/1.1",
            "POST /v1/installations/install-1/platform/conversation HTTP/1.1",
            "POST /v1/installations/install-1/platform/conversation/new HTTP/1.1",
            "POST /v1/installations/install-1/platform/conversations/clear HTTP/1.1",
            "GET /v1/installations/install-1/conversations HTTP/1.1",
            "POST /v1/installations/install-1/kasiai/home HTTP/1.1",
            "GET /v1/installations/install-1/kasiai/preferences HTTP/1.1",
            "PATCH /v1/installations/install-1/kasiai/preferences HTTP/1.1",
            "PATCH /v1/conversations/conversation-1 HTTP/1.1",
            "POST /v1/conversations/conversation-1/channel-default HTTP/1.1",
            "POST /v1/conversations/conversation-1/status/archived HTTP/1.1",
            "POST /v1/conversations/conversation-1/restore HTTP/1.1",
            "POST /v1/installations/install-1/platform/messages HTTP/1.1",
            "POST /v1/channels/inbound HTTP/1.1",
            "POST /v1/channels/delivery-status HTTP/1.1",
            "POST /v1/channel-pairing/consume HTTP/1.1",
            "GET /v1/installations/install-1/channels HTTP/1.1",
            "POST /v1/installations/install-1/channels HTTP/1.1",
            "PATCH /v1/installations/install-1/channels/connection-1 HTTP/1.1",
            "POST /v1/installations/install-1/channels/connection-1/pairing HTTP/1.1",
            "DELETE /v1/channel-bindings/binding-1 HTTP/1.1",
            "GET /v1/conversations/conversation-1?limit=20&before=cursor-1 HTTP/1.1",
            "GET /v1/runs/run-1 HTTP/1.1",
            "GET /v1/runs/run-1/timeline HTTP/1.1",
            "POST /v1/runs/run-1/cancel HTTP/1.1",
            "POST /v1/runs/run-1/retry HTTP/1.1",
            "POST /v1/runs/run-1/external-event HTTP/1.1",
            "POST /v1/runs/run-1/approval HTTP/1.1",
            "GET /v1/runs/run-1/events/stream?after=3 HTTP/1.1",
        ];
        assert_eq!(expected_paths.len(), requests.len());
        for (request, expected_path) in requests.iter().zip(expected_paths) {
            assert!(
                request.starts_with(expected_path),
                "unexpected request: {request}"
            );
        }
        let expected_scopes = [
            "kasiai:write",    // ensure_kasiai
            "agents:read",     // list_agents
            "agents:read",     // get_model_catalog
            "agents:write",    // create_agent
            "agents:write",    // update_agent
            "agents:write",    // delete_agent
            "agents:write",    // create_agent_version
            "agents:read",     // operations_summary
            "agents:read",     // operations_runs
            "agents:read",     // operations_health
            "agents:read",     // operations_effects_reconciliation
            "agents:write",    // reconcile_effect
            "agents:read",     // list_kill_switches
            "agents:write",    // create_kill_switch
            "agents:write",    // disable_kill_switch
            "agents:read",     // list_audit
            "agents:read",     // list_templates
            "agents:write",    // install_template
            "agents:write",    // set_installation_status
            "agents:write",    // set_installation_settings
            "agents:read",     // list_installation_credentials
            "agents:write",    // create_installation_credential
            "agents:write",    // revoke_installation_credential
            "agents:write",    // rotate_installation_credential
            "agents:read",     // list_installation_capabilities
            "agents:read",     // get_installation_readiness
            "agents:write",    // grant_installation_tool
            "agents:read",     // list_installation_grants
            "agents:write",    // grant_installation_resource
            "agents:read",     // list_connectors
            "agents:read",     // list_installation_connectors
            "agents:write",    // grant_installation_connector
            "agents:read",     // list_installation_runs
            "agents:read",     // list_installation_schedules
            "agents:write",    // create_installation_schedule
            "agents:write",    // set_schedule_status
            "agents:read",     // list_knowledge_sources
            "agents:write",    // create_knowledge_source
            "agents:read",     // get_knowledge_source
            "agents:write",    // ingest_knowledge_source_url
            "agents:write",    // ingest_knowledge_source_text
            "agents:write",    // ingest_knowledge_source_file
            "agents:write",    // delete_knowledge_source
            "agents:read",     // list_memory
            "agents:write",    // delete_memory
            "agents:write",    // revalidate_memory
            "agents:read",     // list_agent_versions
            "agents:write",    // publish_agent_version
            "agents:write",    // create_installation
            "agents:write",    // rollback_agent_version
            "agents:write",    // retire_agent_version
            "agents:write",    // archive_agent
            "chat:read",       // resolve_platform_conversation
            "chat:write",      // create_platform_conversation
            "chat:write",      // clear_platform_conversations
            "chat:read",       // list_conversations
            "kasiai:read",     // kasiai_home
            "kasiai:read",     // kasiai_preferences
            "kasiai:write",    // update_kasiai_preferences
            "chat:write",      // update_conversation
            "chat:write",      // set_channel_default_conversation
            "chat:write",      // set_conversation_status
            "chat:write",      // restore_conversation
            "chat:write",      // send_platform_message
            "channels:ingest", // ingest_channel_message
            "channels:ingest", // update_channel_delivery_status
            "channels:ingest", // consume_channel_pairing
            "channels:read",   // list_installation_channels
            "channels:write",  // ensure_channel_connection
            "channels:write",  // update_channel_connection
            "channels:write",  // issue_channel_pairing
            "channels:write",  // revoke_channel_binding
            "chat:read",       // get_conversation
            "runs:read",       // get_run
            "runs:read",       // get_run_timeline
            "runs:cancel",     // cancel_run
            "chat:write",      // retry_run
            "runs:write",      // signal_external_event
            "runs:approve",    // approve_run
            "runs:read",       // stream_run_events
        ];
        assert_eq!(expected_scopes.len(), requests.len());
        for (request, expected_scope) in requests.iter().zip(expected_scopes) {
            assert_scoped_request(request, expected_scope);
        }
        let stream_request = requests
            .iter()
            .find(|request| request.starts_with("GET /v1/runs/run-1/events/stream"))
            .expect("stream request");
        assert_eq!(
            request_header(stream_request, "accept").as_deref(),
            Some("text/event-stream")
        );
        for request in requests.iter().filter(|request| {
            request.starts_with("POST ")
                || request.starts_with("PATCH ")
                || request.starts_with("DELETE ")
        }) {
            if request.contains("/reconcile")
                || request.contains("/channels")
                || request.contains("/runs/")
            {
                assert!(
                    request_header(request, "content-type").is_some(),
                    "write request missing content type: {request}"
                );
            }
        }
    }

    #[tokio::test]
    async fn list_agents_forwards_the_environment_filter() {
        let (base_url, server) = mock_agent_server(vec![(200, r#"{"agents":[]}"#)]).await;
        let client = test_client(&base_url);

        client
            .list_agents("org-1", "actor-1", Some("playground"))
            .await
            .unwrap();

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /v1/agents?environment=playground HTTP/1.1"));
    }

    #[tokio::test]
    async fn operator_client_maps_upstream_errors_and_invalid_json() {
        let (base_url, server) = mock_agent_server(vec![
            (403, r#"{"error":"operator denied"}"#),
            (200, "not-json"),
        ])
        .await;
        let client = test_client(&base_url);

        assert!(matches!(
            client.operator_summary("operator-1").await,
            Err(AppError::Forbidden(message)) if message == "operator denied"
        ));
        assert!(matches!(
            client.operator_health("operator-1").await,
            Err(AppError::BadGateway(message)) if message == "Agent Platform returned an invalid response"
        ));
        server.await.unwrap();
    }
}
