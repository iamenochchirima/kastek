//! Provider revocation checks are bounded and fail closed; background polls do not renew idle activity.
use crate::{
    controllers::auth::{http, setting},
    error::AppError,
};
use actix_web::HttpRequest;
use serde::Deserialize;
use sqlx::PgPool;
fn unavailable(_: impl std::fmt::Debug) -> AppError {
    AppError::ServiceUnavailable("Shared identity verification unavailable".into())
}
pub async fn check_session(
    pool: &PgPool,
    token: &str,
    req: &HttpRequest,
) -> Result<String, AppError> {
    let mut tx = pool.begin().await?;
    let seconds = std::env::var("OIDC_REVOCATION_CHECK_SECONDS")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(300.0)
        .clamp(1.0, 300.0);
    let session=sqlx::query_as::<_,(String,String,bool,bool)>(r#"SELECT "userId","refreshToken", "identityCheckedAt" < NOW()- make_interval(secs=>$2), "providerRefreshedAt" < NOW()- make_interval(secs=>$2) FROM "Session" WHERE "sessionToken"=$1 AND expires>NOW() AND "lastActivityAt">NOW()-INTERVAL '7 days' FOR UPDATE"#).bind(token).bind(seconds).fetch_optional(&mut *tx).await?.ok_or(AppError::Unauthorized)?;
    let interactive = interactive_activity(req);
    let refresh = interactive && session.3;
    if session.2 || refresh {
        let issuer = setting("OIDC_ISSUER_URL")?;
        let client_id = setting("OIDC_CLIENT_ID")?;
        let client_secret = setting("OIDC_CLIENT_SECRET")?;
        let response = if refresh {
            http()?
                .post(format!("{issuer}/protocol/openid-connect/token"))
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", session.1.as_str()),
                    ("client_id", client_id.as_str()),
                    ("client_secret", client_secret.as_str()),
                ])
                .send()
                .await
                .map_err(unavailable)?
        } else {
            http()?
                .post(format!("{issuer}/protocol/openid-connect/token/introspect"))
                .form(&[
                    ("token", session.1.as_str()),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id.as_str()),
                    ("client_secret", client_secret.as_str()),
                ])
                .send()
                .await
                .map_err(unavailable)?
        };
        if response.status().is_server_error() {
            return Err(unavailable("provider"));
        }
        let success = response.status().is_success();
        let body: serde_json::Value = response.json().await.map_err(unavailable)?;
        if !success || (!refresh && body.get("active").and_then(|v| v.as_bool()) != Some(true)) {
            sqlx::query(r#"DELETE FROM "Session" WHERE "sessionToken"=$1"#)
                .bind(token)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Err(AppError::Unauthorized);
        }
        if refresh {
            let refreshed = body
                .get("refresh_token")
                .and_then(|v| v.as_str())
                .ok_or(AppError::Unauthorized)?;
            sqlx::query(r#"UPDATE "Session" SET "refreshToken"=$2,"identityCheckedAt"=NOW(),"providerRefreshedAt"=NOW() WHERE "sessionToken"=$1"#).bind(token).bind(refreshed).execute(&mut *tx).await?;
        } else {
            sqlx::query(
                r#"UPDATE "Session" SET "identityCheckedAt"=NOW() WHERE "sessionToken"=$1"#,
            )
            .bind(token)
            .execute(&mut *tx)
            .await?;
        }
    }
    if interactive {
        sqlx::query(r#"UPDATE "Session" SET "lastActivityAt"=NOW() WHERE "sessionToken"=$1"#)
            .bind(token)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(session.0)
}
pub async fn logout_all(pool: &PgPool, user: &str) -> Result<(), AppError> {
    let issuer = setting("OIDC_ISSUER_URL")?;
    let subject = sqlx::query_scalar::<_, String>(
        r#"SELECT subject FROM "ExternalIdentity" WHERE issuer=$1 AND "userId"=$2"#,
    )
    .bind(&issuer)
    .bind(user)
    .fetch_one(pool)
    .await?;
    // Dedicated least-privilege service account in Labs: realm-management/manage-users.
    let client = http()?;
    let response = client
        .post(format!("{issuer}/protocol/openid-connect/token"))
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", setting("OIDC_ADMIN_CLIENT_ID")?.as_str()),
            (
                "client_secret",
                setting("OIDC_ADMIN_CLIENT_SECRET")?.as_str(),
            ),
        ])
        .send()
        .await
        .map_err(unavailable)?;
    if !response.status().is_success() {
        return Err(unavailable("admin credentials"));
    }
    let access: serde_json::Value = response.json().await.map_err(unavailable)?;
    let access = access
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or(AppError::Unauthorized)?;
    let base = issuer.replace("/realms/", "/admin/realms/");
    let response = client
        .post(format!(
            "{base}/users/{}/logout",
            urlencoding::encode(&subject)
        ))
        .bearer_auth(access)
        .send()
        .await
        .map_err(unavailable)?;
    if !response.status().is_success() {
        return Err(unavailable("logout"));
    }
    sqlx::query(r#"DELETE FROM "Session" WHERE "userId"=$1"#)
        .bind(user)
        .execute(pool)
        .await?;
    Ok(())
}
#[derive(Deserialize)]
struct LogoutClaims {
    iss: String,
    #[serde(rename = "aud")]
    _aud: serde_json::Value,
    iat: i64,
    jti: String,
    sub: Option<String>,
    sid: Option<String>,
    events: serde_json::Value,
    nonce: Option<String>,
}
pub async fn backchannel_logout(pool: &PgPool, token: &str) -> Result<(), AppError> {
    let issuer = setting("OIDC_ISSUER_URL")?;
    let client = setting("OIDC_CLIENT_ID")?;
    let header = jsonwebtoken::decode_header(token).map_err(|_| AppError::Unauthorized)?;
    if header.alg != jsonwebtoken::Algorithm::RS256 {
        return Err(AppError::Unauthorized);
    }
    let jwks: jsonwebtoken::jwk::JwkSet = http()?
        .get(format!("{issuer}/protocol/openid-connect/certs"))
        .send()
        .await
        .map_err(unavailable)?
        .error_for_status()
        .map_err(unavailable)?
        .json()
        .await
        .map_err(unavailable)?;
    let jwk = jwks
        .find(header.kid.as_deref().ok_or(AppError::Unauthorized)?)
        .ok_or(AppError::Unauthorized)?;
    let key = jsonwebtoken::DecodingKey::from_jwk(jwk).map_err(|_| AppError::Unauthorized)?;
    let claims = verify_logout_token(token, &key, &issuer, &client)?;
    let mut tx = pool.begin().await?;
    let inserted=sqlx::query(r#"INSERT INTO "OidcLogoutReplay" (jti,expires) VALUES ($1,NOW()+INTERVAL '10 minutes') ON CONFLICT DO NOTHING"#).bind(claims.jti).execute(&mut *tx).await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::Unauthorized);
    }
    if let Some(sid) = claims.sid {
        sqlx::query(r#"DELETE FROM "Session" WHERE "providerSid"=$1"#)
            .bind(sid)
            .execute(&mut *tx)
            .await?;
    } else if let Some(subject) = claims.sub {
        sqlx::query(r#"DELETE FROM "Session" WHERE "userId" IN (SELECT "userId" FROM "ExternalIdentity" WHERE issuer=$1 AND subject=$2)"#).bind(issuer).bind(subject).execute(&mut *tx).await?;
    }
    sqlx::query(r#"DELETE FROM "OidcLogoutReplay" WHERE expires<NOW()"#)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

fn verify_logout_token(
    token: &str,
    key: &jsonwebtoken::DecodingKey,
    issuer: &str,
    client: &str,
) -> Result<LogoutClaims, AppError> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.required_spec_claims.clear();
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[client]);
    let claims = jsonwebtoken::decode::<LogoutClaims>(token, key, &validation)
        .map_err(|_| AppError::Unauthorized)?
        .claims;
    validate_logout_event(&claims, issuer, chrono::Utc::now().timestamp())?;
    Ok(claims)
}

fn validate_logout_event(claims: &LogoutClaims, issuer: &str, now: i64) -> Result<(), AppError> {
    if claims.iss != issuer
        || claims.nonce.is_some()
        || claims.iat > now + 30
        || claims.iat < now - 300
        || claims.jti.is_empty()
        || (claims.sid.as_deref().unwrap_or("").is_empty()
            && claims.sub.as_deref().unwrap_or("").is_empty())
        || !claims
            .events
            .get("http://schemas.openid.net/event/backchannel-logout")
            .is_some_and(|v| v.is_object())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn claims() -> LogoutClaims {
        serde_json::from_value(serde_json::json!({"iss":"issuer","aud":"growth","iat":1000,"jti":"once","sid":"browser","events":{"http://schemas.openid.net/event/backchannel-logout":{}}})).unwrap()
    }
    #[test]
    fn logout_requires_fresh_logout_event_without_nonce() {
        assert!(validate_logout_event(&claims(), "issuer", 1000).is_ok());
        assert!(validate_logout_event(&claims(), "wrong", 1000).is_err());
        assert!(validate_logout_event(&claims(), "issuer", 1400).is_err());
        assert!(validate_logout_event(&claims(), "issuer", 900).is_err());
        let mut c = claims();
        c.nonce = Some("login nonce".into());
        assert!(validate_logout_event(&c, "issuer", 1000).is_err());
        let mut c = claims();
        c.events = serde_json::json!({});
        assert!(validate_logout_event(&c, "issuer", 1000).is_err());
        let mut c = claims();
        c.sid = None;
        assert!(validate_logout_event(&c, "issuer", 1000).is_err());
    }
}

#[cfg(test)]
mod signature_tests {
    use super::*;
    #[test]
    fn logout_rejects_wrong_signature_audience_and_issuer() {
        let pair = jwt_simple::prelude::RS256KeyPair::generate(2048).unwrap();
        let public = pair.public_key().to_pem().unwrap();
        let private = pair.to_pem().unwrap();
        let key = jsonwebtoken::DecodingKey::from_rsa_pem(public.as_bytes()).unwrap();
        let signing = jsonwebtoken::EncodingKey::from_rsa_pem(private.as_bytes()).unwrap();
        let payload = serde_json::json!({"iss":"issuer","aud":"growth","iat":chrono::Utc::now().timestamp(),"jti":"one","sid":"browser","events":{"http://schemas.openid.net/event/backchannel-logout":{}}});
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &payload,
            &signing,
        )
        .unwrap();
        assert!(verify_logout_token(&token, &key, "issuer", "growth").is_ok());
        assert!(verify_logout_token(&token, &key, "wrong", "growth").is_err());
        assert!(verify_logout_token(&token, &key, "issuer", "wrong").is_err());
        let wrong_pair = jwt_simple::prelude::RS256KeyPair::generate(2048).unwrap();
        let wrong_key = jsonwebtoken::DecodingKey::from_rsa_pem(
            wrong_pair.public_key().to_pem().unwrap().as_bytes(),
        )
        .unwrap();
        assert!(verify_logout_token(&token, &wrong_key, "issuer", "growth").is_err());
        let mut expired = payload.clone();
        expired["exp"] = serde_json::json!(chrono::Utc::now().timestamp() - 120);
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &expired,
            &signing,
        )
        .unwrap();
        assert!(verify_logout_token(&token, &key, "issuer", "growth").is_err());
    }
}

fn interactive_activity(req: &HttpRequest) -> bool {
    let path = req.path();
    let background = req
        .headers()
        .get("x-kasitek-background")
        .and_then(|v| v.to_str().ok())
        == Some("1");
    !background
        && !matches!(
            *req.method(),
            actix_web::http::Method::GET
                | actix_web::http::Method::HEAD
                | actix_web::http::Method::OPTIONS
        )
        && path != "/api/auth/me"
        && !path.contains("/realtime")
        && !path.contains("/notifications")
}
#[cfg(test)]
mod activity_tests {
    use super::*;
    #[test]
    fn background_requests_do_not_extend_product_or_provider_idle() {
        use actix_web::test::TestRequest;
        assert!(!interactive_activity(
            &TestRequest::get().uri("/api/inbox").to_http_request()
        ));
        assert!(!interactive_activity(
            &TestRequest::post()
                .uri("/api/inbox")
                .insert_header(("x-kasitek-background", "1"))
                .to_http_request()
        ));
        assert!(!interactive_activity(
            &TestRequest::post()
                .uri("/api/notifications/read")
                .to_http_request()
        ));
        assert!(interactive_activity(
            &TestRequest::post()
                .uri("/api/auth/activity")
                .to_http_request()
        ));
        assert!(interactive_activity(
            &TestRequest::patch().uri("/api/profile").to_http_request()
        ));
    }
}
