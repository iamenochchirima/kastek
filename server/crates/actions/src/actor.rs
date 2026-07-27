use serde::{Deserialize, Serialize};

use crate::{ActionError, ProductRuntime};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityRealm {
    Platform,
    Direct,
    WhiteLabel,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    PlatformOperator,
    DirectUser,
    TenantStaff,
    TenantClient,
    NativeAgent,
    ApiClient,
    ExternalAgent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ActorRef {
    pub kind: ActorKind,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Actor {
    pub kind: ActorKind,
    pub id: String,
    pub realm: IdentityRealm,
    pub authenticated_client_id: Option<String>,
    pub delegated_by: Option<ActorRef>,
}

impl Actor {
    pub fn validate(&self, runtime: ProductRuntime) -> Result<(), ActionError> {
        require_identifier("actor ID", &self.id)?;
        if let Some(client_id) = &self.authenticated_client_id {
            require_identifier("authenticated client ID", client_id)?;
        }
        if let Some(delegator) = &self.delegated_by {
            require_identifier("delegating actor ID", &delegator.id)?;
        }

        let realm_matches_runtime = matches!(
            (self.realm, runtime),
            (IdentityRealm::Platform, ProductRuntime::ControlPlane)
                | (IdentityRealm::Direct, ProductRuntime::Direct)
                | (IdentityRealm::WhiteLabel, ProductRuntime::WhiteLabel)
        );
        if !realm_matches_runtime {
            return Err(ActionError::InvalidRequest(
                "actor identity realm does not match the product runtime".to_string(),
            ));
        }

        let kind_matches_realm = match self.kind {
            ActorKind::PlatformOperator => self.realm == IdentityRealm::Platform,
            ActorKind::DirectUser => self.realm == IdentityRealm::Direct,
            ActorKind::TenantStaff | ActorKind::TenantClient => {
                self.realm == IdentityRealm::WhiteLabel
            }
            ActorKind::NativeAgent | ActorKind::ApiClient | ActorKind::ExternalAgent => true,
        };
        if !kind_matches_realm {
            return Err(ActionError::InvalidRequest(
                "actor type does not match its identity realm".to_string(),
            ));
        }

        if matches!(
            self.kind,
            ActorKind::NativeAgent | ActorKind::ApiClient | ActorKind::ExternalAgent
        ) && self.authenticated_client_id.is_none()
        {
            return Err(ActionError::InvalidRequest(
                "machine actors require an authenticated client ID".to_string(),
            ));
        }

        Ok(())
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
