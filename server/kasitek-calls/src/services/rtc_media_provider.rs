use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, Utc};
use livekit_api::access_token;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::config::AppConfig;
use crate::db::models::WhatsappCallSessionRow;
use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct MediaSessionContext<'a> {
    pub config: &'a AppConfig,
    pub call: &'a WhatsappCallSessionRow,
}

#[derive(Debug, Clone)]
pub struct ProviderActionContext<'a> {
    pub config: &'a AppConfig,
    pub call: &'a WhatsappCallSessionRow,
    pub action: &'a str,
}

#[derive(Debug, Clone)]
pub struct ProviderSignalContext<'a> {
    pub config: &'a AppConfig,
    pub call: &'a WhatsappCallSessionRow,
    pub kind: &'a str,
    pub source: &'a str,
    pub signal: Value,
}

#[async_trait]
pub trait RtcMediaProvider: Send + Sync {
    fn provider_name(&self) -> &'static str;
    async fn build_media_session(&self, input: MediaSessionContext<'_>) -> Result<Value, AppError>;
    async fn dispatch_action(&self, input: ProviderActionContext<'_>) -> Result<Value, AppError>;
    async fn dispatch_signal(&self, input: ProviderSignalContext<'_>) -> Result<Value, AppError>;
}

pub fn create_provider(config: &AppConfig) -> Box<dyn RtcMediaProvider> {
    match config.whatsapp_call_provider.trim() {
        "livekit" => Box::new(LiveKitMediaProvider),
        _ => Box::new(BridgeMediaProvider),
    }
}

struct BridgeMediaProvider;

fn parse_ice_servers(config: &AppConfig) -> Value {
    if let Some(servers) = config
        .whatsapp_call_ice_servers_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(|value| value.is_array())
    {
        return servers;
    }

    let turn_urls = config
        .whatsapp_call_turn_urls
        .as_deref()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());

    if let Some(turn_urls) = turn_urls {
        return json!([
            { "urls": ["stun:stun.l.google.com:19302"] },
            {
                "urls": turn_urls,
                "username": config.whatsapp_call_turn_username,
                "credential": config.whatsapp_call_turn_credential,
            }
        ]);
    }

    json!([
        { "urls": ["stun:stun.l.google.com:19302"] }
    ])
}

async fn notify_bridge(
    config: &AppConfig,
    endpoint: &str,
    payload: &Value,
) -> Result<Option<Value>, AppError> {
    let Some(base_url) = config
        .whatsapp_call_signaling_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        endpoint.trim_start_matches('/')
    );
    let client = reqwest::Client::new();
    let mut request = client.post(&url).json(payload);
    if let Some(token) = config
        .whatsapp_call_bridge_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header("x-kasitek-call-bridge-token", token);
    }
    let response = request.send().await?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "Bridge request failed ({}): {}",
            status,
            body.get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    Ok(Some(body))
}

#[async_trait]
impl RtcMediaProvider for BridgeMediaProvider {
    fn provider_name(&self) -> &'static str {
        "bridge"
    }

    async fn build_media_session(&self, input: MediaSessionContext<'_>) -> Result<Value, AppError> {
        Ok(json!({
            "provider": input.config.whatsapp_call_provider,
            "callId": input.call.id,
            "waCallId": input.call.wa_call_id,
            "conversationId": input.call.conversation_id,
            "roomName": format!("kasitek-wa-call-{}", input.call.id),
            "signalingUrl": input.config.whatsapp_call_signaling_url,
            "iceServers": parse_ice_servers(input.config),
            "agentRole": "agent",
            "canAccept": input.call.status == "RINGING",
            "canEnd": input.call.status == "ACTIVE"
                || input.call.status == "CONNECTING"
                || input.call.status == "RINGING",
        }))
    }

    async fn dispatch_action(&self, input: ProviderActionContext<'_>) -> Result<Value, AppError> {
        let media_session = self
            .build_media_session(MediaSessionContext {
                config: input.config,
                call: input.call,
            })
            .await?;
        let bridge_request = json!({
            "callId": input.call.id,
            "waCallId": input.call.wa_call_id,
            "action": input.action,
            "call": input.call,
            "mediaSession": media_session,
        });

        let bridge_response =
            match notify_bridge(input.config, &format!("/calls/{}/actions", input.call.id), &bridge_request)
                .await
            {
                Ok(body) => body,
                Err(error) => {
                    log::warn!(
                        "failed to notify call bridge about action action={} call_id={}: {}",
                        input.action,
                        input.call.id,
                        error
                    );
                    None
                }
            };

        Ok(json!({
            "provider": input.config.whatsapp_call_provider,
            "action": input.action,
            "mediaSession": media_session,
            "bridgeResponse": bridge_response,
        }))
    }

    async fn dispatch_signal(&self, input: ProviderSignalContext<'_>) -> Result<Value, AppError> {
        let media_session = self
            .build_media_session(MediaSessionContext {
                config: input.config,
                call: input.call,
            })
            .await?;
        let bridge_request = json!({
            "callId": input.call.id,
            "waCallId": input.call.wa_call_id,
            "kind": input.kind,
            "source": input.source,
            "signal": input.signal,
            "call": input.call,
            "mediaSession": media_session,
        });
        let bridge_response =
            match notify_bridge(input.config, &format!("/calls/{}/signals", input.call.id), &bridge_request)
                .await
            {
                Ok(body) => body,
                Err(error) => {
                    log::warn!(
                        "failed to notify call bridge about signal kind={} call_id={}: {}",
                        input.kind,
                        input.call.id,
                        error
                    );
                    None
                }
            };

        Ok(json!({
            "provider": input.config.whatsapp_call_provider,
            "kind": input.kind,
            "bridgeResponse": bridge_response,
        }))
    }
}

