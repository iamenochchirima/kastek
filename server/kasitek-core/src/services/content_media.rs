//! Workspace-owned content media storage and attachment helpers.
//!
//! The local filesystem adapter keeps development self-contained. The database
//! record is the source of truth and the generated storage key is never
//! accepted from the browser, so moving the adapter to object storage does not
//! change the composer or post contracts.

use actix_multipart::Multipart;
use actix_web::HttpResponse;
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

use crate::config::AppConfig;
use crate::error::AppError;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 512 * 1024 * 1024;
const MAX_AUDIO_BYTES: u64 = 25 * 1024 * 1024;
const PUBLIC_MEDIA_TTL_SECONDS: i64 = 15 * 60;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMediaAssetView {
    pub id: String,
    pub kind: String,
    pub mime_type: String,
    pub file_name: Option<String>,
    pub byte_size: i64,
    pub checksum: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i32>,
    pub processing_status: String,
    pub scan_status: String,
    pub created_at: String,
}

#[derive(Debug)]
struct UploadFields {
    file_name: Option<String>,
    mime_type: Option<String>,
    bytes: Vec<u8>,
    width: Option<i32>,
    height: Option<i32>,
    duration_ms: Option<i32>,
}

#[derive(Debug)]
pub struct ContentMediaBytesUpload {
    pub file_name: Option<String>,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub source: String,
    pub source_key: Option<String>,
}

#[derive(Debug)]
pub struct StoredContentMedia {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub checksum: Option<String>,
}

fn media_kind(mime_type: &str) -> Option<&'static str> {
    if mime_type.starts_with("image/") {
        Some("IMAGE")
    } else if mime_type.starts_with("video/") {
        Some("VIDEO")
    } else if mime_type.starts_with("audio/") || mime_type == "application/ogg" {
        Some("AUDIO")
    } else {
        None
    }
}

fn allowed_mime(mime_type: &str, kind: &str) -> bool {
    match kind {
        "IMAGE" => matches!(
            mime_type,
            "image/jpeg" | "image/png" | "image/webp" | "image/gif"
        ),
        "VIDEO" => matches!(mime_type, "video/mp4" | "video/webm" | "video/quicktime"),
        "AUDIO" => matches!(
            mime_type,
            "audio/aac"
                | "audio/flac"
                | "audio/mp4"
                | "audio/m4a"
                | "audio/mpeg"
                | "audio/ogg"
                | "audio/opus"
                | "audio/wav"
                | "audio/webm"
                | "application/ogg"
        ),
        _ => false,
    }
}

fn matches_file_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "video/mp4" | "video/quicktime" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "video/webm" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "audio/aac" => bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xf6) == 0xf0,
        "audio/flac" => bytes.starts_with(b"fLaC"),
        "audio/mp4" | "audio/m4a" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "audio/mpeg" => {
            bytes.starts_with(b"ID3")
                || (bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
        }
        "audio/ogg" | "audio/opus" | "application/ogg" => bytes.starts_with(b"OggS"),
        "audio/wav" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE",
        "audio/webm" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        _ => false,
    }
}

