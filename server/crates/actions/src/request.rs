use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ActionError, ActionId, Actor, ClientScopeRule, IdempotencyRule, RegisteredAction, Scope,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IncomingActionRequest {
    pub invocation_id: String,
    pub correlation_id: String,
    pub causation_id: Option<String>,
    pub action: ActionId,
    pub actor: Actor,
    pub scope: Scope,
    pub input: Value,
    pub idempotency_key: Option<String>,
    pub approval_id: Option<String>,
    pub requested_at: DateTime<Utc>,
    pub deadline: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
pub struct ValidatedActionRequest {
    request: IncomingActionRequest,
}

impl ValidatedActionRequest {
    pub(crate) fn new(
        request: IncomingActionRequest,
        action: &RegisteredAction,
    ) -> Result<Self, ActionError> {
        require_identifier("invocation ID", &request.invocation_id)?;
        require_identifier("correlation ID", &request.correlation_id)?;
        if let Some(causation_id) = &request.causation_id {
            require_identifier("causation ID", causation_id)?;
        }
        if let Some(idempotency_key) = &request.idempotency_key {
            require_identifier("idempotency key", idempotency_key)?;
        }
        if let Some(approval_id) = &request.approval_id {
            require_identifier("approval ID", approval_id)?;
        }
        if let Some(deadline) = request.deadline {
            if deadline <= request.requested_at {
                return Err(ActionError::InvalidRequest(
                    "deadline must be later than the request time".to_string(),
                ));
            }
        }

        let definition = action.definition();
        if request.action != definition.id {
            return Err(ActionError::InvalidRequest(
                "request action does not match the registered action".to_string(),
            ));
        }

        let runtime = request.scope.runtime();
        request.actor.validate(runtime)?;
        request.scope.validate(request.actor.kind)?;

        if !definition.supported_runtimes.contains(&runtime) {
            return Err(ActionError::InvalidRequest(
                "action does not support the resolved product runtime".to_string(),
            ));
        }
        if !definition.supported_actors.contains(&request.actor.kind) {
            return Err(ActionError::InvalidRequest(
                "action does not support this actor type".to_string(),
            ));
        }
        match definition.client_scope {
            ClientScopeRule::NotApplicable if request.scope.tenant_client_id().is_some() => {
                return Err(ActionError::InvalidRequest(
                    "action does not accept tenant-client scope".to_string(),
                ));
            }
            ClientScopeRule::Required if request.scope.tenant_client_id().is_none() => {
                return Err(ActionError::InvalidRequest(
                    "action requires tenant-client scope".to_string(),
                ));
            }
            _ => {}
        }
        if definition.idempotency == IdempotencyRule::Required && request.idempotency_key.is_none()
        {
            return Err(ActionError::InvalidRequest(
                "action requires an idempotency key".to_string(),
            ));
        }

        action.validate_input(&request.input)?;
        Ok(Self { request })
    }

    pub fn as_incoming(&self) -> &IncomingActionRequest {
        &self.request
    }

    pub fn into_incoming(self) -> IncomingActionRequest {
        self.request
    }
}

fn require_identifier(label: &str, value: &str) -> Result<(), ActionError> {
    if value.trim().is_empty() {
        return Err(ActionError::InvalidRequest(format!(
            "{label} cannot be empty"
        )));
    }
    Ok(())
}
