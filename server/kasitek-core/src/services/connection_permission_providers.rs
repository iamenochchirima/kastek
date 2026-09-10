//! Provider adapters for the shared connection permission module.
//!
//! This is the only module that maps KasiTek capability keys to provider grants. Callers deal in
//! capability keys and normalized states. They never need to know whether a provider uses OAuth
//! scopes, page tasks, an embedded setup flow, or a fixed AT Protocol permission.

use serde_json::Value;

use super::connection_permissions::{
    COMMENTS_MANAGE, EMAIL_INBOUND, EMAIL_OUTBOUND, EMAIL_READ, EMAIL_REPLY, MEDIA_PUBLISH,
    MESSAGING_INBOUND, MESSAGING_OUTBOUND, SOCIAL_ANALYTICS, SOCIAL_POST_DELETE, SOCIAL_PUBLISH,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderAdapter {
    MetaFacebook,
    MetaInstagram,
    InstagramDirect,
    WhatsApp,
    Threads,
    TikTok,
    LinkedInMember,
    LinkedInOrganization,
    X,
    Bluesky,
    GoogleEmail,
    MicrosoftEmail,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CapabilityRule {
    pub supported: bool,
    pub requestable: bool,
    pub requires_target_check: bool,
    pub provider_permission: Option<&'static str>,
    pub grants: &'static [&'static str],
    pub request_scopes: &'static [&'static str],
}

const NONE: &[&str] = &[];

const META_FACEBOOK_MESSAGING: &[&str] = &["pages_messaging", "MESSAGING"];
const META_FACEBOOK_PUBLISHING: &[&str] = &["pages_manage_posts", "CREATE_CONTENT"];
const META_FACEBOOK_ANALYTICS: &[&str] = &["read_insights", "VIEW_INSIGHTS"];
const META_FACEBOOK_COMMENTS: &[&str] = &["pages_manage_engagement", "MODERATE", "COMMUNITY"];
const META_INSTAGRAM_MESSAGING: &[&str] = &["instagram_manage_messages"];
const META_INSTAGRAM_PUBLISHING: &[&str] = &["instagram_content_publish"];
const META_INSTAGRAM_ANALYTICS: &[&str] = &["instagram_manage_insights"];
const META_INSTAGRAM_COMMENTS: &[&str] = &["instagram_manage_comments"];
const META_INSTAGRAM_CONTENT_MANAGEMENT: &[&str] = &["instagram_manage_contents"];
const META_FACEBOOK_REQUIRED: &[&str] = &["pages_show_list", "pages_manage_metadata"];
const META_INSTAGRAM_REQUIRED: &[&str] = &["instagram_basic"];

const WHATSAPP_MESSAGING: &[&str] = &["whatsapp_business_messaging"];
const WHATSAPP_MANAGEMENT: &[&str] = &["whatsapp_business_management", "business_management"];
const WHATSAPP_CHAT: &[&str] = &["whatsapp_business_messaging"];

const THREADS_PUBLISH: &[&str] = &["threads_content_publish"];
const THREADS_ANALYTICS: &[&str] = &["threads_manage_insights"];
const THREADS_MANAGE_REPLIES: &[&str] = &["threads_manage_replies"];
const THREADS_DELETE: &[&str] = &["threads_delete"];

const TIKTOK_PUBLISH: &[&str] = &["video.publish"];
const TIKTOK_UPLOAD: &[&str] = &["video.upload"];
const TIKTOK_ANALYTICS: &[&str] = &["user.info.stats"];

const LINKEDIN_MEMBER_PUBLISH: &[&str] = &["w_member_social"];
const LINKEDIN_ORG_PUBLISH: &[&str] = &["w_organization_social"];
const LINKEDIN_MEMBER_ANALYTICS: &[&str] = &["r_member_postAnalytics"];
const LINKEDIN_MEMBER_COMMENTS: &[&str] = &["r_member_social"];
const LINKEDIN_ORG_ANALYTICS: &[&str] = &["r_organization_admin"];
const LINKEDIN_ORG_COMMENTS: &[&str] = &["r_organization_social"];

const X_PUBLISH: &[&str] = &["tweet.write"];
const X_MEDIA: &[&str] = &["media.write"];
const X_READ: &[&str] = &["tweet.read"];
const X_DM_READ: &[&str] = &["dm.read"];
const X_DM_WRITE: &[&str] = &["dm.write"];

