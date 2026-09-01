function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function platformLabel(value: unknown): string | undefined {
  const platform = nonEmptyString(value);
  if (!platform) return undefined;
  const normalized = platform.toLowerCase();
  if (normalized === "x" || normalized === "twitter") return "X";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function destination(argumentsValue: Record<string, unknown>, output: Record<string, unknown> | undefined): string | undefined {
  const result = asRecord(output?.result);
  const post = asRecord(output?.post);
  const channels = Array.isArray(post?.channels) ? post.channels : [];
  return platformLabel(result?.platform ?? argumentsValue.platform ?? channels[0]);
}

/**
 * Approved effects need a trustworthy completion reply even when the model has
 * already spent its token budget before the approval pause.
 */
export function buildApprovedToolCompletionMessage(
  toolName: string,
  argumentsValue: Record<string, unknown>,
  outputValue: unknown,
): string {
  const output = asRecord(outputValue);
  const post = asRecord(output?.post);
  const title = nonEmptyString(post?.title);
  const platform = destination(argumentsValue, output);
  const target = title ? `“${title}”` : "the post";
  const suffix = platform ? ` to ${platform}` : "";

  switch (toolName) {
    case "kasitek.core.content_post_publish":
      return `Published ${target}${suffix}.`;
    case "kasitek.core.content_post_schedule":
      return `Scheduled ${target}${suffix}.`;
    case "kasitek.core.content_post_unschedule":
      return `Removed the schedule for ${target}.`;
    case "kasitek.core.content_post_delete":
      return "Post deleted.";
    default:
      return "Approved action completed.";
  }
}

export function buildApprovedToolFailureMessage(
  toolName: string,
  error: unknown,
  argumentsValue: Record<string, unknown> = {},
): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (toolName === "kasitek.core.content_post_publish" && /bluesky.*(?:invalid_grant|refresh token|token was not issued)/i.test(message)) {
    return "I couldn’t publish the post because the Bluesky connection has expired. Reconnect Bluesky, then try again.";
  }
  if (toolName === "kasitek.core.content_post_publish") {
    const platform = platformLabel(argumentsValue.platform) ?? "selected channel";
    const lowerMessage = message.toLowerCase();
    if (/media container did not become ready|media id is not available|media container.*(?:processing|publish timeout)|still processing/i.test(message)) {
      return `I couldn’t publish the ${platform} post because Instagram did not finish processing the image in time. The post was not confirmed as published; you can retry this draft.`;
    }
    if (/(permission|scope|not authorized|authorization|forbidden).*(publish|content)|(?:publish|content).*(permission|scope|not authorized|authorization|forbidden)/i.test(message)) {
      return `I couldn’t publish the ${platform} post because this connection is missing publishing access. Open Connections → ${platform} → Access and grant Publish content, then try again.`;
    }
    if (/(?:image|media|photo|video).*(?:invalid|access|fetch|unavailable|public https|attach|accepted)|(?:invalid|access|fetch|unavailable|public https|attach|accepted).*(?:image|media|photo|video)/i.test(message)) {
      return `I couldn’t publish the ${platform} post because the provider could not use the attached media. The post was not confirmed as published; you can retry this draft.`;
    }
    if (/(?:reconnect|connection|credential|oauth|token).*(?:expired|invalid|missing|needs|before publishing)|(?:connect|reconnect) .*account/i.test(lowerMessage)) {
      return `I couldn’t publish the ${platform} post because the ${platform} connection needs attention. Open Connections → ${platform} → Access, then reconnect or update access before trying again.`;
    }
    if (/timed out|result may be pending|confirmation/i.test(lowerMessage)) {
      return `I couldn’t confirm the ${platform} post because the publish request timed out. Check the post status before retrying so it is not duplicated.`;
    }
    if (/timed out|temporarily unavailable|rate limit|returned 5\d\d|service unavailable/i.test(lowerMessage)) {
      return `I couldn’t publish the ${platform} post because the provider is temporarily unavailable. The post was not confirmed as published; try again shortly.`;
    }
    return `I couldn’t publish the ${platform} post. The provider did not confirm that it was published; please try again.`;
  }
  return "I couldn’t complete the approved action. Please try again.";
}
