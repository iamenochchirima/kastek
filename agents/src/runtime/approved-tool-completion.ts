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
  if (normalized === "linkedin") return "LinkedIn";
  if (normalized === "bluesky") return "Bluesky";
  if (normalized === "tiktok") return "TikTok";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function destination(argumentsValue: Record<string, unknown>, output: Record<string, unknown> | undefined): string | undefined {
  const result = asRecord(output?.result);
  const post = asRecord(output?.post);
  const channels = Array.isArray(post?.channels) ? post.channels : [];
  return platformLabel(result?.platform ?? argumentsValue.platform ?? channels[0]);
}

function batchTargetLabel(target: unknown): string | undefined {
  const item = asRecord(target);
  const platform = platformLabel(item?.platform);
  const account = nonEmptyString(item?.accountName);
  if (!platform) return undefined;
  return account ? `${platform} (${account})` : platform;
}

function batchTargetStatus(target: unknown): string {
  const item = asRecord(target);
  return (nonEmptyString(item?.state) ?? nonEmptyString(item?.status) ?? "UNKNOWN").toUpperCase();
}

function batchTargetRemediation(target: unknown): string | undefined {
  const item = asRecord(target);
  const mode = nonEmptyString(item?.remediationMode)?.toUpperCase();
  switch (mode) {
    case "GRANT_ACCESS": return "grant access";
    case "RECONNECT": return "reconnect";
    case "CHECK_CONNECTION": return "check the connection";
    case "FIX_MEDIA": return "fix the media";
    case "FIX_CONTENT": return "fix the content";
    case "REMOVE_TARGET": return "remove this destination";
    case "RECONCILE": return "reconcile before retrying";
    case "RETRY": return "retry available";
    case "RECREATE_DRAFT": return "recreate the draft";
    case "REVIEW": return "review the target";
    default: return undefined;
  }
}

function batchTargetAttentionLabel(target: unknown): string | undefined {
  const label = batchTargetLabel(target);
  const remediation = batchTargetRemediation(target);
  return label && remediation ? `${label} — ${remediation}` : label;
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
    case "kasitek.core.content_post_publish_batch":
    case "kasitek.core.content_post_publish_batch_retry": {
      const batch = asRecord(output?.batch);
      const targets = Array.isArray(batch?.targets) ? batch.targets : [];
      const published = targets
        .filter((item) => batchTargetStatus(item) === "PUBLISHED")
        .map(batchTargetLabel)
        .filter((value): value is string => Boolean(value));
      const attention = targets
        .filter((item) => batchTargetStatus(item) !== "PUBLISHED")
        .map(batchTargetAttentionLabel)
        .filter((value): value is string => Boolean(value));
      const status = nonEmptyString(batch?.status);
      if (toolName === "kasitek.core.content_post_publish_batch_retry" && status === "PROCESSING") return `Retrying the failed destinations for ${target}.`;
      if (status === "SUCCEEDED") return `Published ${target}${published.length ? ` to ${published.join(", ")}` : ""}.`;
      if (status === "PROCESSING") return `Publishing ${target} to ${(attention.length ? attention : published).join(", ") || "the selected destinations"}.`;
      if (status === "PARTIAL") {
        const publishedText = published.length ? `Published to ${published.join(", ")}. ` : "";
        return `${publishedText}${attention.join(", ") || "Some destinations"} still need attention.`;
      }
      if (status === "UNKNOWN") {
        const unknownTargets = targets
          .filter((item) => batchTargetStatus(item) === "UNKNOWN")
          .map(batchTargetLabel)
          .filter((value): value is string => Boolean(value));
        return `The batch publish for ${target} could not be confirmed${unknownTargets.length ? ` for ${unknownTargets.join(", ")}` : ""}. Reconcile the provider result before retrying.`;
      }
      if (status === "BLOCKED" || status === "FAILED") {
        return `The batch publish for ${target} is ${status.toLowerCase()}${attention.length ? ` for ${attention.join(", ")}` : ""}.`;
      }
      return `The batch publish for ${target} is ${status?.toLowerCase() ?? "pending"}.`;
    }
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
  if (toolName === "kasitek.core.content_post_publish_batch" || toolName === "kasitek.core.content_post_publish_batch_retry") {
    if (/permission|scope|authorization|forbidden|reconnect|connection|credential|oauth|token/i.test(message)) {
      return "I couldn’t start the batch publish because one or more destination connections need attention. Check the batch preflight results in Connections before retrying.";
    }
    if (/timed out|result may be pending|confirmation/i.test(message)) {
      return "I couldn’t confirm the batch publish request. Check the post status before retrying so completed destinations are not duplicated.";
    }
    return "I couldn’t start the batch publish. No destination was confirmed as published; please try again.";
  }
  return "I couldn’t complete the approved action. Please try again.";
}