const BLUESKY_POST: &[&str] = &["repo:app.bsky.feed.post"];
const BLUESKY_MEDIA: &[&str] = &["blob:*/*"];
const GOOGLE_EMAIL_READ: &[&str] = &["https://www.googleapis.com/auth/gmail.readonly"];
const GOOGLE_EMAIL_SEND: &[&str] = &["https://www.googleapis.com/auth/gmail.send"];
const MICROSOFT_EMAIL_READ: &[&str] = &["Mail.Read"];
const MICROSOFT_EMAIL_SEND: &[&str] = &["Mail.Send"];

pub(crate) fn adapter_for(
    provider: &str,
    auth_mode: Option<&str>,
    metadata: Option<&Value>,
) -> ProviderAdapter {
    match (provider.to_ascii_uppercase().as_str(), auth_mode) {
        ("FACEBOOK", _) => ProviderAdapter::MetaFacebook,
        ("INSTAGRAM", Some("instagram_login")) => ProviderAdapter::InstagramDirect,
        ("INSTAGRAM", _) => ProviderAdapter::MetaInstagram,
        ("WHATSAPP", _) => ProviderAdapter::WhatsApp,
        ("THREADS", _) => ProviderAdapter::Threads,
        ("TIKTOK", _) => ProviderAdapter::TikTok,
        ("LINKEDIN", _) if metadata_account_type(metadata) == Some("organization") => {
            ProviderAdapter::LinkedInOrganization
        }
        ("LINKEDIN", _) => ProviderAdapter::LinkedInMember,
        ("X", _) => ProviderAdapter::X,
        ("BLUESKY", _) => ProviderAdapter::Bluesky,
        ("GOOGLE", _) => ProviderAdapter::GoogleEmail,
        ("MICROSOFT", _) => ProviderAdapter::MicrosoftEmail,
        _ => ProviderAdapter::Unknown,
    }
}

fn metadata_account_type(metadata: Option<&Value>) -> Option<&str> {
    metadata
        .and_then(|value| value.get("accountType"))
        .and_then(Value::as_str)
}

