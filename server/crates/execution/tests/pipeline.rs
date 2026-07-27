use std::sync::{Arc, Mutex};

use actions::{
    catalog, ActionDefinition, ActionId, ActionOutcome, ActionRegistry, Actor, ActorKind,
    DenialCode, FailureCode, IdentityRealm, IncomingActionRequest, Scope, ValidatedActionRequest,
};
use async_trait::async_trait;
use chrono::{DateTime, Duration, TimeZone, Utc};
use execution::{
    AccessPort, ActionRunner, ClockPort, EntitlementPort, ExecutionPipeline, ExecutionPorts,
    GateDecision, IdempotencyDecision, IdempotencyPort, IdentityPort, JournalOutcome, JournalPort,
    PolicyDecision, PolicyPort, PortError, RunHandle, RunOutput,
};
use serde_json::json;

struct Harness {
    now: DateTime<Utc>,
    calls: Mutex<Vec<&'static str>>,
    identity: Mutex<Result<GateDecision, PortError>>,
    access: Mutex<Result<GateDecision, PortError>>,
    entitlements: Mutex<Result<GateDecision, PortError>>,
    policy: Mutex<Result<PolicyDecision, PortError>>,
    idempotency: Mutex<Result<IdempotencyDecision, PortError>>,
    journal_start: Mutex<Result<RunHandle, PortError>>,
    journal_finish: Mutex<Result<(), PortError>>,
    runner: Mutex<Result<RunOutput, PortError>>,
    journal_outcomes: Mutex<Vec<JournalOutcome>>,
}

impl Default for Harness {
    fn default() -> Self {
        Self {
            now: timestamp(10),
            calls: Mutex::new(Vec::new()),
            identity: Mutex::new(Ok(GateDecision::Allow)),
            access: Mutex::new(Ok(GateDecision::Allow)),
            entitlements: Mutex::new(Ok(GateDecision::Allow)),
            policy: Mutex::new(Ok(PolicyDecision::Allow)),
            idempotency: Mutex::new(Ok(IdempotencyDecision::Proceed)),
            journal_start: Mutex::new(Ok(RunHandle::new("run-1").unwrap())),
            journal_finish: Mutex::new(Ok(())),
            runner: Mutex::new(Ok(RunOutput::Completed(json!({
                "customers": [],
                "nextCursor": null
            })))),
            journal_outcomes: Mutex::new(Vec::new()),
        }
    }
}

impl Harness {
    fn record(&self, stage: &'static str) {
        self.calls.lock().unwrap().push(stage);
    }

    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

impl ClockPort for Harness {
    fn now(&self) -> DateTime<Utc> {
        self.now
    }
}

#[async_trait]
impl IdentityPort for Harness {
    async fn evaluate(
        &self,
        _request: &ValidatedActionRequest,
        _action: &ActionDefinition,
    ) -> Result<GateDecision, PortError> {
        self.record("identity");
        self.identity.lock().unwrap().clone()
    }
}

#[async_trait]
impl AccessPort for Harness {
    async fn evaluate(
        &self,
        _request: &ValidatedActionRequest,
        _action: &ActionDefinition,
    ) -> Result<GateDecision, PortError> {
        self.record("access");
        self.access.lock().unwrap().clone()
    }
}

#[async_trait]
impl EntitlementPort for Harness {
    async fn evaluate(
        &self,
        _request: &ValidatedActionRequest,
        _action: &ActionDefinition,
    ) -> Result<GateDecision, PortError> {
        self.record("entitlements");
        self.entitlements.lock().unwrap().clone()
    }
}

#[async_trait]
impl PolicyPort for Harness {
    async fn evaluate(
        &self,
        _request: &ValidatedActionRequest,
        _action: &ActionDefinition,
    ) -> Result<PolicyDecision, PortError> {
        self.record("policy");
        self.policy.lock().unwrap().clone()
    }
}

#[async_trait]
impl IdempotencyPort for Harness {
    async fn evaluate(
        &self,
        _request: &ValidatedActionRequest,
        _action: &ActionDefinition,
    ) -> Result<IdempotencyDecision, PortError> {
        self.record("idempotency");
        self.idempotency.lock().unwrap().clone()
    }
}

#[async_trait]
impl JournalPort for Harness {
    async fn record_decision(
        &self,
        _request: &ValidatedActionRequest,
        outcome: &JournalOutcome,
    ) -> Result<(), PortError> {
        self.record("journal_decision");
        self.journal_outcomes.lock().unwrap().push(outcome.clone());
        Ok(())
    }

