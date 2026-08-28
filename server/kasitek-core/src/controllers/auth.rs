use actix_web::{web, HttpRequest, HttpResponse};
use bcrypt::{hash, verify, DEFAULT_COST};
use rand::Rng;
use sqlx::PgPool;
use std::collections::HashMap;

use crate::config::AppConfig;
use crate::db::models::{
    AccountCheckRequest, LoginRequest, PasswordSetupRequest, ResendVerificationRequest,
    SendOtpRequest, SetPasswordRequest, SignupRequest, User, UserProfileResponse, VerifyOtpRequest,
};
use crate::error::AppError;
use crate::middleware::extract_user_allow_unverified;
use crate::services::auth::{
    create_session, delete_session, issue_verification_token, send_email, send_sms_message,
};
use crate::services::orgs;
use crate::services::referrals;

fn auth_server_base_url(config: &AppConfig) -> String {
    std::env::var("API_BASE_URL").unwrap_or_else(|_| config.public_api_url.clone())
}

fn invitation_required_redirect(config: &AppConfig) -> HttpResponse {
    HttpResponse::Found()
        .append_header((
            "Location",
            format!(
                "{}/auth-error?code=INVITE_REQUIRED",
                config.frontend_url.trim_end_matches('/')
            ),
        ))
        .finish()
}

fn google_redirect_uri(config: &AppConfig) -> String {
    format!("{}/api/auth/google/callback", auth_server_base_url(config))
}

fn referral_code_from_callback(callback_path: &str) -> Option<String> {
    callback_path
        .split_once('?')
        .and_then(|(_, query)| {
            query.split('&').find_map(|part| {
                let (key, value) = part.split_once('=')?;
                (key == "referralCode")
                    .then(|| {
                        urlencoding::decode(value)
                            .ok()
                            .map(|value| value.into_owned())
                    })
                    .flatten()
            })
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn send_account_verification_email(
    pool: &PgPool,
    config: &AppConfig,
    email: &str,
) -> Result<(), AppError> {
    let token = issue_verification_token(pool, email).await?;
    let verify_url = format!(
        "{}/api/auth/verify-email?token={}&email={}",
        auth_server_base_url(config),
        token,
        urlencoding::encode(email)
    );
    send_email(
        config,
        email,
        "Verify your KasiTek account",
        &format!("Welcome to KasiTek. Verify your email here: {}", verify_url),
    )
    .await
}

pub async fn signup(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<SignupRequest>,
) -> Result<HttpResponse, AppError> {
    if config.private_release_mode {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "KasiTek is currently available by invitation only.",
            "code": "SIGNUP_INVITE_ONLY"
        })));
    }

    let email = body.email.trim().to_lowercase();
    let password = body.password.trim();

    if email.is_empty() || password.is_empty() {
        return Err(AppError::BadRequest(
            "Email and password are required".to_string(),
        ));
    }

    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".to_string(),
        ));
    }

    if body.phone.as_ref().is_some() && body.phone_verified != Some(true) {
        return Err(AppError::BadRequest(
            "Phone number must be verified".to_string(),
        ));
    }

    let existing = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "User" WHERE lower(email) = lower($1)"#,
    )
    .bind(&email)
    .fetch_one(pool.get_ref())
    .await?;

    if existing > 0 {
        let email_verified = sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
            r#"SELECT "emailVerified" FROM "User" WHERE lower(email) = lower($1) LIMIT 1"#,
        )
        .bind(&email)
        .fetch_one(pool.get_ref())
        .await?;

        if email_verified.is_none() {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "error": "This account still needs email verification.",
                "code": "EMAIL_UNVERIFIED"
            })));
        }

        let has_google_account = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*)
            FROM "Account"
            WHERE provider = 'google'
              AND "userId" IN (
                SELECT id FROM "User" WHERE lower(email) = lower($1)
              )
            "#,
        )
        .bind(&email)
        .fetch_one(pool.get_ref())
        .await?
            > 0;

        let user_has_password = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT password FROM "User" WHERE lower(email) = lower($1) LIMIT 1"#,
        )
        .bind(&email)
        .fetch_one(pool.get_ref())
        .await?
        .is_some();

        if has_google_account && !user_has_password {
            let token = issue_verification_token(pool.get_ref(), &email).await?;
            let setup_url = format!(
                "{}/set-password?token={}&email={}",
                config.auth_url,
                token,
                urlencoding::encode(&email)
            );

            let _ = send_email(
                config.get_ref(),
                &email,
                "Set up a password for your KasiTek account",
                &format!(
                    "You already have a Google-linked KasiTek account. Set your password here: {}",
                    setup_url
                ),
            )
            .await;

            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "error": "An account with this email is linked to Google. Check your email to set up a password.",
                "code": "GOOGLE_ACCOUNT_EXISTS"
            })));
        }

        return Err(AppError::Conflict(
            "An account with this email already exists".to_string(),
        ));
    }

    let password_hash = hash(password, DEFAULT_COST)?;
    let user_id = cuid2::create_id();

    sqlx::query(
        r#"
        INSERT INTO "User" (id, email, name, password, phone, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        "#,
    )
    .bind(&user_id)
    .bind(&email)
    .bind(
        body.name
            .as_ref()
            .map(|value| value.trim())
            .filter(|v| !v.is_empty()),
    )
    .bind(&password_hash)
    .bind(
        body.phone
            .as_ref()
            .map(|value| value.trim())
            .filter(|v| !v.is_empty()),
    )
    .execute(pool.get_ref())
    .await?;

    // Auto-create personal organisation for new user
    let org_name = body
        .name
        .as_ref()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .map(|n| format!("{}'s Workspace", n))
        .unwrap_or_else(|| "My Workspace".to_string());
    let base_slug = orgs::slugify(&user_id);
    let created_org = orgs::create_org(
        pool.get_ref(),
        &user_id,
        &org_name,
        &base_slug,
        None,
        config.trial_credits,
        config.trial_duration_days,
    )
    .await;
    if let Ok(org) = created_org {
        if let Some(code) = body
            .referral_code
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let _ = referrals::attribute_referral(
                pool.get_ref(),
                &org.id,
                code,
                referrals::ReferralRewardConfig::from_config(config.get_ref()),
            )
            .await;
        }
    }

    let _ = send_account_verification_email(pool.get_ref(), config.get_ref(), &email).await;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "Account created. Check your email to verify.",
        "userId": user_id
    })))
}