fn safe_file_name(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let name = Path::new(value).file_name()?.to_string_lossy();
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn extension_for(mime_type: &str, file_name: Option<&str>) -> String {
    match mime_type {
        "image/jpeg" => "jpg".to_string(),
        "image/png" => "png".to_string(),
        "image/webp" => "webp".to_string(),
        "image/gif" => "gif".to_string(),
        "video/webm" => "webm".to_string(),
        "video/quicktime" => "mov".to_string(),
        "video/mp4" => "mp4".to_string(),
        "audio/aac" => "aac".to_string(),
        "audio/flac" => "flac".to_string(),
        "audio/mp4" | "audio/m4a" => "m4a".to_string(),
        "audio/mpeg" => "mp3".to_string(),
        "audio/ogg" | "application/ogg" => "ogg".to_string(),
        "audio/opus" => "opus".to_string(),
        "audio/wav" => "wav".to_string(),
        "audio/webm" => "webm".to_string(),
        _ => file_name
            .and_then(|name| Path::new(name).extension().and_then(|value| value.to_str()))
            .filter(|value| value.len() <= 8)
            .unwrap_or("bin")
            .to_string(),
    }
}

fn parse_i32(value: &[u8], name: &str) -> Result<Option<i32>, AppError> {
    let value = std::str::from_utf8(value)
        .map_err(|_| AppError::BadRequest(format!("{name} must be valid text")))?
        .trim();
    if value.is_empty() {
        return Ok(None);
    }
    let parsed = value
        .parse::<i32>()
        .map_err(|_| AppError::BadRequest(format!("{name} must be a whole number")))?;
    if parsed < 0 {
        return Err(AppError::BadRequest(format!("{name} cannot be negative")));
    }
    Ok(Some(parsed))
}

async fn read_upload(mut payload: Multipart) -> Result<UploadFields, AppError> {
    let mut upload = UploadFields {
        file_name: None,
        mime_type: None,
        bytes: Vec::new(),
        width: None,
        height: None,
        duration_ms: None,
    };

    while let Some(field) = payload.next().await {
        let mut field =
            field.map_err(|_| AppError::BadRequest("Failed to read media upload".to_string()))?;
        let Some(name) = field.name().map(str::to_string) else {
            continue;
        };

        if name == "file" {
            upload.file_name = safe_file_name(
                field
                    .content_disposition()
                    .and_then(|disposition| disposition.get_filename()),
            );
            upload.mime_type = field
                .content_type()
                .map(|value| value.essence_str().to_ascii_lowercase());
            while let Some(chunk) = field.next().await {
                let chunk = chunk
                    .map_err(|_| AppError::BadRequest("Failed to read media bytes".to_string()))?;
                upload.bytes.extend_from_slice(&chunk);
                if upload.bytes.len() as u64 > MAX_VIDEO_BYTES {
                    return Err(AppError::BadRequest(
                        "Videos must be 512 MB or smaller".to_string(),
                    ));
                }
            }
        } else {
            let mut value = Vec::new();
            while let Some(chunk) = field.next().await {
                let chunk = chunk.map_err(|_| {
                    AppError::BadRequest("Failed to read media metadata".to_string())
                })?;
                value.extend_from_slice(&chunk);
                if value.len() > 1024 {
                    return Err(AppError::BadRequest(
                        "Media metadata is too large".to_string(),
                    ));
                }
            }
            match name.as_str() {
                "width" => upload.width = parse_i32(&value, "width")?,
                "height" => upload.height = parse_i32(&value, "height")?,
                "durationMs" => upload.duration_ms = parse_i32(&value, "durationMs")?,
                _ => {}
            }
        }
    }

    if upload.bytes.is_empty() {
        return Err(AppError::BadRequest(
            "A media file is required in form-data field: file".to_string(),
        ));
    }
    Ok(upload)
}

fn storage_path(config: &AppConfig, key: &str) -> Result<PathBuf, AppError> {
    let root = PathBuf::from(&config.media_storage_path);
    let path = root.join(key);
    if path.strip_prefix(&root).ok().is_none_or(|relative| {
        relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    }) {
        return Err(AppError::Internal("Invalid media storage key".to_string()));
    }
    Ok(path)
}

fn public_media_signature(config: &AppConfig, asset_id: &str, expires: i64) -> String {
    let mut mac = HmacSha256::new_from_slice(config.session_secret.as_bytes())
        .expect("HMAC accepts keys of every length");
    mac.update(format!("{asset_id}:{expires}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn public_media_url(config: &AppConfig, asset_id: &str) -> String {
    let expires = chrono::Utc::now().timestamp() + PUBLIC_MEDIA_TTL_SECONDS;
    let signature = public_media_signature(config, asset_id, expires);
    format!(
        "{}/api/social/media/{}/public?expires={expires}&signature={signature}",
        config.public_api_url.trim_end_matches('/'),
        urlencoding::encode(asset_id)
    )
}

async fn asset_view(
    pool: &PgPool,
    org_id: &str,
    asset_id: &str,
) -> Result<Option<ContentMediaAssetView>, AppError> {
    sqlx::query_as::<_, ContentMediaAssetViewRow>(
        r#"
        SELECT id, kind::text AS kind, "mimeType" AS mime_type, "fileName" AS file_name,
               "byteSize" AS byte_size, checksum, width, height, "durationMs" AS duration_ms,
               "processingStatus"::text AS processing_status, "scanStatus"::text AS scan_status,
               "createdAt"::text AS created_at
        FROM "ContentMediaAsset"
        WHERE id = $1 AND "orgId" = $2
        "#,
    )
    .bind(asset_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map(|row| row.map(ContentMediaAssetView::from))
    .map_err(AppError::from)
}

#[derive(Debug, sqlx::FromRow)]
struct ContentMediaAssetViewRow {
    id: String,
    kind: String,
    mime_type: String,
    file_name: Option<String>,
    byte_size: i64,
    checksum: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    duration_ms: Option<i32>,
    processing_status: String,
    scan_status: String,
    created_at: String,
}

impl From<ContentMediaAssetViewRow> for ContentMediaAssetView {
    fn from(row: ContentMediaAssetViewRow) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            mime_type: row.mime_type,
            file_name: row.file_name,
            byte_size: row.byte_size,
            checksum: row.checksum,
            width: row.width,
            height: row.height,
            duration_ms: row.duration_ms,
            processing_status: row.processing_status,
            scan_status: row.scan_status,
            created_at: row.created_at,
        }
    }
}

pub async fn upload_content_media(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    org_id: &str,
    payload: Multipart,
) -> Result<ContentMediaAssetView, AppError> {
    let upload = read_upload(payload).await?;
    persist_content_media(
        pool,
        config,
        user_id,
        org_id,
        upload,
        json!({ "adapter": "local", "source": "content_upload" }),
    )
    .await
}

pub async fn upload_content_media_bytes(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    org_id: &str,
    upload: ContentMediaBytesUpload,
) -> Result<ContentMediaAssetView, AppError> {
    let requested_checksum = hex::encode(Sha256::digest(&upload.bytes));
    if let Some(source_key) = upload
        .source_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let existing = sqlx::query_as::<_, ExistingContentMediaIdentity>(
            r#"SELECT id, "mimeType" AS mime_type, "byteSize" AS byte_size, checksum
               FROM "ContentMediaAsset"
               WHERE "orgId" = $1 AND metadata->>'sourceKey' = $2
               ORDER BY "createdAt" DESC LIMIT 1"#,
        )
        .bind(org_id)
        .bind(source_key)
        .fetch_optional(pool)
        .await?;
        if let Some(existing) = existing {
            if !same_media_identity(
                &existing,
                upload.mime_type.trim(),
                upload.bytes.len() as i64,
                &requested_checksum,
            ) {
                return Err(AppError::Conflict(
                    "Media idempotency key already belongs to different media".to_string(),
                ));
            }
            if let Some(asset) = asset_view(pool, org_id, &existing.id).await? {
                return Ok(asset);
            }
        }
    }

    let metadata = json!({
        "adapter": "local",
        "source": upload.source,
        "sourceKey": upload.source_key,
    });
    persist_content_media(
        pool,
        config,
        user_id,
        org_id,
        UploadFields {
            file_name: safe_file_name(upload.file_name.as_deref()),
            mime_type: Some(upload.mime_type.trim().to_ascii_lowercase()),
            bytes: upload.bytes,
            width: None,
            height: None,
            duration_ms: None,
        },
        metadata,
    )
    .await
}

async fn persist_content_media(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    org_id: &str,
    upload: UploadFields,
    metadata: serde_json::Value,
) -> Result<ContentMediaAssetView, AppError> {
    let mime_type = upload.mime_type.as_deref().ok_or_else(|| {
        AppError::BadRequest("The media file must include a MIME type".to_string())
    })?;
    let kind = media_kind(mime_type).ok_or_else(|| {
        AppError::BadRequest("Only image, video, and audio files are supported".to_string())
    })?;
    if !allowed_mime(mime_type, kind) {
        return Err(AppError::BadRequest(format!(
            "Unsupported {kind} media format"
        )));
    }
    if !matches_file_signature(mime_type, &upload.bytes) {
        return Err(AppError::BadRequest(
            "The file contents do not match the declared media format".to_string(),
        ));
    }
    let max_bytes = match kind {
        "IMAGE" => MAX_IMAGE_BYTES,
        "VIDEO" => MAX_VIDEO_BYTES,
        "AUDIO" => MAX_AUDIO_BYTES,
        _ => unreachable!("media_kind only returns supported kinds"),
    };
    if upload.bytes.len() as u64 > max_bytes {
        return Err(AppError::BadRequest(format!(
            "{kind} files must be {} MB or smaller",
            max_bytes / 1024 / 1024
        )));
    }
    if kind == "IMAGE" && upload.duration_ms.is_some() {
        return Err(AppError::BadRequest(
            "Images cannot include a duration".to_string(),
        ));
    }
    if kind == "VIDEO" && upload.duration_ms.is_some_and(|value| value == 0) {
        return Err(AppError::BadRequest(
            "Video duration must be greater than zero".to_string(),
        ));
    }

    let id = cuid2::create_id();
    let checksum = hex::encode(Sha256::digest(&upload.bytes));
    let storage_key = format!(
        "{org_id}/{id}.{}",
        extension_for(mime_type, upload.file_name.as_deref())
    );
    let path = storage_path(config, &storage_key)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| AppError::Internal("Failed to prepare media storage".to_string()))?;
    }
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|_| AppError::Internal("Failed to create media storage object".to_string()))?;
    file.write_all(&upload.bytes)
        .await
        .map_err(|_| AppError::Internal("Failed to write media storage object".to_string()))?;
    file.flush()
        .await
        .map_err(|_| AppError::Internal("Failed to finalize media storage object".to_string()))?;

    let insert = sqlx::query(
        r#"
        INSERT INTO "ContentMediaAsset" (
            id, "orgId", "uploadedById", kind, "fileName", "mimeType", "byteSize", checksum,
            width, height, "durationMs", "storageKey", "processingStatus", "scanStatus", metadata,
            "createdAt", "updatedAt"
        ) VALUES (
            $1, $2, $3, CAST($4 AS "ContentMediaKind"), $5, $6, $7, $8, $9, $10, $11, $12,
            'READY'::"ContentMediaProcessingStatus", 'CLEAN'::"ContentMediaScanStatus", $13, NOW(), NOW()
        )
        "#,
    )
    .bind(&id)
    .bind(org_id)
    .bind(user_id)
    .bind(kind)
    .bind(upload.file_name.as_deref())
    .bind(mime_type)
    .bind(upload.bytes.len() as i64)
    .bind(&checksum)
    .bind(upload.width)
    .bind(upload.height)
    .bind(upload.duration_ms)
    .bind(&storage_key)
    .bind(metadata)
    .execute(pool)
    .await;

    if let Err(error) = insert {
        let _ = tokio::fs::remove_file(path).await;
        return Err(error.into());
    }

    asset_view(pool, org_id, &id)
        .await?
        .ok_or_else(|| AppError::Internal("Uploaded media could not be reloaded".to_string()))
}

