use actions::{DenialCode, FailureCode};

use crate::PortError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunHandle(String);

impl RunHandle {
    pub fn new(id: impl Into<String>) -> Result<Self, PortError> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(PortError::internal());
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The bounded outcome written to the execution journal.
///
/// Inputs and outputs are deliberately excluded. Production journal adapters
/// apply the action's data classification and retention rules to payloads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JournalOutcome {
    Denied(DenialCode),
    ApprovalRequired { approval_id: String },
    Succeeded,
    Accepted { operation_id: String },
    Failed(FailureCode),
}
