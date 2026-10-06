// Generated from Rust source baseline abd419c6ae0d84ca19a0a9cb802cc2bb2626d963. Do not edit by hand.
export const GENERATED_SERDE_BODY_SCHEMAS: Record<string, unknown> = {
  "POST /api/admin/login": {
    "type": "object",
    "properties": {
      "email": {},
      "password": {}
    }
  },
  "POST /api/admin/forgot-password": {
    "type": "object",
    "properties": {
      "email": {}
    }
  },
  "POST /api/admin/reset-password": {
    "type": "object",
    "properties": {
      "email": {},
      "token": {},
      "password": {}
    }
  },
  "PATCH /api/admin/password": {
    "type": "object",
    "properties": {
      "currentPassword": {},
      "nextPassword": {}
    }
  },
  "POST /api/admin/reports": {
    "type": "object",
    "properties": {
      "name": {},
      "reportKey": {},
      "days": {},
      "config": {}
    }
  },
  "POST /api/admin/operations/webhooks/replays": {
    "type": "object",
    "properties": {
      "deliveryId": {},
      "expectedStatus": {},
      "expectedAttemptCount": {}
    }
  },
  "POST /api/admin/operations/support-grants": {
    "type": "object",
    "properties": {
      "adminId": {},
      "organizationId": {},
      "resourceType": {},
      "resourceId": {},
      "reason": {},
      "durationMinutes": {}
    }
  },
  "POST /api/admin/access": {
    "type": "object",
    "properties": {
      "name": {},
      "email": {},
      "workspaceName": {}
    }
  },
  "POST /api/admin/early-access/batch-approve": {
    "type": "object",
    "properties": {
      "applicationIds": {
        "type": "array",
        "items": {}
      },
      "packageKey": {}
    }
  },
  "POST /api/admin/early-access/:id/reject": {
    "type": "object",
    "properties": {
      "reason": {}
    }
  },
  "POST /api/admin/early-access/:id/approve": {
    "type": "object",
    "properties": {
      "packageKey": {}
    }
  },
  "POST /api/admin/billing/products": {
    "type": "object",
    "properties": {
      "key": {},
      "name": {},
      "description": {},
      "active": {}
    }
  },
  "POST /api/admin/billing/plans": {
    "type": "object",
    "properties": {
      "productKey": {},
      "key": {},
      "name": {},
      "interval": {},
      "currency": {},
      "amountMinor": {},
      "creditsPerPeriod": {},
      "active": {},
      "paystackPlanCode": {}
    }
  },
  "POST /api/admin/billing/entitlements": {
    "type": "object",
    "properties": {
      "planKey": {},
      "key": {},
      "value": {}
    }
  },
  "POST /api/admin/billing/orgs/:orgId/grants": {
    "type": "object",
    "properties": {
      "key": {},
      "value": {},
      "endsAt": {},
      "reason": {}
    }
  },
  "POST /api/admin/billing/orgs/:orgId/credits/grants": {
    "type": "object",
    "properties": {
      "amount": {},
      "source": {},
      "endsAt": {},
      "reason": {},
      "reference": {},
      "idempotencyKey": {}
    }
  },
  "POST /api/admin/billing/orgs/:orgId/credits/balance": {
    "type": "object",
    "properties": {
      "targetBalance": {},
      "reason": {},
      "reference": {},
      "idempotencyKey": {}
    }
  },
  "POST /api/admin/referrals/orgs/:orgId/code": {
    "type": "object",
    "properties": {
      "status": {},
      "reason": {}
    }
  },
  "POST /api/admin/referrals/:attributionId/reject": {
    "type": "object",
    "properties": {
      "reason": {},
      "reference": {}
    }
  },
  "POST /api/admin/referrals/:attributionId/reverse": {
    "type": "object",
    "properties": {
      "reason": {},
      "reference": {}
    }
  },
  "POST /api/admin/leads": {
    "type": "object",
    "properties": {
      "businessName": {},
      "contactPerson": {},
      "phone": {},
      "email": {},
      "businessType": {},
      "services": {
        "type": "array",
        "items": {}
      },
      "description": {},
      "source": {},
      "status": {},
      "quoteAmount": {},
      "assignedToId": {}
    }
  },
  "PATCH /api/admin/leads/:id": {
    "type": "object",
    "properties": {
      "businessName": {},
      "contactPerson": {},
      "phone": {},
      "email": {},
      "businessType": {},
      "services": {
        "type": "array",
        "items": {}
      },
      "description": {},
      "source": {},
      "status": {},
      "quoteAmount": {},
      "followUpDate": {},
      "notes": {},
      "assignedToId": {}
    }
  },
  "POST /api/admin/leads/:id/notes": {
    "type": "object",
    "properties": {
      "text": {},
      "adminUserName": {}
    }
  },
  "POST /api/admin/web-services": {
    "type": "object",
    "properties": {
      "businessName": {},
      "website": {},
      "address": {},
      "category": {},
      "bizbayUrl": {},
      "phone": {},
      "email": {},
      "callStatus": {},
      "notes": {}
    }
  },
  "POST /api/admin/web-services/import": {
    "type": "object",
    "properties": {
      "leads": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "businessName": {},
            "website": {},
            "address": {},
            "category": {},
            "bizbayUrl": {},
            "phone": {},
            "email": {},
            "callStatus": {},
            "notes": {}
          }
        }
      }
    }
  },
  "PATCH /api/admin/web-services/:id": {
    "type": "object",
    "properties": {
      "businessName": {},
      "website": {},
      "address": {},
      "category": {},
      "bizbayUrl": {},
      "phone": {},
      "email": {},
      "callStatus": {},
      "notes": {},
      "callbackDate": {}
    }
  },
  "POST /api/admin/quotations": {
    "type": "object",
    "properties": {
      "businessName": {},
      "contactPerson": {},
      "contactEmail": {},
      "contactPhone": {},
      "date": {},
      "serviceType": {},
      "title": {},
      "introduction": {},
      "scopeOfWork": {},
      "deliverables": {},
      "implementationSteps": {},
      "pricingItems": {},
      "maintenanceIncludes": {},
      "termsAndNotes": {},
      "sectionOrder": {},
      "noteSections": {},
      "validityDays": {},
      "status": {},
      "quoteRequestId": {}
    }
  },
  "PATCH /api/admin/quotations/:id": {
    "type": "object",
    "properties": {
      "businessName": {},
      "contactPerson": {},
      "contactEmail": {},
      "contactPhone": {},
      "date": {},
      "serviceType": {},
      "title": {},
      "introduction": {},
      "scopeOfWork": {},
      "deliverables": {},
      "implementationSteps": {},
      "pricingItems": {},
      "maintenanceIncludes": {},
      "termsAndNotes": {},
      "sectionOrder": {},
      "noteSections": {},
      "validityDays": {},
      "status": {},
      "quoteRequestId": {}
    }
  },
  "POST /api/admin/invoices": {
    "type": "object",
    "properties": {
      "businessName": {},
      "contactPerson": {},
      "contactEmail": {},
      "contactPhone": {},
      "date": {},
      "serviceType": {},
      "billingMode": {},
      "recurringActive": {},
      "billingAnchorDay": {},
      "reminderDaysAfterDue": {},
      "title": {},
      "introduction": {},
      "scopeOfWork": {},
      "deliverables": {},
      "implementationSteps": {},
      "pricingItems": {},
      "maintenanceIncludes": {},
      "termsAndNotes": {},
      "sectionOrder": {},
      "noteSections": {},
      "validityDays": {},
      "status": {},
      "quoteRequestId": {}
    }
  },
  "PATCH /api/admin/invoices/:id": {
    "type": "object",
    "properties": {
      "businessName": {},
      "contactPerson": {},
      "contactEmail": {},
      "contactPhone": {},
      "date": {},
      "serviceType": {},
      "billingMode": {},
      "recurringActive": {},
      "billingAnchorDay": {},
      "reminderDaysAfterDue": {},
      "title": {},
      "introduction": {},
      "scopeOfWork": {},
      "deliverables": {},
      "implementationSteps": {},
      "pricingItems": {},
      "maintenanceIncludes": {},
      "termsAndNotes": {},
      "sectionOrder": {},
      "noteSections": {},
      "validityDays": {},
      "status": {},
      "quoteRequestId": {}
    }
  },
  "POST /api/admin/invoices/:id/runs/:run_id/actions": {
    "type": "object",
    "properties": {
      "action": {}
    }
  },
  "POST /api/admin/outreach": {
    "type": "object",
    "properties": {
      "name": {},
      "category": {},
      "status": {}
    }
  },
  "POST /api/admin/outreach/import": {
    "type": "object",
    "properties": {
      "name": {},
      "category": {},
      "listings": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {},
            "website": {},
            "address": {},
            "bizbayUrl": {},
            "phone": {}
          }
        }
      }
    }
  },
  "PATCH /api/admin/outreach/:id": {
    "type": "object",
    "properties": {
      "name": {},
      "category": {},
      "status": {}
    }
  },
  "POST /api/admin/outreach/delivery-logs": {
    "type": "object",
    "properties": {
      "logs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "campaignId": {},
            "leadId": {},
            "recipient": {},
            "subject": {},
            "status": {},
            "provider": {},
            "providerMessageId": {},
            "providerResponse": {},
            "errorMessage": {}
          }
        }
      }
    }
  },
  "POST /api/admin/outreach/:id/leads": {
    "type": "object",
    "properties": {
      "businessName": {},
      "website": {},
      "address": {},
      "bizbayUrl": {},
      "category": {},
      "phone": {},
      "emailAddress": {},
      "emailTemplate": {},
      "notes": {}
    }
  },
  "PATCH /api/admin/outreach/:id/leads/:lead_id": {
    "type": "object",
    "properties": {
      "emailStatus": {},
      "phone": {},
      "emailAddress": {},
      "emailSentAt": {},
      "emailTemplate": {},
      "followUpCount": {},
      "lastFollowUp": {},
      "nextFollowUp": {},
      "notes": {}
    }
  },
  "PATCH /api/internal/agents/v1/connections/status": {
    "type": "object",
    "properties": {
      "provider": {},
      "displayName": {},
      "handle": {},
      "status": {}
    }
  },
  "PATCH /api/internal/agents/v1/connections/:id/status": {
    "type": "object",
    "properties": {
      "status": {}
    }
  },
  "POST /api/internal/agents/v1/email/connections": {
    "type": "object",
    "properties": {
      "userId": {},
      "provider": {},
      "externalAccountId": {},
      "emailAddress": {},
      "displayName": {},
      "accessToken": {},
      "refreshToken": {},
      "expiresAt": {},
      "scopes": {
        "type": "array",
        "items": {}
      }
    }
  },
  "PATCH /api/internal/agents/v1/contacts/:id": {
    "type": "object",
    "properties": {
      "fullName": {},
      "phone": {},
      "location": {},
      "tags": {
        "type": "array",
        "items": {}
      },
      "notes": {},
      "listLabel": {},
      "metadata": {},
      "optIn": {},
      "excluded": {}
    }
  },
  "PATCH /api/internal/agents/v1/inbox/conversations/:id": {
    "type": "object",
    "properties": {
      "starred": {}
    }
  },
  "POST /api/internal/agents/v1/content/posts": {
    "type": "object",
    "properties": {
      "title": {},
      "prompt": {},
      "content": {},
      "channels": {
        "type": "array",
        "items": {}
      },
      "status": {},
      "scheduledFor": {},
      "primaryChannelId": {},
      "channelSelections": {
        "type": "object",
        "additionalProperties": {}
      },
      "variants": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "platform": {},
            "content": {},
            "status": {},
            "aiGenerated": {},
            "metadata": {}
          }
        }
      },
      "media": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assetId": {},
            "sortOrder": {},
            "altText": {},
            "metadata": {}
          }
        }
      },
      "metadata": {}
    }
  },
  "PATCH /api/internal/agents/v1/content/posts/:id": {
    "type": "object",
    "properties": {
      "title": {},
      "prompt": {},
      "content": {},
      "channels": {
        "type": "array",
        "items": {}
      },
      "status": {},
      "scheduledFor": {},
      "primaryChannelId": {},
      "channelSelections": {
        "type": "object",
        "additionalProperties": {}
      },
      "variants": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "platform": {},
            "content": {},
            "status": {},
            "aiGenerated": {},
            "metadata": {}
          }
        }
      },
      "media": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assetId": {},
            "sortOrder": {},
            "altText": {},
            "metadata": {}
          }
        }
      },
      "metadata": {}
    }
  },
  "POST /api/internal/agents/v1/content/posts/:id/publish": {
    "type": "object",
    "properties": {
      "platform": {}
    }
  },
  "POST /api/internal/agents/v1/content/posts/:id/publish-batch": {
    "type": "object",
    "properties": {
      "snapshotHash": {}
    }
  },
  "POST /api/internal/agents/v1/content/posts/:id/delete-published": {
    "type": "object",
    "properties": {
      "platform": {}
    }
  },
  "POST /api/internal/agents/v1/content/posts/:id/schedule": {
    "type": "object",
    "properties": {
      "scheduledFor": {}
    }
  },
  "POST /api/internal/agents/v1/channels/deliver": {
    "type": "object",
    "properties": {
      "channelType": {},
      "externalConversationId": {},
      "text": {},
      "media": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assetId": {},
            "kind": {},
            "mimeType": {},
            "fileName": {},
            "altText": {},
            "caption": {},
            "disposition": {}
          }
        }
      },
      "buttons": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {},
            "title": {}
          }
        }
      },
      "ui": {}
    }
  },
  "POST /api/internal/agents/v1/credits/reservations": {
    "type": "object",
    "properties": {
      "actionKey": {},
      "estimatedCredits": {},
      "sourceType": {},
      "sourceId": {},
      "pricingVersion": {},
      "expiresAt": {},
      "idempotencyKey": {}
    }
  },
  "POST /api/internal/agents/v1/credits/reservations/:reservationId/capture": {
    "type": "object",
    "properties": {
      "actualCredits": {},
      "provider": {},
      "model": {},
      "fundingSource": {},
      "inputTokens": {},
      "outputTokens": {},
      "providerCostUsd": {},
      "metadata": {},
      "idempotencyKey": {}
    }
  },
  "POST /api/internal/agents/v1/credits/reservations/:reservationId/release": {
    "type": "object",
    "properties": {
      "reason": {},
      "idempotencyKey": {}
    }
  },
  "POST /api/agents/installations/:installationId/website-deployments": {
    "type": "object",
    "properties": {
      "allowedOrigins": {
        "type": "array",
        "items": {}
      },
      "displayName": {},
      "welcomeText": {},
      "launcherPosition": {},
      "colorPreset": {},
      "avatarUrl": {},
      "privacyPolicyUrl": {},
      "appearance": {
        "type": "object",
        "properties": {
          "primaryColor": {},
          "launcherSize": {},
          "windowWidth": {},
          "windowHeight": {},
          "borderRadius": {},
          "launcherOffset": {},
          "showBranding": {}
        }
      }
    }
  },
  "PATCH /api/agents/installations/:installationId/website-deployments/:deploymentId": {
    "type": "object",
    "properties": {
      "allowedOrigins": {
        "type": "array",
        "items": {}
      },
      "displayName": {},
      "welcomeText": {},
      "launcherPosition": {},
      "colorPreset": {},
      "avatarUrl": {},
      "privacyPolicyUrl": {},
      "appearance": {
        "type": "object",
        "properties": {
          "primaryColor": {},
          "launcherSize": {},
          "windowWidth": {},
          "windowHeight": {},
          "borderRadius": {},
          "launcherOffset": {},
          "showBranding": {}
        }
      }
    }
  },
  "POST /api/agents/kasiai/channels/whatsapp/pairing": {
    "type": "object",
    "properties": {
      "connectionId": {}
    }
  },
  "POST /api/early-access/invitations/:token/activate": {
    "type": "object",
    "properties": {
      "organizationId": {},
      "workspaceName": {}
    }
  },
  "POST /api/developers/api-keys": {
    "type": "object",
    "properties": {
      "name": {},
      "expiresAt": {}
    }
  },
  "POST /api/calls/providers/twilio/connections": {
    "type": "object",
    "properties": {
      "phoneNumber": {},
      "displayName": {}
    }
  },
  "POST /api/billing/checkout": {
    "type": "object",
    "properties": {
      "planKey": {},
      "idempotencyKey": {}
    }
  },
  "POST /api/referrals/attribute": {
    "type": "object",
    "properties": {
      "code": {}
    }
  },
  "POST /api/orgs": {
    "type": "object",
    "properties": {
      "name": {},
      "slug": {},
      "logo": {}
    }
  },
  "PATCH /api/orgs/:id": {
    "type": "object",
    "properties": {
      "name": {},
      "logo": {}
    }
  },
  "PATCH /api/orgs/:id/members/:userId": {
    "type": "object",
    "properties": {
      "role": {}
    }
  },
  "POST /api/orgs/:id/invitations": {
    "type": "object",
    "properties": {
      "email": {},
      "role": {}
    }
  },
  "PATCH /api/profile": {
    "type": "object",
    "properties": {
      "name": {},
      "phone": {},
      "image": {}
    }
  },
  "PATCH /api/onboarding": {
    "type": "object",
    "properties": {
      "companyName": {},
      "website": {},
      "primaryGoal": {},
      "primaryGoals": {
        "type": "array",
        "items": {}
      },
      "teamRole": {},
      "industry": {},
      "referralSource": {},
      "complete": {},
      "skip": {}
    }
  },
  "POST /api/onboarding/phone": {
    "type": "object",
    "properties": {
      "phone": {},
      "phoneVerified": {}
    }
  },
  "PATCH /api/product-tour": {
    "type": "object",
    "properties": {
      "action": {},
      "currentStep": {}
    }
  },
  "POST /api/notifications": {
    "type": "object",
    "properties": {
      "action": {}
    }
  },
  "POST /api/notifications/push/subscribe": {
    "type": "object",
    "properties": {
      "subscription": {
        "type": "object",
        "properties": {
          "endpoint": {},
          "expirationTime": {},
          "keys": {
            "type": "object",
            "properties": {
              "p256dh": {},
              "auth": {}
            }
          }
        }
      }
    }
  },
  "POST /api/notifications/push/unsubscribe": {
    "type": "object",
    "properties": {
      "endpoint": {}
    }
  },
  "POST /api/notifications/push/test": {
    "type": "object",
    "properties": {
      "title": {},
      "body": {},
      "url": {}
    }
  },
  "PATCH /api/connections/:id/status": {
    "type": "object",
    "properties": {
      "status": {}
    }
  },
  "POST /api/social/ai/ideas": {
    "type": "object",
    "properties": {
      "topic": {},
      "objective": {},
      "channels": {
        "type": "array",
        "items": {}
      }
    }
  },
  "POST /api/social/ai/caption": {
    "type": "object",
    "properties": {
      "prompt": {},
      "title": {},
      "channels": {
        "type": "array",
        "items": {}
      },
      "currentContent": {}
    }
  },
  "POST /api/social/channels": {
    "type": "object",
    "properties": {
      "platform": {},
      "displayName": {},
      "handle": {},
      "externalAccountId": {},
      "status": {},
      "metadata": {}
    }
  },
  "PATCH /api/social/channels/:id": {
    "type": "object",
    "properties": {
      "platform": {},
      "displayName": {},
      "handle": {},
      "status": {},
      "metadata": {}
    }
  },
  "POST /api/social/posts": {
    "type": "object",
    "properties": {
      "title": {},
      "prompt": {},
      "content": {},
      "channels": {
        "type": "array",
        "items": {}
      },
      "status": {},
      "scheduledFor": {},
      "primaryChannelId": {},
      "channelSelections": {
        "type": "object",
        "additionalProperties": {}
      },
      "variants": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "platform": {},
            "content": {},
            "status": {},
            "aiGenerated": {},
            "metadata": {}
          }
        }
      },
      "media": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assetId": {},
            "sortOrder": {},
            "altText": {},
            "metadata": {}
          }
        }
      },
      "metadata": {}
    }
  },
  "PATCH /api/social/posts/:id": {
    "type": "object",
    "properties": {
      "title": {},
      "prompt": {},
      "content": {},
      "channels": {
        "type": "array",
        "items": {}
      },
      "status": {},
      "scheduledFor": {},
      "primaryChannelId": {},
      "channelSelections": {
        "type": "object",
        "additionalProperties": {}
      },
      "variants": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "platform": {},
            "content": {},
            "status": {},
            "aiGenerated": {},
            "metadata": {}
          }
        }
      },
      "media": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assetId": {},
            "sortOrder": {},
            "altText": {},
            "metadata": {}
          }
        }
      },
      "metadata": {}
    }
  },
  "POST /api/social/posts/:id/publish": {
    "type": "object",
    "properties": {
      "platform": {}
    }
  },
  "PATCH /api/social/publish-jobs/:id": {
    "type": "object",
    "properties": {
      "action": {}
    }
  },
  "POST /api/bookings": {
    "type": "object",
    "properties": {
      "serviceId": {},
      "customerId": {},
      "contactName": {},
      "contactPhone": {},
      "scheduledStart": {},
      "timezone": {},
      "notes": {}
    }
  },
  "PATCH /api/bookings/:id": {
    "type": "object",
    "properties": {
      "status": {},
      "notes": {}
    }
  },
  "POST /api/bookings/services": {
    "type": "object",
    "properties": {
      "name": {},
      "description": {},
      "durationMinutes": {}
    }
  },
  "PATCH /api/bookings/services/:id": {
    "type": "object",
    "properties": {
      "name": {},
      "description": {},
      "durationMinutes": {},
      "active": {}
    }
  },
  "POST /api/inbox/:id/messages": {
    "type": "object",
    "properties": {
      "text": {},
      "replyToMessageId": {}
    }
  },
  "POST /api/whatsapp/connections": {
    "type": "object",
    "properties": {
      "wabaId": {},
      "phoneNumberId": {},
      "accessToken": {},
      "phoneDisplayNumber": {}
    }
  },
  "POST /api/whatsapp/connections/:id/token": {
    "type": "object",
    "properties": {
      "accessToken": {}
    }
  },
  "POST /api/whatsapp/onboarding/complete": {
    "type": "object",
    "properties": {
      "code": {},
      "wabaId": {},
      "phoneNumberId": {}
    }
  },
  "PATCH /api/whatsapp/contacts/lists/:label": {
    "type": "object",
    "properties": {
      "nextLabel": {}
    }
  },
  "PATCH /api/whatsapp/contacts/:id": {
    "type": "object",
    "properties": {
      "fullName": {},
      "phone": {},
      "location": {},
      "tags": {
        "type": "array",
        "items": {}
      },
      "notes": {},
      "listLabel": {},
      "metadata": {},
      "optIn": {},
      "excluded": {}
    }
  },
  "POST /api/whatsapp/templates": {
    "type": "object",
    "properties": {
      "connectionId": {},
      "templateName": {},
      "language": {},
      "category": {},
      "header": {},
      "body": {},
      "footer": {}
    }
  },
  "POST /api/whatsapp/inbox/conversations": {
    "type": "object",
    "properties": {
      "connectionId": {},
      "templateId": {},
      "phone": {},
      "customerName": {},
      "bodyParameters": {
        "type": "array",
        "items": {}
      }
    }
  },
  "PATCH /api/whatsapp/inbox/:id": {
    "type": "object",
    "properties": {
      "starred": {}
    }
  },
  "POST /api/whatsapp/inbox/:id/messages": {
    "type": "object",
    "properties": {
      "text": {},
      "replyToMessageId": {}
    }
  },
  "POST /api/whatsapp/inbox/:id/messages/:message_id/reaction": {
    "type": "object",
    "properties": {
      "emoji": {},
      "remove": {}
    }
  },
  "POST /api/whatsapp/calls/:id/signals": {
    "type": "object",
    "properties": {
      "kind": {},
      "payload": {},
      "source": {}
    }
  },
  "POST /api/whatsapp/calls/:id/action": {
    "type": "object",
    "properties": {
      "action": {}
    }
  },
  "POST /api/whatsapp/campaigns": {
    "type": "object",
    "properties": {
      "name": {},
      "description": {},
      "connectionId": {},
      "templateId": {},
      "recipientIds": {
        "type": "array",
        "items": {}
      },
      "excludedContactIds": {
        "type": "array",
        "items": {}
      },
      "listLabel": {},
      "batchSize": {},
      "scheduledAt": {},
      "variableMappings": {},
      "audience": {
        "type": "object",
        "properties": {
          "tags": {
            "type": "array",
            "items": {}
          },
          "location": {},
          "search": {},
          "listLabel": {},
          "optInStatus": {},
          "excludedStatus": {},
          "cooldownStatus": {}
        }
      }
    }
  },
  "PATCH /api/whatsapp/campaigns/:id": {
    "type": "object",
    "properties": {
      "action": {},
      "batchSize": {},
      "excludedContactIds": {
        "type": "array",
        "items": {}
      },
      "scheduledAt": {}
    }
  },
  "POST /api/whatsapp/campaigns/:id/launch": {
    "type": "object",
    "properties": {
      "action": {},
      "batchSize": {},
      "excludedContactIds": {
        "type": "array",
        "items": {}
      },
      "scheduledAt": {}
    }
  },
  "POST /v1/content/posts": {
    "type": "object",
    "properties": {
      "title": {},
      "prompt": {},
      "content": {},
      "channels": {
        "type": "array",
        "items": {}
      },
      "status": {},
      "scheduledFor": {},
      "primaryChannelId": {},
      "channelSelections": {
        "type": "object",
        "additionalProperties": {}
      },
      "variants": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "platform": {},
            "content": {},
            "status": {},
            "aiGenerated": {},
            "metadata": {}
          }
        }
      },
      "media": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assetId": {},
            "sortOrder": {},
            "altText": {},
            "metadata": {}
          }
        }
      },
      "metadata": {}
    }
  },
  "PATCH /v1/content/posts/:id": {
    "type": "object",
    "properties": {
      "title": {},
      "prompt": {},
      "content": {},
      "channels": {
        "type": "array",
        "items": {}
      },
      "status": {},
      "scheduledFor": {},
      "primaryChannelId": {},
      "channelSelections": {
        "type": "object",
        "additionalProperties": {}
      },
      "variants": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "platform": {},
            "content": {},
            "status": {},
            "aiGenerated": {},
            "metadata": {}
          }
        }
      },
      "media": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assetId": {},
            "sortOrder": {},
            "altText": {},
            "metadata": {}
          }
        }
      },
      "metadata": {}
    }
  },
  "POST /v1/webhooks/subscriptions": {
    "type": "object",
    "properties": {
      "url": {},
      "eventTypes": {
        "type": "array",
        "items": {}
      },
      "secret": {}
    }
  },
  "PATCH /v1/webhooks/subscriptions/:id": {
    "type": "object",
    "properties": {
      "url": {},
      "eventTypes": {
        "type": "array",
        "items": {}
      },
      "enabled": {}
    }
  }
} as const;
