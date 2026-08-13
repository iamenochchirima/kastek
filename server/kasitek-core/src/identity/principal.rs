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

#[cfg(test)]
mod tests {
    use super::{Principal, PrincipalKind};
    use actions::{ActorKind, IdentityRealm};

    #[test]
    fn direct_actor_conversion_preserves_supported_principal_kinds() {
        let direct = Principal::direct_user("user-1").to_direct_actor().unwrap();
        assert_eq!(direct.kind, ActorKind::DirectUser);
        assert_eq!(direct.realm, IdentityRealm::Direct);

        let api_client = Principal {
            kind: PrincipalKind::WorkspaceApiKey,
            id: "key-1".to_string(),
            subject_user_id: None,
            client_id: Some("client-1".to_string()),
        }
        .to_direct_actor()
        .unwrap();
        assert_eq!(api_client.kind, ActorKind::ApiClient);
        assert_eq!(
            api_client.authenticated_client_id.as_deref(),
            Some("client-1")
        );
    }

    #[test]
    fn direct_runtime_rejects_wrong_realm_principals() {
        for kind in [
            PrincipalKind::PlatformAdmin,
            PrincipalKind::OAuthUser,
            PrincipalKind::OAuthApplication,
        ] {
            let result = Principal {
                kind,
                id: "principal-1".to_string(),
                subject_user_id: None,
                client_id: None,
            }
            .to_direct_actor();
            assert!(result.is_err());
        }
    }
}
