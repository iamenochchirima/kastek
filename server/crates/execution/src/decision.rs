use actions::{ActionOutcome, DenialCode};
use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GateDecision {
    Allow,
    Deny(DenialCode),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicyDecision {
    Allow,
    Deny(DenialCode),
    ApprovalRequired { approval_id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum IdempotencyDecision {
    Proceed,
    Existing(ActionOutcome),
}

#[derive(Clone, Debug, PartialEq)]
pub enum RunOutput {
    Completed(Value),
    Accepted { operation_id: String },
}
