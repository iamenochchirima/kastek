import { redirect } from "@/lib/navigation";

export const metadata = { title: "Create agent | KasiTek" };

export default async function StudioAgentCreationRoute({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (value !== undefined) queryParams.set(key, value);
  }
  const query = queryParams.toString();
  redirect(`/app/agents/new${query ? `?${query}` : ""}`);
}
