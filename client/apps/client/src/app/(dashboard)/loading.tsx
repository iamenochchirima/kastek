import {
  DashboardGenericPageSkeleton,
  DashboardShellSkeleton,
} from "@/components/dashboard/dashboard-loading";

export default function DashboardLoading() {
  return (
    <DashboardShellSkeleton>
      <DashboardGenericPageSkeleton />
    </DashboardShellSkeleton>
  );
}
