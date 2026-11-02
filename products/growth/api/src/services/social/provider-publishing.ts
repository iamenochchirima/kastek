import { parseSerdeValueJson } from "../../json.js";
import type { CoreConfig } from "../../config.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import { ApiError } from "../../error.js";
import { bad } from "./common.js";
import { setTimeout as delay } from "node:timers/promises";
export interface PublishImage {
  bytes: Buffer;
  mime_type: string;
  alt_text: string;
}
export interface ProviderOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}
export const META_GRAPH = "https://graph.facebook.com/v23.0",
  INSTAGRAM_GRAPH = "https://graph.instagram.com/v23.0",
  THREADS_GRAPH = "https://graph.threads.com/v1.0",
  LINKEDIN_POSTS = "https://api.linkedin.com/rest/posts",
  LINKEDIN_VERSION = "202606",
  TIKTOK_CREATOR =
    "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
export async function providerJson(
  url: string,
  init: RequestInit,
  fallback: string,
  options: ProviderOptions = {},
): Promise<Record<string, any>> {
  const response = await providerResponse(url, init, options);
  const body = await response.text().catch(() => { throw new ApiError(502, "provider_confirmation_unreadable", "Provider response could not be read"); });
  let parsed: Record<string, any> | null;
  try {
    parsed = parseSerdeValueJson(body) as Record<string, any>;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    if (response.status === 429)
      throw new ApiError(429, "rate_limited", "Provider rate limit exceeded");
    if (response.status >= 500)
      throw new ApiError(502, "bad_gateway", "Provider request failed");
    const message = [
      parsed?.detail,
      parsed?.message,
      parsed?.error,
      parsed?.error?.message,
    ].find((value) => typeof value === "string");
    throw bad(message ?? fallback);
  }
  if (parsed === null)
    throw new ApiError(
      502,
      "provider_confirmation_unreadable",
      "Failed to decode provider response",
    );
  return parsed;
}
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
function httpsUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw bad(`${label} image URL is invalid`);
  }
  if (parsed.protocol !== "https:")
    throw bad(`${label} requires a public HTTPS image URL`);
}
function requireId(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(502, "provider_confirmation_missing", message);
  return value;
}
export async function publishPostToX(
  config: CoreConfig,
  encrypted: string,
  text: string,
  images: PublishImage[],
  options: ProviderOptions = {},
): Promise<[string, string]> {
  const token = decryptSocialSecret(config, encrypted);
  if (images.length > 4) throw bad("X posts can include at most 4 images");
  const ids: string[] = [];
  for (const image of images) {
    if (
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/bmp",
        "image/pjpeg",
        "image/tiff",
      ].includes(image.mime_type)
    )
      throw bad("X does not support this image format");
    const uploaded = await providerJson(
      "https://api.x.com/2/media/upload",
      {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          media: image.bytes.toString("base64"),
          media_category: "tweet_image",
          media_type: image.mime_type,
          shared: false,
        }),
      },
      "Failed to upload image to X",
      options,
    );
    ids.push(requireId(uploaded.data?.id, "X did not return a media id"));
  }
  const result = await providerJson(
    "https://api.x.com/2/tweets",
    {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...(ids.length ? { media: { media_ids: ids } } : {}),
      }),
    },
    "Failed to publish to X",
    options,
  );
  return [
    requireId(result.data?.id, "X publish did not return a post id"),
    typeof result.data?.text === "string" ? result.data.text : text,
  ];
}
export async function publishPostToFacebook(
  config: CoreConfig,
  encrypted: string,
  account: string | null,
  text: string,
  image: string | null,
  options: ProviderOptions = {},
): Promise<[string, string]> {
  if (account === null)
    throw bad("Facebook connection is missing a Page identifier");
  const token = decryptSocialSecret(config, encrypted);
  if (image !== null) httpsUrl(image, "Facebook");
  const result = await providerJson(
    `${META_GRAPH}/${account}/${image !== null ? "photos" : "feed"}`,
    {
      method: "POST",
      headers: headers(token),
      body: new URLSearchParams(
        image !== null ? { url: image, caption: text } : { message: text },
      ),
    },
    "Failed to publish to Facebook",
    options,
  );
  return [
    requireId(result.id, "Facebook publish did not return a post id"),
    text,
  ];
}
/** Photo publishing returns a photo id; edits target its existing Page story. */
export async function resolveFacebookPostForUpdate(
  config: CoreConfig, encrypted: string, accountId: string, externalId: string,
  photo: boolean, options: ProviderOptions = {},
): Promise<string> {
  if (!/^\d+(?:_\d+)?$/.test(externalId)) throw bad("Facebook post identifier is invalid");
  if (!photo) return externalId;
  const result = await providerJson(`${META_GRAPH}/${externalId}?fields=id,page_story_id`, {
    headers: headers(decryptSocialSecret(config, encrypted)), signal: AbortSignal.timeout(20_000),
  }, "Failed to resolve the Facebook photo post", options);
  const story = result.page_story_id;
  if (typeof story !== "string" || !/^\d+_\d+$/.test(story) || !story.startsWith(`${accountId}_`))
    throw bad("Facebook did not return the Page post for this photo");
  return story;
}
export async function readFacebookPostMessage(
  config: CoreConfig, encrypted: string, postId: string, options: ProviderOptions = {}, requireNoPhoto = false,
): Promise<string> {
  const result = await providerJson(`${META_GRAPH}/${encodeURIComponent(postId)}?fields=${requireNoPhoto ? "id,message,attachments{type,target}" : "id,message"}`, {
    headers: headers(decryptSocialSecret(config, encrypted)), signal: AbortSignal.timeout(20_000),
  }, "Failed to verify the Facebook post", options);
  if (result.id !== postId || typeof result.message !== "string")
    throw new ApiError(502, "provider_confirmation_missing", "Facebook did not confirm the post text");
  if (requireNoPhoto && result.attachments != null && (!Array.isArray(result.attachments.data) || result.attachments.data.length > 0))
    throw new ApiError(502, "provider_confirmation_missing", "Facebook has not confirmed photo removal");
  return result.message;
}
export async function updateFacebookPostMessage(
  config: CoreConfig, encrypted: string, postId: string, content: string, options: ProviderOptions = {}, removePhoto = false,
): Promise<void> {
  const result = await providerJson(`${META_GRAPH}/${encodeURIComponent(postId)}`, {
    method: "POST", headers: headers(decryptSocialSecret(config, encrypted)),
    body: new URLSearchParams({ message: content, ...(removePhoto ? { attached_media: "[]" } : {}) }), signal: AbortSignal.timeout(20_000),
  }, "Failed to update the Facebook post", options);
  if ((result as unknown) !== true && result.success !== true && result.id !== postId)
    throw new ApiError(502, "provider_confirmation_missing", "Facebook did not confirm the update");
  try {
    if (await readFacebookPostMessage(config, encrypted, postId, options, removePhoto) !== content)
      throw new Error("Unconfirmed text");
  } catch {
    throw new ApiError(502, "provider_confirmation_missing", "Facebook has not confirmed the updated text");
  }
}
/** Detaching a photo preserves its Page story; the original photo receipt remains immutable. */
export function facebookPublishedMutationTarget(externalId: string, metadata: unknown): string {
  const raw = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)._kasitek_facebook_story : null;
  if (raw == null) return externalId;
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad("The saved Facebook Page story identity is invalid");
  const story = raw as Record<string, unknown>;
  if (story.photoDetached !== true || story.originalExternalPostId !== externalId || typeof story.id !== "string" || !/^\d+_\d+$/.test(story.id))
    throw bad("The saved Facebook Page story identity is invalid");
  return story.id;
}
export async function publishPostToThreads(
  config: CoreConfig,
  encrypted: string,
  account: string,
  text: string,
  image: string | null,
  options: ProviderOptions = {},
): Promise<[string, string]> {
  if (Array.from(text).length > 500)
    throw bad("Threads posts are limited to 500 characters");
  const token = decryptSocialSecret(config, encrypted);
  if (image !== null) httpsUrl(image, "Threads");
  const container = await providerJson(
    `${THREADS_GRAPH}/${account}/threads`,
    {
      method: "POST",
      headers: headers(token),
      body: new URLSearchParams(
        image !== null
          ? { text, media_type: "IMAGE", image_url: image }
          : { text, media_type: "TEXT" },
      ),
    },
    "Failed to create Threads post",
    options,
  );
  const id = requireId(container.id, "Threads did not return a creation id");
  const posted = await providerJson(
    `${THREADS_GRAPH}/${account}/threads_publish`,
    {
      method: "POST",
      headers: headers(token),
      body: new URLSearchParams({ creation_id: id }),
    },
    "Failed to publish Threads post",
    options,
  );
  return [requireId(posted.id, "Threads did not return a post id"), text];
}
export async function publishPostToInstagram(
  config: CoreConfig,
  encrypted: string,
  account: string | null,
  metadata: Record<string, unknown> | null,
  image: string,
  caption: string,
  options: ProviderOptions = {},
): Promise<[string, string]> {
  if (account === null)
    throw bad("Instagram connection is missing an account identifier");
  httpsUrl(image, "Instagram");
  const token = decryptSocialSecret(config, encrypted),
    graph =
      metadata?.authMethod === "instagram_login" ? INSTAGRAM_GRAPH : META_GRAPH;
  const container = await providerJson(
    `${graph}/${account}/media`,
    {
      method: "POST",
      headers: headers(token),
      body: new URLSearchParams({ image_url: image, caption }),
    },
    "Failed to create the Instagram media container",
    options,
  );
  const id = requireId(
    container.id,
    "Instagram did not return a media container identifier",
  );
  let ready = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const status = await providerJson(
      `${graph}/${id}?fields=status_code%2Cstatus`,
      { headers: headers(token) },
      "Failed to check the Instagram media container",
      options,
    );
    const code =
      typeof status.status_code === "string"
        ? status.status_code.toUpperCase()
        : null;
    if (code === "FINISHED") {
      ready = true;
      break;
    }
    if (code !== null && !["IN_PROGRESS", "PENDING"].includes(code)) {
      const raw =
        typeof status.status_code === "string" ? status.status_code : "unknown";
      const detail =
        typeof status.status === "string" ? status.status.trim() : "";
      throw bad(
        detail
          ? `Instagram media container ${raw}: ${Array.from(detail).slice(0, 300).join("")}`
          : `Instagram media container returned terminal status ${raw}`,
      );
    }
    if (attempt < 14) await (options.sleep ?? delay)(1000);
  }
  if (!ready)
    throw bad(
      "Instagram media container did not become ready before the publish timeout",
    );
  const posted = await providerJson(
    `${graph}/${account}/media_publish`,
    {
      method: "POST",
      headers: headers(token),
      body: new URLSearchParams({ creation_id: id }),
    },
    "Failed to publish the Instagram post",
    options,
  );
  return [
    requireId(posted.id, "Instagram did not return a published media id"),
    caption,
  ];
}
export async function publishPostToTiktok(
  token: string,
  metadata: Record<string, unknown> | null,
  text: string,
  options: ProviderOptions = {},
): Promise<[string, string]> {
  if (metadata?.tiktokConsent !== true)
    throw bad("TikTok publishing consent is required");
  const media =
    typeof metadata.tiktokMediaUrl === "string"
      ? metadata.tiktokMediaUrl.trim()
      : "";
  if (!media) throw bad("Add a public HTTPS TikTok video or image URL");
  if (!media.startsWith("https://"))
    throw bad("TikTok media URL must use HTTPS");
  const type =
    typeof metadata.tiktokMediaType === "string"
      ? metadata.tiktokMediaType
      : "VIDEO";
  if (type === "VIDEO" && text.length > 2200)
    throw bad("TikTok video captions are limited to 2200 UTF-16 characters");
  if (type === "PHOTO" && text.length > 4000)
    throw bad(
      "TikTok photo descriptions are limited to 4000 UTF-16 characters",
    );
  const privacy =
    typeof metadata.tiktokPrivacyLevel === "string"
      ? metadata.tiktokPrivacyLevel
      : "SELF_ONLY";
  const creator = await providerJson(
    TIKTOK_CREATOR,
    {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: "{}",
    },
    "Failed to query TikTok creator settings",
    options,
  );
  if (
    !Array.isArray(creator.data?.privacy_level_options) ||
    !creator.data.privacy_level_options.includes(privacy)
  )
    throw bad(
      `TikTok privacy level ${privacy} is not available for this account`,
    );
  const payload =
    type === "PHOTO"
      ? {
          post_info: {
            title: Array.from(text).slice(0, 90).join(""),
            description: text,
            privacy_level: privacy,
          },
          source_info: {
            source: "PULL_FROM_URL",
            photo_cover_index: 1,
            photo_images: [media],
          },
          post_mode: "DIRECT_POST",
          media_type: "PHOTO",
        }
      : {
          post_info: { title: text, privacy_level: privacy },
          source_info: { source: "PULL_FROM_URL", video_url: media },
        };
  const result = await providerJson(
    type === "PHOTO"
      ? "https://open.tiktokapis.com/v2/post/publish/content/init/"
      : "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    "Failed to publish to TikTok",
    options,
  );
  const code =
    typeof result.error?.code === "string" ? result.error.code : "ok";
  if (code !== "ok")
    throw bad(
      typeof result.error?.message === "string" ? result.error.message : code,
    );
  return [
    requireId(result.data?.publish_id, "TikTok did not return a publish id"),
    text,
  ];
}
export async function publishPostToLinkedin(
  config: CoreConfig,
  encrypted: string,
  account: string | null,
  metadata: Record<string, unknown> | null,
  text: string,
  image: PublishImage | null,
  options: ProviderOptions = {},
): Promise<[string | null, string]> {
  const token = decryptSocialSecret(config, encrypted);
  const actor =
    typeof metadata?.actorUrn === "string"
      ? metadata.actorUrn
      : account !== null
        ? `urn:li:person:${account}`
        : null;
  if (actor === null)
    throw bad("LinkedIn connection is missing an actor identifier");
  const requestHeaders = {
    ...headers(token),
    "Content-Type": "application/json",
    "Linkedin-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
  let imageUrn: string | undefined;
  if (image) {
    const init = await providerJson(
      "https://api.linkedin.com/rest/images?action=initializeUpload",
      {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ initializeUploadRequest: { owner: actor } }),
      },
      "Failed to initialize LinkedIn image upload",
      options,
    );
    const url = requireId(
      init.value?.uploadUrl,
      "LinkedIn did not return an image upload URL",
    );
    imageUrn = requireId(
      init.value?.image,
      "LinkedIn did not return an image identifier",
    );
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw bad("LinkedIn image upload URL is invalid");
    }
    if (
      parsed.protocol !== "https:" ||
      (parsed.hostname !== "linkedin.com" &&
        !parsed.hostname.endsWith(".linkedin.com"))
    )
      throw bad("LinkedIn image upload URL is not trusted");
    const uploaded = await providerResponse(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": image.mime_type },
        body: new Uint8Array(image.bytes),
      },
      options,
    );
    if (!uploaded.ok) throw bad("Failed to upload image to LinkedIn");
  }
  const response = await providerResponse(
    LINKEDIN_POSTS,
    {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        author: actor,
        commentary: text,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...(image
          ? { content: { media: { altText: image.alt_text, id: imageUrn } } }
          : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    },
    options,
  );
  const body = await response.text().catch(() => { throw new ApiError(502, "provider_confirmation_unreadable", "Provider response could not be read"); });
  if (response.status >= 500) throw new ApiError(502, "bad_gateway", "Provider request failed");
  if (!response.ok) throw bad(body);
  let id = response.headers.get("x-restli-id");
  if (!image && !id) {
    try {
      const parsed = parseSerdeValueJson(body) as Record<string, any>;
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {}
  }
  return [requireId(id, "LinkedIn publish did not return a post id"), text];
}
export function instagramDeleteGraphBase(
  metadata: Record<string, unknown> | null,
): string {
  if (metadata?.authMethod === "instagram_login")
    throw bad(
      "Instagram post deletion requires a Meta/Facebook Login connection with Instagram content management permission; reconnect this account through Meta before deleting the post",
    );
  return META_GRAPH;
}
export async function deletePostFromProvider(
  config: CoreConfig,
  platform: string,
  encrypted: string,
  account: string | null,
  metadata: Record<string, unknown> | null,
  id: string,
  options: ProviderOptions = {},
): Promise<void> {
  if (platform === "TIKTOK")
    throw bad(
      "TikTok does not currently expose a delete endpoint through the Content Posting API; delete the post in TikTok",
    );
  if (platform === "INSTAGRAM") instagramDeleteGraphBase(metadata);
  const token = decryptSocialSecret(config, encrypted);
  let base: string;
  switch (platform) {
    case "X":
      base = "https://api.x.com/2/tweets";
      break;
    case "FACEBOOK":
      base = META_GRAPH;
      break;
    case "INSTAGRAM":
      base = instagramDeleteGraphBase(metadata);
      break;
    case "THREADS":
      base = THREADS_GRAPH;
      break;
    case "LINKEDIN":
      base = LINKEDIN_POSTS;
      break;
    default:
      throw bad(`Deleting posts from ${platform} is not supported`);
  }
  const fallback = `Failed to delete the ${platform === "X" ? "X" : platform === "FACEBOOK" ? "Facebook" : platform === "INSTAGRAM" ? "Instagram" : platform === "THREADS" ? "Threads" : "LinkedIn"} post`;
  const response = await providerResponse(
    `${base}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: {
        ...headers(token),
        ...(platform === "LINKEDIN"
          ? {
              "Linkedin-Version": LINKEDIN_VERSION,
              "X-Restli-Protocol-Version": "2.0.0",
            }
          : {}),
      },
    },
    options,
  );
  if (response.ok || response.status === 404) return;
  const body = await response.text().catch(() => "");
  const detail = Array.from(body).slice(0, 300).join("");
  if (
    platform === "INSTAGRAM" &&
    ([401, 403].includes(response.status) ||
      /permission|oauthexception/i.test(detail))
  )
    throw bad(
      "Instagram deletion was rejected because this connection lacks the required Meta permission. Reconnect Instagram through Meta/Facebook Login and grant instagram_manage_contents, then try again",
    );
  throw bad(
    `${fallback}: ${detail.trim() || `${response.status} ${response.statusText}`}`,
  );
}

export async function providerResponse(
  url: string,
  init: RequestInit,
  options: ProviderOptions = {},
): Promise<Response> {
  try {
    return await (options.fetch ?? fetch)(url, init);
  } catch (error) {
    const timeout =
      error instanceof Error && /timeout|timed out/i.test(error.message);
    throw new ApiError(
      timeout ? 504 : 502,
      timeout ? "gateway_timeout" : "bad_gateway",
      timeout ? "Provider request timed out" : "Provider request failed",
    );
  }
}
