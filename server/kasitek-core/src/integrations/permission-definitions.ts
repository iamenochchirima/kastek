export const PERMISSION_DEFINITIONS = [
    {
        "key": "MESSAGING_INBOUND",
        "group": "MESSAGING",
        "label": "Receive messages",
        "description": "Let KasiTek receive messages for this account."
    },
    {
        "key": "MESSAGING_OUTBOUND",
        "group": "MESSAGING",
        "label": "Reply to messages",
        "description": "Let KasiTek send replies from this account."
    },
    {
        "key": "SOCIAL_PUBLISH",
        "group": "PUBLISHING",
        "label": "Publish content",
        "description": "Create and publish content to this account."
    },
    {
        "key": "MEDIA_PUBLISH",
        "group": "MEDIA",
        "label": "Use media",
        "description": "Upload and use images or videos in content."
    },
    {
        "key": "SOCIAL_ANALYTICS",
        "group": "ANALYTICS",
        "label": "View analytics",
        "description": "Read performance and audience metrics."
    },
    {
        "key": "COMMENTS_MANAGE",
        "group": "COMMUNITY",
        "label": "Manage comments",
        "description": "Read and manage supported comments and interactions."
    },
    {
        "key": "SOCIAL_POST_DELETE",
        "group": "CONTENT_MANAGEMENT",
        "label": "Delete published content",
        "description": "Delete content published through this account."
    },
    {
        "key": "EMAIL_INBOUND",
        "group": "EMAIL",
        "label": "Receive email",
        "description": "Sync incoming email into the workspace inbox."
    },
    {
        "key": "EMAIL_READ",
        "group": "EMAIL",
        "label": "Read email",
        "description": "Read message headers and content from this mailbox."
    },
    {
        "key": "EMAIL_OUTBOUND",
        "group": "EMAIL",
        "label": "Send email",
        "description": "Send email from this mailbox."
    },
    {
        "key": "EMAIL_REPLY",
        "group": "EMAIL",
        "label": "Reply to email",
        "description": "Reply within an existing email thread."
    }
] as const;
