use actix_web::{web, Error, HttpRequest, HttpResponse};
use async_stream::stream;
use bytes::Bytes;
use futures_util::StreamExt;
use sqlx::PgPool;

use crate::middleware::extract_user;
use crate::services::realtime;

pub async fn whatsapp_stream(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, Error> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let channel = realtime::build_whatsapp_user_channel(&user.id);
    let pubsub = realtime::create_pubsub().await?;

    let response_stream = stream! {
        yield Ok::<Bytes, Error>(Bytes::from_static(b"event: ready\ndata: {}\n\n"));

        let Some(mut pubsub) = pubsub else {
            log::warn!("[realtime] no redis client available, falling back to keepalive-only mode");
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                yield Ok(Bytes::from_static(b": keepalive\n\n"));
            }
        };

        log::info!("[realtime] subscribing to channel: {}", channel);
        if let Err(error) = pubsub.subscribe(&channel).await {
            log::error!("[realtime] failed to subscribe to {}: {}", channel, error);
            yield Err(actix_web::error::ErrorInternalServerError(error));
            return;
        }
        log::info!("[realtime] subscribed to {} successfully", channel);

        let mut messages = pubsub.on_message();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {
                    yield Ok(Bytes::from_static(b": keepalive\n\n"));
                }
                next = messages.next() => {
                    let Some(message) = next else {
                        break;
                    };
                    match message.get_payload::<String>() {
                        Ok(payload) => {
                            let line = format!("data: {payload}\n\n");
                            yield Ok(Bytes::from(line));
                        }
                        Err(error) => {
                            yield Err(actix_web::error::ErrorInternalServerError(error));
                            break;
                        }
                    }
                }
            }
        }
    };

    Ok(HttpResponse::Ok()
        .append_header(("Content-Type", "text/event-stream"))
        .append_header(("Cache-Control", "no-cache, no-transform"))
        .append_header(("Connection", "keep-alive"))
        .streaming(response_stream))
}
