use std::collections::{BTreeMap, HashSet};

use actix_web::HttpRequest;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jwt_simple::{
    algorithms::ECDSAP256PublicKeyLike,
    prelude::{ES256PublicKey, VerificationOptions},
};
use serde::{Deserialize, Serialize};

use crate::{
    config::AppConfig,
    error::AppError,
    identity::{
        principal::{Principal, PrincipalKind},
        request_context::RequestContext,
    },
    services::realtime,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DelegationClaims {
    #[serde(rename = "organizationId")]
    pub organization_id: String,
    #[serde(rename = "installationId")]
    pub installation_id: String,
    pub capability: String,
    #[serde(rename = "capabilityVersion")]
    pub capability_version: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "invocationId")]
    pub invocation_id: String,
    #[serde(rename = "correlationId")]
    pub correlation_id: String,
    #[serde(rename = "actorId")]
    pub actor_id: Option<String>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(rename = "argumentsHash")]
    pub arguments_hash: Option<String>,
}

#[derive(Deserialize)]
struct DelegationHeader {
    kid: Option<String>,
}

fn delegation_key_id(token: &str) -> Result<Option<String>, AppError> {
    let encoded = token.split('.').next().ok_or(AppError::Unauthorized)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppError::Unauthorized)?;
    let header: DelegationHeader =
        serde_json::from_slice(&bytes).map_err(|_| AppError::Unauthorized)?;
    match header.kid {
        Some(kid) if kid.trim().is_empty() || kid.len() > 128 => Err(AppError::Unauthorized),
        other => Ok(other),
    }
}

fn select_delegation_public_key(config: &AppConfig, token: &str) -> Result<String, AppError> {
    let kid = delegation_key_id(token)?;
    if let Some(raw_keys) = config.agents_delegation_public_keys_json.as_deref() {
        let keys: BTreeMap<String, String> =
            serde_json::from_str(raw_keys).map_err(|_| AppError::Unauthorized)?;
        let kid = kid.ok_or(AppError::Unauthorized)?;
        return keys
            .get(&kid)
            .filter(|key| !key.trim().is_empty())
            .cloned()
            .ok_or(AppError::Unauthorized);
    }
    if kid.is_some() {
        return Err(AppError::Unauthorized);
    }
    config
        .agents_delegation_public_key
        .clone()
        .ok_or(AppError::Unauthorized)
}

pub async fn resolve(config: &AppConfig, req: &HttpRequest) -> Result<RequestContext, AppError> {
    let token = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;
    let public_key = select_delegation_public_key(config, token)?;
    let key = ES256PublicKey::from_pem(&public_key).map_err(|_| AppError::Unauthorized)?;
    let mut allowed_audiences = HashSet::new();
    allowed_audiences.insert(config.agents_delegation_audience.clone());
    let options = VerificationOptions {
        allowed_issuers: Some(
            [config.agents_delegation_issuer.clone()]
                .into_iter()
                .collect(),
        ),
        allowed_audiences: Some(allowed_audiences),
        max_validity: Some(std::time::Duration::from_secs(120).into()),
        ..VerificationOptions::default()
    };
    let claims = key
        .verify_token::<DelegationClaims>(token, Some(options))
        .map_err(|_| AppError::Unauthorized)?;
    let subject = claims.subject.clone().ok_or(AppError::Unauthorized)?;
    let jti = claims.jwt_id.clone().ok_or(AppError::Unauthorized)?;
    let correlation_id = claims.custom.correlation_id.clone();
    if claims.custom.organization_id.trim().is_empty()
        || claims.custom.installation_id.trim().is_empty()
        || claims.custom.capability.trim().is_empty()
        || claims.custom.capability_version.trim().is_empty()
        || claims.custom.run_id.trim().is_empty()
        || claims.custom.invocation_id.trim().is_empty()
        || claims.custom.correlation_id.trim().is_empty()
        || jti.trim().is_empty()
        || jti.len() > 255
        || subject != claims.custom.installation_id
    {
        return Err(AppError::Unauthorized);
    }
    if !realtime::claim_delegation_replay(&config.agents_delegation_issuer, &jti).await? {
        observability::tracing::warn!(
            event = "operation.failed",
            operation = "agent_delegation.replay_check",
            reason = "replayed_request",
            installation_id = %claims.custom.installation_id,
            run_id = %claims.custom.run_id,
            invocation_id = %claims.custom.invocation_id,
            correlation_id = %claims.custom.correlation_id,
            "delegated request replay rejected"
        );
        return Err(AppError::Unauthorized);
    }
    Ok(RequestContext {
        principal: Principal {
            kind: PrincipalKind::AgentInstallation,
            id: subject.clone(),
            subject_user_id: claims.custom.actor_id.clone(),
            client_id: Some(subject),
        },
        organization_id: claims.custom.organization_id,
        user_id: claims.custom.actor_id,
        client_id: None,
        installation_id: Some(claims.custom.installation_id),
        effective_grants: [claims.custom.capability].into_iter().collect(),
        api_scopes: None,
        correlation_id: Some(correlation_id),
        causation_id: Some(claims.custom.invocation_id),
        idempotency_key: claims.custom.idempotency_key,
    })
}

