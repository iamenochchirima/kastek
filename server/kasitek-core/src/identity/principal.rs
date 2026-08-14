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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PublicApiPrincipalPolicy {
    pub wire_name: &'static str,
    pub actor_kind: ActorKind,
    pub supports_direct_reads: bool,
    pub supports_direct_writes: bool,
    pub requires_installation_capabilities: bool,
}

pub const SUPPORTED_PUBLIC_API_PRINCIPALS: [&str; 2] = ["direct_user", "agent_installation"];
pub const UNSUPPORTED_PUBLIC_API_PRINCIPALS: [&str; 4] = [
    "workspace_api_key",
    "service_account",
    "oauth_user",
    "oauth_application",
];

impl PrincipalKind {
    pub fn wire_name(&self) -> &'static str {
        match self {
            Self::DirectUser => "direct_user",
            Self::PlatformAdmin => "platform_admin",
            Self::WorkspaceApiKey => "workspace_api_key",
            Self::ServiceAccount => "service_account",
            Self::OAuthUser => "oauth_user",
            Self::OAuthApplication => "oauth_application",
            Self::AgentInstallation => "agent_installation",
            Self::TrustedInternalService => "trusted_internal_service",
        }
    }
}

impl Principal {
    /// The public REST boundary deliberately has a narrower principal matrix
    /// than the internal action runtime. Unsupported issuers fail here before
    /// any resource query or capability lookup can run.
    pub fn public_api_policy(&self) -> Result<PublicApiPrincipalPolicy, AppError> {
        match self.kind {
            PrincipalKind::DirectUser => Ok(PublicApiPrincipalPolicy {
                wire_name: "direct_user",
                actor_kind: ActorKind::DirectUser,
                supports_direct_reads: true,
                supports_direct_writes: true,
                requires_installation_capabilities: false,
            }),
            PrincipalKind::AgentInstallation => Ok(PublicApiPrincipalPolicy {
                wire_name: "agent_installation",
                actor_kind: ActorKind::ExternalAgent,
                supports_direct_reads: true,
                supports_direct_writes: true,
                requires_installation_capabilities: true,
            }),
            _ => Err(AppError::UnsupportedPrincipal(format!(
                "Public API principal type {} is not supported",
                self.kind.wire_name()
            ))),
        }
    }
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
    use crate::error::AppError;
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

    #[test]
    fn public_api_principal_matrix_is_explicit_and_stable() {
        let direct = Principal::direct_user("user-1")
            .public_api_policy()
            .expect("direct user is supported");
        assert_eq!(direct.wire_name, "direct_user");
        assert_eq!(direct.actor_kind, ActorKind::DirectUser);
        assert!(!direct.requires_installation_capabilities);

        let installation = Principal {
            kind: PrincipalKind::AgentInstallation,
            id: "installation-1".to_string(),
            subject_user_id: None,
            client_id: Some("credential-1".to_string()),
        }
        .public_api_policy()
        .expect("installation is supported");
        assert_eq!(installation.wire_name, "agent_installation");
        assert_eq!(installation.actor_kind, ActorKind::ExternalAgent);
        assert!(installation.requires_installation_capabilities);

        for kind in [
            PrincipalKind::WorkspaceApiKey,
            PrincipalKind::ServiceAccount,
            PrincipalKind::OAuthUser,
            PrincipalKind::OAuthApplication,
        ] {
            let result = Principal {
                kind,
                id: "principal-1".to_string(),
                subject_user_id: None,
                client_id: None,
            }
            .public_api_policy();
            assert!(matches!(result, Err(AppError::UnsupportedPrincipal(_))));
        }
    }
}
