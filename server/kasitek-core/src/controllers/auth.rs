//! Human authentication is owned by Labs Keycloak; Growth owns opaque product sessions.
use crate::{
    config::AppConfig, db::models::UserProfileResponse, error::AppError, middleware::extract_user,
};
use actix_web::{
    cookie::{Cookie, SameSite},
    web, HttpRequest, HttpResponse,
};
use openidconnect::{
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce, OAuth2TokenResponse,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
};
use serde::Deserialize;
use sqlx::PgPool;

pub(crate) fn setting(name: &str) -> Result<String, AppError> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::ServiceUnavailable(format!("{name} is not configured")))
}
pub(crate) fn http() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| AppError::ServiceUnavailable("Identity connection unavailable".into()))
}
fn provider_error(_: impl std::fmt::Debug) -> AppError {
    AppError::ServiceUnavailable("Shared login is unavailable".into())
}
fn rejected(_: impl std::fmt::Debug) -> AppError {
    AppError::Unauthorized
}
fn transaction_cookie(value: &str, config: &AppConfig) -> Cookie<'static> {
    Cookie::build("kasitek_login", value.to_owned())
        .path("/api/auth")
        .http_only(true)
        .secure(config.is_production())
        .same_site(SameSite::Lax)
        .max_age(actix_web::cookie::time::Duration::minutes(10))
        .finish()
}
pub fn safe_return_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}
#[derive(Deserialize)]
pub struct LoginQuery {
    #[serde(rename = "returnTo")]
    return_to: Option<String>,
    screen: Option<String>,
}
pub async fn login(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    query: web::Query<LoginQuery>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let return_to = query.return_to.as_deref().unwrap_or("/");
    if !safe_return_path(return_to) {
        return Err(AppError::BadRequest("Invalid return path".into()));
    }
    let issuer = IssuerUrl::new(setting("OIDC_ISSUER_URL")?).map_err(provider_error)?;
    let http = http()?;
    let metadata = CoreProviderMetadata::discover_async(issuer, &http)
        .await
        .map_err(provider_error)?;
    let client = CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(setting("OIDC_CLIENT_ID")?),
        Some(ClientSecret::new(setting("OIDC_CLIENT_SECRET")?)),
    )
    .set_redirect_uri(RedirectUrl::new(setting("OIDC_REDIRECT_URI")?).map_err(provider_error)?);
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let force_login = if let Some(cookie) = req.cookie(crate::config::USER_SESSION_COOKIE) {
        !sqlx::query_scalar::<_,bool>(r#"SELECT EXISTS(SELECT 1 FROM "Session" WHERE "sessionToken"=$1 AND expires>NOW() AND "lastActivityAt">NOW()-INTERVAL '7 days')"#).bind(crypto_utils::sha256_hex(cookie.value())).fetch_one(pool.get_ref()).await?
    } else {
        false
    };
    let mut request = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("email".into()))
        .add_scope(Scope::new("profile".into()))
        .set_pkce_challenge(challenge)
        .add_extra_param("max_age", "2592000");
    if force_login {
        request = request.add_extra_param("prompt", "login");
    }
    let (mut url, state, nonce) = request.url();
    if query.screen.as_deref() == Some("signup") {
        let path = url.path().strip_suffix("/auth").ok_or_else(|| {
            AppError::ServiceUnavailable("Unsupported registration endpoint".into())
        })?;
        url.set_path(&format!("{path}/registrations"));
    }
    let browser = CsrfToken::new_random().secret().to_owned();
    sqlx::query(r#"DELETE FROM "OidcTransaction" WHERE expires<NOW()"#)
        .execute(pool.get_ref())
        .await?;
    sqlx::query(r#"INSERT INTO "OidcTransaction" (state, "browserHash", nonce, verifier, "returnTo", expires) VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes')"#).bind(crypto_utils::sha256_hex(state.secret())).bind(crypto_utils::sha256_hex(&browser)).bind(nonce.secret()).bind(verifier.secret()).bind(return_to).execute(pool.get_ref()).await?;
    Ok(HttpResponse::Found()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(transaction_cookie(&browser, &config))
        .append_header(("Location", url.as_str()))
        .finish())
}
#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}
pub async fn callback(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<CallbackQuery>,
) -> HttpResponse {
    match callback_impl(pool, config.clone(), req, query).await {
        Ok(response) => response,
        Err(error) => {
            let code = if matches!(error, AppError::ServiceUnavailable(_)) {
                "IDENTITY_UNAVAILABLE"
            } else {
                "LOGIN_FAILED"
            };
            observability::tracing::warn!(
                event = "auth.callback.failed",
                error_code = code,
                "Shared login callback failed"
            );
            let mut clear = transaction_cookie("", &config);
            clear.make_removal();
            HttpResponse::Found()
                .cookie(clear)
                .insert_header(("Cache-Control", "no-store"))
                .append_header((
                    "Location",
                    format!(
                        "{}/auth-error?code={code}",
                        config.frontend_url.trim_end_matches('/')
                    ),
                ))
                .finish()
        }
    }
}
fn callback_denied(stage: &'static str) -> AppError {
    observability::tracing::warn!(
        event = "auth.callback.denied",
        stage,
        "Shared login callback rejected"
    );
    AppError::Unauthorized
}
async fn callback_impl(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<CallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let state = query
        .state
        .as_ref()
        .ok_or_else(|| callback_denied("missing_state"))?;
    let browser = req
        .cookie("kasitek_login")
        .ok_or_else(|| callback_denied("missing_browser_cookie"))?;
    let tx=sqlx::query_as::<_,(String,String,String)>(r#"DELETE FROM "OidcTransaction" WHERE state=$1 AND "browserHash"=$2 AND expires>NOW() RETURNING nonce,verifier,"returnTo""#).bind(crypto_utils::sha256_hex(state)).bind(crypto_utils::sha256_hex(browser.value())).fetch_optional(pool.get_ref()).await?.ok_or_else(||callback_denied("missing_transaction"))?;
    if query.error.is_some() {
        return Ok(HttpResponse::Found()
            .insert_header(("Cache-Control", "no-store"))
            .append_header((
                "Location",
                format!(
                    "{}/auth-error?code=LOGIN_CANCELLED",
                    config.frontend_url.trim_end_matches('/')
                ),
            ))
            .finish());
    }
    let http = http()?;
    let issuer = setting("OIDC_ISSUER_URL")?;
    let metadata = CoreProviderMetadata::discover_async(
        IssuerUrl::new(issuer.clone()).map_err(provider_error)?,
        &http,
    )
    .await
    .map_err(provider_error)?;
    let client = CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(setting("OIDC_CLIENT_ID")?),
        Some(ClientSecret::new(setting("OIDC_CLIENT_SECRET")?)),
    )
    .set_redirect_uri(RedirectUrl::new(setting("OIDC_REDIRECT_URI")?).map_err(provider_error)?);
    let tokens = client
        .exchange_code(AuthorizationCode::new(
            query.code.clone().ok_or(AppError::Unauthorized)?,
        ))
        .map_err(provider_error)?
        .set_pkce_verifier(PkceCodeVerifier::new(tx.1))
        .request_async(&http)
        .await
        .map_err(|_| callback_denied("code_exchange"))?;
    let id = tokens
        .id_token()
        .ok_or_else(|| callback_denied("missing_id_token"))?;
    let claims = id
        .claims(&client.id_token_verifier(), &Nonce::new(tx.0))
        .map_err(|err| {
            let reason = match err {
                openidconnect::ClaimsVerificationError::InvalidNonce(_) => "invalid_nonce",
                openidconnect::ClaimsVerificationError::InvalidIssuer(_) => "invalid_issuer",
                openidconnect::ClaimsVerificationError::InvalidAudience(_) => "invalid_audience",
                openidconnect::ClaimsVerificationError::SignatureVerification(_) => {
                    "invalid_signature"
                }
                _ => "invalid_claims",
            };
            callback_denied(reason)
        })?;
    if let Some(expected) = claims.access_token_hash() {
        let verifier = client.id_token_verifier();
        let actual = openidconnect::AccessTokenHash::from_token(
            tokens.access_token(),
            id.signing_alg().map_err(rejected)?,
            id.signing_key(&verifier).map_err(rejected)?,
        )
        .map_err(rejected)?;
        if actual != *expected {
            return Err(AppError::Unauthorized);
        }
    }
    if claims.email_verified() != Some(true) {
        return Err(AppError::Forbidden("Verify your email to continue".into()));
    }
    let absolute_expires = authentication_deadline(claims.auth_time(), chrono::Utc::now())?;
    let subject = claims.subject().as_str();
    let email = claims
        .email()
        .ok_or_else(|| callback_denied("missing_email"))?
        .as_str();
    let name = claims
        .name()
        .and_then(|names| names.get(None))
        .map(|name| name.as_str());
    let mut db = pool.begin().await?;
    // Serialize first-use provisioning for this identity; emails never establish identity.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{issuer}:{subject}"))
        .execute(&mut *db)
        .await?;
    let existing = sqlx::query_scalar::<_, String>(
        r#"SELECT "userId" FROM "ExternalIdentity" WHERE issuer=$1 AND subject=$2"#,
    )
    .bind(&issuer)
    .bind(subject)
    .fetch_optional(&mut *db)
    .await?;
    let user_id = if let Some(id) = existing {
        id
    } else {
        let id = cuid2::create_id();
        // A conflicting email is rejected, never silently linked to an existing user.
        sqlx::query(r#"INSERT INTO "User" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,NOW(),NOW(),NOW())"#).bind(&id).bind(name).bind(email).execute(&mut *db).await.map_err(|_|AppError::Conflict("This email belongs to another identity; manage login methods in your existing account".into()))?;
        sqlx::query(
            r#"INSERT INTO "ExternalIdentity" (issuer,subject,"userId") VALUES ($1,$2,$3)"#,
        )
        .bind(&issuer)
        .bind(subject)
        .bind(&id)
        .execute(&mut *db)
        .await?;
        id
    };
    sqlx::query(
        r#"UPDATE "User" SET email=$2, "emailVerified"=NOW(), "updatedAt"=NOW() WHERE id=$1"#,
    )
    .bind(&user_id)
    .bind(email)
    .execute(&mut *db)
    .await
    .map_err(|_| AppError::Conflict("Email is already used by another identity".into()))?;
    let token = CsrfToken::new_random().secret().to_owned();
    let sid: Option<String> =
        serde_json::from_str::<serde_json::Value>(&decode_payload(&id.to_string())?)
            .ok()
            .and_then(|v| v.get("sid").and_then(|s| s.as_str()).map(str::to_owned));
    sqlx::query(r#"INSERT INTO "Session" (id,"sessionToken","userId",expires,"lastActivityAt","identityCheckedAt","refreshToken","idToken","providerSid") VALUES ($1,$2,$3,$7,NOW(),NOW(),$4,$5,$6)"#).bind(cuid2::create_id()).bind(crypto_utils::sha256_hex(&token)).bind(&user_id).bind(tokens.refresh_token().ok_or_else(||callback_denied("missing_refresh_token"))?.secret()).bind(id.to_string()).bind(sid).bind(absolute_expires).execute(&mut *db).await?;
    db.commit().await?;
    observability::tracing::info!(event="auth.login.success",user_id=%user_id,"Shared login completed");
    let mut clear = transaction_cookie("", &config);
    clear.make_removal();
    Ok(HttpResponse::Found()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(config.build_user_session_cookie(&token))
        .cookie(clear)
        .append_header((
            "Location",
            format!("{}{}", config.frontend_url.trim_end_matches('/'), tx.2),
        ))
        .finish())
}
fn authentication_deadline(
    authenticated_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<chrono::DateTime<chrono::Utc>, AppError> {
    let authenticated_at = authenticated_at.ok_or_else(|| callback_denied("missing_auth_time"))?;
    let expires = authenticated_at + chrono::Duration::days(30);
    if expires <= now || authenticated_at > now + chrono::Duration::seconds(30) {
        return Err(callback_denied("invalid_auth_time"));
    }
    Ok(expires)
}
fn decode_payload(token: &str) -> Result<String, AppError> {
    use base64::Engine;
    String::from_utf8(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(token.split('.').nth(1).ok_or(AppError::Unauthorized)?)
            .map_err(rejected)?,
    )
    .map_err(rejected)
}
pub async fn me(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, &pool).await?;
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(serde_json::json!({"user":UserProfileResponse::from(user)})))
}
pub fn require_origin(req: &HttpRequest, config: &AppConfig) -> Result<(), AppError> {
    require_request_origin(req, &config.frontend_url)
}
fn require_request_origin(req: &HttpRequest, frontend_url: &str) -> Result<(), AppError> {
    let expected = url::Url::parse(frontend_url)
        .map_err(provider_error)?
        .origin()
        .ascii_serialization();
    if req.headers().get("Origin").and_then(|h| h.to_str().ok()) != Some(expected.as_str()) {
        return Err(AppError::Forbidden("Invalid request origin".into()));
    }
    Ok(())
}
pub async fn account(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    extract_user(&req, &pool).await?;
    Ok(HttpResponse::Found()
        .insert_header(("Cache-Control", "no-store"))
        .append_header((
            "Location",
            format!(
                "{}/account/",
                setting("OIDC_ISSUER_URL")?.trim_end_matches('/')
            ),
        ))
        .finish())
}
async fn logout_impl(
    pool: &PgPool,
    config: &AppConfig,
    req: &HttpRequest,
    all: bool,
) -> Result<HttpResponse, AppError> {
    require_origin(req, config)?;
    let cookie = req
        .cookie(crate::config::USER_SESSION_COOKIE)
        .ok_or(AppError::Unauthorized)?;
    let token = crypto_utils::sha256_hex(cookie.value());
    let row = sqlx::query_as::<_, (String, String)>(
        r#"SELECT "userId", "idToken" FROM "Session" WHERE "sessionToken"=$1"#,
    )
    .bind(&token)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    if all {
        crate::services::identity::logout_all(pool, &row.0).await?;
    } else {
        sqlx::query(r#"DELETE FROM "Session" WHERE "sessionToken"=$1"#)
            .bind(token)
            .execute(pool)
            .await?;
    }
    let mut redirect = url::Url::parse(&format!(
        "{}/protocol/openid-connect/logout",
        setting("OIDC_ISSUER_URL")?.trim_end_matches('/')
    ))
    .map_err(provider_error)?;
    redirect
        .query_pairs_mut()
        .append_pair("id_token_hint", &row.1)
        .append_pair("client_id", &setting("OIDC_CLIENT_ID")?)
        .append_pair(
            "post_logout_redirect_uri",
            &format!("{}/login", config.frontend_url.trim_end_matches('/')),
        );
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .cookie(config.clear_user_session_cookie())
        .json(serde_json::json!({"redirectUrl":redirect.as_str()})))
}
pub async fn logout(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    logout_impl(&pool, &config, &req, false).await
}
pub async fn logout_all(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    logout_impl(&pool, &config, &req, true).await
}
#[derive(Deserialize)]
pub struct LogoutForm {
    logout_token: String,
}
pub async fn backchannel_logout(
    pool: web::Data<PgPool>,
    form: web::Form<LogoutForm>,
) -> Result<HttpResponse, AppError> {
    crate::services::identity::backchannel_logout(&pool, &form.logout_token).await?;
    Ok(HttpResponse::Ok().finish())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn return_paths_cannot_escape_origin() {
        for bad in ["//evil.test", "https://evil.test", "/\\evil.test", "/\nfoo"] {
            assert!(!safe_return_path(bad));
        }
        assert!(safe_return_path("/invitations/abc?tab=team"));
    }
}

pub async fn activity(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    require_origin(&req, &config)?;
    extract_user(&req, &pool).await?;
    Ok(HttpResponse::NoContent().finish())
}

#[cfg(test)]
mod origin_tests {
    use super::*;
    #[test]
    fn cookie_mutations_require_the_exact_browser_origin() {
        use actix_web::test::TestRequest;
        let origin = "https://growth.example";
        let good = TestRequest::default()
            .insert_header(("Origin", origin))
            .to_http_request();
        assert!(require_request_origin(&good, origin).is_ok());
        for bad in [
            "https://attacker.example",
            "null",
            "https://growth.example.attacker.test",
            "http://growth.example",
        ] {
            let req = TestRequest::default()
                .insert_header(("Origin", bad))
                .to_http_request();
            assert!(require_request_origin(&req, origin).is_err());
        }
        assert!(require_request_origin(&TestRequest::default().to_http_request(), origin).is_err());
    }
}

#[cfg(test)]
mod cookie_tests {
    #[test]
    fn product_cookie_is_host_only_http_only_and_secure_in_production() {
        let cookie = crate::config::build_product_session_cookie("opaque", true);
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.same_site(), Some(actix_web::cookie::SameSite::Lax));
        assert_eq!(cookie.domain(), None);
        assert_eq!(cookie.max_age().unwrap().whole_days(), 30);
    }
}

#[cfg(test)]
mod authentication_age_tests {
    use super::*;
    #[test]
    fn signed_authentication_time_is_required_and_absolute_age_cannot_reset() {
        let now = chrono::Utc::now();
        assert!(authentication_deadline(None, now).is_err());
        assert!(authentication_deadline(Some(now - chrono::Duration::days(30)), now).is_err());
        assert!(authentication_deadline(Some(now + chrono::Duration::minutes(1)), now).is_err());
        let original = now - chrono::Duration::days(20);
        assert_eq!(
            authentication_deadline(Some(original), now).unwrap(),
            original + chrono::Duration::days(30)
        );
    }
}
