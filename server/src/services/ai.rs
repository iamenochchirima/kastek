use serde_json::{json, Value};
use sqlx::PgPool;

use crate::db::models::{BusinessProfileRow, SocialCaptionRequest, SocialIdeasRequest};
use crate::error::AppError;

const PLATFORM_VALUES: &[&str] = &["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X", "WHATSAPP_STATUS"];

fn get_openrouter_api_key() -> Result<String, AppError> {
    std::env::var("OPENROUTER_API_KEY")
        .map_err(|_| AppError::Internal("OPENROUTER_API_KEY is required".to_string()))
}

fn get_openrouter_model() -> String {
    std::env::var("OPENROUTER_MODEL").unwrap_or_else(|_| "openai/gpt-4.1-mini".to_string())
}

fn get_app_url() -> String {
    std::env::var("AUTH_URL")
        .or_else(|_| std::env::var("NEXT_PUBLIC_APP_URL"))
        .unwrap_or_else(|_| "http://localhost:3000".to_string())
}

fn get_platform_label(platform: &str) -> &'static str {
    match platform {
        "FACEBOOK" => "Facebook",
        "INSTAGRAM" => "Instagram",
        "LINKEDIN" => "LinkedIn",
        "X" => "X",
        _ => "WhatsApp Status",
    }
}

fn sanitize_channels(channels: Option<Vec<String>>) -> Vec<String> {
    channels
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_uppercase())
        .filter(|value| PLATFORM_VALUES.contains(&value.as_str()))
        .collect()
}

async fn load_business_profile(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<BusinessProfileRow>, AppError> {
    sqlx::query_as::<_, BusinessProfileRow>(
        r#"
        SELECT "businessName", "businessType", industry, description, city, province, country, website
        FROM "BusinessProfile"
        WHERE "userId" = $1
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn generate_with_openrouter(messages: Vec<Value>) -> Result<String, AppError> {
    let response = reqwest::Client::new()
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header(
            "Authorization",
            format!("Bearer {}", get_openrouter_api_key()?),
        )
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", get_app_url())
        .header("X-OpenRouter-Title", "KasiTek KasiSocial")
        .json(&json!({
            "model": get_openrouter_model(),
            "temperature": 0.7,
            "max_tokens": 700,
            "response_format": { "type": "json_object" },
            "messages": messages,
        }))
        .send()
        .await?;
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("OpenRouter request failed");
        return Err(AppError::Internal(message.to_string()));
    }
    payload
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Internal("OpenRouter returned an empty response".to_string()))
}

pub async fn generate_social_ideas(
    pool: &PgPool,
    user_id: &str,
    input: SocialIdeasRequest,
) -> Result<Value, AppError> {
    let topic = input.topic.as_deref().map(str::trim).unwrap_or("");
    let objective = input.objective.as_deref().map(str::trim).unwrap_or("");
    let channels = sanitize_channels(input.channels);
    if topic.is_empty() && objective.is_empty() {
        return Err(AppError::BadRequest(
            "Add a topic or objective before generating ideas".to_string(),
        ));
    }
    let business_profile = load_business_profile(pool, user_id).await?;
    let system_prompt = [
        "You are the strategy brain for KasiSocial.",
        "Generate practical social media post ideas for a business owner who wants usable drafts right now.",
        "Return valid JSON only.",
        "JSON shape: {\"ideas\":[{\"title\":\"string\",\"angle\":\"string\",\"hook\":\"string\",\"draft\":\"string\",\"suggestedChannels\":[\"FACEBOOK\"|\"INSTAGRAM\"|\"LINKEDIN\"|\"X\"|\"WHATSAPP_STATUS\"]}]}",
        "Generate exactly 4 ideas.",
        "Each draft should already feel postable, not like a note.",
        "LinkedIn-friendly ideas should be more thoughtful and authority-building.",
        "X-friendly ideas should be concise and sharp.",
        "Do not include markdown fences."
    ].join(" ");
    let raw = generate_with_openrouter(vec![
        json!({
            "role": "system",
            "content": system_prompt
        }),
        json!({
            "role": "user",
            "content": format!(
                "Business context: {}\nTopic: {}\nObjective: {}\nPreferred channels: {}\nReturn a mix of educational, promotional, and credibility-building ideas the user can turn into drafts immediately.",
                json!({
                    "businessName": business_profile.as_ref().map(|p| &p.business_name),
                    "businessType": business_profile.as_ref().map(|p| &p.business_type),
                    "industry": business_profile.as_ref().and_then(|p| p.industry.as_ref()),
                    "description": business_profile.as_ref().and_then(|p| p.description.as_ref()),
                    "location": business_profile.as_ref().map(|p| [p.city.as_deref(), p.province.as_deref(), Some(p.country.as_str())].into_iter().flatten().collect::<Vec<_>>().join(", ")),
                    "website": business_profile.as_ref().and_then(|p| p.website.as_ref()),
                }),
                if topic.is_empty() { "Not specified" } else { topic },
                if objective.is_empty() { "General growth and audience engagement" } else { objective },
                if channels.is_empty() {
                    "Not specified".to_string()
                } else {
                    channels.iter().map(|channel| get_platform_label(channel)).collect::<Vec<_>>().join(", ")
                }
            )
        }),
    ])
    .await?;
    let parsed = serde_json::from_str::<Value>(&raw)
        .map_err(|_| AppError::Internal("AI response was not valid JSON".to_string()))?;
    let ideas = parsed
        .get("ideas")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|idea| {
            let title = idea.get("title").and_then(|value| value.as_str())?.trim().to_string();
            let draft = idea.get("draft").and_then(|value| value.as_str())?.trim().to_string();
            if title.is_empty() || draft.is_empty() {
                return None;
            }
            Some(json!({
                "title": title,
                "angle": idea.get("angle").and_then(|value| value.as_str()).unwrap_or("").trim(),
                "hook": idea.get("hook").and_then(|value| value.as_str()).unwrap_or("").trim(),
                "draft": draft,
                "suggestedChannels": idea.get("suggestedChannels").and_then(|value| value.as_array()).map(|items| {
                    items.iter()
                        .filter_map(|item| item.as_str())
                        .filter(|channel| PLATFORM_VALUES.contains(channel))
                        .collect::<Vec<_>>()
                }).unwrap_or_default()
            }))
        })
        .collect::<Vec<_>>();
    if ideas.is_empty() {
        return Err(AppError::Internal(
            "AI response did not include usable ideas".to_string(),
        ));
    }
    Ok(json!({ "ideas": ideas }))
}

