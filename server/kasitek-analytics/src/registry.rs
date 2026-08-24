use std::{
    collections::{HashMap, HashSet},
    fmt, fs,
    path::Path,
};

use jsonschema::Validator;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

const CONTRACT_REGISTRY_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/contracts/registry.json"
));
const CONTRACT_REGISTRY_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/contracts/registry.schema.json"
));
const ENVELOPE_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/contracts/envelope.schema.json"
));
const ENVELOPE_EXAMPLE_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/contracts/examples/envelope.json"
));
const METRICS_INDEX_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/metrics/index.json"));
const METRICS_INDEX_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/metrics/index.schema.json"
));
const METRICS_REGISTRY_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/metrics/registry.schema.json"
));

const CONTRACT_SOURCES: &[ContractSource] = &[
    ContractSource {
        path: "events/agent/run_completed/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/run_completed/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/run_completed.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/run_completed.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/run_failed/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/run_failed/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/run_failed.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/run_failed.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/model_call_completed/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/model_call_completed/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/model_call_completed.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/model_call_completed.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/model_call_failed/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/model_call_failed/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/model_call_failed.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/model_call_failed.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/tool_invocation_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/tool_invocation_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/tool_invocation_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/tool_invocation_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/approval_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/approval_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/approval_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/approval_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/effect_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/effect_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/effect_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/effect_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/handoff_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/handoff_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/handoff_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/handoff_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/schedule_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/schedule_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/schedule_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/schedule_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/installation_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/installation_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/installation_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/installation_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/version_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/version_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/version_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/version_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/definition_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/definition_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/definition_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/definition_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/readiness_snapshot/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/readiness_snapshot/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/readiness_snapshot.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/readiness_snapshot.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/conversation_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/conversation_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/conversation_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/conversation_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/agent/conversation_message/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/agent/conversation_message/v1.schema.json"
        )),
        examples: &[(
            "examples/agent/conversation_message.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/agent/conversation_message.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_sent/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_sent/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_sent.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_sent.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_delivered/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_delivered/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_delivered.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_delivered.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_read/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_read/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_read.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_read.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_failed/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_failed/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_failed.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_failed.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_blocked/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_blocked/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_blocked.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_blocked.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_suppressed/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_suppressed/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_suppressed.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_suppressed.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_unsubscribed/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_unsubscribed/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_unsubscribed.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_unsubscribed.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_timing/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_timing/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_timing.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_timing.json"
            )),
        )],
    },
    ContractSource {
        path: "events/campaign/recipient_retry/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/campaign/recipient_retry/v1.schema.json"
        )),
        examples: &[(
            "examples/campaign/recipient_retry.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/campaign/recipient_retry.json"
            )),
        )],
    },
    ContractSource {
        path: "events/inbox/message_received/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/inbox/message_received/v1.schema.json"
        )),
        examples: &[(
            "examples/inbox/message_received.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/inbox/message_received.json"
            )),
        )],
    },
    ContractSource {
        path: "events/inbox/conversation_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/inbox/conversation_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/inbox/conversation_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/inbox/conversation_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/inbox/conversation_message_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/inbox/conversation_message_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/inbox/conversation_message_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/inbox/conversation_message_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/inbox/response_recorded/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/inbox/response_recorded/v1.schema.json"
        )),
        examples: &[(
            "examples/inbox/response_recorded.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/inbox/response_recorded.json"
            )),
        )],
    },
    ContractSource {
        path: "events/connections/lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/connections/lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/connections/lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/connections/lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/connections/health_check/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/connections/health_check/v1.schema.json"
        )),
        examples: &[(
            "examples/connections/health_check.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/connections/health_check.json"
            )),
        )],
    },
    ContractSource {
        path: "events/connections/capability_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/connections/capability_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/connections/capability_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/connections/capability_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/connections/sync_attempt/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/connections/sync_attempt/v1.schema.json"
        )),
        examples: &[(
            "examples/connections/sync_attempt.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/connections/sync_attempt.json"
            )),
        )],
    },
    ContractSource {
        path: "events/connections/rate_limit/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/connections/rate_limit/v1.schema.json"
        )),
        examples: &[(
            "examples/connections/rate_limit.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/connections/rate_limit.json"
            )),
        )],
    },
    ContractSource {
        path: "events/connections/incident_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/connections/incident_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/connections/incident_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/connections/incident_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/tenant/lead_lifecycle/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/tenant/lead_lifecycle/v1.schema.json"
        )),
        examples: &[(
            "examples/tenant/lead_lifecycle.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/tenant/lead_lifecycle.json"
            )),
        )],
    },
    ContractSource {
        path: "events/tenant/scope_definition/v1.schema.json",
        schema: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/contracts/events/tenant/scope_definition/v1.schema.json"
        )),
        examples: &[(
            "examples/tenant/scope_definition.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/contracts/examples/tenant/scope_definition.json"
            )),
        )],
    },
];

