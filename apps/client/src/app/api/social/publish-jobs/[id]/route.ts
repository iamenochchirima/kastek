import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  claimPublishJob,
  executeSocialPublishJob,
  getUserScopedPostWithJobs,
} from "@/lib/social/publish-service";
import { SocialPublishJobStatus } from "@kasitek/database";

export const runtime = "nodejs";

type JobAction = "retry" | "cancel" | "run_now";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: JobAction };

    if (!body.action) {
      return NextResponse.json({ error: "Action is required" }, { status: 400 });
    }

    const job = await prisma.socialPublishJob.findFirst({
      where: { id, userId },
    });

    if (!job) {
      return NextResponse.json({ error: "Publish job not found" }, { status: 404 });
    }

    if (body.action === "cancel") {
      await prisma.socialPublishJob.update({
        where: { id },
        data: {
          status: SocialPublishJobStatus.CANCELED,
          errorMessage: null,
        },
      });

      const post = await getUserScopedPostWithJobs(userId, job.postId);
      return NextResponse.json({ post });
    }

    if (body.action === "retry") {
      await prisma.socialPublishJob.update({
        where: { id },
        data: {
          status: SocialPublishJobStatus.QUEUED,
          errorMessage: null,
          scheduledFor: new Date(),
        },
      });

      const post = await getUserScopedPostWithJobs(userId, job.postId);
      return NextResponse.json({ post });
    }

    if (body.action === "run_now") {
      const claimed = await claimPublishJob(id, [
        SocialPublishJobStatus.PENDING,
        SocialPublishJobStatus.FAILED,
        SocialPublishJobStatus.QUEUED,
      ]);

      if (!claimed) {
        return NextResponse.json(
          { error: "This publish job is already processing" },
          { status: 409 },
        );
      }

      await executeSocialPublishJob(id);
      const post = await getUserScopedPostWithJobs(userId, job.postId);
      return NextResponse.json({ post });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update publish job";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