pub async fn login(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<LoginRequest>,
) -> Result<HttpResponse, AppError> {
    let email = body.email.trim().to_lowercase();
    let password = body.password.trim();

    let user = sqlx::query_as::<_, User>(
        r#"
        SELECT
            id,
            name,
            email,
            phone,
            image,
            password,
            "emailVerified" AT TIME ZONE 'UTC' AS "emailVerified",
            "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
            "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "User"
        WHERE lower(email) = lower($1)
        LIMIT 1
        "#,
    )
    .bind(&email)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::Unauthorized)?;

    let hashed = user.password.clone().ok_or(AppError::Unauthorized)?;
    if !verify(password, &hashed)? {
        return Err(AppError::Unauthorized);
    }

    if user.email_verified.is_none() {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Verify your email before signing in.",
            "code": "EMAIL_UNVERIFIED"
        })));
    }

    let session_token = create_session(pool.get_ref(), &user.id).await?;

    Ok(HttpResponse::Ok()
        .cookie(config.build_user_session_cookie(&session_token))
        .json(serde_json::json!({ "user": UserProfileResponse::from(user) })))
}

pub async fn logout(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    if let Some(cookie) = req.cookie(crate::config::USER_SESSION_COOKIE) {
        delete_session(pool.get_ref(), cookie.value()).await?;
    }

    Ok(HttpResponse::Ok()
        .cookie(config.clear_user_session_cookie())
        .json(serde_json::json!({ "message": "Logged out" })))
}

pub async fn me(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user_allow_unverified(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "user": UserProfileResponse::from(user)
    })))
}

pub async fn start_google_oauth(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    query: web::Query<HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let client_id = std::env::var("GOOGLE_CLIENT_ID")
        .or_else(|_| std::env::var("AUTH_GOOGLE_ID"))
        .map_err(|_| AppError::Internal("Missing Google OAuth client id".to_string()))?;
    let callback_url = query
        .get("callbackUrl")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("/dashboard");
    let state = cuid2::create_id();
    let identifier = format!("google-oauth-state:{state}");
    sqlx::query(r#"DELETE FROM "VerificationToken" WHERE identifier = $1"#)
        .bind(&identifier)
        .execute(pool.get_ref())
        .await?;
    sqlx::query(
        r#"
        INSERT INTO "VerificationToken" (identifier, token, expires)
        VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
        "#,
    )
    .bind(&identifier)
    .bind(callback_url)
    .execute(pool.get_ref())
    .await?;

    let authorize_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&access_type=offline&prompt=consent",
        urlencoding::encode(&client_id),
        urlencoding::encode(&google_redirect_uri(config.get_ref())),
        urlencoding::encode("openid email profile"),
        urlencoding::encode(&state)
    );
    Ok(HttpResponse::Found()
        .append_header(("Location", authorize_url))
        .finish())
}

