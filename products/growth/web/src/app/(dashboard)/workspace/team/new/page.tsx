import { getWorkspaceSession } from "@/lib/core-auth";
import { redirect } from "react-router";
import { CreateOrgForm } from "./create-org-form";
import { MotionReveal } from "@/components/ui/motion-reveal";

export function meta() { return [{ title: "Create Organisation | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");
  return {  };
}

export default function NewOrgPage() {
  return (
    <div className="min-h-[100dvh] space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-lg space-y-6">
        <MotionReveal>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            Organisation
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Create organisation
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Create a new workspace to collaborate with your team.
          </p>
        </div>
        </MotionReveal>
        <MotionReveal delay={0.08}>
          <CreateOrgForm />
        </MotionReveal>
      </div>
    </div>
  );
}
