use serde_json::{json, Map, Value};

use crate::services::agents::types::{AgentDispatchPayload, BuiltWorkflow};

fn workflow_path(payload: &AgentDispatchPayload, suffix: &str) -> String {
    let suffix = suffix.trim_matches('/');
    if suffix.is_empty() {
        format!(
            "kasitek/agents/{}/{}",
            payload.template.channel, payload.bot_id
        )
    } else {
        format!(
            "kasitek/agents/{}/{}/{}",
            payload.template.channel, payload.bot_id, suffix
        )
    }
}

fn response_message(payload: &AgentDispatchPayload) -> String {
    payload
        .greeting_message
        .clone()
        .unwrap_or_else(|| format!("{} is online.", payload.name))
}

fn response_body(payload: &AgentDispatchPayload, channel: &str) -> String {
    json!({
        "ok": true,
        "botId": payload.bot_id,
        "deploymentId": payload.deployment_id,
        "channel": channel,
        "message": response_message(payload),
    })
    .to_string()
}

fn runtime_headers(payload: &AgentDispatchPayload) -> Value {
    let auth_header = payload
        .callbacks
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|token| format!("Bearer {token}"))
        .unwrap_or_default();

    json!({
        "parameters": [
            {
                "name": "Authorization",
                "value": auth_header,
            },
            {
                "name": "Content-Type",
                "value": "application/json",
            }
        ]
    })
}