pub async fn google_oauth_callback(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    query: web::Query<HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let state = query
        .get("state")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing OAuth state".to_string()))?;
    let code = query
        .get("code")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing Google OAuth code".to_string()))?;
    let state_identifier = format!("google-oauth-state:{state}");
    let callback_path = sqlx::query_scalar::<_, String>(
        r#"
        DELETE FROM "VerificationToken"
        WHERE identifier = $1 AND expires > NOW()
        RETURNING token
        "#,
    )
    .bind(&state_identifier)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::BadRequest("Invalid or expired OAuth state".to_string()))?;

    let client_id = std::env::var("GOOGLE_CLIENT_ID")
        .or_else(|_| std::env::var("AUTH_GOOGLE_ID"))
        .map_err(|_| AppError::Internal("Missing Google OAuth client id".to_string()))?;
    let client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
        .or_else(|_| std::env::var("AUTH_GOOGLE_SECRET"))
        .map_err(|_| AppError::Internal("Missing Google OAuth client secret".to_string()))?;

    let token_response = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            (
                "redirect_uri",
                google_redirect_uri(config.get_ref()).as_str(),
            ),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await?;
    let token_payload = token_response.json::<serde_json::Value>().await?;
    let access_token = token_payload
        .get("access_token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::BadRequest("Google token exchange failed".to_string()))?;

    let profile_response = reqwest::Client::new()
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await?;
    let profile = profile_response.json::<serde_json::Value>().await?;
    let provider_user_id = profile
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::BadRequest("Google profile did not include id".to_string()))?;
    let email = profile
        .get("email")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Google profile did not include email".to_string()))?;
    let name = profile
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let image = profile
        .get("picture")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let existing_linked_user = sqlx::query_scalar::<_, String>(
        r#"SELECT "userId" FROM "Account" WHERE provider = 'google' AND "providerAccountId" = $1 LIMIT 1"#,
    )
    .bind(provider_user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let mut created_org_id = None;
    let user_id = if let Some(user_id) = existing_linked_user {
        sqlx::query(
            r#"
            UPDATE "User"
            SET name = COALESCE($1, name),
                email = COALESCE($2, email),
                image = COALESCE($3, image),
                "emailVerified" = COALESCE("emailVerified", NOW()),
                "updatedAt" = NOW()
            WHERE id = $4
            "#,
        )
        .bind(name)
        .bind(&email)
        .bind(image)
        .bind(&user_id)
        .execute(pool.get_ref())
        .await?;
        user_id
    } else {
        let existing_user = sqlx::query_as::<_, (String, bool)>(
            r#"SELECT id, password IS NOT NULL
               FROM "User" WHERE lower(email) = lower($1) LIMIT 1"#,
        )
        .bind(&email)
        .fetch_optional(pool.get_ref())
        .await?;
        let user_id = if let Some((existing_user_id, has_password)) = existing_user {
            if config.private_release_mode && !has_password {
                let has_membership = sqlx::query_scalar::<_, bool>(
                    r#"SELECT EXISTS(
                         SELECT 1 FROM "OrganizationMember" WHERE "userId" = $1
                       )"#,
                )
                .bind(&existing_user_id)
                .fetch_one(pool.get_ref())
                .await?;
                let has_pending_invitation = sqlx::query_scalar::<_, bool>(
                    r#"SELECT EXISTS(
                         SELECT 1 FROM "OrganizationInvitation"
                         WHERE lower(email) = lower($1)
                           AND "acceptedAt" IS NULL
                           AND "revokedAt" IS NULL
                           AND "expiresAt" > NOW()
                       )"#,
                )
                .bind(&email)
                .fetch_one(pool.get_ref())
                .await?;

                if !has_membership && !has_pending_invitation {
                    observability::tracing::warn!(
                        event = "auth.google.denied",
                        provider = "google",
                        reason = "invitation_required",
                        "new Google account rejected while KasiTek is invite-only"
                    );
                    return Ok(invitation_required_redirect(config.get_ref()));
                }
            }

            sqlx::query(
                r#"
                UPDATE "User"
                SET name = COALESCE($1, name),
                    image = COALESCE($2, image),
                    "emailVerified" = COALESCE("emailVerified", NOW()),
                    "updatedAt" = NOW()
                WHERE id = $3
                "#,
            )
            .bind(name)
            .bind(image)
            .bind(&existing_user_id)
            .execute(pool.get_ref())
            .await?;
            existing_user_id
        } else {
            if config.private_release_mode {
                observability::tracing::warn!(
                    event = "auth.google.denied",
                    provider = "google",
                    reason = "invitation_required",
                    "new Google account rejected while KasiTek is invite-only"
                );
                return Ok(invitation_required_redirect(config.get_ref()));
            }

            let new_user_id = cuid2::create_id();
            sqlx::query(
                r#"
                INSERT INTO "User" (id, name, email, image, "emailVerified", "createdAt", "updatedAt")
                VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
                "#,
            )
            .bind(&new_user_id)
            .bind(name)
            .bind(&email)
            .bind(image)
            .execute(pool.get_ref())
            .await?;

            // Public signup mode creates a personal organisation for new Google users.
            let org_name = name
                .filter(|n| !n.is_empty())
                .map(|n| format!("{}'s Workspace", n))
                .unwrap_or_else(|| "My Workspace".to_string());
            let base_slug = orgs::slugify(&new_user_id);
            if let Ok(org) = orgs::create_org(
                pool.get_ref(),
                &new_user_id,
                &org_name,
                &base_slug,
                None,
                config.trial_credits,
                config.trial_duration_days,
            )
            .await
            {
                created_org_id = Some(org.id);
            }

            new_user_id
        };

        sqlx::query(
            r#"
            INSERT INTO "Account" (
                id, "userId", type, provider, "providerAccountId", access_token, token_type, scope
            )
            VALUES ($1, $2, 'oauth', 'google', $3, $4, 'Bearer', 'openid email profile')
            ON CONFLICT (provider, "providerAccountId")
            DO UPDATE SET
                "userId" = EXCLUDED."userId",
                access_token = EXCLUDED.access_token,
                token_type = EXCLUDED.token_type,
                scope = EXCLUDED.scope
            "#,
        )
        .bind(cuid2::create_id())
        .bind(&user_id)
        .bind(provider_user_id)
        .bind(access_token)
        .execute(pool.get_ref())
        .await?;
        user_id
    };

    if let Some(org_id) = created_org_id {
        if let Some(code) = referral_code_from_callback(&callback_path) {
            let _ = referrals::attribute_referral(
                pool.get_ref(),
                &org_id,
                &code,
                referrals::ReferralRewardConfig::from_config(config.get_ref()),
            )
            .await;
        }
    }

    let session_token = create_session(pool.get_ref(), &user_id).await?;
    let target = if callback_path.starts_with("http://") || callback_path.starts_with("https://") {
        callback_path
    } else {
        format!(
            "{}{}",
            config.frontend_url.trim_end_matches('/'),
            callback_path
        )
    };
    Ok(HttpResponse::Found()
        .cookie(config.build_user_session_cookie(&session_token))
        .append_header(("Location", target))
        .finish())
}

