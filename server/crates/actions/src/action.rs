use std::collections::BTreeSet;

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ActionError, ActorKind, ApprovalRule, RiskClass};

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct ActionId {
    name: String,
    version: Version,
}

impl ActionId {
    pub fn new(name: impl Into<String>, version: Version) -> Result<Self, ActionError> {
        let name = name.into();
        validate_action_name(&name)?;
        Ok(Self { name, version })
    }

    pub fn parse(name: impl Into<String>, version: &str) -> Result<Self, ActionError> {
        let version = Version::parse(version)
            .map_err(|_| ActionError::InvalidActionVersion(version.to_string()))?;
        Self::new(name, version)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn version(&self) -> &Version {
        &self.version
    }
}

impl std::fmt::Display for ActionId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}@{}", self.name, self.version)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductRuntime {
    ControlPlane,
    Direct,
    WhiteLabel,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionLifecycle {
    Draft,
    Internal,
    Pilot,
    Public,
    Deprecated,
    Retired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DataClassification {
    Public,
    Internal,
    Confidential,
    Restricted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyRule {
    NotApplicable,
    Optional,
    Required,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditRule {
    None,
    Access,
    Full,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageRule {
    None,
    Count,
    Measured,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientScopeRule {
    NotApplicable,
    Optional,
    Required,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ActionDefinition {
    pub id: ActionId,
    pub owning_domain: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub risk: RiskClass,
    pub approval: ApprovalRule,
    pub supported_runtimes: BTreeSet<ProductRuntime>,
    pub supported_actors: BTreeSet<ActorKind>,
    pub client_scope: ClientScopeRule,
    pub required_grants: BTreeSet<String>,
    pub required_oauth_scopes: BTreeSet<String>,
    pub required_entitlements: BTreeSet<String>,
    pub idempotency: IdempotencyRule,
    pub data_classification: DataClassification,
    pub audit: AuditRule,
    pub usage: UsageRule,
    pub lifecycle: ActionLifecycle,
}

impl ActionDefinition {
    pub fn validate_metadata(&self) -> Result<(), ActionError> {
        validate_action_name(self.id.name())?;
        require_text("owning domain", &self.owning_domain)?;
        require_text("title", &self.title)?;
        require_text("description", &self.description)?;

        if self.supported_runtimes.is_empty() {
            return Err(ActionError::InvalidDefinition(
                "supported runtimes cannot be empty".to_string(),
            ));
        }
        if self.supported_actors.is_empty() {
            return Err(ActionError::InvalidDefinition(
                "supported actors cannot be empty".to_string(),
            ));
        }
        for grant in &self.required_grants {
            require_text("grant", grant)?;
        }
        for scope in &self.required_oauth_scopes {
            require_text("OAuth scope", scope)?;
        }
        for entitlement in &self.required_entitlements {
            require_text("entitlement", entitlement)?;
        }
        if matches!(self.risk, RiskClass::Read | RiskClass::Draft)
            && matches!(self.approval, ApprovalRule::Always | ApprovalRule::FourEyes)
        {
            return Err(ActionError::InvalidDefinition(
                "read and draft actions cannot require unconditional approval".to_string(),
            ));
        }
        Ok(())
    }
}

fn require_text(label: &str, value: &str) -> Result<(), ActionError> {
    if value.trim().is_empty() {
        return Err(ActionError::InvalidDefinition(format!(
            "{label} cannot be empty"
        )));
    }
    Ok(())
}

fn validate_action_name(name: &str) -> Result<(), ActionError> {
    if !(3..=128).contains(&name.len()) || !name.contains('.') {
        return Err(ActionError::InvalidActionName(name.to_string()));
    }

    let valid = name.split('.').all(|segment| {
        let mut chars = segment.chars();
        matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
            && chars.all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '_' | '-')
            })
    });

    if valid {
        Ok(())
    } else {
        Err(ActionError::InvalidActionName(name.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::ActionId;

    #[test]
    fn action_names_are_namespaced_and_lowercase() {
        assert!(ActionId::parse("customer.search", "1.0.0").is_ok());
        assert!(ActionId::parse("customer_search", "1.0.0").is_err());
        assert!(ActionId::parse("Customer.search", "1.0.0").is_err());
        assert!(ActionId::parse("customer..search", "1.0.0").is_err());
    }
}
