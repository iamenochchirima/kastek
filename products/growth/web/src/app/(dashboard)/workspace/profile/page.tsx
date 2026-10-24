import type { ClientLoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function meta() { return [{ title: "Profile | KasiTek" }]; }

type ProfileSearchParams = Record<string, string | string[] | undefined>;

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const urlSearch = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...urlSearch.keys()].map(key => [key, urlSearch.getAll(key).length > 1 ? urlSearch.getAll(key) : urlSearch.get(key)!])) as ProfileSearchParams);

  const params = new URLSearchParams({ section: "profile" });
  const search = searchParams;
  for (const [key, value] of Object.entries(search)) {
    if (key === "section" || value === undefined) continue;
    params.set(key, Array.isArray(value) ? value[0] ?? "" : value);
  }
  throw redirect(`/workspace/settings?${params.toString()}`);

}

export default function WorkspaceProfilePage() { return null; }
