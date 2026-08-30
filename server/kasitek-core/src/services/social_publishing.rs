use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::error::AppError;

use super::social::{
    decrypt_social_secret, encrypt_social_secret, fetch_json, required_env, ThreadsTokenResponse,
    TikTokTokenResponse, INSTAGRAM_GRAPH_BASE, LINKEDIN_API_VERSION, LINKEDIN_POSTS_URL,
    META_GRAPH_BASE, THREADS_GRAPH_BASE, TIKTOK_CREATOR_INFO_URL, TIKTOK_PUBLISH_URL,
    TIKTOK_TOKEN_URL, X_POST_TWEET_URL,
};

async fn send_provider_delete(
    request: reqwest::RequestBuilder,
    fallback: &str,
) -> Result<(), AppError> {
    let response = request.send().await?;
    let status = response.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }

    let body = response.text().await.unwrap_or_default();
    let detail = body.chars().take(300).collect::<String>();
    let detail = if detail.trim().is_empty() {
        status.to_string()
    } else {
        detail.trim().to_string()
    };
    Err(AppError::BadRequest(format!("{fallback}: {detail}")))
}

pub(crate) struct PublishImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub alt_text: String,
}

pub(crate) async fn delete_post_from_provider(
    platform: &str,
    access_token_encrypted: &str,
    _external_account_id: &Option<String>,
    connection_metadata: &Option<Value>,
    external_post_id: &str,
) -> Result<(), AppError> {
    if platform == "TIKTOK" {
        return Err(AppError::BadRequest(
            "TikTok does not currently expose a delete endpoint through the Content Posting API; delete the post in TikTok".to_string(),
        ));
    }
    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let client = reqwest::Client::new();
    match platform {
        "X" => {
            send_provider_delete(
                client
                    .delete(format!(
                        "{X_POST_TWEET_URL}/{}",
                        urlencoding::encode(external_post_id)
                    ))
                    .bearer_auth(access_token),
                "Failed to delete the X post",
            )
            .await
        }
        "FACEBOOK" => {
            send_provider_delete(
                client
                    .delete(format!(
                        "{META_GRAPH_BASE}/{}",
                        urlencoding::encode(external_post_id)
                    ))
                    .bearer_auth(access_token),
                "Failed to delete the Facebook post",
            )
            .await
        }
        "INSTAGRAM" => {
            let uses_instagram_login = connection_metadata
                .as_ref()
                .and_then(|value| value.get("authMethod"))
                .and_then(Value::as_str)
                == Some("instagram_login");
            let graph_base = if uses_instagram_login {
                INSTAGRAM_GRAPH_BASE
            } else {
                META_GRAPH_BASE
            };
            send_provider_delete(
                client
                    .delete(format!(
                        "{graph_base}/{}",
                        urlencoding::encode(external_post_id)
                    ))
                    .bearer_auth(access_token),
                "Failed to delete the Instagram post",
            )
            .await
        }
        "THREADS" => {
            send_provider_delete(
                client
                    .delete(format!(
                        "{THREADS_GRAPH_BASE}/{}",
                        urlencoding::encode(external_post_id)
                    ))
                    .bearer_auth(access_token),
                "Failed to delete the Threads post",
            )
            .await
        }
        "LINKEDIN" => {
            send_provider_delete(
                client
                    .delete(format!(
                        "{LINKEDIN_POSTS_URL}/{}",
                        urlencoding::encode(external_post_id)
                    ))
                    .bearer_auth(access_token)
                    .header("Linkedin-Version", LINKEDIN_API_VERSION)
                    .header("X-Restli-Protocol-Version", "2.0.0"),
                "Failed to delete the LinkedIn post",
            )
            .await
        }
        _ => Err(AppError::BadRequest(format!(
            "Deleting posts from {platform} is not supported"
        ))),
    }
}

