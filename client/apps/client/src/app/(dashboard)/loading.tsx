"use client";

import { AgentsPageSkeleton } from "@/components/dashboard/agents/agents-loading";
import {
  DashboardGenericPageSkeleton,
  DashboardShellSkeleton,
} from "@/components/dashboard/dashboard-loading";
import { usePathname } from "next/navigation";

export default function DashboardLoading() {
  const pathname = usePathname();
  const content = pathname.startsWith("/agents") ? (
    <AgentsPageSkeleton />
  ) : (
    <DashboardGenericPageSkeleton />
  );

  return (
    <DashboardShellSkeleton>
      {content}
    </DashboardShellSkeleton>
  );
}
