import { prisma } from "@/lib/prisma";
import { publishPostToLinkedIn } from "@/lib/social/linkedin";
import { publishPostToX } from "@/lib/social/x";
import {
  SocialPlatform,
  SocialPostStatus,
  SocialPublishJobStatus,
} from "@kasitek/database";
import { socialChannelPublicSelect } from "@/lib/social/db";

type PublishExecutionResult = {
  jobId: string;
  postId: string;
  platform: SocialPlatform;
  status: SocialPublishJobStatus;
  externalPostId?: string | null;
};

async function loadPublishJob(jobId: string) {
  return prisma.socialPublishJob.findUnique({
    where: { id: jobId },
    include: {
      post: true,
      variant: true,
      channelConnection: true,
    },
  });
}

async function resolveConnectedXChannel(userId: string, channelConnectionId?: string | null) {
  if (channelConnectionId) {
    const channel = await prisma.socialChannelConnection.findFirst({
      where: {
        id: channelConnectionId,
        userId,
        platform: SocialPlatform.X,
        status: "CONNECTED",
      },
    });

    if (channel?.accessToken) {
      return channel;
    }
  }

  const latest = await prisma.socialChannelConnection.findFirst({
    where: {
      userId,
      platform: SocialPlatform.X,
      status: "CONNECTED",
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!latest?.accessToken) {
    throw new Error("Connect an X account before publishing");
  }

  return latest;
}

async function resolveConnectedLinkedInChannel(userId: string, channelConnectionId?: string | null) {
  if (channelConnectionId) {
    const channel = await prisma.socialChannelConnection.findFirst({
      where: {
        id: channelConnectionId,
        userId,
        platform: SocialPlatform.LINKEDIN,
        status: "CONNECTED",
      },
    });

    if (channel?.accessToken) {
      return channel;
    }
  }

  const latest = await prisma.socialChannelConnection.findFirst({
    where: {
      userId,
      platform: SocialPlatform.LINKEDIN,
      status: "CONNECTED",
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!latest?.accessToken) {
    throw new Error("Connect a LinkedIn account before publishing");
  }

  return latest;
}

async function markJobFailed({
  jobId,
  postId,
  message,
}: {
  jobId: string;
  postId: string;
  message: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.socialPublishJob.update({
      where: { id: jobId },
      data: {
        status: SocialPublishJobStatus.FAILED,
        errorMessage: message,
      },
    });

    await tx.socialPost.update({
      where: { id: postId },
      data: {
        status: SocialPostStatus.FAILED,
        metadata: {
          failedAt: new Date().toISOString(),
          failureReason: message,
        },
      },
    });
  });
}

export async function executeSocialPublishJob(jobId: string): Promise<PublishExecutionResult> {
  const job = await loadPublishJob(jobId);

  if (!job) {
    throw new Error("Publish job not found");
  }

  if (job.status === SocialPublishJobStatus.CANCELED) {
    throw new Error("Publish job is canceled");
  }

  if (job.status === SocialPublishJobStatus.PUBLISHED && job.externalPostId) {
    return {
      jobId: job.id,
      postId: job.postId,
      platform: job.platform,
      status: SocialPublishJobStatus.PUBLISHED,
      externalPostId: job.externalPostId,
    };
  }

  try {
    const publishText = job.variant?.content?.trim() || job.post.content.trim();
    let published: { id: string | null; text: string };
    let connectionId: string | null = null;
    let provider: "x" | "linkedin";

    if (job.platform === SocialPlatform.X) {
      if (publishText.length > 280) {
        throw new Error("X posts are currently limited to 280 characters");
      }

      const xChannel = await resolveConnectedXChannel(job.userId, job.channelConnectionId);
      const xPublished = await publishPostToX({
        accessTokenEncrypted: xChannel.accessToken as string,
        text: publishText,
      });
      published = {
        id: xPublished.id,
        text: xPublished.text || publishText,
      };
      connectionId = xChannel.id;
      provider = "x";
    } else if (job.platform === SocialPlatform.LINKEDIN) {
      if (publishText.length > 3000) {
        throw new Error("LinkedIn posts are currently limited to 3000 characters");
      }

      const linkedInChannel = await resolveConnectedLinkedInChannel(
        job.userId,
        job.channelConnectionId,
      );
      published = await publishPostToLinkedIn({
        accessTokenEncrypted: linkedInChannel.accessToken as string,
        externalAccountId: linkedInChannel.externalAccountId,
        metadata: linkedInChannel.metadata,
        text: publishText,
      });
      connectionId = linkedInChannel.id;
      provider = "linkedin";
    } else {
      throw new Error(`Publishing is not implemented yet for ${job.platform}`);
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.socialPublishJob.update({
        where: { id: job.id },
        data: {
          status: SocialPublishJobStatus.PUBLISHED,
          publishedAt: now,
          externalPostId: published.id,
          errorMessage: null,
          channelConnectionId: connectionId,
          metadata: {
            provider,
            publishedText: published.text || publishText,
          },
        },
      });

      await tx.socialPost.update({
        where: { id: job.postId },
        data: {
          status: SocialPostStatus.PUBLISHED,
          publishedAt: now,
          primaryChannelId: job.post.primaryChannelId || connectionId,
          metadata: {
            latestPublishedPostId: published.id,
            latestPublishedPlatform: job.platform,
          },
        },
      });
    });

    return {
      jobId: job.id,
      postId: job.postId,
      platform: job.platform,
      status: SocialPublishJobStatus.PUBLISHED,
      externalPostId: published.id,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to publish social post";
    await markJobFailed({
      jobId: job.id,
      postId: job.postId,
      message,
    });
    throw error;
  }
}

export async function claimPublishJob(jobId: string, allowedStatuses: SocialPublishJobStatus[]) {
  const result = await prisma.socialPublishJob.updateMany({
    where: {
      id: jobId,
      status: {
        in: allowedStatuses,
      },
    },
    data: {
      status: SocialPublishJobStatus.PROCESSING,
      errorMessage: null,
    },
  });

  return result.count === 1;
}

export async function processDueSocialPublishJobs(limit = 10) {
  const dueJobs = await prisma.socialPublishJob.findMany({
    where: {
      status: SocialPublishJobStatus.QUEUED,
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }],
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });

  let processed = 0;

  for (const job of dueJobs) {
    const claimed = await claimPublishJob(job.id, [SocialPublishJobStatus.QUEUED]);
    if (!claimed) continue;

    try {
      await executeSocialPublishJob(job.id);
      processed += 1;
    } catch {
      processed += 1;
    }
  }

  return processed;
}

export async function getUserScopedPostWithJobs(userId: string, postId: string) {
  return prisma.socialPost.findFirst({
    where: { id: postId, userId },
    include: {
      primaryChannel: {
        select: socialChannelPublicSelect,
      },
      variants: {
        orderBy: { createdAt: "asc" },
      },
      publishJobs: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
}