impl ProviderAdapter {
    pub(crate) fn auth_mode(self) -> &'static str {
        match self {
            Self::MetaFacebook | Self::MetaInstagram => "meta_login",
            Self::InstagramDirect => "instagram_login",
            Self::WhatsApp => "whatsapp_embedded_signup",
            Self::Threads => "threads_oauth",
            Self::TikTok => "tiktok_oauth",
            Self::LinkedInMember | Self::LinkedInOrganization => "linkedin_oauth",
            Self::X => "x_oauth",
            Self::Bluesky => "bluesky_oauth",
            Self::GoogleEmail => "google_email_oauth",
            Self::MicrosoftEmail => "microsoft_email_oauth",
            Self::Unknown => "unknown",
        }
    }

    pub(crate) fn capability(self, key: &str) -> CapabilityRule {
        match self {
            Self::MetaFacebook => meta_rule(
                key,
                META_FACEBOOK_MESSAGING,
                META_FACEBOOK_PUBLISHING,
                META_FACEBOOK_ANALYTICS,
                META_FACEBOOK_COMMENTS,
            ),
            Self::MetaInstagram => match key {
                MESSAGING_INBOUND | MESSAGING_OUTBOUND => rule(
                    "instagram_manage_messages",
                    META_INSTAGRAM_MESSAGING,
                    META_INSTAGRAM_MESSAGING,
                    true,
                ),
                SOCIAL_PUBLISH => rule(
                    "instagram_content_publish",
                    META_INSTAGRAM_PUBLISHING,
                    META_INSTAGRAM_PUBLISHING,
                    true,
                ),
                MEDIA_PUBLISH => rule(
                    "instagram_content_publish",
                    META_INSTAGRAM_PUBLISHING,
                    META_INSTAGRAM_PUBLISHING,
                    true,
                ),
                SOCIAL_ANALYTICS => rule(
                    "instagram_manage_insights",
                    META_INSTAGRAM_ANALYTICS,
                    META_INSTAGRAM_ANALYTICS,
                    true,
                ),
                COMMENTS_MANAGE => rule(
                    "instagram_manage_comments",
                    META_INSTAGRAM_COMMENTS,
                    META_INSTAGRAM_COMMENTS,
                    true,
                ),
                SOCIAL_POST_DELETE => rule(
                    "instagram_manage_contents",
                    META_INSTAGRAM_CONTENT_MANAGEMENT,
                    META_INSTAGRAM_CONTENT_MANAGEMENT,
                    true,
                ),
                _ => unsupported(),
            },
            Self::InstagramDirect => match key {
                MESSAGING_INBOUND | MESSAGING_OUTBOUND => rule(
                    "instagram_business_manage_messages",
                    &["instagram_business_manage_messages"],
                    &["instagram_business_manage_messages"],
                    true,
                ),
                SOCIAL_PUBLISH => rule(
                    "instagram_business_content_publish",
                    &["instagram_business_content_publish"],
                    &["instagram_business_content_publish"],
                    true,
                ),
                MEDIA_PUBLISH => rule(
                    "instagram_business_content_publish",
                    &["instagram_business_content_publish"],
                    &["instagram_business_content_publish"],
                    true,
                ),
                SOCIAL_ANALYTICS => rule(
                    "instagram_business_manage_insights",
                    &["instagram_business_manage_insights"],
                    &["instagram_business_manage_insights"],
                    true,
                ),
                COMMENTS_MANAGE => rule(
                    "instagram_business_manage_comments",
                    &["instagram_business_manage_comments"],
                    &["instagram_business_manage_comments"],
                    true,
                ),
                SOCIAL_POST_DELETE => unsupported(),
                _ => unsupported(),
            },
            Self::WhatsApp => match key {
                // Embedded Signup requests a fixed Meta bundle. These are marked requestable so
                // the shared access action can reopen that guided flow, even though the provider
                // does not offer arbitrary per-scope checkboxes.
                MESSAGING_INBOUND | MESSAGING_OUTBOUND => rule_with_target_check(
                    "whatsapp_business_messaging",
                    WHATSAPP_MESSAGING,
                    WHATSAPP_CHAT,
                    true,
                ),
                MEDIA_PUBLISH => rule_with_target_check(
                    "whatsapp_business_management",
                    WHATSAPP_MANAGEMENT,
                    WHATSAPP_MANAGEMENT,
                    true,
                ),
                SOCIAL_ANALYTICS => unknown_supported(),
                SOCIAL_PUBLISH | COMMENTS_MANAGE | SOCIAL_POST_DELETE => unsupported(),
                _ => unsupported(),
            },
            Self::Threads => match key {
                SOCIAL_PUBLISH | MEDIA_PUBLISH => rule(
                    "threads_content_publish",
                    THREADS_PUBLISH,
                    THREADS_PUBLISH,
                    true,
                ),
                SOCIAL_ANALYTICS => rule(
                    "threads_manage_insights",
                    THREADS_ANALYTICS,
                    THREADS_ANALYTICS,
                    true,
                ),
                COMMENTS_MANAGE => rule(
                    "threads_manage_replies",
                    THREADS_MANAGE_REPLIES,
                    THREADS_MANAGE_REPLIES,
                    true,
                ),
                SOCIAL_POST_DELETE => rule("threads_delete", THREADS_DELETE, THREADS_DELETE, true),
                _ => unsupported(),
            },
            Self::TikTok => match key {
                SOCIAL_PUBLISH => rule("video.publish", TIKTOK_PUBLISH, TIKTOK_PUBLISH, true),
                MEDIA_PUBLISH => rule("video.upload", TIKTOK_UPLOAD, TIKTOK_UPLOAD, true),
                SOCIAL_ANALYTICS => {
                    rule("user.info.stats", TIKTOK_ANALYTICS, TIKTOK_ANALYTICS, true)
                }
                _ => unsupported(),
            },
            Self::LinkedInMember => match key {
                SOCIAL_PUBLISH | MEDIA_PUBLISH => rule(
                    "w_member_social",
                    LINKEDIN_MEMBER_PUBLISH,
                    LINKEDIN_MEMBER_PUBLISH,
                    true,
                ),
                SOCIAL_ANALYTICS => rule(
                    "r_member_postAnalytics",
                    LINKEDIN_MEMBER_ANALYTICS,
                    LINKEDIN_MEMBER_ANALYTICS,
                    true,
                ),
                COMMENTS_MANAGE => rule(
                    "r_member_social",
                    LINKEDIN_MEMBER_COMMENTS,
                    LINKEDIN_MEMBER_COMMENTS,
                    true,
                ),
                SOCIAL_POST_DELETE => unknown_supported(),
                _ => unsupported(),
            },
            Self::LinkedInOrganization => match key {
                SOCIAL_PUBLISH | MEDIA_PUBLISH => rule_with_target_check(
                    "w_organization_social",
                    LINKEDIN_ORG_PUBLISH,
                    LINKEDIN_ORG_PUBLISH,
                    true,
                ),
                SOCIAL_ANALYTICS => rule_with_target_check(
                    "r_organization_admin",
                    LINKEDIN_ORG_ANALYTICS,
                    LINKEDIN_ORG_ANALYTICS,
                    true,
                ),
                COMMENTS_MANAGE => rule_with_target_check(
                    "r_organization_social",
                    LINKEDIN_ORG_COMMENTS,
                    LINKEDIN_ORG_COMMENTS,
                    true,
                ),
                SOCIAL_POST_DELETE => unknown_supported(),
                _ => unsupported(),
            },
            Self::X => match key {
                MESSAGING_INBOUND => rule("dm.read", X_DM_READ, X_DM_READ, true),
                MESSAGING_OUTBOUND => rule("dm.write", X_DM_WRITE, X_DM_WRITE, true),
                SOCIAL_PUBLISH | SOCIAL_POST_DELETE | COMMENTS_MANAGE => {
                    rule("tweet.write", X_PUBLISH, X_PUBLISH, true)
                }
                MEDIA_PUBLISH => rule("media.write", X_MEDIA, X_MEDIA, true),
                SOCIAL_ANALYTICS => rule("tweet.read", X_READ, X_READ, true),
                _ => unsupported(),
            },
            Self::Bluesky => match key {
                SOCIAL_PUBLISH | SOCIAL_POST_DELETE => {
                    rule("repo:app.bsky.feed.post", BLUESKY_POST, BLUESKY_POST, true)
                }
                MEDIA_PUBLISH => rule("blob:*/*", BLUESKY_MEDIA, BLUESKY_MEDIA, true),
                _ => unsupported(),
            },
            Self::GoogleEmail => match key {
                EMAIL_INBOUND | EMAIL_READ => rule("https://www.googleapis.com/auth/gmail.readonly", GOOGLE_EMAIL_READ, GOOGLE_EMAIL_READ, false),
                EMAIL_OUTBOUND | EMAIL_REPLY => rule("https://www.googleapis.com/auth/gmail.send", GOOGLE_EMAIL_SEND, GOOGLE_EMAIL_SEND, false),
                _ => unsupported(),
            },
            Self::MicrosoftEmail => match key {
                EMAIL_INBOUND | EMAIL_READ => rule("Mail.Read", MICROSOFT_EMAIL_READ, MICROSOFT_EMAIL_READ, false),
                EMAIL_OUTBOUND | EMAIL_REPLY => rule("Mail.Send", MICROSOFT_EMAIL_SEND, MICROSOFT_EMAIL_SEND, false),
                _ => unsupported(),
            },
            Self::Unknown => unsupported(),
        }
    }

    pub(crate) fn required_scopes(
        self,
        requested: &[String],
        configured: Option<&str>,
    ) -> Vec<String> {
        let mut scopes = Vec::new();
        if let Some(configured) = configured {
            for scope in configured
                .split([',', ' '])
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if !scopes.iter().any(|item| item == scope) {
                    scopes.push(scope.to_string());
                }
            }
        }
        for capability in requested {
            for scope in self.capability(capability).request_scopes {
                if !scopes.iter().any(|item| item == scope) {
                    scopes.push((*scope).to_string());
                }
            }
        }
        if matches!(self, Self::MetaFacebook | Self::MetaInstagram) {
            let required = if matches!(self, Self::MetaInstagram) {
                META_INSTAGRAM_REQUIRED
            } else {
                META_FACEBOOK_REQUIRED
            };
            for scope in required {
                if !scopes.iter().any(|item| item == scope) {
                    scopes.push((*scope).to_string());
                }
            }
        }
        if matches!(
            self,
            Self::Threads | Self::TikTok | Self::LinkedInMember | Self::LinkedInOrganization
        ) && requested.is_empty()
            && scopes.is_empty()
        {
            return Vec::new();
        }
        scopes
    }

    pub(crate) fn provider_name(self) -> &'static str {
        match self {
            Self::MetaFacebook => "FACEBOOK",
            Self::MetaInstagram | Self::InstagramDirect => "INSTAGRAM",
            Self::WhatsApp => "WHATSAPP",
            Self::Threads => "THREADS",
            Self::TikTok => "TIKTOK",
            Self::LinkedInMember | Self::LinkedInOrganization => "LINKEDIN",
            Self::X => "X",
            Self::Bluesky => "BLUESKY",
            Self::GoogleEmail => "GOOGLE",
            Self::MicrosoftEmail => "MICROSOFT",
            Self::Unknown => "UNKNOWN",
        }
    }
}