struct LiveKitMediaProvider;

fn livekit_room_name(call: &WhatsappCallSessionRow) -> String {
    format!("kasitek-wa-call-{}", call.id)
}

fn livekit_participant_identity(call: &WhatsappCallSessionRow) -> String {
    format!("agent:{}:{}", call.user_id, call.id)
}

fn livekit_participant_name(call: &WhatsappCallSessionRow) -> String {
    call.agent_label
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Agent {}", call.user_id))
}

fn livekit_participant_metadata(call: &WhatsappCallSessionRow) -> String {
    json!({
        "callId": call.id,
        "waCallId": call.wa_call_id,
        "conversationId": call.conversation_id,
        "direction": call.direction,
        "fromPhone": call.from_phone,
        "toPhone": call.to_phone,
    })
    .to_string()
}

fn livekit_token(config: &AppConfig, call: &WhatsappCallSessionRow) -> Result<(String, chrono::DateTime<Utc>), AppError> {
    let api_key = config
        .livekit_api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Internal("LIVEKIT_API_KEY is not configured".to_string()))?;
    let api_secret = config
        .livekit_api_secret
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Internal("LIVEKIT_API_SECRET is not configured".to_string()))?;

    let expires_at = Utc::now() + ChronoDuration::seconds(config.livekit_token_ttl_seconds as i64);
    let participant_identity = livekit_participant_identity(call);
    let participant_name = livekit_participant_name(call);
    let participant_metadata = livekit_participant_metadata(call);
    let room_name = livekit_room_name(call);

    let token = access_token::AccessToken::with_api_key(api_key, api_secret)
        .with_identity(&participant_identity)
        .with_name(&participant_name)
        .with_metadata(&participant_metadata)
        .with_attributes(HashMap::from([
            ("callId".to_string(), call.id.clone()),
            (
                "conversationId".to_string(),
                call.conversation_id.clone().unwrap_or_default(),
            ),
            ("userId".to_string(), call.user_id.clone()),
        ]))
        .with_grants(access_token::VideoGrants {
            room_join: true,
            room: room_name,
            can_publish: true,
            can_publish_data: true,
            can_subscribe: true,
            ..Default::default()
        })
        .with_ttl(std::time::Duration::from_secs(config.livekit_token_ttl_seconds))
        .to_jwt()
        .map_err(|error| AppError::Internal(format!("Failed to generate LiveKit token: {error}")))?;

    Ok((token, expires_at))
}

#[async_trait]
impl RtcMediaProvider for LiveKitMediaProvider {
    fn provider_name(&self) -> &'static str {
        "livekit"
    }

    async fn build_media_session(&self, input: MediaSessionContext<'_>) -> Result<Value, AppError> {
        let server_url = input
            .config
            .livekit_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::Internal("LIVEKIT_URL is not configured".to_string()))?;
        let (participant_token, expires_at) = livekit_token(input.config, input.call)?;
        let room_name = livekit_room_name(input.call);
        let participant_identity = livekit_participant_identity(input.call);
        let participant_name = livekit_participant_name(input.call);

        Ok(json!({
            "provider": "livekit",
            "callId": input.call.id,
            "waCallId": input.call.wa_call_id,
            "conversationId": input.call.conversation_id,
            "roomName": room_name,
            "agentRole": "agent",
            "canAccept": input.call.status == "RINGING",
            "canEnd": input.call.status == "ACTIVE"
                || input.call.status == "CONNECTING"
                || input.call.status == "RINGING",
            "livekit": {
                "serverUrl": server_url,
                "roomName": room_name,
                "participantIdentity": participant_identity,
                "participantName": participant_name,
                "participantToken": participant_token,
                "expiresAt": expires_at,
            }
        }))
    }

    async fn dispatch_action(&self, input: ProviderActionContext<'_>) -> Result<Value, AppError> {
        let media_session = self
            .build_media_session(MediaSessionContext {
                config: input.config,
                call: input.call,
            })
            .await?;
        Ok(json!({
            "provider": "livekit",
            "action": input.action,
            "mediaSession": media_session,
            "note": "LiveKit media session prepared for agent-side connection",
        }))
    }

    async fn dispatch_signal(&self, input: ProviderSignalContext<'_>) -> Result<Value, AppError> {
        Ok(json!({
            "provider": "livekit",
            "kind": input.kind,
            "ignored": true,
            "note": "LiveKit sessions do not use the legacy bridge signaling path",
        }))
    }
}
