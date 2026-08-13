use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use reqwest::{Client, Method, Response, StatusCode};
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
}

#[derive(Debug, Deserialize)]
struct UpstreamError {
    error: Option<String>,
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
    ) -> Result<Value, AppError> {
        self.request_json(
            Method::GET,
            "/v1/agents",
            organization_id,
            actor_id,
            &["agents:read"],
            None,
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
        let response = self
            .client
            .get(url)
            .timeout(self.timeout)
            .header(
                "Authorization",
                format!(
                    "Bearer {}",
                    self.token(organization_id, actor_id, &["runs:read"], &correlation_id)?
                ),
            )
            .header("x-organization-id", organization_id)
            .header("x-actor-id", actor_id)
            .header("x-correlation-id", &correlation_id)
            .send()
            .await
            .map_err(|error| self.map_request_error(error))?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(self.map_status(response).await)
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
        let response = request
            .send()
            .await
            .map_err(|error| self.map_request_error(error))?;
        if !response.status().is_success() {
            return Err(self.map_status(response).await);
        }
        response.json::<Value>().await.map_err(|error| {
            log::error!("Agent Platform returned invalid JSON: {error}");
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

    fn map_request_error(&self, error: reqwest::Error) -> AppError {
        if error.is_timeout() {
            AppError::GatewayTimeout("Agent Platform request timed out".to_string())
        } else if error.is_connect() {
            AppError::ServiceUnavailable("Agent Platform is unavailable".to_string())
        } else {
            log::error!("Agent Platform request failed: {error}");
            AppError::BadGateway("Agent Platform request failed".to_string())
        }
    }

    async fn map_status(&self, response: Response) -> AppError {
        let status = response.status();
        let detail = response
            .json::<UpstreamError>()
            .await
            .ok()
            .and_then(|value| value.error)
            .unwrap_or_else(|| "Agent Platform request failed".to_string());
        match status {
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

    #[test]
    fn internal_claims_use_the_agents_wire_format() {
        let claims = InternalClaims {
            organization_id: "org-1",
            actor_id: "user-1",
            correlation_id: "00000000-0000-4000-8000-000000000001".to_string(),
            audience: "kasitek-agents",
            expires_at: 1_900_000_000,
            scopes: &["chat:write"],
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
    }
}
