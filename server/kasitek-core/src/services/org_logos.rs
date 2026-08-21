//! Workspace organization logo storage.
//!
//! Logos use the same mounted local media root as social uploads, but keep a
//! stable organization-scoped URL so the value stored on `Organization` does
//! not expose a filesystem path or expire like a signed public media URL.

use actix_multipart::Multipart;
use actix_web::HttpResponse;
use futures_util::StreamExt;
use sqlx::PgPool;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::orgs;

const MAX_LOGO_BYTES: usize = 5 * 1024 * 1024;
const LOGO_URL_PREFIX: &str = "/api/orgs/";

struct LogoUpload {
    mime_type: String,
    bytes: Vec<u8>,
}

fn allowed_mime(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    )
}

fn matches_file_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    }
}

fn logo_path(config: &AppConfig, org_id: &str) -> Result<PathBuf, AppError> {
    let root = PathBuf::from(&config.media_storage_path);
    let path = root
        .join("organization-logos")
        .join(format!("{org_id}.image"));
    if path.strip_prefix(&root).ok().is_none_or(|relative| {
        relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    }) {
        return Err(AppError::Internal(
            "Invalid organization logo path".to_string(),
        ));
    }
    Ok(path)
}

async fn read_upload(mut payload: Multipart) -> Result<LogoUpload, AppError> {
    let mut upload: Option<LogoUpload> = None;

    while let Some(field) = payload.next().await {
        let mut field =
            field.map_err(|_| AppError::BadRequest("Failed to read logo upload".to_string()))?;
        if field.name() != Some("file") {
            continue;
        }

        let mime_type = field
            .content_type()
            .map(|value| value.essence_str().to_ascii_lowercase())
            .ok_or_else(|| {
                AppError::BadRequest("The logo file must include a MIME type".to_string())
            })?;
        let mut bytes = Vec::new();
        while let Some(chunk) = field.next().await {
            let chunk =
                chunk.map_err(|_| AppError::BadRequest("Failed to read logo bytes".to_string()))?;
            bytes.extend_from_slice(&chunk);
            if bytes.len() > MAX_LOGO_BYTES {
                return Err(AppError::BadRequest(
                    "Organization logos must be 5 MB or smaller".to_string(),
                ));
            }
        }
        upload = Some(LogoUpload { mime_type, bytes });
    }

    let upload = upload.ok_or_else(|| {
        AppError::BadRequest("A logo file is required in form-data field: file".to_string())
    })?;
    if upload.bytes.is_empty() {
        return Err(AppError::BadRequest(
            "The logo file cannot be empty".to_string(),
        ));
    }
    if !allowed_mime(&upload.mime_type) {
        return Err(AppError::BadRequest(
            "Use a PNG, JPEG, WebP, or GIF image for the organization logo".to_string(),
        ));
    }
    if !matches_file_signature(&upload.mime_type, &upload.bytes) {
        return Err(AppError::BadRequest(
            "The file contents do not match the declared image format".to_string(),
        ));
    }
    Ok(upload)
}

fn mime_type_for_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

pub fn logo_url(org_id: &str, revision: &str) -> String {
    format!("{LOGO_URL_PREFIX}{org_id}/logo?v={revision}")
}

pub async fn upload(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    payload: Multipart,
) -> Result<orgs::OrgRow, AppError> {
    let upload = read_upload(payload).await?;
    let path = logo_path(config, org_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| AppError::Internal("Failed to prepare logo storage".to_string()))?;
    }

    // Write beside the final object and rename so a concurrent image request
    // never observes a partially written logo.
    let temporary_path = path.with_extension(format!("upload-{}", cuid2::create_id()));
    let write_result = async {
        let mut file = tokio::fs::File::create(&temporary_path)
            .await
            .map_err(|_| AppError::Internal("Failed to create logo storage object".to_string()))?;
        file.write_all(&upload.bytes)
            .await
            .map_err(|_| AppError::Internal("Failed to write logo storage object".to_string()))?;
        file.flush().await.map_err(|_| {
            AppError::Internal("Failed to finalize logo storage object".to_string())
        })?;
        tokio::fs::rename(&temporary_path, &path)
            .await
            .map_err(|_| AppError::Internal("Failed to publish logo storage object".to_string()))
    }
    .await;
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return Err(error);
    }

    let logo = logo_url(org_id, &cuid2::create_id());
    orgs::update_org(pool, org_id, None, Some(Some(&logo))).await
}

pub async fn download(config: &AppConfig, org_id: &str) -> Result<HttpResponse, AppError> {
    let path = logo_path(config, org_id)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| AppError::NotFound("Organization logo not found".to_string()))?;
    let mime_type = mime_type_for_bytes(&bytes)
        .ok_or_else(|| AppError::NotFound("Organization logo is not available".to_string()))?;
    Ok(HttpResponse::Ok()
        .content_type(mime_type)
        .insert_header(("Cache-Control", "private, max-age=300, must-revalidate"))
        .body(bytes))
}

#[cfg(test)]
mod tests {
    use super::{allowed_mime, matches_file_signature};

    #[test]
    fn accepts_only_supported_logo_formats() {
        assert!(allowed_mime("image/png"));
        assert!(allowed_mime("image/webp"));
        assert!(!allowed_mime("image/svg+xml"));
        assert!(!allowed_mime("application/pdf"));
    }

    #[test]
    fn validates_logo_signatures() {
        assert!(matches_file_signature(
            "image/png",
            b"\x89PNG\r\n\x1a\nrest"
        ));
        assert!(!matches_file_signature("image/png", b"not an image"));
    }
}