    async fn start(
        &self,
        _request: &ValidatedActionRequest,
        _action: &ActionDefinition,
    ) -> Result<RunHandle, PortError> {
        self.record("journal_start");
        self.journal_start.lock().unwrap().clone()
    }

    async fn finish(&self, _run: &RunHandle, outcome: &JournalOutcome) -> Result<(), PortError> {
        self.record("journal_finish");
        self.journal_outcomes.lock().unwrap().push(outcome.clone());
        *self.journal_finish.lock().unwrap()
    }
}

#[async_trait]
impl ActionRunner for Harness {
    async fn run(
        &self,
        _request: &ValidatedActionRequest,
        _action: &ActionDefinition,
    ) -> Result<RunOutput, PortError> {
        self.record("runner");
        self.runner.lock().unwrap().clone()
    }
}

fn pipeline(harness: Arc<Harness>) -> ExecutionPipeline {
    let registry = Arc::new(catalog::initial_registry().unwrap());
    ExecutionPipeline::new(
        registry,
        ExecutionPorts {
            clock: harness.clone(),
            identity: harness.clone(),
            access: harness.clone(),
            entitlements: harness.clone(),
            policy: harness.clone(),
            idempotency: harness.clone(),
            journal: harness.clone(),
            runner: harness,
        },
    )
}

fn request() -> IncomingActionRequest {
    IncomingActionRequest {
        invocation_id: "invocation-1".to_string(),
        correlation_id: "correlation-1".to_string(),
        causation_id: None,
        action: ActionId::parse("customer.search", "1.0.0").unwrap(),
        actor: Actor {
            kind: ActorKind::DirectUser,
            id: "user-1".to_string(),
            realm: IdentityRealm::Direct,
            authenticated_client_id: None,
            delegated_by: None,
        },
        scope: Scope::Direct {
            organisation_id: "organisation-1".to_string(),
        },
        input: json!({"query": "Nandi"}),
        idempotency_key: None,
        approval_id: None,
        requested_at: timestamp(0),
        deadline: Some(timestamp(30)),
    }
}

fn timestamp(seconds: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(seconds, 0).single().unwrap()
}

#[tokio::test]
async fn successful_run_uses_the_fixed_gate_order() {
    let harness = Arc::new(Harness::default());
    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        harness.calls(),
        vec![
            "identity",
            "access",
            "entitlements",
            "policy",
            "idempotency",
            "journal_start",
            "runner",
            "journal_finish"
        ]
    );
    assert!(matches!(result.outcome, ActionOutcome::Succeeded { .. }));
    assert_eq!(
        *harness.journal_outcomes.lock().unwrap(),
        vec![JournalOutcome::Succeeded]
    );
}

#[tokio::test]
async fn denial_stops_before_later_gates_and_the_runner() {
    let harness = Arc::new(Harness::default());
    *harness.access.lock().unwrap() = Ok(GateDecision::Deny(DenialCode::MissingGrant));

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        harness.calls(),
        vec!["identity", "access", "journal_decision"]
    );
    assert_eq!(
        result.outcome,
        ActionOutcome::Denied {
            reason_code: DenialCode::MissingGrant
        }
    );
}

#[tokio::test]
async fn dependency_failure_is_safe_and_fails_closed() {
    let harness = Arc::new(Harness::default());
    *harness.entitlements.lock().unwrap() = Err(PortError::unavailable());

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        harness.calls(),
        vec!["identity", "access", "entitlements", "journal_decision"]
    );
    assert_eq!(
        result.outcome,
        ActionOutcome::Failed {
            error_code: FailureCode::TemporarilyUnavailable
        }
    );
}

