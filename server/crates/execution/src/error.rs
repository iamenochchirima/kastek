use actions::{ActionError, FailureCode};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExecutionError {
    #[error("invalid action request: {0}")]
    InvalidRequest(#[from] ActionError),
}

/// A dependency failure safe to return through an action protocol adapter.
///
/// Internal error details belong in service telemetry, not in this value.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("execution dependency failed with {code:?}")]
pub struct PortError {
    pub code: FailureCode,
}

impl PortError {
    pub const fn new(code: FailureCode) -> Self {
        Self { code }
    }

    pub const fn unavailable() -> Self {
        Self::new(FailureCode::TemporarilyUnavailable)
    }

    pub const fn internal() -> Self {
        Self::new(FailureCode::Internal)
    }
}
