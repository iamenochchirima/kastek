use chrono::{DateTime, Utc};
use serde::Serialize;

pub const SERVICE_NAME: &str = "kasitek-analytics";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessKind {
    Api,
    Worker,
}

impl ProcessKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Api => "analytics-api",
            Self::Worker => "analytics-worker",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LivenessResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub process: &'static str,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct DependencyStatus {
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
pub struct ReadinessResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub process: &'static str,
    pub timestamp: DateTime<Utc>,
    pub dependencies: ReadinessDependencies,
}

#[derive(Debug, Serialize)]
pub struct ReadinessDependencies {
    pub postgres: DependencyStatus,
    pub migrations: DependencyStatus,
}
