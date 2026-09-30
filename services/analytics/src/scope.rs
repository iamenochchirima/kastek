use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_REPORTING_GRANT_VALIDITY_SECONDS: i64 = 120;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    CoreOrganization,
    TenantWorkspace,
    TenantClient,
}

impl ScopeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CoreOrganization => "core_organization",
            Self::TenantWorkspace => "tenant_workspace",
            Self::TenantClient => "tenant_client",
        }
    }

    pub const fn parent_kind(self) -> Option<Self> {
        match self {
            Self::TenantClient => Some(Self::TenantWorkspace),
            Self::CoreOrganization | Self::TenantWorkspace => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeStatus {
    Active,
    Suspended,
    Deleted,
}

impl ScopeStatus {
    const fn is_authorizable(self) -> bool {
        matches!(self, Self::Active)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalType {
    User,
    ServiceIdentity,
    AgentInstallation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DescendantMode {
    None,
    All,
    Explicit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopeNode {
    pub scope_id: i64,
    pub kind: ScopeKind,
    pub root_scope_id: i64,
    pub parent_scope_id: Option<i64>,
    pub status: ScopeStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReportingGrant {
    pub grant_id: String,
    pub issuer: String,
    pub audience: String,
    pub principal_type: PrincipalType,
    pub principal_id: String,
    pub scope_id: i64,
    pub root_scope_id: i64,
    pub descendant_mode: DescendantMode,
    #[serde(default)]
    pub explicit_descendant_scope_ids: Vec<i64>,
    #[serde(default)]
    pub permissions: BTreeSet<String>,
    #[serde(default)]
    pub metric_keys: Vec<String>,
    #[serde(default)]
    pub dimension_keys: Vec<String>,
    pub policy_version: String,
    pub issued_at: DateTime<Utc>,
    pub not_before: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    #[serde(default)]
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizedScope {
    pub requested_scope_id: i64,
    pub authorized_scope_ids: Vec<i64>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ScopeAuthorizationError {
    #[error("scope {0} is invalid")]
    InvalidScopeId(i64),
    #[error("scope {0} is duplicated")]
    DuplicateScope(i64),
    #[error("scope {scope_id} references missing parent {parent_scope_id}")]
    MissingParent { scope_id: i64, parent_scope_id: i64 },
    #[error("scope {scope_id} references itself as its parent")]
    SelfParent { scope_id: i64 },
    #[error("scope {scope_id} has an invalid root {root_scope_id}")]
    InvalidRoot { scope_id: i64, root_scope_id: i64 },
    #[error("scope {scope_id} has parent kind {parent_kind:?}, expected {expected_kind:?}")]
    InvalidParentKind {
        scope_id: i64,
        parent_kind: ScopeKind,
        expected_kind: ScopeKind,
    },
    #[error("scope hierarchy contains a cycle at {0}")]
    HierarchyCycle(i64),
    #[error("scope {0} is not available for authorization")]
    ScopeUnavailable(i64),
    #[error("grant {0} is invalid: {1}")]
    InvalidGrant(String, String),
    #[error("grant audience is not accepted")]
    InvalidAudience,
    #[error("grant is not currently valid")]
    GrantNotCurrent,
    #[error("grant validity exceeds {MAX_REPORTING_GRANT_VALIDITY_SECONDS} seconds")]
    GrantValidityTooLong,
    #[error("grant permission {0} is missing")]
    MissingPermission(String),
    #[error("scope {0} is outside the grant")]
    ScopeOutsideGrant(i64),
}

#[derive(Clone, Debug, Default)]
pub struct ScopeCatalog {
    scopes: BTreeMap<i64, ScopeNode>,
}

impl ScopeCatalog {
    pub fn new(
        scopes: impl IntoIterator<Item = ScopeNode>,
    ) -> Result<Self, ScopeAuthorizationError> {
        let mut catalog = Self::default();
        for scope in scopes {
            if scope.scope_id <= 0 || scope.root_scope_id <= 0 {
                return Err(ScopeAuthorizationError::InvalidScopeId(scope.scope_id));
            }
            let scope_id = scope.scope_id;
            if catalog.scopes.insert(scope_id, scope).is_some() {
                return Err(ScopeAuthorizationError::DuplicateScope(scope_id));
            }
        }
        catalog.validate_hierarchy()?;
        Ok(catalog)
    }

    pub fn scope(&self, scope_id: i64) -> Option<&ScopeNode> {
        self.scopes.get(&scope_id)
    }

    pub fn is_descendant(&self, ancestor_scope_id: i64, scope_id: i64) -> bool {
        if ancestor_scope_id == scope_id {
            return true;
        }
        let mut current = scope_id;
        let mut visited = BTreeSet::new();
        while let Some(scope) = self.scopes.get(&current) {
            if !visited.insert(current) {
                return false;
            }
            let Some(parent_scope_id) = scope.parent_scope_id else {
                return false;
            };
            if parent_scope_id == ancestor_scope_id {
                return true;
            }
            current = parent_scope_id;
        }
        false
    }

    pub fn active_descendants(&self, ancestor_scope_id: i64) -> Vec<i64> {
        self.scopes
            .values()
            .filter(|scope| {
                self.is_descendant(ancestor_scope_id, scope.scope_id)
                    && self.authorizable_scope(scope.scope_id).is_ok()
            })
            .map(|scope| scope.scope_id)
            .collect()
    }

    pub fn authorize(
        &self,
        grant: &ReportingGrant,
        expected_audience: &str,
        now: DateTime<Utc>,
        requested_scope_id: i64,
        required_permission: &str,
    ) -> Result<AuthorizedScope, ScopeAuthorizationError> {
        validate_grant(grant, expected_audience, now)?;
        if !grant.permissions.contains(required_permission) {
            return Err(ScopeAuthorizationError::MissingPermission(
                required_permission.to_string(),
            ));
        }

        let granted_scope = self.authorizable_scope(grant.scope_id)?;
        if granted_scope.root_scope_id != grant.root_scope_id {
            return Err(ScopeAuthorizationError::InvalidGrant(
                grant.grant_id.clone(),
                "grant root does not match its selected scope".to_string(),
            ));
        }
        let requested_scope = self.authorizable_scope(requested_scope_id)?;
        if requested_scope.root_scope_id != grant.root_scope_id {
            return Err(ScopeAuthorizationError::ScopeOutsideGrant(
                requested_scope_id,
            ));
        }

        if grant.descendant_mode == DescendantMode::Explicit {
            for descendant_scope_id in &grant.explicit_descendant_scope_ids {
                let descendant = self.authorizable_scope(*descendant_scope_id)?;
                if descendant.root_scope_id != grant.root_scope_id
                    || !self.is_descendant(grant.scope_id, *descendant_scope_id)
                {
                    return Err(ScopeAuthorizationError::ScopeOutsideGrant(
                        *descendant_scope_id,
                    ));
                }
            }
        }

        let authorized = match grant.descendant_mode {
            DescendantMode::None => requested_scope_id == grant.scope_id,
            DescendantMode::All => self.is_descendant(grant.scope_id, requested_scope_id),
            DescendantMode::Explicit => {
                grant
                    .explicit_descendant_scope_ids
                    .contains(&requested_scope_id)
                    && self.is_descendant(grant.scope_id, requested_scope_id)
            }
        };
        if !authorized {
            return Err(ScopeAuthorizationError::ScopeOutsideGrant(
                requested_scope_id,
            ));
        }

        let authorized_scope_ids = match grant.descendant_mode {
            DescendantMode::None => vec![grant.scope_id],
            DescendantMode::All => self.active_descendants(grant.scope_id),
            DescendantMode::Explicit => {
                let mut ids = grant.explicit_descendant_scope_ids.clone();
                ids.push(grant.scope_id);
                ids.sort_unstable();
                ids.dedup();
                ids
            }
        };

        Ok(AuthorizedScope {
            requested_scope_id,
            authorized_scope_ids,
        })
    }

    fn authorizable_scope(&self, scope_id: i64) -> Result<&ScopeNode, ScopeAuthorizationError> {
        let scope = self
            .scope(scope_id)
            .ok_or(ScopeAuthorizationError::InvalidScopeId(scope_id))?;
        if !scope.status.is_authorizable() {
            return Err(ScopeAuthorizationError::ScopeUnavailable(scope_id));
        }
        let mut current = scope.parent_scope_id;
        while let Some(parent_scope_id) = current {
            let parent =
                self.scope(parent_scope_id)
                    .ok_or(ScopeAuthorizationError::MissingParent {
                        scope_id,
                        parent_scope_id,
                    })?;
            if !parent.status.is_authorizable() {
                return Err(ScopeAuthorizationError::ScopeUnavailable(parent_scope_id));
            }
            current = parent.parent_scope_id;
        }
        Ok(scope)
    }

    fn validate_hierarchy(&self) -> Result<(), ScopeAuthorizationError> {
        for scope in self.scopes.values() {
            if scope.parent_scope_id.is_none() {
                if scope.root_scope_id != scope.scope_id {
                    return Err(ScopeAuthorizationError::InvalidRoot {
                        scope_id: scope.scope_id,
                        root_scope_id: scope.root_scope_id,
                    });
                }
                continue;
            }

            let parent_scope_id = scope.parent_scope_id.expect("checked above");
            if parent_scope_id == scope.scope_id {
                return Err(ScopeAuthorizationError::SelfParent {
                    scope_id: scope.scope_id,
                });
            }
            let parent = self.scopes.get(&parent_scope_id).ok_or(
                ScopeAuthorizationError::MissingParent {
                    scope_id: scope.scope_id,
                    parent_scope_id,
                },
            )?;
            if scope.root_scope_id != parent.root_scope_id {
                return Err(ScopeAuthorizationError::InvalidRoot {
                    scope_id: scope.scope_id,
                    root_scope_id: scope.root_scope_id,
                });
            }
            if scope.kind.parent_kind() != Some(parent.kind) {
                return Err(ScopeAuthorizationError::InvalidParentKind {
                    scope_id: scope.scope_id,
                    parent_kind: parent.kind,
                    expected_kind: scope.kind.parent_kind().unwrap_or(parent.kind),
                });
            }

            let mut current = scope.scope_id;
            let mut visited = BTreeSet::new();
            while let Some(node) = self.scopes.get(&current) {
                if !visited.insert(current) {
                    return Err(ScopeAuthorizationError::HierarchyCycle(current));
                }
                let Some(parent_scope_id) = node.parent_scope_id else {
                    break;
                };
                current = parent_scope_id;
            }
        }
        Ok(())
    }
}

pub fn validate_grant(
    grant: &ReportingGrant,
    expected_audience: &str,
    now: DateTime<Utc>,
) -> Result<(), ScopeAuthorizationError> {
    if grant.grant_id.trim().is_empty()
        || grant.issuer.trim().is_empty()
        || grant.audience.trim().is_empty()
        || grant.principal_id.trim().is_empty()
        || grant.policy_version.trim().is_empty()
        || grant.scope_id <= 0
        || grant.root_scope_id <= 0
    {
        return Err(ScopeAuthorizationError::InvalidGrant(
            grant.grant_id.clone(),
            "required fields are missing".to_string(),
        ));
    }
    if grant.audience != expected_audience {
        return Err(ScopeAuthorizationError::InvalidAudience);
    }
    if grant.revoked_at.is_some() {
        return Err(ScopeAuthorizationError::InvalidGrant(
            grant.grant_id.clone(),
            "grant is revoked".to_string(),
        ));
    }
    if grant.issued_at > grant.not_before || grant.expires_at <= grant.not_before {
        return Err(ScopeAuthorizationError::InvalidGrant(
            grant.grant_id.clone(),
            "grant timestamps are inconsistent".to_string(),
        ));
    }
    if grant.expires_at - grant.issued_at > Duration::seconds(MAX_REPORTING_GRANT_VALIDITY_SECONDS)
    {
        return Err(ScopeAuthorizationError::GrantValidityTooLong);
    }
    if now < grant.not_before || now >= grant.expires_at {
        return Err(ScopeAuthorizationError::GrantNotCurrent);
    }
    match grant.descendant_mode {
        DescendantMode::Explicit if grant.explicit_descendant_scope_ids.is_empty() => {
            return Err(ScopeAuthorizationError::InvalidGrant(
                grant.grant_id.clone(),
                "explicit descendant mode requires at least one descendant".to_string(),
            ));
        }
        DescendantMode::None | DescendantMode::All
            if !grant.explicit_descendant_scope_ids.is_empty() =>
        {
            return Err(ScopeAuthorizationError::InvalidGrant(
                grant.grant_id.clone(),
                "explicit descendants are only valid in explicit mode".to_string(),
            ));
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        DescendantMode, PrincipalType, ReportingGrant, ScopeCatalog, ScopeKind, ScopeNode,
        ScopeStatus, MAX_REPORTING_GRANT_VALIDITY_SECONDS,
    };
    use chrono::{Duration, TimeZone, Utc};
    use std::collections::BTreeSet;

    fn catalog() -> ScopeCatalog {
        ScopeCatalog::new([
            ScopeNode {
                scope_id: 1,
                kind: ScopeKind::CoreOrganization,
                root_scope_id: 1,
                parent_scope_id: None,
                status: ScopeStatus::Active,
            },
            ScopeNode {
                scope_id: 2,
                kind: ScopeKind::TenantWorkspace,
                root_scope_id: 2,
                parent_scope_id: None,
                status: ScopeStatus::Active,
            },
            ScopeNode {
                scope_id: 3,
                kind: ScopeKind::TenantClient,
                root_scope_id: 2,
                parent_scope_id: Some(2),
                status: ScopeStatus::Active,
            },
            ScopeNode {
                scope_id: 4,
                kind: ScopeKind::TenantClient,
                root_scope_id: 2,
                parent_scope_id: Some(2),
                status: ScopeStatus::Active,
            },
        ])
        .expect("fixture hierarchy should be valid")
    }

    fn grant(scope_id: i64, mode: DescendantMode, now: chrono::DateTime<Utc>) -> ReportingGrant {
        ReportingGrant {
            grant_id: format!("grant-{scope_id}"),
            issuer: "tenant-platform".to_string(),
            audience: "kasitek-analytics-reporting".to_string(),
            principal_type: PrincipalType::User,
            principal_id: "user-1".to_string(),
            scope_id,
            root_scope_id: if scope_id == 3 { 2 } else { scope_id },
            descendant_mode: mode,
            explicit_descendant_scope_ids: Vec::new(),
            permissions: BTreeSet::from(["analytics:read".to_string()]),
            metric_keys: Vec::new(),
            dimension_keys: Vec::new(),
            policy_version: "policy-1".to_string(),
            issued_at: now - Duration::seconds(10),
            not_before: now - Duration::seconds(5),
            expires_at: now + Duration::seconds(30),
            correlation_id: None,
            revoked_at: None,
        }
    }

    #[test]
    fn parent_relationship_does_not_grant_child_access_by_default() {
        let now = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
        let result = catalog().authorize(
            &grant(2, DescendantMode::None, now),
            "kasitek-analytics-reporting",
            now,
            3,
            "analytics:read",
        );
        assert!(matches!(
            result,
            Err(super::ScopeAuthorizationError::ScopeOutsideGrant(3))
        ));
    }

    #[test]
    fn workspace_all_descendants_cannot_cross_into_core_scope() {
        let now = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
        let result = catalog().authorize(
            &grant(2, DescendantMode::All, now),
            "kasitek-analytics-reporting",
            now,
            1,
            "analytics:read",
        );
        assert!(result.is_err());
        let child = catalog()
            .authorize(
                &grant(2, DescendantMode::All, now),
                "kasitek-analytics-reporting",
                now,
                3,
                "analytics:read",
            )
            .expect("workspace grant should include current client descendants");
        assert!(child.authorized_scope_ids.contains(&2));
        assert!(child.authorized_scope_ids.contains(&3));
        assert!(child.authorized_scope_ids.contains(&4));
    }

    #[test]
    fn client_grant_cannot_read_parent_or_sibling() {
        let now = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
        let grant = grant(3, DescendantMode::None, now);
        assert!(catalog()
            .authorize(
                &grant,
                "kasitek-analytics-reporting",
                now,
                2,
                "analytics:read"
            )
            .is_err());
        assert!(catalog()
            .authorize(
                &grant,
                "kasitek-analytics-reporting",
                now,
                4,
                "analytics:read"
            )
            .is_err());
    }

    #[test]
    fn explicit_workspace_descendants_are_bounded() {
        let now = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
        let mut grant = grant(2, DescendantMode::Explicit, now);
        grant.explicit_descendant_scope_ids = vec![3];
        assert!(catalog()
            .authorize(
                &grant,
                "kasitek-analytics-reporting",
                now,
                3,
                "analytics:read"
            )
            .is_ok());
        assert!(catalog()
            .authorize(
                &grant,
                "kasitek-analytics-reporting",
                now,
                4,
                "analytics:read"
            )
            .is_err());
    }

    #[test]
    fn explicit_grants_reject_non_descendant_members() {
        let now = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
        let mut grant = grant(2, DescendantMode::Explicit, now);
        grant.explicit_descendant_scope_ids = vec![1];
        assert!(matches!(
            catalog().authorize(
                &grant,
                "kasitek-analytics-reporting",
                now,
                2,
                "analytics:read"
            ),
            Err(super::ScopeAuthorizationError::ScopeOutsideGrant(1))
        ));
    }

    #[test]
    fn suspended_parent_invalidates_child_authorization() {
        let now = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
        let scopes = [
            ScopeNode {
                scope_id: 2,
                kind: ScopeKind::TenantWorkspace,
                root_scope_id: 2,
                parent_scope_id: None,
                status: ScopeStatus::Suspended,
            },
            ScopeNode {
                scope_id: 3,
                kind: ScopeKind::TenantClient,
                root_scope_id: 2,
                parent_scope_id: Some(2),
                status: ScopeStatus::Active,
            },
        ];
        let catalog = ScopeCatalog::new(scopes).expect("fixture hierarchy should be valid");
        assert!(matches!(
            catalog.authorize(
                &grant(3, DescendantMode::None, now),
                "kasitek-analytics-reporting",
                now,
                3,
                "analytics:read"
            ),
            Err(super::ScopeAuthorizationError::ScopeUnavailable(2))
        ));
    }

    #[test]
    fn expired_and_overlong_grants_are_rejected() {
        let now = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
        let mut expired = grant(2, DescendantMode::None, now);
        expired.expires_at = now - Duration::seconds(1);
        assert!(catalog()
            .authorize(
                &expired,
                "kasitek-analytics-reporting",
                now,
                2,
                "analytics:read"
            )
            .is_err());

        let mut overlong = grant(2, DescendantMode::None, now);
        overlong.expires_at =
            overlong.issued_at + Duration::seconds(MAX_REPORTING_GRANT_VALIDITY_SECONDS + 1);
        assert!(catalog()
            .authorize(
                &overlong,
                "kasitek-analytics-reporting",
                now,
                2,
                "analytics:read"
            )
            .is_err());
    }

    #[test]
    fn invalid_parent_kind_is_rejected() {
        let error = ScopeCatalog::new([ScopeNode {
            scope_id: 3,
            kind: ScopeKind::TenantClient,
            root_scope_id: 3,
            parent_scope_id: Some(1),
            status: ScopeStatus::Active,
        }])
        .unwrap_err();
        assert!(matches!(
            error,
            super::ScopeAuthorizationError::MissingParent { .. }
        ));
    }
}