const METRIC_SOURCES: &[MetricSource] = &[
    MetricSource {
        path: "domains/agents/runtime.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/domains/agents/runtime.yaml"
        )),
    },
    MetricSource {
        path: "domains/campaigns/delivery.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/domains/campaigns/delivery.yaml"
        )),
    },
    MetricSource {
        path: "domains/connections/health.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/domains/connections/health.yaml"
        )),
    },
    MetricSource {
        path: "domains/inbox/conversations.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/domains/inbox/conversations.yaml"
        )),
    },
    MetricSource {
        path: "domains/tenants/leads.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/domains/tenants/leads.yaml"
        )),
    },
    MetricSource {
        path: "dimensions/core.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/dimensions/core.yaml"
        )),
    },
    MetricSource {
        path: "metric-sets/overview.summary.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/metric-sets/overview.summary.yaml"
        )),
    },
    MetricSource {
        path: "metric-sets/agent.performance.yaml",
        content: include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/metrics/metric-sets/agent.performance.yaml"
        )),
    },
];

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("failed to parse JSON registry file {path}: {source}")]
    Json {
        path: String,
        source: serde_json::Error,
    },
    #[error("failed to parse YAML registry file {path}: {source}")]
    Yaml {
        path: String,
        source: serde_yaml::Error,
    },
    #[error("registry schema compilation failed for {path}: {message}")]
    SchemaCompile { path: String, message: String },
    #[error("registry validation failed for {path}: {message}")]
    Validation { path: String, message: String },
    #[error("registry source file is not indexed: {path}")]
    UnindexedSource { path: String },
    #[error("registry source file is missing: {path}")]
    MissingSource { path: String },
    #[error("registry identity conflict: {message}")]
    IdentityConflict { message: String },
    #[error("registry dependency cycle: {path}")]
    DependencyCycle { path: String },
    #[error("generated registry binding is stale: {path}")]
    GeneratedStale { path: String },
    #[error("registry binding I/O failed for {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
}

#[derive(Clone, Debug, Deserialize)]
struct ContractRegistryFile {
    registry_version: String,
    envelope: String,
    contracts: Vec<ContractEntry>,
}

#[derive(Clone, Debug, Deserialize)]
struct ContractEntry {
    identity: String,
    schema: String,
    examples: Vec<String>,
    owner: String,
    category: String,
    privacy_class: String,
}

#[derive(Clone, Copy, Debug)]
struct ContractSource {
    path: &'static str,
    schema: &'static str,
    examples: &'static [(&'static str, &'static str)],
}

