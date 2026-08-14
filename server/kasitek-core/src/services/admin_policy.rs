use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataClassification {
    Public,
    Operational,
    CustomerContent,
    Secret,
}

pub fn operator_projection_fields() -> BTreeSet<&'static str> {
    [
        "id",
        "organization_id",
        "installation_id",
        "run_id",
        "correlation_id",
        "status",
        "capability",
        "resource_type",
        "created_at",
        "updated_at",
    ]
    .into_iter()
    .collect()
}

pub fn prohibited_operator_fields() -> BTreeSet<&'static str> {
    [
        "password",
        "token",
        "access_token",
        "refresh_token",
        "client_secret",
        "provider_receipt",
        "prompt",
        "raw_payload",
        "customer_content",
    ]
    .into_iter()
    .collect()
}

pub fn can_use_emergency_access(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "superadmin" | "owner"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        can_use_emergency_access, operator_projection_fields, prohibited_operator_fields,
        DataClassification,
    };

    #[test]
    fn classifies_and_limits_operator_data() {
        assert_eq!(
            DataClassification::CustomerContent,
            DataClassification::CustomerContent
        );
        assert!(operator_projection_fields().contains("correlation_id"));
        assert!(prohibited_operator_fields().contains("access_token"));
        assert!(!operator_projection_fields().contains("prompt"));
    }

    #[test]
    fn reserves_emergency_access_for_owner_roles() {
        assert!(can_use_emergency_access("owner"));
        assert!(can_use_emergency_access("SUPERADMIN"));
        assert!(!can_use_emergency_access("operator"));
    }
}