fn meta_rule(
    key: &str,
    messaging: &'static [&'static str],
    publishing: &'static [&'static str],
    analytics: &'static [&'static str],
    comments: &'static [&'static str],
) -> CapabilityRule {
    match key {
        MESSAGING_INBOUND | MESSAGING_OUTBOUND => rule(
            messaging.first().copied().unwrap_or(""),
            messaging,
            messaging,
            true,
        ),
        SOCIAL_PUBLISH | MEDIA_PUBLISH => rule(
            publishing.first().copied().unwrap_or(""),
            publishing,
            publishing,
            true,
        ),
        SOCIAL_ANALYTICS => rule(
            analytics.first().copied().unwrap_or(""),
            analytics,
            analytics,
            true,
        ),
        COMMENTS_MANAGE => rule(
            comments.first().copied().unwrap_or(""),
            comments,
            comments,
            true,
        ),
        SOCIAL_POST_DELETE => rule(
            publishing.first().copied().unwrap_or(""),
            publishing,
            publishing,
            true,
        ),
        _ => unsupported(),
    }
}

fn rule(
    provider_permission: &'static str,
    grants: &'static [&'static str],
    request_scopes: &'static [&'static str],
    requestable: bool,
) -> CapabilityRule {
    CapabilityRule {
        supported: true,
        requestable,
        requires_target_check: false,
        provider_permission: (!provider_permission.is_empty()).then_some(provider_permission),
        grants,
        request_scopes,
    }
}

