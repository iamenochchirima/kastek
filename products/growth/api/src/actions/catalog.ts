// Exported from the original Rust catalog functions; retain their schemas and policy metadata.
export const catalog = [
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "optional",
        "data_classification": "confidential",
        "description": "Search customer records within the caller's authorised scope.",
        "id": {
            "name": "customer.search",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
                "cursor": {
                    "maxLength": 512,
                    "minLength": 1,
                    "type": "string"
                },
                "limit": {
                    "default": 25,
                    "maximum": 100,
                    "minimum": 1,
                    "type": "integer"
                },
                "query": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                }
            },
            "required": [
                "query"
            ],
            "type": "object"
        },
        "lifecycle": "internal",
        "output_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
                "customers": {
                    "items": {
                        "additionalProperties": false,
                        "properties": {
                            "displayName": {
                                "type": [
                                    "string",
                                    "null"
                                ]
                            },
                            "id": {
                                "minLength": 1,
                                "type": "string"
                            }
                        },
                        "required": [
                            "id",
                            "displayName"
                        ],
                        "type": "object"
                    },
                    "type": "array"
                },
                "nextCursor": {
                    "type": [
                        "string",
                        "null"
                    ]
                }
            },
            "required": [
                "customers",
                "nextCursor"
            ],
            "type": "object"
        },
        "owning_domain": "customer_crm",
        "required_entitlements": [
            "feature.contacts.access"
        ],
        "required_grants": [
            "customers.read"
        ],
        "required_oauth_scopes": [
            "customers:read"
        ],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "tenant_staff",
            "tenant_client",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Search customers",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "optional",
        "data_classification": "restricted",
        "description": "Read a scoped summary of a customer conversation.",
        "id": {
            "name": "conversation.get_summary",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
                "conversationId": {
                    "maxLength": 128,
                    "minLength": 1,
                    "type": "string"
                },
                "includeRecentMessages": {
                    "default": false,
                    "type": "boolean"
                }
            },
            "required": [
                "conversationId"
            ],
            "type": "object"
        },
        "lifecycle": "internal",
        "output_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
                "conversationId": {
                    "minLength": 1,
                    "type": "string"
                },
                "lastMessageAt": {
                    "type": [
                        "string",
                        "null"
                    ]
                },
                "participantCount": {
                    "minimum": 0,
                    "type": "integer"
                },
                "status": {
                    "minLength": 1,
                    "type": "string"
                },
                "summary": {
                    "type": "string"
                }
            },
            "required": [
                "conversationId",
                "status",
                "summary",
                "participantCount",
                "lastMessageAt"
            ],
            "type": "object"
        },
        "owning_domain": "conversations",
        "required_entitlements": [
            "feature.inbox.access"
        ],
        "required_grants": [
            "conversations.read"
        ],
        "required_oauth_scopes": [
            "conversations:read"
        ],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "tenant_staff",
            "tenant_client",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Get conversation summary",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "full",
        "client_scope": "optional",
        "data_classification": "restricted",
        "description": "Create a reply draft without sending it to the customer.",
        "id": {
            "name": "conversation.draft_reply",
            "version": "1.0.0"
        },
        "idempotency": "optional",
        "input_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
                "conversationId": {
                    "maxLength": 128,
                    "minLength": 1,
                    "type": "string"
                },
                "instructions": {
                    "maxLength": 2000,
                    "type": "string"
                },
                "tone": {
                    "default": "neutral",
                    "enum": [
                        "neutral",
                        "friendly",
                        "formal",
                        "concise"
                    ],
                    "type": "string"
                }
            },
            "required": [
                "conversationId"
            ],
            "type": "object"
        },
        "lifecycle": "internal",
        "output_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
                "draft": {
                    "minLength": 1,
                    "type": "string"
                },
                "warnings": {
                    "items": {
                        "type": "string"
                    },
                    "type": "array"
                }
            },
            "required": [
                "draft",
                "warnings"
            ],
            "type": "object"
        },
        "owning_domain": "conversations",
        "required_entitlements": [
            "feature.agents.manage",
            "feature.inbox.access"
        ],
        "required_grants": [
            "conversations.draft"
        ],
        "required_oauth_scopes": [
            "conversations:draft"
        ],
        "risk": "draft",
        "supported_actors": [
            "direct_user",
            "tenant_staff",
            "tenant_client",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Draft conversation reply",
        "usage": "measured"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "List active and inactive booking services in the caller's workspace.",
        "id": {
            "name": "bookings.services.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "type": "object"
        },
        "lifecycle": "internal",
        "output_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
                "services": {
                    "type": "array"
                }
            },
            "required": [
                "services"
            ],
            "type": "object"
        },
        "owning_domain": "bookings",
        "required_entitlements": [
            "feature.bookings.access"
        ],
        "required_grants": [
            "bookings.read"
        ],
        "required_oauth_scopes": [
            "bookings:read"
        ],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "List booking services",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "restricted",
        "description": "List the caller's organization-scoped contacts without provider secrets.",
        "id": {
            "name": "contacts.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "limit": {
                    "maximum": 200,
                    "minimum": 1,
                    "type": "integer"
                },
                "q": {
                    "maxLength": 200,
                    "type": "string"
                }
            },
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "contacts"
            ],
            "type": "object"
        },
        "owning_domain": "contacts",
        "required_entitlements": [
            "feature.contacts.access"
        ],
        "required_grants": [
            "contacts.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "List contacts",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "restricted",
        "description": "List organization-scoped inbox conversations and safe unread state.",
        "id": {
            "name": "inbox.conversations.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "conversations"
            ],
            "type": "object"
        },
        "owning_domain": "inbox",
        "required_entitlements": [
            "feature.inbox.access"
        ],
        "required_grants": [
            "inbox.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "List inbox conversations",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "restricted",
        "description": "Read a redacted organization-scoped inbox conversation timeline.",
        "id": {
            "name": "inbox.messages.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "conversationId": {
                    "maxLength": 160,
                    "minLength": 1,
                    "type": "string"
                }
            },
            "required": [
                "conversationId"
            ],
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "messages"
            ],
            "type": "object"
        },
        "owning_domain": "inbox",
        "required_entitlements": [
            "feature.inbox.access"
        ],
        "required_grants": [
            "inbox.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "List inbox messages",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "restricted",
        "description": "List organization-scoped booking services and appointments.",
        "id": {
            "name": "bookings.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "bookings"
            ],
            "type": "object"
        },
        "owning_domain": "bookings",
        "required_entitlements": [
            "feature.bookings.access"
        ],
        "required_grants": [
            "bookings.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "List bookings",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "restricted",
        "description": "List organization-scoped WhatsApp campaign status and delivery summaries.",
        "id": {
            "name": "campaigns.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "campaigns"
            ],
            "type": "object"
        },
        "owning_domain": "campaigns",
        "required_entitlements": [
            "feature.campaigns.manage"
        ],
        "required_grants": [
            "campaigns.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "List campaigns",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "restricted",
        "description": "Read one organization-scoped WhatsApp campaign summary without recipient details.",
        "id": {
            "name": "campaigns.get",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "campaignId": {
                    "maxLength": 160,
                    "minLength": 1,
                    "type": "string"
                }
            },
            "required": [
                "campaignId"
            ],
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "campaign"
            ],
            "type": "object"
        },
        "owning_domain": "campaigns",
        "required_entitlements": [
            "feature.campaigns.manage"
        ],
        "required_grants": [
            "campaigns.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "Get campaign summary",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "access",
        "client_scope": "not_applicable",
        "data_classification": "restricted",
        "description": "List organization-scoped WhatsApp templates and approval status without message bodies.",
        "id": {
            "name": "templates.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "status": {
                    "enum": [
                        "APPROVED",
                        "PENDING",
                        "REJECTED",
                        "DISABLED"
                    ],
                    "type": "string"
                }
            },
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "templates"
            ],
            "type": "object"
        },
        "owning_domain": "templates",
        "required_entitlements": [
            "feature.templates.manage"
        ],
        "required_grants": [
            "templates.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct"
        ],
        "title": "List templates",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "List workspace-owned content drafts and publication records.",
        "id": {
            "name": "content.posts.list",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": false,
            "properties": {
                "posts": {
                    "type": "array"
                }
            },
            "required": [
                "posts"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.read"
        ],
        "required_oauth_scopes": [],
        "risk": "read",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "List content posts",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "Create a reviewable content draft without publishing it.",
        "id": {
            "name": "content.posts.draft.create",
            "version": "1.0.0"
        },
        "idempotency": "required",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "media": {
                    "type": "array"
                },
                "text": {
                    "maxLength": 50000,
                    "type": "string"
                }
            },
            "required": [
                "text"
            ],
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "post"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.write"
        ],
        "required_oauth_scopes": [],
        "risk": "draft",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Create content draft",
        "usage": "count"
    },
    {
        "approval": {
            "type": "none"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "Update a workspace content draft without publishing it.",
        "id": {
            "name": "content.posts.draft.update",
            "version": "1.0.0"
        },
        "idempotency": "not_applicable",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "channels": {
                    "type": "array"
                },
                "content": {
                    "type": "string"
                },
                "metadata": {
                    "type": "object"
                },
                "postId": {
                    "type": "string"
                },
                "prompt": {
                    "type": "string"
                },
                "title": {
                    "type": "string"
                }
            },
            "required": [
                "postId"
            ],
            "type": "object"
        },
        "lifecycle": "public",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "post"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.write"
        ],
        "required_oauth_scopes": [],
        "risk": "draft",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Update content draft",
        "usage": "count"
    },
    {
        "approval": {
            "type": "policy_controlled"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "Publish an immutable, approved content revision to selected channels.",
        "id": {
            "name": "content.posts.publish",
            "version": "1.0.0"
        },
        "idempotency": "required",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "platform": {
                    "type": "string"
                },
                "postId": {
                    "type": "string"
                }
            },
            "required": [
                "postId",
                "platform"
            ],
            "type": "object"
        },
        "lifecycle": "pilot",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "status"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.publish"
        ],
        "required_oauth_scopes": [],
        "risk": "external_effect",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Publish content",
        "usage": "count"
    },
    {
        "approval": {
            "type": "always"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "Publish one approved content revision to every configured destination as one durable operation.",
        "id": {
            "name": "content.posts.publish_batch",
            "version": "1.0.0"
        },
        "idempotency": "required",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "postId": {
                    "type": "string"
                }
            },
            "required": [
                "postId"
            ],
            "type": "object"
        },
        "lifecycle": "pilot",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "status",
                "batch"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.publish"
        ],
        "required_oauth_scopes": [],
        "risk": "external_effect",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Publish content batch",
        "usage": "count"
    },
    {
        "approval": {
            "type": "always"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "Retry only confirmed failed destinations from an existing content publish batch.",
        "id": {
            "name": "content.posts.publish_batch.retry",
            "version": "1.0.0"
        },
        "idempotency": "required",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "batchId": {
                    "type": "string"
                }
            },
            "required": [
                "batchId"
            ],
            "type": "object"
        },
        "lifecycle": "pilot",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "status",
                "batch"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.publish"
        ],
        "required_oauth_scopes": [],
        "risk": "external_effect",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Retry failed content destinations",
        "usage": "count"
    },
    {
        "approval": {
            "type": "always"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "Move a scheduled content post back to a draft without publishing it.",
        "id": {
            "name": "content.posts.unschedule",
            "version": "1.0.0"
        },
        "idempotency": "required",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "postId": {
                    "type": "string"
                }
            },
            "required": [
                "postId"
            ],
            "type": "object"
        },
        "lifecycle": "pilot",
        "output_schema": {
            "additionalProperties": true,
            "required": [
                "post",
                "status"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.publish"
        ],
        "required_oauth_scopes": [],
        "risk": "external_effect",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Unschedule content",
        "usage": "count"
    },
    {
        "approval": {
            "type": "always"
        },
        "audit": "full",
        "client_scope": "not_applicable",
        "data_classification": "confidential",
        "description": "Delete an unpublished content draft or schedule.",
        "id": {
            "name": "content.posts.delete",
            "version": "1.0.0"
        },
        "idempotency": "required",
        "input_schema": {
            "additionalProperties": false,
            "properties": {
                "postId": {
                    "type": "string"
                }
            },
            "required": [
                "postId"
            ],
            "type": "object"
        },
        "lifecycle": "pilot",
        "output_schema": {
            "additionalProperties": false,
            "properties": {
                "deleted": {
                    "type": "boolean"
                },
                "postId": {
                    "type": "string"
                }
            },
            "required": [
                "postId",
                "deleted"
            ],
            "type": "object"
        },
        "owning_domain": "content",
        "required_entitlements": [
            "feature.social.access"
        ],
        "required_grants": [
            "content.write"
        ],
        "required_oauth_scopes": [],
        "risk": "external_effect",
        "supported_actors": [
            "direct_user",
            "native_agent",
            "api_client",
            "external_agent"
        ],
        "supported_runtimes": [
            "direct",
            "white_label"
        ],
        "title": "Delete content",
        "usage": "count"
    }
] as const;
