use std::collections::HashSet;

use actix_web::HttpRequest;
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

pub async fn resolve(config: &AppConfig, req: &HttpRequest) -> Result<RequestContext, AppError> {
    let token = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;
    let public_key = config
        .agents_delegation_public_key
        .as_deref()
        .ok_or(AppError::Unauthorized)?;
    let key = ES256PublicKey::from_pem(public_key).map_err(|_| AppError::Unauthorized)?;
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
        log::warn!(
            "[agent-delegation] rejected replayed request installation_id={} run_id={} invocation_id={} correlation_id={}",
            claims.custom.installation_id,
            claims.custom.run_id,
            claims.custom.invocation_id,
            claims.custom.correlation_id,
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
        correlation_id: Some(correlation_id),
        causation_id: Some(claims.custom.invocation_id),
        idempotency_key: claims.custom.idempotency_key,
    })
}
