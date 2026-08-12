use actions::{Actor, ActorKind, IdentityRealm};

use crate::error::AppError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrincipalKind {
    DirectUser,
    PlatformAdmin,
    WorkspaceApiKey,
    ServiceAccount,
    OAuthUser,
    OAuthApplication,
    AgentInstallation,
    TrustedInternalService,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Principal {
    pub kind: PrincipalKind,
    pub id: String,
    pub subject_user_id: Option<String>,
    pub client_id: Option<String>,
}

impl Principal {
    pub fn direct_user(user_id: impl Into<String>) -> Self {
        let id = user_id.into();
        Self {
            kind: PrincipalKind::DirectUser,
            subject_user_id: Some(id.clone()),
            client_id: None,
            id,
        }
    }

    pub fn to_direct_actor(&self) -> Result<Actor, AppError> {
        let (kind, authenticated_client_id) = match self.kind {
            PrincipalKind::DirectUser => (ActorKind::DirectUser, None),
            PrincipalKind::WorkspaceApiKey | PrincipalKind::ServiceAccount => (
                ActorKind::ApiClient,
                self.client_id.clone().or_else(|| Some(self.id.clone())),
            ),
            PrincipalKind::AgentInstallation => (
                ActorKind::ExternalAgent,
                self.client_id.clone().or_else(|| Some(self.id.clone())),
            ),
            PrincipalKind::TrustedInternalService => (
                ActorKind::NativeAgent,
                self.client_id.clone().or_else(|| Some(self.id.clone())),
            ),
            PrincipalKind::PlatformAdmin
            | PrincipalKind::OAuthUser
            | PrincipalKind::OAuthApplication => {
                return Err(AppError::Forbidden(
                    "This principal cannot act in the direct product runtime".to_string(),
                ));
            }
        };

        Ok(Actor {
            kind,
            id: self.id.clone(),
            realm: IdentityRealm::Direct,
            authenticated_client_id,
            delegated_by: None,
        })
    }
}