pub(crate) async fn publish_post_to_x(
    access_token_encrypted: &str,
    text: &str,
    images: Vec<PublishImage>,
) -> Result<(String, String), AppError> {
    let access_token = decrypt_social_secret(access_token_encrypted)?;
    if images.len() > 4 {
        return Err(AppError::BadRequest(
            "X posts can include at most 4 images".to_string(),
        ));
    }
    let client = reqwest::Client::new();
    let mut media_ids = Vec::new();
    for image in images {
        if !matches!(
            image.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "image/bmp" | "image/pjpeg" | "image/tiff"
        ) {
            return Err(AppError::BadRequest(
                "X does not support this image format".to_string(),
            ));
        }
        let upload: Value = fetch_json(
            client
                .post("https://api.x.com/2/media/upload")
                .bearer_auth(&access_token)
                .json(&json!({
                    "media": STANDARD.encode(image.bytes),
                    "media_category": "tweet_image",
                    "media_type": image.mime_type,
                    "shared": false,
                })),
            "Failed to upload image to X",
        )
        .await?;
        let media_id = upload
            .get("data")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::BadRequest("X did not return a media id".to_string()))?;
        media_ids.push(media_id.to_string());
    }
    let mut request_body = json!({ "text": text });
    if !media_ids.is_empty() {
        request_body["media"] = json!({ "media_ids": media_ids });
    }
    let result: Value = fetch_json(
        client
            .post(X_POST_TWEET_URL)
            .bearer_auth(&access_token)
            .header("Content-Type", "application/json")
            .json(&request_body),
        "Failed to publish to X",
    )
    .await?;

    let id = result
        .get("data")
        .and_then(|value| value.get("id"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::BadRequest("X publish did not return a post id".to_string()))?;
    let published_text = result
        .get("data")
        .and_then(|value| value.get("text"))
        .and_then(|value| value.as_str())
        .unwrap_or(text);
    Ok((id.to_string(), published_text.to_string()))
}

