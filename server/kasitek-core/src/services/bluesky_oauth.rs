use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Utc};
use crypto_utils::{generate_token, sha256_base64_url};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use rand::thread_rng;
use reqwest::{header::HeaderMap, Client, Response, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::net::IpAddr;

use crate::services::social::{decrypt_social_secret, encrypt_social_secret};
use crate::{config::AppConfig, error::AppError};

const SCOPE: &str = "atproto repo:app.bsky.feed.post";
const STATE_TTL_MINUTES: i64 = 10;

fn normalize_handle(value: &str) -> String {
    let handle = value.trim().trim_start_matches('@');
    if handle.is_empty() || handle.contains('.') {
        return handle.to_string();
    }
    format!("{handle}.bsky.social")
}

#[derive(sqlx::FromRow)]
struct AuthorizationRow {
    state: String,
    user_id: String,
    org_id: String,
    handle: Option<String>,
    expected_did: String,
    pds_url: String,
    authorization_url: String,
    code_verifier: String,
    dpop_private_key: String,
    dpop_nonce: Option<String>,
}

#[derive(Deserialize)]
struct DidResolution {
    did: String,
}

#[derive(Deserialize)]
struct ProtectedResourceMetadata {
    authorization_servers: Vec<String>,
}

#[derive(Clone, Deserialize)]
struct AuthorizationServerMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    pushed_authorization_request_endpoint: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    sub: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
}

pub struct CompletedAuthorization {
    pub user_id: String,
    pub org_id: String,
    pub did: String,
    pub handle: String,
    pub access_token: String,
    pub refresh_token: String,
    pub pds_url: String,
    pub authorization_url: String,
    pub dpop_private_key: String,
    pub authorization_nonce: Option<String>,
    pub expires_in: Option<i64>,
    pub scope: Option<String>,
}

pub struct RefreshedSession {
    pub access_token: String,
    pub refresh_token: String,
    pub authorization_nonce: Option<String>,
    pub expires_in: Option<i64>,
}

fn app_url(config: &AppConfig) -> String {
    config.public_api_url.trim_end_matches('/').to_string()
}
pub fn client_id(config: &AppConfig) -> String {
    format!(
        "{}/api/social/oauth/bluesky/client-metadata",
        app_url(config)
    )
}
pub fn callback_url(config: &AppConfig) -> String {
    format!("{}/api/social/oauth/bluesky/callback", app_url(config))
}

fn signing_key_from_encoded(encoded: &str, label: &str) -> Result<SigningKey, AppError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| AppError::Internal(format!("{label} must be base64url")))?;
    SigningKey::from_slice(&bytes)
        .map_err(|_| AppError::Internal(format!("{label} must be a 32-byte P-256 key")))
}

fn client_signing_key() -> Result<SigningKey, AppError> {
    let value = std::env::var("AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY").map_err(|_| {
        AppError::Internal("AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY is required".to_string())
    })?;
    signing_key_from_encoded(&value, "AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY")
}

fn public_jwk(key: &SigningKey, include_kid: bool) -> Value {
    let point = key.verifying_key().to_encoded_point(false);
    let mut value = json!({
        "kty":"EC", "crv":"P-256",
        "x":URL_SAFE_NO_PAD.encode(point.x().expect("P-256 x")),
        "y":URL_SAFE_NO_PAD.encode(point.y().expect("P-256 y"))
    });
    if include_kid {
        value["kid"] = Value::String(
            std::env::var("AUTH_BLUESKY_OAUTH_CLIENT_KEY_ID")
                .unwrap_or_else(|_| "kasitek-bluesky-oauth-1".to_string()),
        );
        value["use"] = Value::String("sig".to_string());
        value["alg"] = Value::String("ES256".to_string());
    }
    value
}