fn metadata_object(mut pairs: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    for (key, value) in pairs.drain(..) {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

fn stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

fn website_event_body(payload: &AgentDispatchPayload, event_type: &str) -> String {
    let metadata = metadata_object(vec![
        ("source", json!("n8n")),
        ("template", json!(payload.template.workflow_template)),
        ("botId", json!(payload.bot_id)),
        (
            "visitorMessage",
            json!("={{$json.body?.message || $json.body?.text || null}}"),
        ),
        (
            "visitorName",
            json!("={{$json.body?.name || $json.body?.visitor?.name || null}}"),
        ),
    ]);

    stringify(&json!({
        "eventType": event_type,
        "channel": "website",
        "status": "ok",
        "conversationId": "={{$json.body?.sessionId || $json.body?.conversationId || $json.query?.sessionId || null}}",
        "responseTimeMs": "={{$json.body?.responseTimeMs || null}}",
        "metadata": metadata,
    }))
}

fn whatsapp_event_body(payload: &AgentDispatchPayload, event_type: &str) -> String {
    let metadata = metadata_object(vec![
        ("source", json!("n8n")),
        ("template", json!(payload.template.workflow_template)),
        ("botId", json!(payload.bot_id)),
        (
            "fromPhone",
            json!("={{$json.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from || null}}"),
        ),
        (
            "messagePreview",
            json!("={{$json.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body || null}}"),
        ),
    ]);

    stringify(&json!({
        "eventType": event_type,
        "channel": "whatsapp",
        "status": "ok",
        "conversationId": "={{$json.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id || null}}",
        "metadata": metadata,
    }))
}

fn runtime_event_node(
    payload: &AgentDispatchPayload,
    name: &str,
    body_json: String,
    position: [i32; 2],
) -> Value {
    json!({
        "id": name.replace(' ', "_"),
        "name": name,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": position,
        "parameters": {
            "method": "POST",
            "url": payload.callbacks.runtime_event_url,
            "sendHeaders": true,
            "headerParameters": runtime_headers(payload),
            "sendBody": true,
            "specifyBody": "json",
            "jsonBody": format!("={body_json}"),
            "options": {}
        }
    })
}

fn respond_node(payload: &AgentDispatchPayload, channel: &str, position: [i32; 2]) -> Value {
    json!({
        "id": format!("Respond_{}", channel),
        "name": "Respond to Webhook",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1,
        "position": position,
        "parameters": {
            "respondWith": "json",
            "responseBody": response_body(payload, channel),
            "options": {}
        }
    })
}

fn webhook_node(name: &str, path: &str) -> Value {
    json!({
        "id": name.replace(' ', "_"),
        "name": name,
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [240, 260],
        "parameters": {
            "httpMethod": "POST",
            "path": path,
            "responseMode": "responseNode",
            "options": {}
        }
    })
}

fn integration_string(payload: &AgentDispatchPayload, keys: &[&str]) -> Option<String> {
    let config = payload.integration_config.as_ref()?;
    keys.iter()
        .find_map(|key| config.get(*key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn website_workflow(payload: &AgentDispatchPayload) -> BuiltWorkflow {
    let ingress_path = workflow_path(payload, "chat");
    let nodes = vec![
        webhook_node("Website Trigger", &ingress_path),
        runtime_event_node(
            payload,
            "Track Website Hit",
            website_event_body(payload, "agent.hit"),
            [520, 180],
        ),
        runtime_event_node(
            payload,
            "Track Website Response",
            website_event_body(payload, "agent.responded"),
            [520, 340],
        ),
        respond_node(payload, "website", [820, 260]),
    ];

    let connections = json!({
        "Website Trigger": {
            "main": [[
                {
                    "node": "Track Website Hit",
                    "type": "main",
                    "index": 0
                },
                {
                    "node": "Track Website Response",
                    "type": "main",
                    "index": 0
                }
            ]]
        },
        "Track Website Hit": {
            "main": [[
                {
                    "node": "Respond to Webhook",
                    "type": "main",
                    "index": 0
                }
            ]]
        },
        "Track Website Response": {
            "main": [[
                {
                    "node": "Respond to Webhook",
                    "type": "main",
                    "index": 0
                }
            ]]
        }
    });

    let deployment_payload = json!({
        "channel": "website",
        "ingress": {
            "path": ingress_path,
            "mode": "webhook",
            "expects": {
                "message": "string",
                "sessionId": "string",
                "name": "string?"
            }
        },
        "widget": {
            "kind": "custom_webhook",
            "notes": "Point your website widget or form bridge at this n8n webhook path."
        },
        "runtimeEvents": ["agent.hit", "agent.responded"]
    });

    BuiltWorkflow {
        workflow: json!({
            "name": format!("KasiAgents - {} [website]", payload.name),
            "nodes": nodes,
            "connections": connections,
            "settings": {}
        }),
        deployment_payload,
    }
}

fn whatsapp_send_node(payload: &AgentDispatchPayload, position: [i32; 2]) -> Option<Value> {
    let phone_number_id = integration_string(
        payload,
        &["phoneNumberId", "businessPhoneNumberId", "waPhoneNumberId"],
    )?;
    let access_token = integration_string(
        payload,
        &["accessToken", "whatsappAccessToken", "bearerToken"],
    )?;

    Some(json!({
        "id": "Send_WhatsApp_Message",
        "name": "Send WhatsApp Greeting",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": position,
        "parameters": {
            "method": "POST",
            "url": format!("https://graph.facebook.com/v19.0/{phone_number_id}/messages"),
            "sendHeaders": true,
            "headerParameters": {
                "parameters": [
                    {
                        "name": "Authorization",
                        "value": format!("Bearer {access_token}"),
                    },
                    {
                        "name": "Content-Type",
                        "value": "application/json",
                    }
                ]
            },
            "sendBody": true,
            "specifyBody": "json",
            "jsonBody": format!(
                "={}",
                stringify(&json!({
                    "messaging_product": "whatsapp",
                    "to": "={{$json.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from}}",
                    "type": "text",
                    "text": {
                        "preview_url": false,
                        "body": response_message(payload),
                    }
                }))
            ),
            "options": {}
        }
    }))
}

fn whatsapp_workflow(payload: &AgentDispatchPayload) -> BuiltWorkflow {
    let ingress_path = workflow_path(payload, "webhook");
    let mut nodes = vec![
        webhook_node("WhatsApp Trigger", &ingress_path),
        runtime_event_node(
            payload,
            "Track WhatsApp Hit",
            whatsapp_event_body(payload, "agent.hit"),
            [520, 180],
        ),
    ];

    let send_node = whatsapp_send_node(payload, [520, 340]);
    let can_send_reply = send_node.is_some();
    if let Some(node) = send_node {
        nodes.push(node);
        nodes.push(runtime_event_node(
            payload,
            "Track WhatsApp Response",
            whatsapp_event_body(payload, "agent.responded"),
            [800, 340],
        ));
    }
    nodes.push(respond_node(payload, "whatsapp", [1060, 260]));

    let mut connections = json!({
        "WhatsApp Trigger": {
            "main": [[
                {
                    "node": "Track WhatsApp Hit",
                    "type": "main",
                    "index": 0
                }
            ]]
        },
        "Track WhatsApp Hit": {
            "main": [[
                {
                    "node": "Respond to Webhook",
                    "type": "main",
                    "index": 0
                }
            ]]
        }
    });

    if can_send_reply {
        connections["WhatsApp Trigger"]["main"][0]
            .as_array_mut()
            .expect("main connection should be an array")
            .push(json!({
                "node": "Send WhatsApp Greeting",
                "type": "main",
                "index": 0
            }));
        connections["Send WhatsApp Greeting"] = json!({
            "main": [[
                {
                    "node": "Track WhatsApp Response",
                    "type": "main",
                    "index": 0
                }
            ]]
        });
        connections["Track WhatsApp Response"] = json!({
            "main": [[
                {
                    "node": "Respond to Webhook",
                    "type": "main",
                    "index": 0
                }
            ]]
        });
    }

    let deployment_payload = json!({
        "channel": "whatsapp",
        "ingress": {
            "path": ingress_path,
            "mode": "webhook",
            "expects": "Meta-style WhatsApp webhook payloads"
        },
        "reply": {
            "mode": if can_send_reply { "graph_api" } else { "event_only" },
            "configured": can_send_reply,
            "missingRequirements": if can_send_reply {
                Value::Null
            } else {
                json!(["integrationConfig.phoneNumberId", "integrationConfig.accessToken"])
            }
        },
        "runtimeEvents": if can_send_reply {
            json!(["agent.hit", "agent.responded"])
        } else {
            json!(["agent.hit"])
        }
    });

    BuiltWorkflow {
        workflow: json!({
            "name": format!("KasiAgents - {} [whatsapp]", payload.name),
            "nodes": nodes,
            "connections": connections,
            "settings": {}
        }),
        deployment_payload,
    }
}

pub fn build_workflow(payload: &AgentDispatchPayload) -> BuiltWorkflow {
    match payload.bot_type.as_str() {
        "website_agent" => website_workflow(payload),
        "whatsapp_agent" => whatsapp_workflow(payload),
        _ => {
            let ingress_path = workflow_path(payload, "");
            BuiltWorkflow {
                workflow: json!({
                    "name": format!("KasiAgents - {} [{}]", payload.name, payload.template.channel),
                    "nodes": [
                        webhook_node("Inbound Trigger", &ingress_path),
                        respond_node(payload, &payload.template.channel, [540, 260])
                    ],
                    "connections": {
                        "Inbound Trigger": {
                            "main": [[{
                                "node": "Respond to Webhook",
                                "type": "main",
                                "index": 0
                            }]]
                        }
                    },
                    "settings": {}
                }),
                deployment_payload: json!({
                    "channel": payload.template.channel,
                    "ingress": {
                        "path": ingress_path,
                        "mode": "webhook"
                    }
                }),
            }
        }
    }
}
