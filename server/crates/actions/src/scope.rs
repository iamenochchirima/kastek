use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{ActionError, ActorKind, ProductRuntime};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ClientAccess {
    All,
    Assigned { client_ids: BTreeSet<String> },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum Scope {
    ControlPlane,
    Direct {
        organisation_id: String,
    },
    TenantStaff {
        workspace_id: String,
        client_access: ClientAccess,
    },
    TenantClient {
        workspace_id: String,
        tenant_client_id: String,
    },
}

impl Scope {
    pub fn runtime(&self) -> ProductRuntime {
        match self {
            Self::ControlPlane => ProductRuntime::ControlPlane,
            Self::Direct { .. } => ProductRuntime::Direct,
            Self::TenantStaff { .. } | Self::TenantClient { .. } => ProductRuntime::WhiteLabel,
        }
    }

    pub fn tenant_client_id(&self) -> Option<&str> {
        match self {
            Self::TenantClient {
                tenant_client_id, ..
            } => Some(tenant_client_id),
            _ => None,
        }
    }

    pub fn validate(&self, actor_kind: ActorKind) -> Result<(), ActionError> {
        match self {
            Self::ControlPlane => {
                if actor_kind != ActorKind::PlatformOperator {
                    return Err(ActionError::InvalidRequest(
                        "only platform operators can use control-plane scope".to_string(),
                    ));
                }
            }
            Self::Direct { organisation_id } => {
                require_identifier("organisation ID", organisation_id)?;
                if matches!(actor_kind, ActorKind::TenantStaff | ActorKind::TenantClient) {
                    return Err(ActionError::InvalidRequest(
                        "white-label actors cannot use direct scope".to_string(),
                    ));
                }
            }
            Self::TenantStaff {
                workspace_id,
                client_access,
            } => {
                require_identifier("workspace ID", workspace_id)?;
                if actor_kind == ActorKind::TenantClient {
                    return Err(ActionError::InvalidRequest(
                        "tenant client actors require tenant-client scope".to_string(),
                    ));
                }
                if let ClientAccess::Assigned { client_ids } = client_access {
                    for client_id in client_ids {
                        require_identifier("assigned client ID", client_id)?;
                    }
                }
            }
            Self::TenantClient {
                workspace_id,
                tenant_client_id,
            } => {
                require_identifier("workspace ID", workspace_id)?;
                require_identifier("tenant client ID", tenant_client_id)?;
                if actor_kind != ActorKind::TenantClient
                    && !matches!(
                        actor_kind,
                        ActorKind::NativeAgent | ActorKind::ApiClient | ActorKind::ExternalAgent
                    )
                {
                    return Err(ActionError::InvalidRequest(
                        "tenant-client scope requires a tenant client or scoped machine actor"
                            .to_string(),
                    ));
                }
            }
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