pub async fn account_check(
    pool: web::Data<PgPool>,
    body: web::Json<AccountCheckRequest>,
) -> Result<HttpResponse, AppError> {
    let Some(email) = body.email.as_ref().map(|value| value.trim().to_lowercase()) else {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "provider": null })));
    };

    if email.is_empty() {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "provider": null })));
    }

    let user = sqlx::query_as::<_, User>(
        r#"
        SELECT
            id,
            name,
            email,
            phone,
            image,
            password,
            "emailVerified" AT TIME ZONE 'UTC' AS "emailVerified",
            "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
            "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "User"
        WHERE lower(email) = lower($1)
        LIMIT 1
        "#,
    )
    .bind(&email)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(user) = user else {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "provider": null })));
    };

    let google_accounts = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "Account" WHERE "userId" = $1 AND provider = 'google'"#,
    )
    .bind(&user.id)
    .fetch_one(pool.get_ref())
    .await?;

    let provider = match (google_accounts > 0, user.password.is_some()) {
        (true, true) => Some("both"),
        (true, false) => Some("google"),
        (false, true) => Some("credentials"),
        (false, false) => None,
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({ "provider": provider })))
}

pub async fn resend_verification(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<ResendVerificationRequest>,
) -> Result<HttpResponse, AppError> {
    let email = body
        .email
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());

    if let Some(email) = email {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, name, email, phone, image, password,
                   "emailVerified" AT TIME ZONE 'UTC' AS "emailVerified",
                   "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                   "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
            FROM "User"
            WHERE lower(email) = lower($1)
            LIMIT 1
            "#,
        )
        .bind(&email)
        .fetch_optional(pool.get_ref())
        .await?;

        if user.is_some_and(|user| user.email_verified.is_none()) {
            send_account_verification_email(pool.get_ref(), config.get_ref(), &email).await?;
        }
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "If this account needs verification, we sent a new verification link."
    })))
}

