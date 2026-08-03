use ::config::{env_optional, env_string_or, env_u16_or, env_u32_or};
use actix_web::cookie::{Cookie, SameSite};
use std::env;

pub const USER_SESSION_COOKIE: &str = "kasitek_session";
pub const ADMIN_SESSION_COOKIE: &str = "kasitek_admin_session";

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub port: u16,
    pub environment: String,
    pub database_url: String,
    pub database_max_connections: u32,
    pub frontend_url: String,
    pub admin_frontend_url: String,
    pub public_api_url: String,
    pub auth_url: String,
    pub private_release_mode: bool,
    #[allow(dead_code)]
    pub session_secret: String,
    pub resend_api_key: Option<String>,
    pub resend_from_email: String,
    pub zoomconnect_send_url: Option<String>,
    pub kasitek_calls_url: Option<String>,
    pub n8n_api_url: Option<String>,
    pub n8n_api_key: Option<String>,
    pub n8n_callback_token: Option<String>,
    pub web_push_vapid_public_key: Option<String>,
    pub web_push_vapid_private_key: Option<String>,
    pub web_push_subject: String,
    pub paystack_secret_key: Option<String>,
    pub paystack_mode: String,
    pub paystack_api_base_url: String,
    pub twilio_account_sid: Option<String>,
    pub twilio_auth_token: Option<String>,
    pub twilio_api_key_sid: Option<String>,
    pub twilio_api_key_secret: Option<String>,
    pub twilio_twiml_app_sid: Option<String>,
    pub twilio_voice_webhook_url: Option<String>,
    pub twilio_browser_twiml_url: Option<String>,
    pub twilio_inbound_fallback_number: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, env::VarError> {
        let environment = env_string_or("ENVIRONMENT", "development");
        let frontend_url = env_string_or("FRONTEND_URL", "http://localhost:3000");
        let admin_frontend_url = env_optional("ADMIN_FRONTEND_URL").unwrap_or_else(|| {
            if environment.eq_ignore_ascii_case("production") {
                "https://admin.kasitek.co.za".to_string()
            } else {
                "http://localhost:3001".to_string()
            }
        });
        let public_api_url = env_string_or("KASITEK_CORE_PUBLIC_URL", "http://localhost:4000");
        let paystack_mode = if env_string_or("PAYSTACK_MODE", "test").eq_ignore_ascii_case("live") {
            "live".to_string()
        } else {
            "test".to_string()
        };
        let private_release_mode =
            !env_string_or("KASITEK_ACCESS_MODE", "private").eq_ignore_ascii_case("public");

        Ok(Self {
            port: env_u16_or("PORT", 4000),
            environment,
            database_url: env_optional("DATABASE_URL").ok_or(env::VarError::NotPresent)?,
            database_max_connections: env_u32_or("DATABASE_MAX_CONNECTIONS", 10),
            frontend_url: frontend_url.clone(),
            admin_frontend_url,
            public_api_url,
            auth_url: frontend_url,
            private_release_mode,
            session_secret: env_optional("SESSION_SECRET")
                .or_else(|| env_optional("AUTH_SECRET"))
                .unwrap_or_else(|| "kasitek-dev-session-secret".to_string()),
            resend_api_key: env_optional("AUTH_RESEND_KEY"),
            resend_from_email: env_string_or(
                "RESEND_FROM_EMAIL",
                "KasiTek <noreply@kasitek.co.za>",
            ),
            zoomconnect_send_url: env_optional("ZOOMCONNECT_SEND_URL"),
            kasitek_calls_url: env_optional("KASITEK_CALLS_URL"),
            n8n_api_url: env_optional("N8N_API_URL"),
            n8n_api_key: env_optional("N8N_API_KEY"),
            n8n_callback_token: env_optional("N8N_CALLBACK_TOKEN")
                .or_else(|| env_optional("N8N_PROVISIONER_TOKEN")),
            web_push_vapid_public_key: env_optional("WEB_PUSH_VAPID_PUBLIC_KEY"),
            web_push_vapid_private_key: env_optional("WEB_PUSH_VAPID_PRIVATE_KEY"),
            web_push_subject: env_string_or("WEB_PUSH_SUBJECT", "mailto:hello@kasitek.co.za"),
            paystack_secret_key: {
                if paystack_mode == "live" {
                    env_optional("PAYSTACK_LIVE_SECRET_KEY")
                } else {
                    env_optional("PAYSTACK_TEST_SECRET_KEY")
                }
                .or_else(|| env_optional("PAYSTACK_SECRET_KEY"))
            },
            paystack_mode,
            paystack_api_base_url: env_string_or(
                "PAYSTACK_API_BASE_URL",
                "https://api.paystack.co",
            ),
            twilio_account_sid: env_optional("TWILIO_ACCOUNT_SID"),
            twilio_auth_token: env_optional("TWILIO_AUTH_TOKEN"),
            twilio_api_key_sid: env_optional("TWILIO_API_KEY_SID"),
            twilio_api_key_secret: env_optional("TWILIO_API_KEY_SECRET"),
            twilio_twiml_app_sid: env_optional("TWILIO_TWIML_APP_SID"),
            twilio_voice_webhook_url: env_optional("TWILIO_VOICE_WEBHOOK_URL"),
            twilio_browser_twiml_url: env_optional("TWILIO_BROWSER_TWIML_URL"),
            twilio_inbound_fallback_number: env_optional("TWILIO_INBOUND_FALLBACK_NUMBER"),
        })
    }

    pub fn is_production(&self) -> bool {
        self.environment.eq_ignore_ascii_case("production")
    }

    pub fn web_push_configured(&self) -> bool {
        self.web_push_vapid_public_key.is_some() && self.web_push_vapid_private_key.is_some()
    }

    pub fn twilio_voice_configured(&self) -> bool {
        self.twilio_account_sid.is_some()
            && self.twilio_auth_token.is_some()
            && self.twilio_voice_webhook_url.is_some()
    }

    pub fn twilio_browser_configured(&self) -> bool {
        self.twilio_account_sid.is_some()
            && self.twilio_api_key_sid.is_some()
            && self.twilio_api_key_secret.is_some()
            && self.twilio_twiml_app_sid.is_some()
            && self.twilio_browser_twiml_url.is_some()
    }

    pub fn build_user_session_cookie(&self, value: &str) -> Cookie<'static> {
        self.build_cookie(USER_SESSION_COOKIE, value)
    }

    pub fn clear_user_session_cookie(&self) -> Cookie<'static> {
        self.clear_cookie(USER_SESSION_COOKIE)
    }

    pub fn build_admin_session_cookie(&self, value: &str) -> Cookie<'static> {
        self.build_cookie(ADMIN_SESSION_COOKIE, value)
    }

    pub fn clear_admin_session_cookie(&self) -> Cookie<'static> {
        self.clear_cookie(ADMIN_SESSION_COOKIE)
    }

    fn build_cookie(&self, name: &str, value: &str) -> Cookie<'static> {
        let mut cookie = Cookie::build(name.to_string(), value.to_string())
            .path("/")
            .http_only(true)
            .same_site(if self.is_production() {
                SameSite::None
            } else {
                SameSite::Lax
            })
            .secure(self.is_production())
            .finish();

        if let Ok(domain) = env::var("COOKIE_DOMAIN") {
            cookie.set_domain(domain);
        }

        cookie
    }

    fn clear_cookie(&self, name: &str) -> Cookie<'static> {
        let mut cookie = Cookie::build(name.to_string(), "")
            .path("/")
            .http_only(true)
            .same_site(if self.is_production() {
                SameSite::None
            } else {
                SameSite::Lax
            })
            .secure(self.is_production())
            .max_age(actix_web::cookie::time::Duration::seconds(0))
            .finish();

        if let Ok(domain) = env::var("COOKIE_DOMAIN") {
            cookie.set_domain(domain);
        }

        cookie
    }
}
