use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ActionResult {
    pub invocation_id: String,
    pub correlation_id: String,
    pub outcome: ActionOutcome,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ActionOutcome {
    Succeeded { output: Value },
    Accepted { operation_id: String },
    ApprovalRequired { approval_id: String },
    Denied { reason_code: DenialCode },
    Failed { error_code: FailureCode },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DenialCode {
    UnsupportedAction,
    UnsupportedRuntime,
    UnsupportedActor,
    UnauthorizedScope,
    MissingGrant,
    MissingEntitlement,
    LimitExceeded,
    ApprovalRejected,
    PolicyDenied,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    InvalidInput,
    InvalidOutput,
    Conflict,
    DeadlineExceeded,
    TemporarilyUnavailable,
    Internal,
}