pub fn client_metadata(config: &AppConfig) -> Result<Value, AppError> {
    let id = client_id(config);
    validate_public_https(&id, "client metadata")?;
    Ok(json!({
        "client_id":id,
        "client_name":"KasiTek",
        "client_uri":app_url(config),
        "application_type":"web",
        "grant_types":["authorization_code","refresh_token"],
        "response_types":["code"],
        "redirect_uris":[callback_url(config)],
        "scope":SCOPE,
        "dpop_bound_access_tokens":true,
        "token_endpoint_auth_method":"private_key_jwt",
        "token_endpoint_auth_signing_alg":"ES256",
        "jwks":{"keys":[public_jwk(&client_signing_key()?, true)]}
    }))
}

/// Confirms that the client metadata URL configured in the API is publicly
/// reachable before we send a user to Bluesky's authorization server. This
/// avoids a consent flow that can never complete because a proxy, tunnel, or
/// deployment route does not expose the OAuth metadata endpoint.
pub async fn verify_public_client_metadata(config: &AppConfig) -> Result<(), AppError> {
    let endpoint = client_id(config);
    validate_public_network_url(&endpoint, "client metadata").await?;
    let metadata: Value = json_response(
        http_client()?.get(&endpoint).send().await.map_err(|e| {
            AppError::BadRequest(format!("Could not reach Bluesky client metadata: {e}"))
        })?,
        "Bluesky client metadata is not publicly available",
    )
    .await?;
    if metadata.get("client_id").and_then(Value::as_str) != Some(endpoint.as_str()) {
        return Err(AppError::BadRequest(
            "Bluesky client metadata does not match KASITEK_CORE_PUBLIC_URL".to_string(),
        ));
    }
    Ok(())
}

fn jwt(key: &SigningKey, header: Value, claims: Value) -> Result<String, AppError> {
    let header = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&header).map_err(|e| AppError::Internal(e.to_string()))?);
    let claims = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|e| AppError::Internal(e.to_string()))?);
    let input = format!("{header}.{claims}");
    let signature: Signature = key.sign(input.as_bytes());
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

fn client_assertion(config: &AppConfig, audience: &str) -> Result<String, AppError> {
    let id = client_id(config);
    let now = Utc::now().timestamp();
    jwt(
        &client_signing_key()?,
        json!({"alg":"ES256","typ":"JWT","kid":std::env::var("AUTH_BLUESKY_OAUTH_CLIENT_KEY_ID").unwrap_or_else(|_|"kasitek-bluesky-oauth-1".to_string())}),
        json!({"iss":id,"sub":id,"aud":audience,"jti":generate_token(18),"iat":now,"exp":now+60}),
    )
}

fn dpop_proof(
    key: &SigningKey,
    method: &str,
    url: &str,
    nonce: Option<&str>,
    access_token: Option<&str>,
) -> Result<String, AppError> {
    let now = Utc::now().timestamp();
    let mut claims =
        json!({"jti":generate_token(18),"htm":method,"htu":url,"iat":now,"exp":now+60});
    if let Some(nonce) = nonce {
        claims["nonce"] = Value::String(nonce.to_string());
    }
    if let Some(token) = access_token {
        claims["ath"] = Value::String(URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes())));
    }
    jwt(
        key,
        json!({"typ":"dpop+jwt","alg":"ES256","jwk":public_jwk(key,false)}),
        claims,
    )
}

fn validate_public_https(value: &str, label: &str) -> Result<Url, AppError> {
    let url = Url::parse(value)
        .map_err(|_| AppError::BadRequest(format!("Invalid Bluesky {label} URL")))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::BadRequest(format!(
            "Bluesky {label} must use public HTTPS"
        )));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::BadRequest(format!("Invalid Bluesky {label} host")))?;
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| !is_public_ip(ip))
            .unwrap_or(false)
    {
        return Err(AppError::BadRequest(format!(
            "Bluesky {label} host is not public"
        )));
    }
    Ok(url)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified())
        }
        IpAddr::V6(ip) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
    }
}

