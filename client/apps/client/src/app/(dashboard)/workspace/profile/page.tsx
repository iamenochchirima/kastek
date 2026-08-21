import { redirect } from "next/navigation";

export const metadata = {
  title: "Profile | KasiTek",
};

type ProfileSearchParams = Record<string, string | string[] | undefined>;

export default async function WorkspaceProfilePage({
  searchParams,
}: {
  searchParams: Promise<ProfileSearchParams>;
}) {
  const params = new URLSearchParams({ section: "profile" });
  const search = await searchParams;
  for (const [key, value] of Object.entries(search)) {
    if (key === "section" || value === undefined) continue;
    params.set(key, Array.isArray(value) ? value[0] ?? "" : value);
  }
  redirect(`/workspace/settings?${params.toString()}`);
}
