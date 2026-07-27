use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SchemaSide {
    Input,
    Output,
}

impl std::fmt::Display for SchemaSide {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Input => formatter.write_str("input"),
            Self::Output => formatter.write_str("output"),
        }
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ActionError {
    #[error("action name is invalid: {0}")]
    InvalidActionName(String),
    #[error("action version is invalid: {0}")]
    InvalidActionVersion(String),
    #[error("action definition is invalid: {0}")]
    InvalidDefinition(String),
    #[error("{side} schema is invalid: {detail}")]
    InvalidSchema { side: SchemaSide, detail: String },
    #[error("{side} does not match the action schema at {instance_path}")]
    SchemaViolation {
        side: SchemaSide,
        instance_path: String,
    },
    #[error("action is already registered: {0}")]
    DuplicateAction(String),
    #[error("action is not registered: {0}")]
    ActionNotFound(String),
    #[error("action request is invalid: {0}")]
    InvalidRequest(String),
}