pub async fn generate_social_caption(
    pool: &PgPool,
    user_id: &str,
    input: SocialCaptionRequest,
) -> Result<Value, AppError> {
    let prompt = input.prompt.as_deref().map(str::trim).unwrap_or("");
    let title = input.title.as_deref().map(str::trim).unwrap_or("");
    let current_content = input
        .current_content
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    let channels = sanitize_channels(input.channels);
    if prompt.is_empty() && title.is_empty() && current_content.is_empty() {
        return Err(AppError::BadRequest(
            "Provide a prompt, title, or current content to generate from".to_string(),
        ));
    }
    let business_profile = load_business_profile(pool, user_id).await?;
    let system_prompt = [
        "You write high-performing social media copy for businesses using KasiSocial.",
        "Return valid JSON only.",
        "JSON shape: {\"title\":\"string\",\"content\":\"string\",\"suggestedChannels\":[\"FACEBOOK\"|\"INSTAGRAM\"|\"LINKEDIN\"|\"X\"|\"WHATSAPP_STATUS\"],\"variants\":[{\"platform\":\"FACEBOOK\"|\"INSTAGRAM\"|\"LINKEDIN\"|\"X\"|\"WHATSAPP_STATUS\",\"content\":\"string\"}]}.",
        "Keep copy aligned with the business voice and practical for real posting.",
        "Do not include markdown fences.",
        "Prefer concise, publish-ready output.",
        "If channels are provided, tailor the output for those channels but keep one unified caption.",
        "Make LinkedIn variants more developed and professional than the others.",
        "Make X variants compact and punchy.",
        "Make WhatsApp Status variants extremely short."
    ].join(" ");
    let raw = generate_with_openrouter(vec![
        json!({
            "role": "system",
            "content": system_prompt
        }),
        json!({
            "role": "user",
            "content": format!(
                "Business context: {}\nRequested channels: {}\nCurrent title: {}\nPrompt: {}\nCurrent content: {}\nGenerate a strong master title and caption, then generate one variant per selected platform. If the prompt is vague, make a sensible business-ready assumption.",
                json!({
                    "businessName": business_profile.as_ref().map(|p| &p.business_name),
                    "businessType": business_profile.as_ref().map(|p| &p.business_type),
                    "industry": business_profile.as_ref().and_then(|p| p.industry.as_ref()),
                    "description": business_profile.as_ref().and_then(|p| p.description.as_ref()),
                    "location": business_profile.as_ref().map(|p| [p.city.as_deref(), p.province.as_deref(), Some(p.country.as_str())].into_iter().flatten().collect::<Vec<_>>().join(", ")),
                    "website": business_profile.as_ref().and_then(|p| p.website.as_ref()),
                }),
                if channels.is_empty() {
                    "Not specified".to_string()
                } else {
                    channels.iter().map(|channel| get_platform_label(channel)).collect::<Vec<_>>().join(", ")
                },
                if title.is_empty() { "None" } else { title },
                if prompt.is_empty() { "None" } else { prompt },
                if current_content.is_empty() { "None" } else { current_content },
            )
        }),
    ])
    .await?;
    let parsed = serde_json::from_str::<Value>(&raw)
        .map_err(|_| AppError::Internal("AI response was not valid JSON".to_string()))?;
    let content = parsed
        .get("content")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Internal("AI response did not include caption content".to_string())
        })?;
    let suggested_channels = parsed
        .get("suggestedChannels")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|channel| PLATFORM_VALUES.contains(channel))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| channels.iter().map(String::as_str).collect::<Vec<_>>());
    let variants = parsed
        .get("variants")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|variant| {
            let platform = variant.get("platform").and_then(|value| value.as_str())?;
            let content = variant
                .get("content")
                .and_then(|value| value.as_str())?
                .trim();
            if !PLATFORM_VALUES.contains(&platform) || content.is_empty() {
                return None;
            }
            Some(json!({ "platform": platform, "content": content }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "draft": {
            "title": parsed.get("title").and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty()).unwrap_or(if title.is_empty() { "Untitled social post" } else { title }),
            "content": content,
            "suggestedChannels": suggested_channels,
            "variants": variants
        }
    }))
}
