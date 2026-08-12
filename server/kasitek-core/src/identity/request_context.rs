use std::collections::BTreeSet;

use actions::Scope;

use super::principal::Principal;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestContext {
    pub principal: Principal,
    pub organization_id: String,
    pub user_id: Option<String>,
    pub client_id: Option<String>,
    pub installation_id: Option<String>,
    pub effective_grants: BTreeSet<String>,
    pub correlation_id: Option<String>,
    pub causation_id: Option<String>,
    pub idempotency_key: Option<String>,
}

impl RequestContext {
    pub fn direct_scope(&self) -> Scope {
        Scope::Direct {
            organisation_id: self.organization_id.clone(),
        }
    }

    pub fn has_grant(&self, grant: &str) -> bool {
        self.effective_grants.contains(grant)
    }
}
