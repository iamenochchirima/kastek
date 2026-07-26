import { fetchRustJson } from "@/lib/rust-server-api";

export type OnboardingProfile = {
  orgId: string;
  orgName: string;
  website: string | null;
  primaryGoal: string | null;
  primaryGoals: string[];
  teamRole: string | null;
  industry: string | null;
  referralSource: string | null;
  completedAt: string | null;
  skippedAt: string | null;
};

export type OnboardingStatus = {
  profile: OnboardingProfile;
  canManage: boolean;
  needsOnboarding: boolean;
};

export function fetchOnboardingStatus() {
  return fetchRustJson<OnboardingStatus>("/api/onboarding");
}