#[derive(Clone, Debug, Deserialize)]
struct MetricsIndex {
    registry_version: String,
    files: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
struct MetricSource {
    path: &'static str,
    content: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetricDefinition {
    pub key: String,
    pub version: u32,
    pub domain: String,
    pub owner: String,
    pub lifecycle: String,
    pub description: String,
    pub value_type: String,
    pub unit: String,
    #[serde(default)]
    pub precision: Option<u8>,
    pub sources: Vec<String>,
    pub formula: String,
    pub eligible_population: String,
    pub exclusions: Vec<String>,
    #[serde(default)]
    pub numerator: Option<String>,
    #[serde(default)]
    pub denominator: Option<String>,
    pub time_semantics: String,
    pub default_aggregation: String,
    pub temporal_aggregation: String,
    pub comparison: String,
    pub deduplication: String,
    pub descendant_aggregation: String,
    pub supported_intervals: Vec<String>,
    pub scope_kinds: Vec<String>,
    pub dimensions: Vec<String>,
    pub permissions: Vec<String>,
    pub privacy_class: String,
    pub exactness: String,
    pub freshness: FreshnessDefinition,
    pub coverage: CoverageDefinition,
    pub availability: String,
    pub effective_from: String,
    #[serde(default)]
    pub applicability: Option<String>,
    #[serde(default)]
    pub replacement: Option<String>,
    pub dependencies: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FreshnessDefinition {
    pub max_age_seconds: u64,
    pub late_data_window_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoverageDefinition {
    pub mode: String,
    pub required_sources: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DimensionDefinition {
    pub key: String,
    #[serde(rename = "type")]
    pub value_type: String,
    pub source: String,
    pub compatible_metrics: Vec<String>,
    pub filterable: bool,
    pub groupable: bool,
    pub cardinality: String,
    pub privacy_class: String,
    pub stable_key: bool,
    pub permissions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetricSetDefinition {
    pub key: String,
    pub version: u32,
    pub owner: String,
    pub lifecycle: String,
    pub description: String,
    pub metrics: Vec<String>,
    pub default_interval: String,
    pub scope_kinds: Vec<String>,
    pub permissions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContractSummary {
    pub identity: String,
    pub owner: String,
    pub category: String,
    pub privacy_class: String,
    pub schema_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RegistrySnapshot {
    pub contract_registry_version: String,
    pub metrics_registry_version: String,
    pub contracts: Vec<ContractSummary>,
    pub metrics: Vec<MetricDefinition>,
    pub dimensions: Vec<DimensionDefinition>,
    pub metric_sets: Vec<MetricSetDefinition>,
    pub sha256: String,
}

impl RegistrySnapshot {
    pub fn metric_keys(&self) -> Vec<String> {
        self.metrics.iter().map(metric_identity).collect()
    }

    pub fn dimension_keys(&self) -> Vec<String> {
        self.dimensions
            .iter()
            .map(|dimension| dimension.key.clone())
            .collect()
    }

    pub fn metric_set_keys(&self) -> Vec<String> {
        self.metric_sets.iter().map(metric_set_identity).collect()
    }

    pub fn render_rust_bindings(&self) -> String {
        let mut output = String::from("// @generated by analytics-registry; do not edit.\n\n");
        output.push_str(&format!(
            "pub const REGISTRY_VERSION: &str = {};\npub const REGISTRY_SHA256: &str =\n    {};\n\n",
            rust_string(&self.metrics_registry_version),
            rust_string(&self.sha256)
        ));
        render_rust_slice(
            &mut output,
            "CONTRACT_KEYS",
            &self
                .contracts
                .iter()
                .map(|item| item.identity.clone())
                .collect::<Vec<_>>(),
        );
        render_rust_slice(&mut output, "METRIC_KEYS", &self.metric_keys());
        render_rust_slice(&mut output, "DIMENSION_KEYS", &self.dimension_keys());
        render_rust_slice(&mut output, "METRIC_SET_KEYS", &self.metric_set_keys());
        output.push_str("pub mod metric_keys {\n");
        for metric in &self.metrics {
            let identifier = rust_identifier(&metric_identity(metric));
            let value = rust_string(&metric_identity(metric));
            let inline = format!("    pub const {identifier}: &str = {value};");
            if inline.len() <= 100 {
                output.push_str(&format!("{inline}\n"));
            } else {
                output.push_str(&format!(
                    "    pub const {identifier}: &str =\n        {value};\n"
                ));
            }
        }
        output.push_str("}\n");
        output
    }

    pub fn render_typescript_bindings(&self) -> String {
        let mut output = String::from("// @generated by analytics-registry; do not edit.\n\n");
        output.push_str(&format!(
            "export const ANALYTICS_REGISTRY_VERSION = {} as const;\nexport const ANALYTICS_REGISTRY_SHA256 = {} as const;\n\n",
            json_string(&self.metrics_registry_version),
            json_string(&self.sha256)
        ));
        render_typescript_tuple(
            &mut output,
            "ANALYTICS_CONTRACT_KEYS",
            &self
                .contracts
                .iter()
                .map(|item| item.identity.clone())
                .collect::<Vec<_>>(),
        );
        render_typescript_tuple(&mut output, "ANALYTICS_METRIC_KEYS", &self.metric_keys());
        render_typescript_tuple(
            &mut output,
            "ANALYTICS_DIMENSION_KEYS",
            &self.dimension_keys(),
        );
        render_typescript_tuple(
            &mut output,
            "ANALYTICS_METRIC_SET_KEYS",
            &self.metric_set_keys(),
        );
        output.push_str(
            "\nexport type AnalyticsContractKey = (typeof ANALYTICS_CONTRACT_KEYS)[number];\n",
        );
        output
            .push_str("export type AnalyticsMetricKey = (typeof ANALYTICS_METRIC_KEYS)[number];\n");
        output.push_str(
            "export type AnalyticsDimensionKey = (typeof ANALYTICS_DIMENSION_KEYS)[number];\n",
        );
        output.push_str(
            "export type AnalyticsMetricSetKey = (typeof ANALYTICS_METRIC_SET_KEYS)[number];\n",
        );
        output
    }

    pub fn check_generated_bindings(&self) -> Result<(), RegistryError> {
        check_file(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/generated_registry.rs"),
            &self.render_rust_bindings(),
        )?;
        check_file(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../agents/src/analytics/generated-registry.ts"),
            &self.render_typescript_bindings(),
        )
    }

    pub fn write_generated_bindings(&self) -> Result<(), RegistryError> {
        let rust_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/generated_registry.rs");
        let typescript_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../agents/src/analytics/generated-registry.ts");
        write_file(&rust_path, &self.render_rust_bindings())?;
        write_file(&typescript_path, &self.render_typescript_bindings())
    }
}

pub fn load_registry() -> Result<RegistrySnapshot, RegistryError> {
    let contract_registry: ContractRegistryFile =
        parse_json("contracts/registry.json", CONTRACT_REGISTRY_JSON)?;
    let contract_registry_value =
        parse_json_value("contracts/registry.json", CONTRACT_REGISTRY_JSON)?;
    let contract_registry_schema = parse_json_value(
        "contracts/registry.schema.json",
        CONTRACT_REGISTRY_SCHEMA_JSON,
    )?;
    validate_value(
        "contracts/registry.json",
        &contract_registry_schema,
        &contract_registry_value,
    )?;
    if contract_registry.envelope != "envelope.schema.json" {
        return Err(RegistryError::IdentityConflict {
            message: format!(
                "contract registry envelope must be envelope.schema.json, got {}",
                contract_registry.envelope
            ),
        });
    }

    let envelope_schema = parse_json_value("contracts/envelope.schema.json", ENVELOPE_SCHEMA_JSON)?;
    validate_schema("contracts/envelope.schema.json", &envelope_schema)?;
    let envelope_example =
        parse_json_value("contracts/examples/envelope.json", ENVELOPE_EXAMPLE_JSON)?;
    validate_value(
        "contracts/examples/envelope.json",
        &envelope_schema,
        &envelope_example,
    )?;

    let mut contracts = Vec::with_capacity(contract_registry.contracts.len());
    let mut contract_identities = HashSet::new();
    for entry in &contract_registry.contracts {
        if !contract_identities.insert(entry.identity.clone()) {
            return Err(RegistryError::IdentityConflict {
                message: format!("duplicate contract identity {}", entry.identity),
            });
        }
        let source = CONTRACT_SOURCES
            .iter()
            .find(|source| source.path == entry.schema)
            .ok_or_else(|| RegistryError::MissingSource {
                path: entry.schema.clone(),
            })?;
        let schema_value = parse_json_value(source.path, source.schema)?;
        validate_schema(source.path, &schema_value)?;
        let metadata = schema_value
            .get("x-kasitek")
            .ok_or_else(|| RegistryError::Validation {
                path: source.path.to_string(),
                message: "schema is missing x-kasitek ownership metadata".to_string(),
            })?;
        if metadata.get("identity").and_then(Value::as_str) != Some(entry.identity.as_str())
            || metadata.get("owner").and_then(Value::as_str) != Some(entry.owner.as_str())
            || metadata.get("privacy_class").and_then(Value::as_str)
                != Some(entry.privacy_class.as_str())
        {
            return Err(RegistryError::IdentityConflict {
                message: format!("registry metadata does not match {}", entry.identity),
            });
        }
        for prohibited in metadata
            .get("prohibited_fields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if schema_value
                .get("properties")
                .and_then(Value::as_object)
                .is_some_and(|properties| properties.contains_key(prohibited))
            {
                return Err(RegistryError::Validation {
                    path: source.path.to_string(),
                    message: format!("prohibited field {prohibited} is declared as a property"),
                });
            }
        }
        for example_path in &entry.examples {
            let example = source
                .examples
                .iter()
                .find(|(path, _)| path == example_path)
                .ok_or_else(|| RegistryError::MissingSource {
                    path: example_path.clone(),
                })?;
            let value = parse_json_value(example_path, example.1)?;
            validate_value(example_path, &schema_value, &value)?;
        }
        contracts.push(ContractSummary {
            identity: entry.identity.clone(),
            owner: entry.owner.clone(),
            category: entry.category.clone(),
            privacy_class: entry.privacy_class.clone(),
            schema_sha256: canonical_json_sha256(&schema_value)?,
        });
    }
    for source in CONTRACT_SOURCES {
        if !contract_registry
            .contracts
            .iter()
            .any(|entry| entry.schema == source.path)
        {
            return Err(RegistryError::UnindexedSource {
                path: source.path.to_string(),
            });
        }
    }
    contracts.sort_by(|left, right| left.identity.cmp(&right.identity));

    let metrics_index: MetricsIndex = parse_json("metrics/index.json", METRICS_INDEX_JSON)?;
    let metrics_index_value = parse_json_value("metrics/index.json", METRICS_INDEX_JSON)?;
    let metrics_index_schema =
        parse_json_value("metrics/index.schema.json", METRICS_INDEX_SCHEMA_JSON)?;
    validate_value(
        "metrics/index.json",
        &metrics_index_schema,
        &metrics_index_value,
    )?;
    let metrics_schema =
        parse_json_value("metrics/registry.schema.json", METRICS_REGISTRY_SCHEMA_JSON)?;
    validate_schema("metrics/registry.schema.json", &metrics_schema)?;
    let mut metrics = Vec::new();
    let mut dimensions = Vec::new();
    let mut metric_sets = Vec::new();
    let mut indexed_paths = HashSet::new();
    for path in &metrics_index.files {
        indexed_paths.insert(path.clone());
        let source = METRIC_SOURCES
            .iter()
            .find(|source| source.path == path)
            .ok_or_else(|| RegistryError::MissingSource { path: path.clone() })?;
        let value = serde_yaml::from_str::<Value>(source.content).map_err(|source_error| {
            RegistryError::Yaml {
                path: path.clone(),
                source: source_error,
            }
        })?;
        validate_value(path, &metrics_schema, &value)?;
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let definitions = value
            .get("definitions")
            .and_then(Value::as_array)
            .ok_or_else(|| RegistryError::Validation {
                path: path.clone(),
                message: "definitions must be an array".to_string(),
            })?;
        match kind {
            "metrics" => metrics.extend(
                definitions
                    .iter()
                    .cloned()
                    .map(|item| from_value(path, item))
                    .collect::<Result<Vec<MetricDefinition>, _>>()?,
            ),
            "dimensions" => dimensions.extend(
                definitions
                    .iter()
                    .cloned()
                    .map(|item| from_value(path, item))
                    .collect::<Result<Vec<DimensionDefinition>, _>>()?,
            ),
            "metric_sets" => metric_sets.extend(
                definitions
                    .iter()
                    .cloned()
                    .map(|item| from_value(path, item))
                    .collect::<Result<Vec<MetricSetDefinition>, _>>()?,
            ),
            _ => {
                return Err(RegistryError::Validation {
                    path: path.clone(),
                    message: format!("unsupported registry source kind {kind}"),
                });
            }
        }
    }
    for source in METRIC_SOURCES {
        if !indexed_paths.contains(source.path) {
            return Err(RegistryError::UnindexedSource {
                path: source.path.to_string(),
            });
        }
    }
    metrics.sort_by_key(metric_identity);
    dimensions.sort_by(|left, right| left.key.cmp(&right.key));
    metric_sets.sort_by_key(metric_set_identity);
    validate_metric_semantics(&metrics, &dimensions, &metric_sets, &contracts)?;

    let artifact = json!({
        "contract_registry_version": contract_registry.registry_version,
        "metrics_registry_version": metrics_index.registry_version,
        "contracts": contracts,
        "metrics": metrics,
        "dimensions": dimensions,
        "metric_sets": metric_sets,
    });
    let sha256 =
        sha256_hex(
            &serde_json::to_vec(&artifact).map_err(|source| RegistryError::Json {
                path: "registry-artifact".to_string(),
                source,
            })?,
        );

    Ok(RegistrySnapshot {
        contract_registry_version: contract_registry.registry_version,
        metrics_registry_version: metrics_index.registry_version,
        contracts,
        metrics,
        dimensions,
        metric_sets,
        sha256,
    })
}

/// Validates the transport envelope with the repository-owned envelope schema. Ingestion maps the
/// returned diagnostic to a safe error code before returning it to a producer; raw validation
/// details are not sent over the API.
pub fn validate_envelope(value: &Value) -> Result<(), String> {
    let schema: Value = serde_json::from_str(ENVELOPE_SCHEMA_JSON)
        .map_err(|error| format!("envelope schema parse failed: {error}"))?;
    let validator = jsonschema::draft202012::new(&schema)
        .map_err(|error| format!("envelope schema compile failed: {error}"))?;
    validator.validate(value).map_err(|error| error.to_string())
}

/// Validates the `data` object for a registered contract. Scope definitions and provider
/// observations are intentionally allowed to use their versioned contract identity until their
/// domain schemas are added to the registry; their typed fields are validated by ingestion.
pub fn validate_registered_contract(contract_identity: &str, value: &Value) -> Result<(), String> {
    let source = CONTRACT_SOURCES
        .iter()
        .find(|source| {
            let Ok(schema) = serde_json::from_str::<Value>(source.schema) else {
                return false;
            };
            schema
                .get("x-kasitek")
                .and_then(|metadata| metadata.get("identity"))
                .and_then(Value::as_str)
                == Some(contract_identity)
        })
        .ok_or_else(|| format!("contract {contract_identity} is not registered"))?;
    let schema: Value = serde_json::from_str(source.schema)
        .map_err(|error| format!("contract schema parse failed: {error}"))?;
    let validator = jsonschema::draft202012::new(&schema)
        .map_err(|error| format!("contract schema compile failed: {error}"))?;
    validator.validate(value).map_err(|error| error.to_string())
}

fn validate_metric_semantics(
    metrics: &[MetricDefinition],
    dimensions: &[DimensionDefinition],
    metric_sets: &[MetricSetDefinition],
    contracts: &[ContractSummary],
) -> Result<(), RegistryError> {
    let contract_keys = contracts
        .iter()
        .map(|contract| contract.identity.as_str())
        .collect::<HashSet<_>>();
    let metric_keys = metrics.iter().map(metric_identity).collect::<HashSet<_>>();
    let mut seen_metric_keys = HashSet::new();
    let dimension_keys = dimensions
        .iter()
        .map(|dimension| dimension.key.as_str())
        .collect::<HashSet<_>>();
    let mut metric_set_keys = HashSet::new();
    for metric in metrics {
        let identity = metric_identity(metric);
        if !seen_metric_keys.insert(identity.clone()) {
            return Err(RegistryError::IdentityConflict {
                message: format!("duplicate metric identity {identity}"),
            });
        }
        if metric
            .sources
            .iter()
            .any(|source| !contract_keys.contains(source.as_str()))
        {
            return Err(RegistryError::IdentityConflict {
                message: format!("metric {identity} references an unregistered source contract"),
            });
        }
        if metric
            .dimensions
            .iter()
            .any(|dimension| !dimension_keys.contains(dimension.as_str()))
        {
            return Err(RegistryError::IdentityConflict {
                message: format!("metric {identity} references an unknown dimension"),
            });
        }
        if metric.coverage.required_sources.iter().any(|source| {
            !metric
                .sources
                .iter()
                .any(|metric_source| metric_source == source)
        }) {
            return Err(RegistryError::IdentityConflict {
                message: format!(
                    "metric {identity} coverage references a source outside its source set"
                ),
            });
        }
        if (metric.value_type == "percentage" || metric.default_aggregation == "ratio_of_sums")
            && (metric.numerator.is_none() || metric.denominator.is_none())
        {
            return Err(RegistryError::Validation {
                path: identity.clone(),
                message: "ratio metrics require numerator and denominator".to_string(),
            });
        }
        if let Some(numerator) = &metric.numerator {
            if !metric.dependencies.contains(numerator) {
                return Err(RegistryError::IdentityConflict {
                    message: format!(
                        "metric {identity} numerator {numerator} is not declared as a dependency"
                    ),
                });
            }
        }
        if let Some(denominator) = &metric.denominator {
            if !metric.dependencies.contains(denominator) {
                return Err(RegistryError::IdentityConflict {
                    message: format!(
                        "metric {identity} denominator {denominator} is not declared as a dependency"
                    ),
                });
            }
        }
        for dependency in &metric.dependencies {
            if !metric_keys.contains(dependency) {
                return Err(RegistryError::IdentityConflict {
                    message: format!(
                        "metric {identity} references unknown dependency {dependency}"
                    ),
                });
            }
        }
    }
    let graph = metrics
        .iter()
        .map(|metric| (metric_identity(metric), metric.dependencies.clone()))
        .collect::<HashMap<_, _>>();
    for key in graph.keys() {
        visit_dependency(key, &graph, &mut HashSet::new(), &mut HashSet::new())?;
    }
    for dimension in dimensions {
        for metric in &dimension.compatible_metrics {
            if !metric_keys.contains(metric) {
                return Err(RegistryError::IdentityConflict {
                    message: format!(
                        "dimension {} references unknown metric {metric}",
                        dimension.key
                    ),
                });
            }
            if let Some(definition) = metrics
                .iter()
                .find(|definition| metric_identity(definition) == *metric)
            {
                if !definition.dimensions.contains(&dimension.key) {
                    return Err(RegistryError::IdentityConflict {
                        message: format!(
                            "dimension {} is compatible with metric {metric} but the metric does not declare it",
                            dimension.key
                        ),
                    });
                }
            }
        }
    }
    for metric_set in metric_sets {
        let identity = metric_set_identity(metric_set);
        if !metric_set_keys.insert(identity.clone()) {
            return Err(RegistryError::IdentityConflict {
                message: format!("duplicate metric-set identity {identity}"),
            });
        }
        if metric_set
            .metrics
            .iter()
            .any(|metric| !metric_keys.contains(metric))
        {
            return Err(RegistryError::IdentityConflict {
                message: format!("metric set {identity} references an unknown metric"),
            });
        }
    }
    Ok(())
}

fn visit_dependency(
    key: &str,
    graph: &HashMap<String, Vec<String>>,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
) -> Result<(), RegistryError> {
    if visited.contains(key) {
        return Ok(());
    }
    if !visiting.insert(key.to_string()) {
        return Err(RegistryError::DependencyCycle {
            path: key.to_string(),
        });
    }
    if let Some(dependencies) = graph.get(key) {
        for dependency in dependencies {
            visit_dependency(dependency, graph, visiting, visited)?;
        }
    }
    visiting.remove(key);
    visited.insert(key.to_string());
    Ok(())
}

fn parse_json<T: DeserializeOwned>(path: &str, source: &str) -> Result<T, RegistryError> {
    serde_json::from_str(source).map_err(|source| RegistryError::Json {
        path: path.to_string(),
        source,
    })
}

fn parse_json_value(path: &str, source: &str) -> Result<Value, RegistryError> {
    parse_json(path, source)
}

fn from_value<T: DeserializeOwned>(path: &str, value: Value) -> Result<T, RegistryError> {
    serde_json::from_value(value).map_err(|source| RegistryError::Json {
        path: path.to_string(),
        source,
    })
}

fn validate_schema(path: &str, schema: &Value) -> Result<(), RegistryError> {
    jsonschema::draft202012::new(schema)
        .map(|_: Validator| ())
        .map_err(|error| RegistryError::SchemaCompile {
            path: path.to_string(),
            message: error.to_string(),
        })
}

fn validate_value(path: &str, schema: &Value, value: &Value) -> Result<(), RegistryError> {
    let validator =
        jsonschema::draft202012::new(schema).map_err(|error| RegistryError::SchemaCompile {
            path: path.to_string(),
            message: error.to_string(),
        })?;
    validator
        .validate(value)
        .map_err(|error| RegistryError::Validation {
            path: path.to_string(),
            message: error.to_string(),
        })
}

fn canonical_json_sha256(value: &Value) -> Result<String, RegistryError> {
    let bytes = serde_json::to_vec(value).map_err(|source| RegistryError::Json {
        path: "canonical-json".to_string(),
        source,
    })?;
    Ok(sha256_hex(&bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn metric_identity(metric: &MetricDefinition) -> String {
    format!("{}@{}", metric.key, metric.version)
}

fn metric_set_identity(metric_set: &MetricSetDefinition) -> String {
    format!("{}@{}", metric_set.key, metric_set.version)
}

fn rust_string(value: &str) -> String {
    format!("{value:?}")
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("strings are serializable")
}

fn rust_identifier(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn render_rust_slice(output: &mut String, name: &str, values: &[String]) {
    let inline = values
        .iter()
        .map(|value| rust_string(value))
        .collect::<Vec<_>>()
        .join(", ");
    if format!("pub const {name}: &[&str] = &[{inline}];").len() <= 100 {
        output.push_str(&format!("pub const {name}: &[&str] = &[{inline}];\n\n"));
        return;
    }
    output.push_str(&format!("pub const {name}: &[&str] = &[\n"));
    for value in values {
        output.push_str(&format!("    {},\n", rust_string(value)));
    }
    output.push_str("];\n\n");
}

fn render_typescript_tuple(output: &mut String, name: &str, values: &[String]) {
    output.push_str(&format!("export const {name} = [\n"));
    for value in values {
        output.push_str(&format!("  {},\n", json_string(value)));
    }
    output.push_str("] as const;\n\n");
}

fn check_file(path: impl AsRef<Path>, expected: &str) -> Result<(), RegistryError> {
    let path = path.as_ref();
    let current = fs::read_to_string(path).map_err(|source| RegistryError::Io {
        path: path.display().to_string(),
        source,
    })?;
    if current != expected {
        return Err(RegistryError::GeneratedStale {
            path: path.display().to_string(),
        });
    }
    Ok(())
}

fn write_file(path: impl AsRef<Path>, content: &str) -> Result<(), RegistryError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| RegistryError::Io {
            path: parent.display().to_string(),
            source,
        })?;
    }
    fs::write(path, content).map_err(|source| RegistryError::Io {
        path: path.display().to_string(),
        source,
    })
}

impl fmt::Display for RegistrySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "metrics_registry={} contracts={} metrics={} dimensions={} metric_sets={} sha256={}",
            self.metrics_registry_version,
            self.contracts.len(),
            self.metrics.len(),
            self.dimensions.len(),
            self.metric_sets.len(),
            self.sha256
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{load_registry, validate_registered_contract};
    use serde_json::json;

    #[test]
    fn repository_registry_is_valid_and_deterministic() {
        let registry = load_registry().expect("repository registry should validate");
        assert_eq!(registry.contracts.len(), 36);
        assert_eq!(registry.metrics.len(), 41);
        assert_eq!(registry.dimensions.len(), 59);
        assert_eq!(registry.metric_sets.len(), 2);
        assert_eq!(registry.metric_keys().len(), 41);
        assert!(!registry.sha256.is_empty());
    }

    #[test]
    fn generated_bindings_match_the_canonical_registry() {
        let registry = load_registry().expect("repository registry should validate");
        registry
            .check_generated_bindings()
            .expect("generated bindings should be current");
        assert_eq!(crate::generated_registry::REGISTRY_SHA256, registry.sha256);
    }

    #[test]
    fn handoff_contract_accepts_every_bounded_repository_lifecycle_value() {
        let cases = [
            ("requested", "pending", "handoff_requested", "agent", None),
            ("claimed", "claimed", "human_owned", "user", None),
            ("first_human_response", "sent", "human_owned", "user", None),
            ("human_message", "sent", "human_owned", "user", None),
            (
                "continued",
                "resolved",
                "agent_active",
                "user",
                Some("continued_with_agent"),
            ),
            ("resolved", "resolved", "resolved", "user", Some("resolved")),
            (
                "released",
                "pending",
                "handoff_requested",
                "user",
                Some("released"),
            ),
            ("expired", "expired", "expired", "system", Some("deadline")),
            (
                "cancelled",
                "cancelled",
                "cancelled",
                "agent",
                Some("run_cancelled"),
            ),
        ];
        for (action, status, conversation_state, actor_type, resolution_code) in cases {
            let mut data = json!({
                "handoff_id": "handoff-1",
                "conversation_id": "conversation-1",
                "installation_id": "installation-1",
                "agent_definition_id": "agent-1",
                "agent_version_id": "version-1",
                "agent_audience": "customer_service",
                "run_id": "run-1",
                "channel_type": "whatsapp",
                "action": action,
                "status": status,
                "reason": "customer_requested",
                "priority": "normal",
                "actor_type": actor_type,
                "conversation_state": conversation_state,
                "occurred_at": "2026-08-24T10:00:00Z"
            });
            if let Some(value) = resolution_code {
                data["resolution_code"] = json!(value);
            }
            validate_registered_contract("agent.handoff.lifecycle@1", &data)
                .unwrap_or_else(|error| panic!("{action} should validate: {error}"));
        }
    }

    #[test]
    fn handoff_contract_rejects_free_form_resolution_text() {
        let data = json!({
            "handoff_id": "handoff-1",
            "conversation_id": "conversation-1",
            "installation_id": "installation-1",
            "agent_definition_id": "agent-1",
            "agent_version_id": "version-1",
            "agent_audience": "customer_service",
            "channel_type": "platform",
            "action": "released",
            "status": "pending",
            "reason": "customer_requested",
            "priority": "normal",
            "actor_type": "user",
            "conversation_state": "handoff_requested",
            "resolution_code": "operator wrote a private note",
            "occurred_at": "2026-08-24T10:00:00Z"
        });
        assert!(validate_registered_contract("agent.handoff.lifecycle@1", &data).is_err());
    }
}