fn rule_with_target_check(
    provider_permission: &'static str,
    grants: &'static [&'static str],
    request_scopes: &'static [&'static str],
    requestable: bool,
) -> CapabilityRule {
    CapabilityRule {
        supported: true,
        requestable,
        requires_target_check: true,
        provider_permission: Some(provider_permission),
        grants,
        request_scopes,
    }
}

fn unknown_supported() -> CapabilityRule {
    CapabilityRule {
        supported: true,
        requestable: false,
        requires_target_check: true,
        provider_permission: None,
        grants: NONE,
        request_scopes: NONE,
    }
}

fn unsupported() -> CapabilityRule {
    CapabilityRule {
        supported: false,
        requestable: false,
        requires_target_check: false,
        provider_permission: None,
        grants: NONE,
        request_scopes: NONE,
    }
}

#[cfg(test)]
mod tests {
    use super::{adapter_for, ProviderAdapter};
    use crate::services::connection_permissions::{
        COMMENTS_MANAGE, MEDIA_PUBLISH, MESSAGING_INBOUND, MESSAGING_OUTBOUND, SOCIAL_ANALYTICS,
        SOCIAL_POST_DELETE, SOCIAL_PUBLISH,
    };
    use serde_json::json;

    #[test]
    fn selects_provider_specific_adapters() {
        assert_eq!(
            adapter_for("WHATSAPP", None, None),
            ProviderAdapter::WhatsApp
        );
        assert_eq!(
            adapter_for("INSTAGRAM", Some("instagram_login"), None),
            ProviderAdapter::InstagramDirect
        );
        assert_eq!(
            adapter_for(
                "LINKEDIN",
                None,
                Some(&json!({"accountType":"organization"}))
            ),
            ProviderAdapter::LinkedInOrganization
        );
    }

    #[test]
    fn fixed_setup_adapters_are_requestable_through_their_setup_flow() {
        let whatsapp = adapter_for("WHATSAPP", None, None).capability(MESSAGING_INBOUND);
        assert!(whatsapp.supported);
        assert!(whatsapp.requires_target_check);
        let bluesky = adapter_for("BLUESKY", None, None).capability(SOCIAL_PUBLISH);
        assert!(bluesky.supported);
        assert!(bluesky.requestable);
    }

