import { Outlet } from "react-router";
import ThemeScope from "@/components/theme-scope";
import { MotionReveal } from "@/components/ui/motion-reveal";

export default function AuthLayout() {
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-4 py-8 sm:py-10">
      <ThemeScope mode="stored" />
      <div className="relative w-full max-w-md">
        <MotionReveal>
          <div className="rounded-lg border border-border bg-card p-6 shadow-[0_24px_80px_rgb(0_0_0_/_0.18)] sm:p-8">
            <Outlet />
          </div>
        </MotionReveal>
      </div>
    </div>
  );
}