#[tokio::test]
async fn approval_required_stops_before_idempotency_and_execution() {
    let harness = Arc::new(Harness::default());
    *harness.policy.lock().unwrap() = Ok(PolicyDecision::ApprovalRequired {
        approval_id: "approval-1".to_string(),
    });

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        harness.calls(),
        vec![
            "identity",
            "access",
            "entitlements",
            "policy",
            "journal_decision"
        ]
    );
    assert_eq!(
        result.outcome,
        ActionOutcome::ApprovalRequired {
            approval_id: "approval-1".to_string()
        }
    );
}

#[tokio::test]
async fn idempotency_replay_returns_the_existing_outcome_without_a_new_run() {
    let harness = Arc::new(Harness::default());
    let existing = ActionOutcome::Accepted {
        operation_id: "operation-existing".to_string(),
    };
    *harness.idempotency.lock().unwrap() = Ok(IdempotencyDecision::Existing(existing.clone()));

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        harness.calls(),
        vec![
            "identity",
            "access",
            "entitlements",
            "policy",
            "idempotency"
        ]
    );
    assert_eq!(result.outcome, existing);
}

#[tokio::test]
async fn journal_start_failure_prevents_the_runner_from_starting() {
    let harness = Arc::new(Harness::default());
    *harness.journal_start.lock().unwrap() = Err(PortError::unavailable());

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        harness.calls(),
        vec![
            "identity",
            "access",
            "entitlements",
            "policy",
            "idempotency",
            "journal_start"
        ]
    );
    assert_eq!(
        result.outcome,
        ActionOutcome::Failed {
            error_code: FailureCode::TemporarilyUnavailable
        }
    );
}

#[tokio::test]
async fn invalid_runner_output_is_rejected_and_journalled() {
    let harness = Arc::new(Harness::default());
    *harness.runner.lock().unwrap() = Ok(RunOutput::Completed(json!({"customers": []})));

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        result.outcome,
        ActionOutcome::Failed {
            error_code: FailureCode::InvalidOutput
        }
    );
    assert_eq!(
        *harness.journal_outcomes.lock().unwrap(),
        vec![JournalOutcome::Failed(FailureCode::InvalidOutput)]
    );
}

#[tokio::test]
async fn empty_operation_identifier_is_rejected_and_journalled() {
    let harness = Arc::new(Harness::default());
    *harness.runner.lock().unwrap() = Ok(RunOutput::Accepted {
        operation_id: " ".to_string(),
    });

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        result.outcome,
        ActionOutcome::Failed {
            error_code: FailureCode::Internal
        }
    );
    assert_eq!(
        *harness.journal_outcomes.lock().unwrap(),
        vec![JournalOutcome::Failed(FailureCode::Internal)]
    );
}

#[tokio::test]
async fn journal_finish_failure_cannot_return_a_false_success() {
    let harness = Arc::new(Harness::default());
    *harness.journal_finish.lock().unwrap() = Err(PortError::unavailable());

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(
        result.outcome,
        ActionOutcome::Failed {
            error_code: FailureCode::TemporarilyUnavailable
        }
    );
    assert_eq!(harness.calls().last(), Some(&"journal_finish"));
}

#[tokio::test]
async fn expired_requests_stop_before_identity_evaluation() {
    let harness = Arc::new(Harness {
        now: timestamp(31),
        ..Harness::default()
    });

    let result = pipeline(harness.clone()).execute(request()).await.unwrap();

    assert_eq!(harness.calls(), vec!["journal_decision"]);
    assert_eq!(
        result.outcome,
        ActionOutcome::Failed {
            error_code: FailureCode::DeadlineExceeded
        }
    );
}

#[tokio::test]
async fn invalid_envelopes_never_enter_the_execution_ports() {
    let harness = Arc::new(Harness::default());
    let mut invalid = request();
    invalid.invocation_id = " ".to_string();

    assert!(pipeline(harness.clone()).execute(invalid).await.is_err());
    assert!(harness.calls().is_empty());
}

#[test]
fn request_fixture_has_a_valid_deadline_window() {
    let request = request();
    assert_eq!(
        request.deadline.unwrap() - request.requested_at,
        Duration::seconds(30)
    );
    let registry: ActionRegistry = catalog::initial_registry().unwrap();
    assert!(registry.validate_request(request).is_ok());
}