    #[test]
    fn x_and_tiktok_have_product_level_publish_mappings() {
        assert_eq!(
            adapter_for("X", None, None)
                .capability(SOCIAL_PUBLISH)
                .provider_permission,
            Some("tweet.write")
        );
        assert_eq!(
            adapter_for("TIKTOK", None, None)
                .capability(SOCIAL_PUBLISH)
                .provider_permission,
            Some("video.publish")
        );
        assert_eq!(
            adapter_for("INSTAGRAM", Some("instagram_login"), None)
                .capability(SOCIAL_POST_DELETE)
                .supported,
            false
        );
    }

    #[test]
    fn every_expanded_provider_has_a_publish_adapter() {
        for provider in ["THREADS", "TIKTOK", "LINKEDIN", "X", "BLUESKY"] {
            let rule = adapter_for(provider, None, None).capability(SOCIAL_PUBLISH);
            assert!(rule.supported, "{provider} publish support is missing");
            assert!(
                rule.requestable,
                "{provider} publish request mapping is missing"
            );
            assert!(
                !rule.request_scopes.is_empty(),
                "{provider} publish scope is missing"
            );
        }
    }

    #[test]
    fn expanded_provider_mappings_keep_capabilities_distinct() {
        let threads = adapter_for("THREADS", None, None);
        assert_eq!(
            threads.capability(SOCIAL_PUBLISH).provider_permission,
            Some("threads_content_publish")
        );
        assert_eq!(
            threads.capability(COMMENTS_MANAGE).provider_permission,
            Some("threads_manage_replies")
        );

        let tiktok = adapter_for("TIKTOK", None, None);
        assert_eq!(
            tiktok.capability(MEDIA_PUBLISH).provider_permission,
            Some("video.upload")
        );
        assert_eq!(
            tiktok.capability(SOCIAL_ANALYTICS).provider_permission,
            Some("user.info.stats")
        );

        let linkedin = adapter_for(
            "LINKEDIN",
            None,
            Some(&json!({"accountType":"organization"})),
        );
        assert_eq!(
            linkedin.capability(SOCIAL_PUBLISH).provider_permission,
            Some("w_organization_social")
        );
        assert!(linkedin.capability(SOCIAL_ANALYTICS).requires_target_check);

        let x = adapter_for("X", None, None);
        assert_eq!(
            x.capability(MESSAGING_INBOUND).provider_permission,
            Some("dm.read")
        );
        assert_eq!(
            x.capability(MESSAGING_OUTBOUND).provider_permission,
            Some("dm.write")
        );

        let bluesky = adapter_for("BLUESKY", None, None);
        assert_eq!(
            bluesky.capability(MEDIA_PUBLISH).provider_permission,
            Some("blob:*/*")
        );
        assert_eq!(
            bluesky.capability(SOCIAL_POST_DELETE).provider_permission,
            Some("repo:app.bsky.feed.post")
        );
    }

    #[test]
    fn bluesky_delete_access_is_requestable_with_repository_post_scope() {
        let bluesky = adapter_for("BLUESKY", None, None);
        let delete = bluesky.capability(SOCIAL_POST_DELETE);

        assert!(delete.supported);
        assert!(delete.requestable);
        assert_eq!(delete.provider_permission, Some("repo:app.bsky.feed.post"));
        assert_eq!(delete.request_scopes, &["repo:app.bsky.feed.post"]);
    }

    #[test]
    fn bluesky_does_not_request_undeclared_chat_scopes() {
        let bluesky = adapter_for("BLUESKY", None, None);
        let inbound = bluesky.capability(MESSAGING_INBOUND);

        assert!(!inbound.supported);
        assert!(!inbound.requestable);
        assert!(bluesky
            .required_scopes(&[MESSAGING_INBOUND.to_string()], None)
            .is_empty());
    }

    #[test]
    fn threads_delete_access_is_requestable_with_its_provider_scope() {
        let threads = adapter_for("THREADS", None, None);
        let delete = threads.capability(SOCIAL_POST_DELETE);

        assert!(delete.supported);
        assert!(delete.requestable);
        assert_eq!(delete.provider_permission, Some("threads_delete"));
        assert_eq!(delete.request_scopes, &["threads_delete"]);
        assert_eq!(
            threads.required_scopes(&[SOCIAL_POST_DELETE.to_string()], None),
            vec!["threads_delete"]
        );
    }
}