async fn validate_public_network_url(value: &str, label: &str) -> Result<Url, AppError> {
    let url = validate_public_https(value, label)?;
    let host = url
        .host_str()
        .ok_or_else(|| AppError::BadRequest(format!("Invalid Bluesky {label} host")))?;
    let addresses = tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
        .await
        .map_err(|_| AppError::BadRequest(format!("Could not resolve Bluesky {label} host")))?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(AppError::BadRequest(format!(
            "Bluesky {label} resolved to a non-public address"
        )));
    }
    Ok(url)
}

fn http_client() -> Result<Client, AppError> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))
}

async fn json_response<T: serde::de::DeserializeOwned>(
    response: Response,
    context: &str,
) -> Result<T, AppError> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "{context}: {}",
            body.chars().take(300).collect::<String>()
        )));
    }
    serde_json::from_str(&body)
        .map_err(|_| AppError::BadRequest(format!("{context}: invalid JSON response")))
}

fn did_document_url(did: &str) -> Result<String, AppError> {
    if did.starts_with("did:plc:") {
        // plc.directory resolves the complete DID. Passing only the identifier
        // returns a misleading "DID not registered" response.
        Ok(format!("https://plc.directory/{did}"))
    } else if let Some(id) = did.strip_prefix("did:web:") {
        let parts: Vec<_> = id.split(':').collect();
        let host = parts
            .first()
            .ok_or_else(|| AppError::BadRequest("Invalid did:web identity".to_string()))?;
        let host = urlencoding::decode(host)
            .map_err(|_| AppError::BadRequest("Invalid did:web hostname".to_string()))?;
        if parts.len() == 1 {
            Ok(format!("https://{host}/.well-known/did.json"))
        } else {
            let path = parts[1..]
                .iter()
                .map(|part| urlencoding::decode(part).map(|value| value.into_owned()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| AppError::BadRequest("Invalid did:web path".to_string()))?;
            Ok(format!("https://{host}/{}/did.json", path.join("/")))
        }
    } else {
        Err(AppError::BadRequest(
            "Unsupported Bluesky DID method".to_string(),
        ))
    }
}

async fn resolve_identity(handle: &str) -> Result<(String, String), AppError> {
    let client = http_client()?;
    let response = client
        .get("https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle")
        .query(&[("handle", handle)])
        .send()
        .await
        .map_err(|e| AppError::BadRequest(format!("Failed to resolve Bluesky handle: {e}")))?;
    let resolved: DidResolution =
        json_response(response, "Failed to resolve Bluesky handle").await?;
    let did_url = did_document_url(&resolved.did)?;
    validate_public_network_url(&did_url, "DID document").await?;
    let document: Value = json_response(
        client
            .get(did_url)
            .send()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?,
        "Failed to resolve Bluesky DID",
    )
    .await?;
    let handle_alias = format!("at://{handle}");
    let handle_matches = document
        .get("alsoKnownAs")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values.iter().any(|value| {
                value
                    .as_str()
                    .is_some_and(|alias| alias.eq_ignore_ascii_case(&handle_alias))
            })
        });
    if !handle_matches {
        return Err(AppError::BadRequest(
            "Bluesky handle and DID do not verify each other".to_string(),
        ));
    }
    let services = document
        .get("service")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("Bluesky DID has no PDS service".to_string()))?;
    let pds = services
        .iter()
        .find(|service| {
            service
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.ends_with("#atproto_pds"))
        })
        .and_then(|service| service.get("serviceEndpoint"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Bluesky DID has no PDS endpoint".to_string()))?;
    Ok((
        resolved.did,
        validate_public_network_url(pds, "PDS")
            .await?
            .to_string()
            .trim_end_matches('/')
            .to_string(),
    ))
}

async fn authorization_metadata(pds_url: &str) -> Result<AuthorizationServerMetadata, AppError> {
    let client = http_client()?;
    validate_public_network_url(pds_url, "PDS").await?;
    let protected: ProtectedResourceMetadata = json_response(
        client
            .get(format!("{pds_url}/.well-known/oauth-protected-resource"))
            .send()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?,
        "Failed to discover Bluesky authorization server",
    )
    .await?;
    let issuer = protected.authorization_servers.first().ok_or_else(|| {
        AppError::BadRequest("Bluesky PDS has no authorization server".to_string())
    })?;
    let issuer = validate_public_network_url(issuer, "authorization server")
        .await?
        .to_string()
        .trim_end_matches('/')
        .to_string();
    let metadata: AuthorizationServerMetadata = json_response(
        client
            .get(format!("{issuer}/.well-known/oauth-authorization-server"))
            .send()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?,
        "Failed to load Bluesky authorization metadata",
    )
    .await?;
    if metadata.issuer.trim_end_matches('/') != issuer {
        return Err(AppError::BadRequest(
            "Bluesky authorization issuer mismatch".to_string(),
        ));
    }
    for value in [
        &metadata.authorization_endpoint,
        &metadata.token_endpoint,
        &metadata.pushed_authorization_request_endpoint,
    ] {
        validate_public_network_url(value, "OAuth endpoint").await?;
    }
    Ok(metadata)
}

fn response_nonce(headers: &HeaderMap) -> Option<String> {
    headers
        .get("DPoP-Nonce")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

async fn post_oauth_form(
    config: &AppConfig,
    endpoint: &str,
    issuer: &str,
    dpop_key: &SigningKey,
    nonce: Option<&str>,
    mut form: Vec<(String, String)>,
) -> Result<(Response, Option<String>), AppError> {
    form.push((
        "client_assertion_type".to_string(),
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer".to_string(),
    ));
    form.push((
        "client_assertion".to_string(),
        client_assertion(config, issuer)?,
    ));
    let client = http_client()?;
    let response = client
        .post(endpoint)
        .header("DPoP", dpop_proof(dpop_key, "POST", endpoint, nonce, None)?)
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    let discovered = response_nonce(response.headers());
    if !response.status().is_success() && discovered.is_some() && discovered.as_deref() != nonce {
        let last = form.len();
        form[last - 1].1 = client_assertion(config, issuer)?;
        let retry = client
            .post(endpoint)
            .header(
                "DPoP",
                dpop_proof(dpop_key, "POST", endpoint, discovered.as_deref(), None)?,
            )
            .form(&form)
            .send()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
        let retry_nonce = response_nonce(retry.headers()).or(discovered);
        return Ok((retry, retry_nonce));
    }
    Ok((response, discovered.or_else(|| nonce.map(str::to_string))))
}

pub async fn start(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    org_id: &str,
    handle: &str,
) -> Result<String, AppError> {
    verify_public_client_metadata(config).await?;
    let handle = normalize_handle(handle);
    if handle.is_empty() {
        return Err(AppError::BadRequest(
            "Bluesky handle is required".to_string(),
        ));
    }
    let (did, pds_url) = resolve_identity(&handle).await?;
    let metadata = authorization_metadata(&pds_url).await?;
    let state = generate_token(24);
    let verifier = generate_token(48);
    let challenge = sha256_base64_url(&verifier);
    let dpop_key = SigningKey::random(&mut thread_rng());
    let form = vec![
        ("client_id".into(), client_id(config)),
        ("response_type".into(), "code".into()),
        ("redirect_uri".into(), callback_url(config)),
        ("scope".into(), SCOPE.into()),
        ("state".into(), state.clone()),
        ("code_challenge".into(), challenge),
        ("code_challenge_method".into(), "S256".into()),
        ("login_hint".into(), handle.clone()),
    ];
    let (response, nonce) = post_oauth_form(
        config,
        &metadata.pushed_authorization_request_endpoint,
        &metadata.issuer,
        &dpop_key,
        None,
        form,
    )
    .await?;
    #[derive(Deserialize)]
    struct ParResponse {
        request_uri: String,
    }
    let par: ParResponse = json_response(response, "Bluesky authorization request failed").await?;
    sqlx::query(r#"DELETE FROM "SocialOAuthAuthorization" WHERE provider='BLUESKY' AND "expiresAt" < NOW()"#).execute(pool).await?;
    sqlx::query(r#"INSERT INTO "SocialOAuthAuthorization" (id,provider,state,"userId","orgId",handle,"expectedDid","pdsUrl","authorizationUrl","codeVerifier","dpopPrivateKey","dpopNonce","createdAt","expiresAt") VALUES ($1,'BLUESKY',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)"#)
        .bind(cuid2::create_id()).bind(&state).bind(user_id).bind(org_id).bind(&handle).bind(&did).bind(&pds_url).bind(&metadata.issuer)
        .bind(encrypt_social_secret(&verifier)?).bind(encrypt_social_secret(&URL_SAFE_NO_PAD.encode(dpop_key.to_bytes()))?).bind(nonce).bind(Utc::now()+Duration::minutes(STATE_TTL_MINUTES)).execute(pool).await?;
    let mut url = Url::parse(&metadata.authorization_endpoint)
        .map_err(|_| AppError::BadRequest("Invalid Bluesky authorization URL".to_string()))?;
    url.query_pairs_mut()
        .append_pair("client_id", &client_id(config))
        .append_pair("request_uri", &par.request_uri);
    Ok(url.to_string())
}

pub async fn complete(
    pool: &PgPool,
    config: &AppConfig,
    state: &str,
    code: &str,
    issuer: &str,
) -> Result<CompletedAuthorization, AppError> {
    let row=sqlx::query_as::<_,AuthorizationRow>(r#"SELECT state,"userId" AS user_id,"orgId" AS org_id,handle,"expectedDid" AS expected_did,"pdsUrl" AS pds_url,"authorizationUrl" AS authorization_url,"codeVerifier" AS code_verifier,"dpopPrivateKey" AS dpop_private_key,"dpopNonce" AS dpop_nonce FROM "SocialOAuthAuthorization" WHERE provider='BLUESKY' AND state=$1 AND "expiresAt">NOW() LIMIT 1"#).bind(state).fetch_optional(pool).await?.ok_or_else(||AppError::BadRequest("Invalid or expired Bluesky OAuth state".to_string()))?;
    if issuer.trim_end_matches('/') != row.authorization_url.trim_end_matches('/') {
        return Err(AppError::BadRequest(
            "Bluesky OAuth issuer mismatch".to_string(),
        ));
    }
    let metadata = authorization_metadata(&row.pds_url).await?;
    if metadata.issuer.trim_end_matches('/') != row.authorization_url.trim_end_matches('/') {
        return Err(AppError::BadRequest(
            "Bluesky authorization server changed during OAuth".to_string(),
        ));
    }
    let key = signing_key_from_encoded(
        &decrypt_social_secret(&row.dpop_private_key)?,
        "Bluesky DPoP key",
    )?;
    let form = vec![
        ("grant_type".into(), "authorization_code".into()),
        ("code".into(), code.into()),
        ("redirect_uri".into(), callback_url(config)),
        ("client_id".into(), client_id(config)),
        (
            "code_verifier".into(),
            decrypt_social_secret(&row.code_verifier)?,
        ),
    ];
    let (response, nonce) = post_oauth_form(
        config,
        &metadata.token_endpoint,
        &metadata.issuer,
        &key,
        row.dpop_nonce.as_deref(),
        form,
    )
    .await?;
    let tokens: TokenResponse = json_response(response, "Bluesky token exchange failed").await?;
    if tokens.sub != row.expected_did {
        return Err(AppError::BadRequest(
            "Bluesky authorized a different account than requested".to_string(),
        ));
    }
    sqlx::query(r#"DELETE FROM "SocialOAuthAuthorization" WHERE state=$1"#)
        .bind(&row.state)
        .execute(pool)
        .await?;
    Ok(CompletedAuthorization {
        user_id: row.user_id,
        org_id: row.org_id,
        did: tokens.sub,
        handle: row.handle.unwrap_or_else(|| "Bluesky account".into()),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        pds_url: row.pds_url,
        authorization_url: row.authorization_url,
        dpop_private_key: decrypt_social_secret(&row.dpop_private_key)?,
        authorization_nonce: nonce,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
    })
}

pub async fn refresh(
    config: &AppConfig,
    refresh_token: &str,
    authorization_url: &str,
    dpop_private_key: &str,
    nonce: Option<&str>,
) -> Result<RefreshedSession, AppError> {
    let metadata = authorization_metadata_from_issuer(authorization_url).await?;
    let key = signing_key_from_encoded(dpop_private_key, "Bluesky DPoP key")?;
    let form = vec![
        ("grant_type".into(), "refresh_token".into()),
        ("refresh_token".into(), refresh_token.into()),
        ("client_id".into(), client_id(config)),
    ];
    let (response, nonce) = post_oauth_form(
        config,
        &metadata.token_endpoint,
        &metadata.issuer,
        &key,
        nonce,
        form,
    )
    .await?;
    let tokens: TokenResponse = json_response(response, "Bluesky token refresh failed").await?;
    Ok(RefreshedSession {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        authorization_nonce: nonce,
        expires_in: tokens.expires_in,
    })
}

async fn authorization_metadata_from_issuer(
    issuer: &str,
) -> Result<AuthorizationServerMetadata, AppError> {
    let issuer = validate_public_network_url(issuer, "authorization server")
        .await?
        .to_string()
        .trim_end_matches('/')
        .to_string();
    let metadata: AuthorizationServerMetadata = json_response(
        http_client()?
            .get(format!("{issuer}/.well-known/oauth-authorization-server"))
            .send()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?,
        "Failed to load Bluesky authorization metadata",
    )
    .await?;
    if metadata.issuer.trim_end_matches('/') != issuer {
        return Err(AppError::BadRequest(
            "Bluesky authorization issuer mismatch".to_string(),
        ));
    }
    for value in [
        &metadata.authorization_endpoint,
        &metadata.token_endpoint,
        &metadata.pushed_authorization_request_endpoint,
    ] {
        validate_public_network_url(value, "OAuth endpoint").await?;
    }
    Ok(metadata)
}

pub async fn create_post(
    pds_url: &str,
    did: &str,
    text: &str,
    access_token: &str,
    dpop_private_key: &str,
    nonce: Option<&str>,
) -> Result<(String, Option<String>), AppError> {
    let pds_url = validate_public_network_url(pds_url, "PDS").await?;
    let endpoint = format!(
        "{}/xrpc/com.atproto.repo.createRecord",
        pds_url.to_string().trim_end_matches('/')
    );
    let key = signing_key_from_encoded(dpop_private_key, "Bluesky DPoP key")?;
    let body = json!({"repo":did,"collection":"app.bsky.feed.post","record":{"$type":"app.bsky.feed.post","text":text,"createdAt":Utc::now().to_rfc3339()}});
    let client = http_client()?;
    let mut response = client
        .post(&endpoint)
        .header("Authorization", format!("DPoP {access_token}"))
        .header(
            "DPoP",
            dpop_proof(&key, "POST", &endpoint, nonce, Some(access_token))?,
        )
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    let mut latest = response_nonce(response.headers()).or_else(|| nonce.map(str::to_string));
    if !response.status().is_success()
        && response_nonce(response.headers()).is_some()
        && response_nonce(response.headers()).as_deref() != nonce
    {
        let retry_nonce = response_nonce(response.headers());
        response = client
            .post(&endpoint)
            .header("Authorization", format!("DPoP {access_token}"))
            .header(
                "DPoP",
                dpop_proof(
                    &key,
                    "POST",
                    &endpoint,
                    retry_nonce.as_deref(),
                    Some(access_token),
                )?,
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
        latest = response_nonce(response.headers()).or(latest);
    }
    let value: Value = json_response(response, "Failed to publish to Bluesky").await?;
    let uri = value
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Bluesky did not return a post URI".to_string()))?;
    Ok((uri.to_string(), latest))
}

pub async fn delete_post(
    pds_url: &str,
    did: &str,
    uri: &str,
    access_token: &str,
    dpop_private_key: &str,
    nonce: Option<&str>,
) -> Result<Option<String>, AppError> {
    let expected_prefix = format!("at://{did}/app.bsky.feed.post/");
    let rkey = uri
        .strip_prefix(&expected_prefix)
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| AppError::BadRequest("Bluesky post URI is invalid".to_string()))?;
    let pds_url = validate_public_network_url(pds_url, "PDS").await?;
    let endpoint = format!(
        "{}/xrpc/com.atproto.repo.deleteRecord",
        pds_url.to_string().trim_end_matches('/')
    );
    let key = signing_key_from_encoded(dpop_private_key, "Bluesky DPoP key")?;
    let body = json!({
        "repo": did,
        "collection": "app.bsky.feed.post",
        "rkey": rkey,
    });
    let client = http_client()?;
    let send = |nonce: Option<String>| {
        let client = client.clone();
        let endpoint = endpoint.clone();
        let key = key.clone();
        let access_token = access_token.to_string();
        let body = body.clone();
        async move {
            client
                .post(&endpoint)
                .header("Authorization", format!("DPoP {access_token}"))
                .header(
                    "DPoP",
                    dpop_proof(
                        &key,
                        "POST",
                        &endpoint,
                        nonce.as_deref(),
                        Some(&access_token),
                    )?,
                )
                .json(&body)
                .send()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))
        }
    };

    let mut response = send(nonce.map(str::to_string)).await?;
    let mut latest = response_nonce(response.headers()).or_else(|| nonce.map(str::to_string));
    if !response.status().is_success()
        && response_nonce(response.headers()).is_some()
        && response_nonce(response.headers()).as_deref() != nonce
    {
        let retry_nonce = response_nonce(response.headers());
        response = send(retry_nonce).await?;
        latest = response_nonce(response.headers()).or(latest);
    }
    if !response.status().is_success() && response.status().as_u16() != 404 {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(300).collect::<String>();
        let detail = if detail.trim().is_empty() {
            status.to_string()
        } else {
            detail.trim().to_string()
        };
        return Err(AppError::BadRequest(format!(
            "Failed to delete Bluesky post: {detail}"
        )));
    }
    Ok(latest)
}

#[cfg(test)]
mod tests {
    use super::{did_document_url, dpop_proof, normalize_handle, validate_public_https};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use p256::ecdsa::{signature::Verifier, Signature, SigningKey};
    use rand::thread_rng;
    use serde_json::Value;

    #[test]
    fn dpop_proof_is_signed_and_bound_to_request_and_token() {
        let key = SigningKey::random(&mut thread_rng());
        let token = "access-token";
        let proof = dpop_proof(
            &key,
            "POST",
            "https://pds.example/xrpc/com.atproto.repo.createRecord",
            Some("nonce-value"),
            Some(token),
        )
        .unwrap();
        let parts = proof.split('.').collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["htm"], "POST");
        assert_eq!(claims["nonce"], "nonce-value");
        assert!(claims["ath"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        key.verifying_key()
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn oauth_discovery_rejects_local_and_private_hosts() {
        assert!(validate_public_https("http://example.com", "test").is_err());
        assert!(validate_public_https("https://localhost/test", "test").is_err());
        assert!(validate_public_https("https://127.0.0.1/test", "test").is_err());
        assert!(validate_public_https("https://10.0.0.1/test", "test").is_err());
        assert!(validate_public_https("https://pds.example/test", "test").is_ok());
    }

    #[test]
    fn normalizes_short_handles_to_the_default_bluesky_domain() {
        assert_eq!(normalize_handle("business"), "business.bsky.social");
        assert_eq!(normalize_handle("@business"), "business.bsky.social");
        assert_eq!(
            normalize_handle("business.bsky.social"),
            "business.bsky.social"
        );
        assert_eq!(
            normalize_handle("business.example.com"),
            "business.example.com"
        );
    }

    #[test]
    fn plc_directory_lookup_uses_the_complete_did() {
        let did = "did:plc:jif45llp4ysqv5onnb7b4ory";
        assert_eq!(
            did_document_url(did).unwrap(),
            "https://plc.directory/did:plc:jif45llp4ysqv5onnb7b4ory"
        );
    }
}
