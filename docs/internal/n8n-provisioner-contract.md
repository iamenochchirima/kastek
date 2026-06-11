# n8n Provisioner Contract

This document defines the contract between KasiTek and the internal n8n-side provisioner.

## Purpose

KasiTek is the control plane. n8n is the execution layer. End users do not interact with n8n directly.

KasiTek sends managed deployment actions to the provisioner. The provisioner creates or updates the underlying workflow and then reports deployment status back to KasiTek.

## Required environment

On `kasitek-core`:

- `N8N_PROVISIONER_URL`
- `N8N_PROVISIONER_TOKEN`
- `KASITEK_CORE_PUBLIC_URL`

## Outbound request from KasiTek to the provisioner

`POST $N8N_PROVISIONER_URL`

Authorization:

`Bearer $N8N_PROVISIONER_TOKEN`

Example payload for `whatsapp_agent`:

```json
{
  "action": "provision",
  "botId": "bot_123",
  "userId": "user_123",
  "deploymentId": "dep_123",
  "versionNumber": 1,
  "name": "Sales Assistant",
  "type": "whatsapp_agent",
  "status": "provisioning",
  "language": "en",
  "greetingMessage": "Hi, how can I help you today?",
  "personality": "Qualify leads and escalate ready buyers.",
  "capabilities": {
    "analytics": true,
    "handoff": true,
    "deploymentMode": "managed"
  },
  "knowledgeBase": {
    "launchMode": "managed",
    "provisioningStatus": "pending_template_connection"
  },
  "integrationConfig": {
    "channel": "whatsapp",
    "deploymentTarget": "n8n",
    "templateKey": "whatsapp_agent",
    "launchMode": "managed"
  },
  "template": {
    "key": "whatsapp_agent",
    "channel": "whatsapp",
    "workflowTemplate": "kasitek_whatsapp_agent_v1",
    "description": "Managed WhatsApp agent with reply, qualification, and handoff flow."
  },
  "callbacks": {
    "deploymentCallbackUrl": "https://api.example.com/api/bots/bot_123/deployments/dep_123/callback",
    "runtimeEventUrl": "https://api.example.com/api/bots/bot_123/events/trusted",
    "authToken": "same-token-used-for-provisioner"
  },
  "channelConfig": {
    "channel": "whatsapp",
    "requires": ["whatsapp_connection", "message_webhook", "human_handoff"],
    "features": ["reply", "qualification", "handoff", "event_tracking"],
    "integration": {
      "channel": "whatsapp",
      "deploymentTarget": "n8n",
      "templateKey": "whatsapp_agent",
      "launchMode": "managed"
    }
  }
}
```

Example payload for `website_agent` differs mainly in:

- `type`
- `template.workflowTemplate`
- `channelConfig`

## Immediate response from the provisioner

The provisioner may respond immediately with:

```json
{
  "workflowId": "n8n_workflow_123",
  "status": "active",
  "message": "Workflow provisioned",
  "payload": {
    "workflowName": "Sales Assistant",
    "templateVersion": "v1"
  }
}
```

If the provisioner works asynchronously, it may return:

```json
{
  "status": "provisioning",
  "message": "Provisioning accepted"
}
```

## Deployment callback back into KasiTek

The provisioner should POST back to:

`POST /api/bots/{botId}/deployments/{deploymentId}/callback`

Authorization:

`Bearer $N8N_PROVISIONER_TOKEN`

Payload:

```json
{
  "status": "active",
  "workflowId": "n8n_workflow_123",
  "message": "Workflow activated",
  "payload": {
    "templateVersion": "v1",
    "nodeCount": 18
  }
}
```

Allowed practical statuses:

- `provisioning`
- `active`
- `paused`
- `error`

## Runtime analytics callback

For actual hits, runs, failures, and handoffs, n8n should POST to:

`POST /api/bots/{botId}/events/trusted`

Authorization:

`Bearer $N8N_PROVISIONER_TOKEN`

Current event payload shape:

```json
{
  "eventType": "agent.hit",
  "channel": "whatsapp",
  "status": "ok",
  "conversationId": "conv_123",
  "responseTimeMs": 840,
  "metadata": {
    "source": "n8n",
    "template": "kasitek_whatsapp_agent_v1"
  }
}
```