#[cfg(test)]
mod tests {
    use super::{delegation_key_id, select_delegation_public_key};
    use crate::config::AppConfig;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    fn token(header: &str) -> String {
        format!("{}.payload.signature", URL_SAFE_NO_PAD.encode(header))
    }

    fn config(keys: Option<&str>, legacy: Option<&str>) -> AppConfig {
        // This construction intentionally exercises only key selection; the remaining settings are
        // unrelated to delegation verification and use development-safe placeholders.
        AppConfig {
            port: 4000,
            environment: "test".to_string(),
            database_url: "postgres://test".to_string(),
            database_max_connections: 1,
            frontend_url: "http://localhost:3000".to_string(),
            admin_frontend_url: "http://localhost:3001".to_string(),
            public_api_url: "http://localhost:4000".to_string(),
            media_storage_path: ".data/media".to_string(),
            public_api_rate_limit_per_minute: 120,
            auth_url: "http://localhost:3000".to_string(),
            private_release_mode: true,
            early_access_self_service_enabled: true,
            session_secret: "test".to_string(),
            resend_api_key: None,
            resend_from_email: "test@example.com".to_string(),
            zoomconnect_send_url: None,
            agents_internal_token: None,
            agents_api_url: None,
            agents_internal_auth_secret: None,
            agents_internal_auth_audience: "test".to_string(),
            agents_delegation_public_key: legacy.map(str::to_string),
            agents_delegation_public_keys_json: keys.map(str::to_string),
            agents_delegation_issuer: "issuer".to_string(),
            agents_delegation_audience: "audience".to_string(),
            agents_installation_token_public_key: None,
            agents_installation_token_issuer: "issuer".to_string(),
            agents_api_timeout_ms: 1_000,
            email_google_client_id: None,
            email_google_client_secret: None,
            email_google_redirect_uri: None,
            email_microsoft_client_id: None,
            email_microsoft_client_secret: None,
            email_microsoft_redirect_uri: None,
            web_push_vapid_public_key: None,
            web_push_vapid_private_key: None,
            web_push_subject: "mailto:test@example.com".to_string(),
            paystack_secret_key: None,
            paystack_mode: "test".to_string(),
            paystack_api_base_url: "https://example.test".to_string(),
            trial_credits: 1_000,
            trial_duration_days: 14,
            referral_referrer_credits: 1_000,
            referral_referee_credits: 500,
            referral_reward_expiry_days: 365,
            referral_attribution_window_days: 90,
            twilio_account_sid: None,
            twilio_auth_token: None,
            twilio_api_key_sid: None,
            twilio_api_key_secret: None,
            twilio_twiml_app_sid: None,
            twilio_voice_webhook_url: None,
            twilio_browser_twiml_url: None,
            twilio_inbound_fallback_number: None,
            analytics_reporting_url: "http://localhost:4300".to_string(),
            analytics_reporting_private_key: None,
            analytics_reporting_key_id: None,
            analytics_reporting_resolver_token: None,
            analytics_reporting_issuer: "kasitek-core".to_string(),
            analytics_reporting_audience: "kasitek-analytics-reporting".to_string(),
            analytics_reporting_timeout_ms: 5_000,
        }
    }

    #[test]
    fn selects_overlapping_rotated_key_by_kid() {
        let keys = r#"{"old":"old-pem","current":"current-pem"}"#;
        assert_eq!(
            select_delegation_public_key(
                &config(Some(keys), None),
                &token(r#"{"alg":"ES256","kid":"old"}"#)
            )
            .unwrap(),
            "old-pem"
        );
        assert_eq!(
            select_delegation_public_key(
                &config(Some(keys), None),
                &token(r#"{"alg":"ES256","kid":"current"}"#)
            )
            .unwrap(),
            "current-pem"
        );
    }

    #[test]
    fn rejects_unknown_or_missing_rotation_key_id() {
        let config = config(Some(r#"{"current":"current-pem"}"#), None);
        assert!(select_delegation_public_key(
            &config,
            &token(r#"{"alg":"ES256","kid":"unknown"}"#)
        )
        .is_err());
        assert!(select_delegation_public_key(&config, &token(r#"{"alg":"ES256"}"#)).is_err());
        assert!(delegation_key_id("not-a-jwt").is_err());
    }

    #[test]
    fn permits_legacy_tokens_only_with_the_legacy_single_key() {
        assert_eq!(
            select_delegation_public_key(
                &config(None, Some("legacy-pem")),
                &token(r#"{"alg":"ES256"}"#)
            )
            .unwrap(),
            "legacy-pem"
        );
        assert!(select_delegation_public_key(
            &config(None, Some("legacy-pem")),
            &token(r#"{"alg":"ES256","kid":"current"}"#)
        )
        .is_err());
    }
}
