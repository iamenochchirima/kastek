use actions::{ActionDefinition, ValidatedActionRequest};
use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::{
    GateDecision, IdempotencyDecision, JournalOutcome, PolicyDecision, PortError, RunHandle,
    RunOutput,
};

pub trait ClockPort: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

#[async_trait]
pub trait IdentityPort: Send + Sync {
    async fn evaluate(
        &self,
        request: &ValidatedActionRequest,
        action: &ActionDefinition,
    ) -> Result<GateDecision, PortError>;
}

#[async_trait]
pub trait AccessPort: Send + Sync {
    async fn evaluate(
        &self,
        request: &ValidatedActionRequest,
        action: &ActionDefinition,
    ) -> Result<GateDecision, PortError>;
}

#[async_trait]
pub trait EntitlementPort: Send + Sync {
    async fn evaluate(
        &self,
        request: &ValidatedActionRequest,
        action: &ActionDefinition,
    ) -> Result<GateDecision, PortError>;
}

#[async_trait]
pub trait PolicyPort: Send + Sync {
    async fn evaluate(
        &self,
        request: &ValidatedActionRequest,
        action: &ActionDefinition,
    ) -> Result<PolicyDecision, PortError>;
}

#[async_trait]
pub trait IdempotencyPort: Send + Sync {
    async fn evaluate(
        &self,
        request: &ValidatedActionRequest,
        action: &ActionDefinition,
    ) -> Result<IdempotencyDecision, PortError>;
}

#[async_trait]
pub trait JournalPort: Send + Sync {
    async fn record_decision(
        &self,
        request: &ValidatedActionRequest,
        outcome: &JournalOutcome,
    ) -> Result<(), PortError>;

    async fn start(
        &self,
        request: &ValidatedActionRequest,
        action: &ActionDefinition,
    ) -> Result<RunHandle, PortError>;

    async fn finish(&self, run: &RunHandle, outcome: &JournalOutcome) -> Result<(), PortError>;
}

#[async_trait]
pub trait ActionRunner: Send + Sync {
    async fn run(
        &self,
        request: &ValidatedActionRequest,
        action: &ActionDefinition,
    ) -> Result<RunOutput, PortError>;
}
