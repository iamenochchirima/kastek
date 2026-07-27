use std::sync::Arc;

use actions::{
    ActionOutcome, ActionRegistry, ActionResult, DenialCode, FailureCode, IncomingActionRequest,
    ValidatedActionRequest,
};

use crate::{
    AccessPort, ActionRunner, ClockPort, EntitlementPort, ExecutionError, GateDecision,
    IdempotencyDecision, IdempotencyPort, IdentityPort, JournalOutcome, JournalPort,
    PolicyDecision, PolicyPort, PortError, RunOutput,
};

pub struct ExecutionPorts {
    pub clock: Arc<dyn ClockPort>,
    pub identity: Arc<dyn IdentityPort>,
    pub access: Arc<dyn AccessPort>,
    pub entitlements: Arc<dyn EntitlementPort>,
    pub policy: Arc<dyn PolicyPort>,
    pub idempotency: Arc<dyn IdempotencyPort>,
    pub journal: Arc<dyn JournalPort>,
    pub runner: Arc<dyn ActionRunner>,
}

pub struct ExecutionPipeline {
    registry: Arc<ActionRegistry>,
    ports: ExecutionPorts,
}

impl ExecutionPipeline {
    pub fn new(registry: Arc<ActionRegistry>, ports: ExecutionPorts) -> Self {
        Self { registry, ports }
    }

    pub async fn execute(
        &self,
        request: IncomingActionRequest,
    ) -> Result<ActionResult, ExecutionError> {
        let request = self.registry.validate_request(request)?;
        let action = self
            .registry
            .get(&request.as_incoming().action)?
            .definition();

        if request
            .as_incoming()
            .deadline
            .is_some_and(|deadline| deadline <= self.ports.clock.now())
        {
            return Ok(self
                .record_failure(&request, FailureCode::DeadlineExceeded)
                .await);
        }

        match self.ports.identity.evaluate(&request, action).await {
            Ok(GateDecision::Allow) => {}
            Ok(GateDecision::Deny(code)) => return Ok(self.record_denial(&request, code).await),
            Err(error) => return Ok(self.record_failure(&request, error.code).await),
        }

        match self.ports.access.evaluate(&request, action).await {
            Ok(GateDecision::Allow) => {}
            Ok(GateDecision::Deny(code)) => return Ok(self.record_denial(&request, code).await),
            Err(error) => return Ok(self.record_failure(&request, error.code).await),
        }

        match self.ports.entitlements.evaluate(&request, action).await {
            Ok(GateDecision::Allow) => {}
            Ok(GateDecision::Deny(code)) => return Ok(self.record_denial(&request, code).await),
            Err(error) => return Ok(self.record_failure(&request, error.code).await),
        }

        match self.ports.policy.evaluate(&request, action).await {
            Ok(PolicyDecision::Allow) => {}
            Ok(PolicyDecision::Deny(code)) => return Ok(self.record_denial(&request, code).await),
            Ok(PolicyDecision::ApprovalRequired { approval_id }) => {
                if approval_id.trim().is_empty() {
                    return Ok(self.record_failure(&request, FailureCode::Internal).await);
                }
                let journal_outcome = JournalOutcome::ApprovalRequired {
                    approval_id: approval_id.clone(),
                };
                let outcome = ActionOutcome::ApprovalRequired { approval_id };
                return Ok(self
                    .record_decision(&request, journal_outcome, outcome)
                    .await);
            }
            Err(error) => return Ok(self.record_failure(&request, error.code).await),
        }

        match self.ports.idempotency.evaluate(&request, action).await {
            Ok(IdempotencyDecision::Proceed) => {}
            Ok(IdempotencyDecision::Existing(outcome)) => {
                return Ok(action_result(&request, outcome));
            }
            Err(error) => return Ok(self.record_failure(&request, error.code).await),
        }

        let run = match self.ports.journal.start(&request, action).await {
            Ok(run) => run,
            Err(error) => return Ok(action_result(&request, failed(error.code))),
        };

        let (journal_outcome, action_outcome) = match self.ports.runner.run(&request, action).await
        {
            Ok(RunOutput::Completed(output)) => {
                if self.registry.validate_output(&action.id, &output).is_err() {
                    (
                        JournalOutcome::Failed(FailureCode::InvalidOutput),
                        failed(FailureCode::InvalidOutput),
                    )
                } else {
                    (
                        JournalOutcome::Succeeded,
                        ActionOutcome::Succeeded { output },
                    )
                }
            }
            Ok(RunOutput::Accepted { operation_id }) if !operation_id.trim().is_empty() => (
                JournalOutcome::Accepted {
                    operation_id: operation_id.clone(),
                },
                ActionOutcome::Accepted { operation_id },
            ),
            Ok(RunOutput::Accepted { .. }) => (
                JournalOutcome::Failed(FailureCode::Internal),
                failed(FailureCode::Internal),
            ),
            Err(error) => (JournalOutcome::Failed(error.code), failed(error.code)),
        };

        if let Err(error) = self.ports.journal.finish(&run, &journal_outcome).await {
            return Ok(action_result(&request, failed(error.code)));
        }

        Ok(action_result(&request, action_outcome))
    }

    async fn record_denial(
        &self,
        request: &ValidatedActionRequest,
        code: DenialCode,
    ) -> ActionResult {
        self.record_decision(
            request,
            JournalOutcome::Denied(code),
            ActionOutcome::Denied { reason_code: code },
        )
        .await
    }

    async fn record_failure(
        &self,
        request: &ValidatedActionRequest,
        code: FailureCode,
    ) -> ActionResult {
        self.record_decision(request, JournalOutcome::Failed(code), failed(code))
            .await
    }

    async fn record_decision(
        &self,
        request: &ValidatedActionRequest,
        journal_outcome: JournalOutcome,
        action_outcome: ActionOutcome,
    ) -> ActionResult {
        let outcome = match self
            .ports
            .journal
            .record_decision(request, &journal_outcome)
            .await
        {
            Ok(()) => action_outcome,
            Err(PortError { code }) => failed(code),
        };
        action_result(request, outcome)
    }
}

fn failed(error_code: FailureCode) -> ActionOutcome {
    ActionOutcome::Failed { error_code }
}

fn action_result(request: &ValidatedActionRequest, outcome: ActionOutcome) -> ActionResult {
    let request = request.as_incoming();
    ActionResult {
        invocation_id: request.invocation_id.clone(),
        correlation_id: request.correlation_id.clone(),
        outcome,
    }
}
