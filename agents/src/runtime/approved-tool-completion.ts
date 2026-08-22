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

export function buildApprovedToolFailureMessage(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (toolName === "kasitek.core.content_post_publish" && /bluesky.*(?:invalid_grant|refresh token|token was not issued)/i.test(message)) {
    return "I couldn’t publish the post because the Bluesky connection has expired. Reconnect Bluesky, then try again.";
  }
  if (toolName === "kasitek.core.content_post_publish") {
    return "I couldn’t publish the post. Check the channel connection, then try again.";
  }
  return "I couldn’t complete the approved action. Please try again.";
}