pub async fn download_content_media(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    asset_id: &str,
) -> Result<HttpResponse, AppError> {
    let row = sqlx::query_as::<_, ContentMediaDownloadRow>(
        r#"
        SELECT "storageKey" AS storage_key, "mimeType" AS mime_type, "fileName" AS file_name, checksum,
               "processingStatus"::text AS processing_status, "scanStatus"::text AS scan_status
        FROM "ContentMediaAsset"
        WHERE id = $1 AND "orgId" = $2
        "#,
    )
    .bind(asset_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Media asset not found".to_string()))?;
    if row.processing_status != "READY" || row.scan_status != "CLEAN" {
        return Err(AppError::Conflict("Media asset is not ready".to_string()));
    }
    let path = storage_path(config, &row.storage_key)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| AppError::NotFound("Media file is no longer available".to_string()))?;
    let mut response = HttpResponse::Ok();
    response.content_type(row.mime_type);
    if let Some(file_name) = row.file_name {
        response.insert_header((
            "Content-Disposition",
            format!("inline; filename=\"{}\"", file_name.replace('"', "")),
        ));
    }
    Ok(response.body(bytes))
}

pub async fn read_content_media_bytes(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    asset_id: &str,
) -> Result<StoredContentMedia, AppError> {
    let row = sqlx::query_as::<_, ContentMediaDownloadRow>(
        r#"
        SELECT "storageKey" AS storage_key, "mimeType" AS mime_type, "fileName" AS file_name, checksum,
               "processingStatus"::text AS processing_status, "scanStatus"::text AS scan_status
        FROM "ContentMediaAsset"
        WHERE id = $1 AND "orgId" = $2
        "#,
    )
    .bind(asset_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Media asset not found".to_string()))?;
    if row.processing_status != "READY" || row.scan_status != "CLEAN" {
        return Err(AppError::BadRequest("Media asset is not ready".to_string()));
    }
    let bytes = tokio::fs::read(storage_path(config, &row.storage_key)?)
        .await
        .map_err(|_| AppError::NotFound("Media object not found".to_string()))?;
    Ok(StoredContentMedia {
        bytes,
        mime_type: row.mime_type,
        checksum: row.checksum,
    })
}

pub async fn delete_audio_content_media(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    asset_id: &str,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, ContentMediaDeleteRow>(
        r#"
        SELECT kind::text AS kind, "storageKey" AS storage_key,
               "previewStorageKey" AS preview_storage_key
        FROM "ContentMediaAsset"
        WHERE id = $1 AND "orgId" = $2
        FOR UPDATE
        "#,
    )
    .bind(asset_id)
    .bind(org_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    if row.kind != "AUDIO" {
        return Err(AppError::BadRequest(
            "Only audio media can be deleted by the transcription lifecycle".to_string(),
        ));
    }
    let referenced = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
             SELECT 1 FROM "SocialPostMedia" WHERE "assetId" = $1
           )"#,
    )
    .bind(asset_id)
    .fetch_one(&mut *tx)
    .await?;
    if referenced {
        return Err(AppError::Conflict(
            "Audio media is still attached to published content".to_string(),
        ));
    }

    let object_path = storage_path(config, &row.storage_key)?;
    let preview_path = row
        .preview_storage_key
        .as_deref()
        .map(|key| storage_path(config, key))
        .transpose()?;
    for path in [Some(object_path), preview_path].into_iter().flatten() {
        match tokio::fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(AppError::Internal(
                    "The media storage object could not be removed; metadata was retained for retry"
                        .to_string(),
                ));
            }
        }
    }

    sqlx::query(r#"DELETE FROM "ContentMediaAsset" WHERE id = $1 AND "orgId" = $2"#)
        .bind(asset_id)
        .bind(org_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn download_public_content_media(
    pool: &PgPool,
    config: &AppConfig,
    asset_id: &str,
    expires: i64,
    signature: &str,
) -> Result<HttpResponse, AppError> {
    if expires < chrono::Utc::now().timestamp()
        || public_media_signature(config, asset_id, expires) != signature
    {
        return Err(AppError::Unauthorized);
    }
    // Provider fetches are external and cannot be retried by the provider if
    // this endpoint briefly loses a pooled database connection. Retry the
    // small metadata lookup here so a transient Core/DB blip does not become
    // an opaque "invalid media type" error at Instagram or Meta.
    let mut row = None;
    for attempt in 0..3 {
        match sqlx::query_as::<_, ContentMediaDownloadRow>(
            r#"
            SELECT "storageKey" AS storage_key, "mimeType" AS mime_type, "fileName" AS file_name,
                   "processingStatus"::text AS processing_status, "scanStatus"::text AS scan_status
            FROM "ContentMediaAsset"
            WHERE id = $1
            "#,
        )
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        {
            Ok(value) => {
                row = value;
                break;
            }
            Err(error) if attempt < 2 => {
                observability::tracing::warn!(
                    event = "dependency.unavailable",
                    dependency = "postgres",
                    operation = "content_media.public_read.retry",
                    attempt = attempt + 1,
                    error_type = %std::any::type_name_of_val(&error),
                    "public media metadata lookup failed; retrying"
                );
                tokio::time::sleep(Duration::from_millis(100 * (attempt as u64 + 1))).await;
            }
            Err(error) => return Err(AppError::from(error)),
        }
    }
    let row = row.ok_or_else(|| AppError::NotFound("Media asset not found".to_string()))?;
    if row.processing_status != "READY" || row.scan_status != "CLEAN" {
        return Err(AppError::Conflict("Media asset is not ready".to_string()));
    }
    let path = storage_path(config, &row.storage_key)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| AppError::NotFound("Media file is no longer available".to_string()))?;
    let mut response = HttpResponse::Ok();
    response.content_type(row.mime_type);
    response.insert_header(("Cache-Control", "private, max-age=900"));
    if let Some(file_name) = row.file_name {
        response.insert_header((
            "Content-Disposition",
            format!("inline; filename=\"{}\"", file_name.replace('"', "")),
        ));
    }
    Ok(response.body(bytes))
}

#[derive(Debug, sqlx::FromRow)]
struct ContentMediaDownloadRow {
    storage_key: String,
    mime_type: String,
    file_name: Option<String>,
    checksum: Option<String>,
    processing_status: String,
    scan_status: String,
}

#[derive(Debug, sqlx::FromRow)]
struct ExistingContentMediaIdentity {
    id: String,
    mime_type: String,
    byte_size: i64,
    checksum: Option<String>,
}

fn same_media_identity(
    existing: &ExistingContentMediaIdentity,
    mime_type: &str,
    byte_size: i64,
    checksum: &str,
) -> bool {
    existing.mime_type == mime_type.trim().to_ascii_lowercase()
        && existing.byte_size == byte_size
        && existing.checksum.as_deref() == Some(checksum)
}

#[derive(Debug, sqlx::FromRow)]
struct ContentMediaDeleteRow {
    kind: String,
    storage_key: String,
    preview_storage_key: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        matches_file_signature, media_kind, same_media_identity, ExistingContentMediaIdentity,
    };

    #[test]
    fn classifies_audio_mime_types_including_ogg_variant() {
        assert_eq!(media_kind("audio/webm"), Some("AUDIO"));
        assert_eq!(media_kind("application/ogg"), Some("AUDIO"));
        assert_eq!(media_kind("application/octet-stream"), None);
    }

    #[test]
    fn validates_audio_signatures() {
        assert!(matches_file_signature("audio/ogg", b"OggS-opus"));
        assert!(matches_file_signature("application/ogg", b"OggS-opus"));
        assert!(matches_file_signature(
            "audio/webm",
            &[0x1a, 0x45, 0xdf, 0xa3]
        ));
        assert!(!matches_file_signature("audio/wav", b"OggS-opus"));
    }

    #[test]
    fn rejects_a_reused_source_key_when_the_media_identity_changes() {
        let existing = ExistingContentMediaIdentity {
            id: "asset-1".to_string(),
            mime_type: "audio/ogg".to_string(),
            byte_size: 8,
            checksum: Some(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            ),
        };
        assert!(same_media_identity(
            &existing,
            " audio/ogg ",
            8,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ));
        assert!(!same_media_identity(
            &existing,
            "audio/ogg",
            8,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ));
    }
}