pub(crate) async fn publish_post_to_linkedin(
    access_token_encrypted: &str,
    external_account_id: &Option<String>,
    metadata: &Option<Value>,
    text: &str,
    image: Option<PublishImage>,
) -> Result<(Option<String>, String), AppError> {
    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let actor_urn = metadata
        .as_ref()
        .and_then(|value| value.get("actorUrn"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| {
            external_account_id
                .as_ref()
                .map(|value| format!("urn:li:person:{value}"))
        })
        .ok_or_else(|| {
            AppError::BadRequest("LinkedIn connection is missing an actor identifier".to_string())
        })?;

    if let Some(image) = image {
        let client = reqwest::Client::new();
        let init: Value = fetch_json(
            client
                .post("https://api.linkedin.com/rest/images?action=initializeUpload")
                .bearer_auth(&access_token)
                .header("Content-Type", "application/json")
                .header("Linkedin-Version", LINKEDIN_API_VERSION)
                .header("X-Restli-Protocol-Version", "2.0.0")
                .json(&json!({ "initializeUploadRequest": { "owner": &actor_urn } })),
            "Failed to initialize LinkedIn image upload",
        )
        .await?;
        let upload_url = init
            .pointer("/value/uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::BadRequest("LinkedIn did not return an image upload URL".to_string())
            })?;
        let image_urn = init
            .pointer("/value/image")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::BadRequest("LinkedIn did not return an image identifier".to_string())
            })?;
        let parsed_upload_url = reqwest::Url::parse(upload_url).map_err(|_| {
            AppError::BadRequest("LinkedIn image upload URL is invalid".to_string())
        })?;
        if parsed_upload_url.scheme() != "https"
            || parsed_upload_url
                .host_str()
                .is_none_or(|host| host != "linkedin.com" && !host.ends_with(".linkedin.com"))
        {
            return Err(AppError::BadRequest(
                "LinkedIn image upload URL is not trusted".to_string(),
            ));
        }
        let upload_response = client
            .put(parsed_upload_url)
            .header("Content-Type", &image.mime_type)
            .body(image.bytes)
            .send()
            .await?;
        if !upload_response.status().is_success() {
            return Err(AppError::BadRequest(
                "Failed to upload image to LinkedIn".to_string(),
            ));
        }
        let response = client
            .post(LINKEDIN_POSTS_URL)
            .bearer_auth(&access_token)
            .header("Content-Type", "application/json")
            .header("Linkedin-Version", LINKEDIN_API_VERSION)
            .header("X-Restli-Protocol-Version", "2.0.0")
            .json(&json!({
                "author": &actor_urn,
                "commentary": text,
                "visibility": "PUBLIC",
                "distribution": {
                    "feedDistribution": "MAIN_FEED",
                    "targetEntities": [],
                    "thirdPartyDistributionChannels": []
                },
                "content": { "media": { "altText": image.alt_text, "id": image_urn } },
                "lifecycleState": "PUBLISHED",
                "isReshareDisabledByAuthor": false
            }))
            .send()
            .await?;
        let status = response.status();
        let external_post_id = response
            .headers()
            .get("x-restli-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.text().await?;
        if !status.is_success() {
            return Err(AppError::BadRequest(body));
        }
        return Ok((external_post_id, text.to_string()));
    }

    let response = reqwest::Client::new()
        .post(LINKEDIN_POSTS_URL)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("Linkedin-Version", LINKEDIN_API_VERSION)
        .header("X-Restli-Protocol-Version", "2.0.0")
        .json(&json!({
            "author": actor_urn,
            "commentary": text,
            "visibility": "PUBLIC",
            "distribution": {
                "feedDistribution": "MAIN_FEED",
                "targetEntities": [],
                "thirdPartyDistributionChannels": []
            },
            "lifecycleState": "PUBLISHED",
            "isReshareDisabledByAuthor": false
        }))
        .send()
        .await?;

    let headers = response.headers().clone();
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(AppError::BadRequest(body));
    }

    let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let external_post_id = headers
        .get("x-restli-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
        .or_else(|| {
            payload
                .get("id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        });
    Ok((external_post_id, text.to_string()))
}

pub(crate) async fn save_rotated_tokens(
    pool: &PgPool,
    channel_id: &str,
    access: &str,
    refresh: Option<&str>,
    expires_in: Option<i64>,
) -> Result<(), AppError> {
    let encrypted_access = encrypt_social_secret(access)?;
    let encrypted_refresh = match refresh {
        Some(value) => Some(encrypt_social_secret(value)?),
        None => None,
    };
    let expires_at =
        expires_in.map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());
    sqlx::query(
        r#"UPDATE "SocialChannelConnection" SET "accessToken"=$1,
        "refreshToken"=COALESCE($2,"refreshToken"), metadata=COALESCE(metadata,'{}'::jsonb) || $3,
        "lastSyncedAt"=NOW(), "updatedAt"=NOW() WHERE id=$4"#,
    )
    .bind(encrypted_access)
    .bind(encrypted_refresh)
    .bind(json!({"expiresAt": expires_at}))
    .bind(channel_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn publish_post_to_threads(
    access_token_encrypted: &str,
    user_id: &str,
    text: &str,
    image_url: Option<&str>,
) -> Result<(String, String), AppError> {
    if text.chars().count() > 500 {
        return Err(AppError::BadRequest(
            "Threads posts are limited to 500 characters".to_string(),
        ));
    }
    let access = decrypt_social_secret(access_token_encrypted)?;
    let mut create_form = vec![("text", text.to_string())];
    if let Some(image_url) = image_url {
        let parsed = reqwest::Url::parse(image_url)
            .map_err(|_| AppError::BadRequest("Threads image URL is invalid".to_string()))?;
        if parsed.scheme() != "https" {
            return Err(AppError::BadRequest(
                "Threads requires a public HTTPS image URL".to_string(),
            ));
        }
        create_form.push(("media_type", "IMAGE".to_string()));
        create_form.push(("image_url", image_url.to_string()));
    } else {
        create_form.push(("media_type", "TEXT".to_string()));
    }
    let create: Value = fetch_json(
        reqwest::Client::new()
            .post(format!(
                "{}/{}",
                super::social::THREADS_GRAPH_BASE,
                format!("{user_id}/threads")
            ))
            .bearer_auth(&access)
            .form(&create_form),
        "Failed to create Threads post",
    )
    .await?;
    let creation_id = create
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Threads did not return a creation id".to_string()))?;
    let publish: Value = fetch_json(
        reqwest::Client::new()
            .post(format!(
                "{}/{}",
                super::social::THREADS_GRAPH_BASE,
                format!("{user_id}/threads_publish")
            ))
            .bearer_auth(access)
            .form(&[("creation_id", creation_id)]),
        "Failed to publish Threads post",
    )
    .await?;
    let id = publish
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Threads did not return a post id".to_string()))?;
    Ok((id.to_string(), text.to_string()))
}

pub(crate) async fn refresh_threads_token(
    access_encrypted: &str,
) -> Result<ThreadsTokenResponse, AppError> {
    let access = decrypt_social_secret(access_encrypted)?;
    let url = format!(
        "https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token&access_token={}",
        urlencoding::encode(&access)
    );
    fetch_json(
        reqwest::Client::new().get(url),
        "Threads token refresh failed",
    )
    .await
}

pub(crate) async fn refresh_tiktok_token(
    refresh_encrypted: &str,
) -> Result<TikTokTokenResponse, AppError> {
    let refresh = decrypt_social_secret(refresh_encrypted)?;
    fetch_json(
        reqwest::Client::new().post(TIKTOK_TOKEN_URL).form(&[
            ("client_key", required_env("AUTH_TIKTOK_CLIENT_KEY")?),
            ("client_secret", required_env("AUTH_TIKTOK_CLIENT_SECRET")?),
            ("grant_type", "refresh_token".to_string()),
            ("refresh_token", refresh),
        ]),
        "TikTok token refresh failed",
    )
    .await
}

pub(crate) async fn publish_post_to_tiktok(
    access_token: &str,
    metadata: &Option<Value>,
    text: &str,
) -> Result<(String, String), AppError> {
    let consented = metadata
        .as_ref()
        .and_then(|v| v.get("tiktokConsent"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !consented {
        return Err(AppError::BadRequest(
            "TikTok publishing consent is required".to_string(),
        ));
    }
    let media_url = metadata
        .as_ref()
        .and_then(|v| v.get("tiktokMediaUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("Add a public HTTPS TikTok video or image URL".to_string())
        })?;
    if !media_url.starts_with("https://") {
        return Err(AppError::BadRequest(
            "TikTok media URL must use HTTPS".to_string(),
        ));
    }
    let media_type = metadata
        .as_ref()
        .and_then(|v| v.get("tiktokMediaType"))
        .and_then(Value::as_str)
        .unwrap_or("VIDEO");
    if media_type == "VIDEO" && text.encode_utf16().count() > 2200 {
        return Err(AppError::BadRequest(
            "TikTok video captions are limited to 2200 UTF-16 characters".to_string(),
        ));
    }
    if media_type == "PHOTO" && text.encode_utf16().count() > 4000 {
        return Err(AppError::BadRequest(
            "TikTok photo descriptions are limited to 4000 UTF-16 characters".to_string(),
        ));
    }
    let requested_privacy = metadata
        .as_ref()
        .and_then(|v| v.get("tiktokPrivacyLevel"))
        .and_then(Value::as_str)
        .unwrap_or("SELF_ONLY");
    let creator: Value = fetch_json(
        reqwest::Client::new()
            .post(TIKTOK_CREATOR_INFO_URL)
            .bearer_auth(access_token)
            .header("Content-Type", "application/json")
            .json(&json!({})),
        "Failed to query TikTok creator settings",
    )
    .await?;
    let allowed = creator
        .get("data")
        .and_then(|v| v.get("privacy_level_options"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    if !allowed.contains(&requested_privacy) {
        return Err(AppError::BadRequest(format!(
            "TikTok privacy level {requested_privacy} is not available for this account"
        )));
    }
    let (url, payload) = if media_type == "PHOTO" {
        (
            TIKTOK_PUBLISH_URL,
            json!({"post_info":{"title":text.chars().take(90).collect::<String>(),"description":text,"privacy_level":requested_privacy},
            "source_info":{"source":"PULL_FROM_URL","photo_cover_index":1,"photo_images":[media_url]},"post_mode":"DIRECT_POST","media_type":"PHOTO"}),
        )
    } else {
        (
            "https://open.tiktokapis.com/v2/post/publish/video/init/",
            json!({"post_info":{"title":text,"privacy_level":requested_privacy},
            "source_info":{"source":"PULL_FROM_URL","video_url":media_url}}),
        )
    };
    let result: Value = fetch_json(
        reqwest::Client::new()
            .post(url)
            .bearer_auth(access_token)
            .header("Content-Type", "application/json")
            .json(&payload),
        "Failed to publish to TikTok",
    )
    .await?;
    let code = result
        .get("error")
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("ok");
    if code != "ok" {
        return Err(AppError::BadRequest(
            result
                .get("error")
                .and_then(|v| v.get("message"))
                .and_then(Value::as_str)
                .unwrap_or(code)
                .to_string(),
        ));
    }
    let id = result
        .get("data")
        .and_then(|v| v.get("publish_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("TikTok did not return a publish id".to_string()))?;
    Ok((id.to_string(), text.to_string()))
}

pub(crate) async fn publish_post_to_facebook(
    access_token_encrypted: &str,
    external_account_id: &Option<String>,
    text: &str,
    image_url: Option<&str>,
) -> Result<(String, String), AppError> {
    let page_id = external_account_id.as_deref().ok_or_else(|| {
        AppError::BadRequest("Facebook connection is missing a Page identifier".to_string())
    })?;
    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let (endpoint, form) = match image_url {
        Some(image_url) => {
            let parsed = reqwest::Url::parse(image_url)
                .map_err(|_| AppError::BadRequest("Facebook image URL is invalid".to_string()))?;
            if parsed.scheme() != "https" {
                return Err(AppError::BadRequest(
                    "Facebook requires a public HTTPS image URL".to_string(),
                ));
            }
            (
                format!("{META_GRAPH_BASE}/{page_id}/photos"),
                vec![
                    ("url", image_url.to_string()),
                    ("caption", text.to_string()),
                ],
            )
        }
        None => (
            format!("{META_GRAPH_BASE}/{page_id}/feed"),
            vec![("message", text.to_string())],
        ),
    };
    let result: Value = fetch_json(
        reqwest::Client::new()
            .post(endpoint)
            .bearer_auth(access_token)
            .form(&form),
        "Failed to publish to Facebook",
    )
    .await?;

    let id = result.get("id").and_then(Value::as_str).ok_or_else(|| {
        AppError::BadRequest("Facebook publish did not return a post id".to_string())
    })?;
    Ok((id.to_string(), text.to_string()))
}

pub(crate) async fn publish_post_to_instagram(
    access_token_encrypted: &str,
    external_account_id: &Option<String>,
    connection_metadata: &Option<Value>,
    image_url: &str,
    caption: &str,
) -> Result<(String, String), AppError> {
    let account_id = external_account_id.as_deref().ok_or_else(|| {
        AppError::BadRequest("Instagram connection is missing an account identifier".to_string())
    })?;
    let parsed_image_url = reqwest::Url::parse(image_url)
        .map_err(|_| AppError::BadRequest("Instagram image URL is invalid".to_string()))?;
    if parsed_image_url.scheme() != "https" {
        return Err(AppError::BadRequest(
            "Instagram requires a public HTTPS image URL".to_string(),
        ));
    }

    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let uses_instagram_login = connection_metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        == Some("instagram_login");
    let graph_base = if uses_instagram_login {
        INSTAGRAM_GRAPH_BASE
    } else {
        META_GRAPH_BASE
    };
    let client = reqwest::Client::new();
    let container: Value = fetch_json(
        client
            .post(format!("{graph_base}/{account_id}/media"))
            .bearer_auth(&access_token)
            .form(&[
                ("image_url", image_url.to_string()),
                ("caption", caption.to_string()),
            ]),
        "Failed to create the Instagram media container",
    )
    .await?;
    let creation_id = container.get("id").and_then(Value::as_str).ok_or_else(|| {
        AppError::BadRequest("Instagram did not return a media container identifier".to_string())
    })?;
    let published: Value = fetch_json(
        client
            .post(format!("{graph_base}/{account_id}/media_publish"))
            .bearer_auth(access_token)
            .form(&[("creation_id", creation_id)]),
        "Failed to publish the Instagram post",
    )
    .await?;
    let post_id = published.get("id").and_then(Value::as_str).ok_or_else(|| {
        AppError::BadRequest("Instagram did not return a published media id".to_string())
    })?;
    Ok((post_id.to_string(), caption.to_string()))
}