pub async fn send_otp(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<SendOtpRequest>,
) -> Result<HttpResponse, AppError> {
    let phone = body
        .phone
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Phone number is required".to_string()))?;

    let code = format!("{:06}", rand::thread_rng().gen_range(0..=999999));
    let identifier = format!("phone:{phone}");

    sqlx::query(r#"DELETE FROM "VerificationToken" WHERE identifier = $1"#)
        .bind(&identifier)
        .execute(pool.get_ref())
        .await?;

    sqlx::query(
        r#"
        INSERT INTO "VerificationToken" (identifier, token, expires)
        VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
        "#,
    )
    .bind(&identifier)
    .bind(&code)
    .execute(pool.get_ref())
    .await?;

    send_sms_message(
        config.get_ref(),
        &phone,
        &format!("Your KasiTek verification code is: {code}"),
    )
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "OTP sent" })))
}

pub async fn verify_otp(
    pool: web::Data<PgPool>,
    body: web::Json<VerifyOtpRequest>,
) -> Result<HttpResponse, AppError> {
    let phone = body
        .phone
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Phone number and code are required".to_string()))?;
    let code = body
        .code
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Phone number and code are required".to_string()))?;

    let deleted = sqlx::query(
        r#"
        DELETE FROM "VerificationToken"
        WHERE identifier = $1
          AND token = $2
          AND expires > NOW()
        "#,
    )
    .bind(format!("phone:{phone}"))
    .bind(code)
    .execute(pool.get_ref())
    .await?;

    if deleted.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "Invalid or expired code. Please try again.".to_string(),
        ));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "verified": true })))
}

pub async fn verify_email(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let token = query
        .get("token")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing token".to_string()))?;
    let email = query
        .get("email")
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing email".to_string()))?;

    let deleted = sqlx::query(
        r#"
        DELETE FROM "VerificationToken"
        WHERE identifier = $1
          AND token = $2
          AND expires > NOW()
        "#,
    )
    .bind(&email)
    .bind(&token)
    .execute(pool.get_ref())
    .await?;

    if deleted.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "Invalid or expired verification token".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE "User"
        SET "emailVerified" = NOW(), "updatedAt" = NOW()
        WHERE lower(email) = lower($1)
        "#,
    )
    .bind(&email)
    .execute(pool.get_ref())
    .await?;

    sqlx::query(
        r#"DELETE FROM "Session" WHERE "userId" IN (
            SELECT id FROM "User" WHERE lower(email) = lower($1)
        )"#,
    )
    .bind(&email)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Found()
        .cookie(config.clear_user_session_cookie())
        .append_header((
            "Location",
            format!(
                "{}/verify-request?verified=true&email={}",
                config.frontend_url.trim_end_matches('/'),
                urlencoding::encode(&email)
            ),
        ))
        .finish())
}

pub async fn request_password_setup(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<PasswordSetupRequest>,
) -> Result<HttpResponse, AppError> {
    let email = body
        .email
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Email is required".to_string()))?;

    let exists = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "User" WHERE lower(email) = lower($1)"#,
    )
    .bind(&email)
    .fetch_one(pool.get_ref())
    .await?;

    if exists == 0 {
        return Err(AppError::NotFound("User not found".to_string()));
    }

    let token = issue_verification_token(pool.get_ref(), &email).await?;
    let setup_url = format!(
        "{}/set-password?token={}&email={}",
        config.auth_url,
        token,
        urlencoding::encode(&email)
    );

    let _ = send_email(
        config.get_ref(),
        &email,
        "Set up your KasiTek password",
        &format!("Use this link to set your password: {}", setup_url),
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "Password setup email sent"
    })))
}

pub async fn set_password(
    pool: web::Data<PgPool>,
    body: web::Json<SetPasswordRequest>,
) -> Result<HttpResponse, AppError> {
    let email = body
        .email
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Email is required".to_string()))?;
    let token = body
        .token
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Token is required".to_string()))?;
    let password = body
        .password
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Password is required".to_string()))?;

    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".to_string(),
        ));
    }

    let deleted = sqlx::query(
        r#"
        DELETE FROM "VerificationToken"
        WHERE identifier = $1
          AND token = $2
          AND expires > NOW()
        "#,
    )
    .bind(&email)
    .bind(&token)
    .execute(pool.get_ref())
    .await?;

    if deleted.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "Invalid or expired password setup token".to_string(),
        ));
    }

    let password_hash = hash(password, DEFAULT_COST)?;
    sqlx::query(
        r#"
        UPDATE "User"
        SET password = $1, "updatedAt" = NOW()
        WHERE lower(email) = lower($2)
        "#,
    )
    .bind(password_hash)
    .bind(email)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "Password updated"
    })))
}
