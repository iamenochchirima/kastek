use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct AgentDispatchPayload {
    pub action: String,
    #[serde(rename = "botId")]
    pub bot_id: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "deploymentId")]
    pub deployment_id: String,
    #[serde(rename = "workflowId")]
    pub workflow_id: Option<String>,
    #[serde(rename = "versionNumber")]
    pub version_number: i32,
    pub name: String,
    #[serde(rename = "type")]
    pub bot_type: String,
    pub status: String,
    pub language: String,
    #[serde(rename = "greetingMessage")]
    pub greeting_message: Option<String>,
    pub personality: Option<String>,
    pub capabilities: Option<Value>,
    #[serde(rename = "knowledgeBase")]
    pub knowledge_base: Option<Value>,
    #[serde(rename = "integrationConfig")]
    pub integration_config: Option<Value>,
    pub template: AgentTemplateDefinition,
    pub callbacks: AgentCallbacks,
    #[serde(rename = "channelConfig")]
    pub channel_config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTemplateDefinition {
    pub key: String,
    pub channel: String,
    #[serde(rename = "workflowTemplate")]
    pub workflow_template: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCallbacks {
    #[serde(rename = "deploymentCallbackUrl")]
    pub deployment_callback_url: String,
    #[serde(rename = "runtimeEventUrl")]
    pub runtime_event_url: String,
    #[serde(rename = "authToken")]
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentDispatchResult {
    #[serde(rename = "workflowId")]
    pub workflow_id: Option<String>,
    pub status: Option<String>,
    pub message: Option<String>,
    pub payload: Option<Value>,
}

pub struct BuiltWorkflow {
    pub workflow: Value,
    pub deployment_payload: Value,
}
