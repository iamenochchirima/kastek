pub mod decision;
pub mod error;
pub mod journal;
pub mod pipeline;
pub mod ports;

pub use decision::{GateDecision, IdempotencyDecision, PolicyDecision, RunOutput};
pub use error::{ExecutionError, PortError};
pub use journal::{JournalOutcome, RunHandle};
pub use pipeline::{ExecutionPipeline, ExecutionPorts};
pub use ports::{
    AccessPort, ActionRunner, ClockPort, EntitlementPort, IdempotencyPort, IdentityPort,
    JournalPort, PolicyPort,
};
